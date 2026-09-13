import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { MessageDedup, parseAgentpushWebhook, parseEmailInbound, type InboundEnvelope } from "../channels/index.ts"
import { resolveDisplayName } from "../channels/display-name.ts"
import {
  NullProviders,
  normalizeInboundMedia,
  type IngressFetch,
  type MediaReferenceResolver,
  type SttProvider,
  type VisionProvider,
} from "../channels/media-ingress.ts"
import { AgentpushMediaFetcher } from "../channels/agentpush/media-fetch.ts"
import { TelegramMediaResolver } from "../channels/telegram-media.ts"
import { OpenAiSttProvider, OpenAiVisionProvider } from "../media/openai.ts"
import type { TranscriptRecord } from "../daemon/records.ts"
import { env } from "../env.ts"
import { joinLinks } from "../links/index.ts"
import type { Room, Tier, Delivery, Member } from "../rooms/types.ts"
import { ROUTED_PROVIDERS, deliverySeqOf, pullMemberStale } from "../rooms/types.ts"
import { renderRoomNotFoundPage, renderRoomPage } from "../web/page.ts"
import {
  newUserMessageText,
  outboxToAguiEventBody,
  parseRunAgentInput,
  runErrorEvent,
  sinceFromInput,
  type AguiEvent,
} from "../audience/agui.ts"
import { proxyArtifact, publicArtifactUrl } from "./artifact-proxy.ts"
import { ArtifactRenderStore, type ArtifactRenderRecord } from "./artifact-renders.ts"
import { createMcpCanvakitHandler, defaultMcpCanvakitDeps, type McpResponse } from "./mcp-canvakit.ts"
import { bearerOf, createMcpRoomHandler, memberToken, tokensMatch } from "./mcp-room.ts"
import { createMcpPersonalHandler } from "./mcp-personal.ts"
import { getSessionBusy, type DaemonExtraOptions } from "./daemon-extra.ts"
import type { NameClaimedReason, RoomService, RoomWebSendOutcome } from "./room-service.ts"
import { MediaStore, type IngressMediaRecord } from "./media-store.ts"

/** The `Room` shape handed to any client-facing surface — the JSON API and
 *  the page's server-side embed alike: the raw box `artifactUrl` swapped for
 *  the stable, room-code-keyed proxy URL, so the raw e2b URL never reaches a
 *  browser (architecture.md §9.3b; mirrors `RoomService`'s own
 *  `memberFacingArtifactUrl` for messenger/email replies). */
function toPublicRoom(room: Room, hasStoredRender: boolean): Room {
  // `deliveries` carries the text of tool-addressed say/whisper messages,
  // whispers included — this projection is handed to any GET /rooms/:code
  // caller and server-side page embed, so it is stripped unconditionally
  // here (PLAN §3.3: the leak the adversarial review caught).
  const { deliveries: _stripped, ...publicRoom } = room
  void _stripped
  // A box last confirmed dead (`artifactReady === false`, the idle sweep's
  // probe) advertises no URL at all — the page shows its paused/self-heal
  // state instead of a clickable dead link (the dead-artifact finding).
  // Exception: a STORED render is servable by this service itself, box or
  // no box, so the URL stays alive while the render exists.
  if (room.artifactReady === false && !hasStoredRender) return { ...publicRoom, artifactUrl: undefined }
  if (room.artifactUrl === undefined) {
    return hasStoredRender ? { ...publicRoom, artifactUrl: publicArtifactUrl(room.code) } : publicRoom
  }
  return { ...publicRoom, artifactUrl: publicArtifactUrl(room.code) }
}

/** The only record kinds the room web transcript renders (architecture.md
 *  §5.2's fan-out list, extended with the tier-3 richer view). */
const STREAM_KINDS: ReadonlySet<TranscriptRecord["kind"]> = new Set([
  "user-prompt",
  "text-delta",
  "thought",
  "tool-call",
  "tool-result",
  "turn-end",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key]
  return typeof v === "string" ? v : undefined
}

function isTier(value: unknown): value is Tier {
  return value === "messenger" || value === "email" || value === "room-web"
}

async function readRawBodyText(req: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const text = await readRawBodyText(req)
  return text.length > 0 ? JSON.parse(text) : undefined
}

function flattenHeaders(headers: IncomingMessage["headers"]): Record<string, string | undefined> {
  const flat: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(headers)) {
    flat[key] = Array.isArray(value) ? value[0] : value
  }
  return flat
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

/** `Access-Control-Allow-Origin: *`, scoped to exactly two routes (BRIEF-03):
 *  `GET /r/:code/state` and the artifact proxy. Both panels' `fetch` runs
 *  from the HOST APPLICATION's origin, not ours, so the browser's CORS check
 *  blocks the read independent of CSP `connectDomains` — every panel sits on
 *  "Loading…" forever in any browser-based host without this. Safe here
 *  specifically because both payloads are already unauthenticated: the room
 *  code IS the capability, so a browser reading either cross-origin learns
 *  nothing it could not learn with `curl`. Deliberately NOT used on
 *  `/rooms/:code/outbox`, `/outbox/cursor`, `/rooms/:code/send`, or `/mcp/*`
 *  — those are bearer-authenticated and member-scoped, and `ACAO: *` on a
 *  credentialed endpoint is a different, much worse decision. Never paired
 *  with `Access-Control-Allow-Credentials`: the browser rejects that
 *  combination anyway, and it is the classic way a public endpoint becomes
 *  credentialed by accident. */
function setPublicCorsHeader(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*")
}

/** Preflight response for the same two public routes `setPublicCorsHeader`
 *  covers. A plain `GET` with no custom headers never preflights, but the
 *  panel's `fetch`-and-inject fallback may add one — and a missing `OPTIONS`
 *  handler here would 404, which reads exactly like the route not existing. */
function sendCorsPreflight(res: ServerResponse): void {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
  })
  res.end()
}

/** Injectable media-ingress pieces for the webhook handlers and the media
 *  route (docs/MULTIMODAL.md). Every default is the degraded-but-visible one,
 *  and each is upgraded only when the matching credential is configured. */
export interface HttpMediaHooks {
  mediaStore?: MediaStore
  renders?: ArtifactRenderStore
  stt?: SttProvider
  vision?: VisionProvider
  fetch?: IngressFetch
  maxBytes?: number
  resolveReference?: MediaReferenceResolver
}

interface MediaIngress {
  readonly store: MediaStore
  readonly renders: ArtifactRenderStore
  readonly stt: SttProvider
  readonly vision: VisionProvider
  readonly fetch: IngressFetch | undefined
  readonly maxBytes: number | undefined
  readonly resolveReference: MediaReferenceResolver | undefined
}

/** Credentials decide capability, and each one is independent:
 *
 *  - no `RDV_TELEGRAM_BOT_TOKEN` → a Telegram voice note or photo lands as a
 *    visible "could not be fetched" line, because agentpush sends only a
 *    `file_id` (docs/UPSTREAM.md §11) and nothing here can resolve it.
 *  - no `RDV_OPENAI_API_KEY` → the bytes land and are stored, but nobody can
 *    say what is in them: "transcription unavailable".
 *  - both set → a voice note arrives as its transcript, an image as a
 *    description, attributed like any other message.
 *
 *  Explicit hooks always win, so tests never depend on the environment. */
function resolveMediaIngress(hooks: HttpMediaHooks | undefined): MediaIngress {
  const openaiKey = env.openaiApiKey
  const telegramToken = env.telegramBotToken
  return {
    // env.mediaDir is the live runtime store the running service serves
    // media from; a test must inject its own MediaStore/ArtifactRenderStore,
    // never rely on this.
    store: hooks?.mediaStore ?? new MediaStore(env.mediaDir),
    renders: hooks?.renders ?? new ArtifactRenderStore(env.mediaDir),
    stt: hooks?.stt ?? (openaiKey !== undefined ? new OpenAiSttProvider(openaiKey) : NullProviders.stt),
    vision: hooks?.vision ?? (openaiKey !== undefined ? new OpenAiVisionProvider(openaiKey) : NullProviders.vision),
    fetch: hooks?.fetch,
    maxBytes: hooks?.maxBytes,
    resolveReference: hooks?.resolveReference ?? defaultReferenceResolver(telegramToken),
  }
}

/**
 * Who resolves a bare `providerMediaId` into bytes.
 *
 * Preferred: agentpush's own `messaging_attachment_fetch`, which works for
 * EVERY messenger channel and keeps the provider credential inside agentpush.
 *
 * Fallback: the direct Telegram resolver, for when agentpush is not
 * configured (the console/local transport). It is Telegram-only by
 * construction — the previous wiring used it for every channel, so a WhatsApp
 * voice note's Meta media id was sent to Telegram's `getFile` and rejected,
 * landing a 0-byte record and telling the member the file "could not be
 * fetched". Provider-blind resolution read as a platform limit and was our
 * own bug.
 */
function defaultReferenceResolver(telegramToken: string | undefined): MediaReferenceResolver | undefined {
  if (env.agentpushUrl !== undefined) {
    return new AgentpushMediaFetcher({
      baseUrl: env.agentpushUrl,
      apiKey: env.agentpushKey,
      maxBytes: env.mediaMaxBytes,
    })
  }
  if (telegramToken !== undefined) {
    return new TelegramMediaResolver({ token: telegramToken, maxBytes: env.mediaMaxBytes })
  }
  return undefined
}

/** docs/MULTIMODAL.md transcript convention: a media message fans in as
 *  `[Name · channel · kind] <normalized line>`. The suffix rides INSIDE the
 *  text on this side because `RoomService.InboundInput` lives in
 *  room-service.ts — another executor's file this milestone must not touch —
 *  so there is nowhere to add the optional field `handleInbound` would need.
 *  `fanIn` still prepends its own `[Name · tier]`, so the session prompt
 *  shows both prefixes; nothing is dropped, only doubled. */
function attributedMediaText(envelope: InboundEnvelope, mediaText: string, suffix: string): string {
  const line = `[${envelope.displayName} · ${envelope.source} · ${suffix}] ${mediaText}`
  return envelope.text.length > 0 ? `${envelope.text}\n${line}` : line
}

/** The ingress pipeline's first half: normalize media into text + stored
 *  records BEFORE anything is enqueued, then hand back the text to fan in. */
async function ingestEnvelopeMedia(
  envelope: InboundEnvelope,
  media: MediaIngress,
): Promise<{ text: string; records: readonly IngressMediaRecord[] }> {
  const normalized = await normalizeInboundMedia(envelope, {
    store: media.store,
    stt: media.stt,
    vision: media.vision,
    ...(media.fetch !== undefined ? { fetch: media.fetch } : {}),
    ...(media.maxBytes !== undefined ? { maxBytes: media.maxBytes } : {}),
    ...(media.resolveReference !== undefined ? { resolveReference: media.resolveReference } : {}),
  })
  if (normalized.text === undefined || normalized.attributionSuffix === undefined) {
    return { text: envelope.text, records: [] }
  }
  return {
    text: attributedMediaText(envelope, normalized.text, normalized.attributionSuffix),
    records: normalized.records,
  }
}

async function handleInboundSimulated(service: RoomService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  if (!isRecord(body)) {
    sendJson(res, 400, { error: "invalid_body" })
    return
  }
  const provider = stringField(body, "provider")
  const source = stringField(body, "source")
  const contactRef = stringField(body, "contactRef")
  const displayName = stringField(body, "displayName")
  const text = stringField(body, "text")
  const tier = body.tier
  if (
    provider === undefined ||
    source === undefined ||
    contactRef === undefined ||
    displayName === undefined ||
    text === undefined ||
    !isTier(tier)
  ) {
    sendJson(res, 400, { error: "invalid_body" })
    return
  }
  // Brief E: an unroutable provider used to surface as an uncaught 500 from
  // `addMember` → `deliveryFromAddress`. The request body is the one place
  // an arbitrary provider enters the system unverified — validate it here and
  // answer 400 naming it, before anything downstream throws.
  if (!ROUTED_PROVIDERS.includes(provider)) {
    sendJson(res, 400, { error: "unknown_provider", provider })
    return
  }

  const outcome = await service.handleInbound({
    address: { provider, source, contactRef },
    displayName,
    tier,
    text,
  })
  // Brief D: the boundary catches a genuinely unroutable member and answers
  // it as an outcome, never an uncaught 500. The simulated surface makes it
  // an explicit 422 naming the fault.
  if (outcome.kind === "undeliverable") {
    sendJson(res, 422, { error: "undeliverable", message: outcome.reason })
    return
  }
  sendJson(res, 200, outcome)
}

/** The `GET /r/:code/state` payload — everything the room page's poll loop
 *  patches the DOM from, one JSON snapshot: room state, the member-facing
 *  proxied artifact fact (never the raw e2b host), the roster, and the
 *  agent's busy/idle fact read from the daemon session descriptor. */
export interface RoomStatePayload {
  code: string
  state: Room["state"]
  artifact: { url: string | undefined; ready: boolean; renderedAt: string | undefined }
  members: { displayName: string; tier: Tier; joinedAt: string; away: boolean }[]
  agent: { busy: boolean; lastActivityAt: string }
  updatedAt: string
}

/** One state snapshot for the page's poller. The artifact is advertised as
 *  ready only when the room is active AND its stored URL exists AND the last
 *  boot/liveness probe confirmed it answers — a paused room or a confirmed
 *  dead box gets `ready: false` and no URL at all, so the page never renders
 *  a clickable dead link (the dead-artifact finding).
 *
 *  `renderedAt` (BRIEF-05) is the artifact panel's freshness signal: it is
 *  `undefined` whenever there is no stored render, NEVER a fallback to "now"
 *  — a value that changes on every poll would make the panel reload
 *  forever, the present bug inverted. It only ever comes from the store's
 *  own record. */
async function roomStatePayload(
  room: Room,
  daemon: DaemonExtraOptions,
  getStoredRender: (code: string) => Promise<ArtifactRenderRecord | undefined>,
  now: Date = new Date(),
): Promise<RoomStatePayload> {
  const storedRender = await getStoredRender(room.code)
  const artifactLive =
    (room.state !== "paused" && room.artifactUrl !== undefined && room.artifactReady !== false) ||
    storedRender !== undefined
  const busy =
    room.sessionId !== undefined ? ((await getSessionBusy(daemon, room.sessionId)) ?? false) : false
  return {
    code: room.code,
    state: room.state,
    artifact: {
      url: artifactLive ? publicArtifactUrl(room.code) : undefined,
      ready: artifactLive,
      renderedAt: storedRender?.renderedAt,
    },
    members: room.members.map((member) => ({
      displayName: member.displayName,
      tier: member.tier,
      joinedAt: member.joinedAt,
      // Stale pull member (brief D): the tab has not acked for PULL_STALE_MS
      // — shown away in the roster and on the page, and its retention floor
      // is released. The member itself is NEVER removed (D6 constraint 1).
      away: pullMemberStale(member, now.getTime()),
    })),
    agent: { busy, lastActivityAt: room.lastActivityAt },
    updatedAt: now.toISOString(),
  }
}

async function handleRoomState(
  service: RoomService,
  daemon: DaemonExtraOptions,
  getStoredRender: (code: string) => Promise<ArtifactRenderRecord | undefined>,
  res: ServerResponse,
  encodedCode: string,
): Promise<void> {
  const code = decodeURIComponent(encodedCode)
  const room = service.getRoom(code)
  if (room === undefined) {
    sendJson(res, 404, { error: "not_found" })
    return
  }
  sendJson(res, 200, await roomStatePayload(room, daemon, getStoredRender))
}

async function handleGetRoom(
  service: RoomService,
  hasStoredRender: (code: string) => Promise<boolean>,
  res: ServerResponse,
  encodedCode: string,
): Promise<void> {
  const code = decodeURIComponent(encodedCode)
  const room = service.getRoom(code)
  if (room === undefined) {
    sendJson(res, 404, { error: "not_found" })
    return
  }
  sendJson(res, 200, toPublicRoom(room, await hasStoredRender(code)))
}

async function handleHealth(service: RoomService, res: ServerResponse): Promise<void> {
  const rooms = service.roomCount()
  const daemon = await service.daemonHealth()
  sendJson(res, 200, { status: "ok", rooms, daemon })
}

async function handleRoomPage(
  service: RoomService,
  daemon: DaemonExtraOptions,
  hasStoredRender: (code: string) => Promise<boolean>,
  res: ServerResponse,
  encodedCode: string,
): Promise<void> {
  const code = decodeURIComponent(encodedCode)
  const room = service.getRoom(code)
  if (room === undefined) {
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" })
    res.end(renderRoomNotFoundPage(code))
    return
  }
  const links = joinLinks(room.code, {
    publicUrl: env.publicUrl,
    whatsappNumber: env.whatsappNumber,
    telegramBot: env.telegramBot,
    smsNumber: env.smsNumber,
  })
  // Server-render the initial agent status too, so the page is never blank
  // or lying before the first poll lands.
  const busy =
    room.sessionId !== undefined ? ((await getSessionBusy(daemon, room.sessionId)) ?? false) : false
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  res.end(renderRoomPage(toPublicRoom(room, await hasStoredRender(code)), links, busy))
}

/** `GET /r/:code/artifact/` and `GET /r/:code/artifact/*` — the stable,
 *  room-code-keyed URL members are actually given (architecture.md §9.3b,
 *  `publicArtifactUrl`). When the room has a stored canvakit render, the
 *  INDEX is served from that render (the box cannot produce the branded
 *  page; this service already has it) while every other path proxies to the
 *  box. A room with no `artifactUrl` yet is handed to `proxyArtifact` the
 *  same as an unreachable upstream: both self-heal with the same refreshing
 *  503 page, so this route never needs its own 404 for "no artifact". An
 *  unknown room code, though, is a 404 — there is nothing to self-heal
 *  toward. */
async function handleRoomArtifact(
  service: RoomService,
  renders: ArtifactRenderStore,
  req: IncomingMessage,
  res: ServerResponse,
  encodedCode: string,
  subPath: string,
  search: string,
): Promise<void> {
  const code = decodeURIComponent(encodedCode)
  const room = service.getRoom(code)
  if (room === undefined) {
    sendJson(res, 404, { error: "not_found" })
    return
  }

  // The deliverable PDF is the one subpath under this prefix that NEVER
  // proxies to the box: canvakit produced it on this host and it exists
  // nowhere else. So "no stored render" is a definite 404 here, not the
  // self-healing 503 the rest of the prefix answers with — that page means
  // "the box is coming up", and for bytes that are not coming it would be a
  // delay standing in for an absence.
  if (subPath === "/deliverable.pdf") {
    const pdf = await renders.readPdf(code)
    if (pdf === undefined) {
      sendJson(res, 404, { error: "no_render", message: `room ${code} has no rendered artifact yet` })
      return
    }
    res.writeHead(200, {
      "content-type": "application/pdf",
      "content-length": String(pdf.length),
      // `inline`, so a browser and a messenger preview it rather than
      // forcing a download; the filename still carries the room code for
      // whoever does save it.
      "content-disposition": `inline; filename="${code}-deliverable.pdf"`,
      // The bytes change only when a new render lands, and every link to
      // them is the same stable URL — so revalidate rather than cache, or a
      // re-render silently serves the old document.
      "cache-control": "no-cache",
    })
    res.end(req.method === "HEAD" ? undefined : pdf)
    return
  }

  const renderedIndex = (await renders.hasOrLoad(code)) ? await renders.readHtml(code) : undefined
  await proxyArtifact(
    {
      artifactUrl: room.artifactUrl,
      method: req.method,
      subPath,
      search,
      ...(renderedIndex !== undefined ? { renderedIndex } : {}),
    },
    res,
  )
}

function parseSince(raw: string | null): number {
  if (raw === null) return 0
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

async function handleRoomStream(
  service: RoomService,
  req: IncomingMessage,
  res: ServerResponse,
  encodedCode: string,
  since: number,
): Promise<void> {
  const code = decodeURIComponent(encodedCode)
  const room = service.getRoom(code)
  if (room === undefined) {
    sendJson(res, 404, { error: "not_found" })
    return
  }
  if (room.sessionId === undefined) {
    sendJson(res, 409, { error: "no_session" })
    return
  }
  const sessionId = room.sessionId

  const controller = new AbortController()
  req.on("close", () => controller.abort())

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  // Node buffers headers until the first write() otherwise — an idle room
  // (nobody talking yet) would leave the browser's EventSource stuck
  // "connecting" forever instead of open-and-waiting.
  res.flushHeaders()

  try {
    for await (const record of service.events(sessionId, since, controller.signal)) {
      if (!STREAM_KINDS.has(record.kind)) continue
      res.write(`data: ${JSON.stringify(record)}\n\n`)
    }
  } catch {
    // Upstream closed, was aborted by the browser disconnecting, or the
    // daemon dropped the connection — either way the client's EventSource
    // reconnects from its own last-seen `since`, nothing to do here.
  } finally {
    res.end()
  }
}

async function handleRoomSend(
  service: RoomService,
  req: IncomingMessage,
  res: ServerResponse,
  encodedCode: string,
): Promise<void> {
  const code = decodeURIComponent(encodedCode)
  const body = await readJsonBody(req)
  if (!isRecord(body)) {
    sendJson(res, 400, { error: "invalid_body" })
    return
  }
  const displayName = stringField(body, "displayName")
  const text = stringField(body, "text")
  const claim = stringField(body, "claim")
  if (displayName === undefined || text === undefined || displayName.trim().length === 0 || text.trim().length === 0) {
    sendJson(res, 400, { error: "invalid_body" })
    return
  }

  const outcome = await service.sendFromRoomWeb(
    code,
    displayName,
    text,
    claim !== undefined && claim.trim().length > 0 ? claim.trim() : undefined,
  )
  if (outcome.kind === "unknown-code") {
    sendJson(res, 404, { error: "not_found" })
    return
  }
  if (outcome.kind === "no-session") {
    sendJson(res, 409, { error: "no_session" })
    return
  }
  if (outcome.kind === "name-claimed") {
    sendJson(res, 409, { error: "name_claimed", reason: outcome.reason, message: nameClaimedMessage(outcome.reason) })
    return
  }
  if (outcome.kind === "delivered") {
    sendJson(res, 200, { delivered: true, text: outcome.text })
    return
  }
  sendJson(res, 200, outcome.result)
}

/** The refusal message for a name someone else holds, shared by the claim
 *  exchange and the send path so the page renders it from either (brief A:
 *  a distinct outcome the UI can render, not a generic 500). */
const NAME_TAKEN_MESSAGE = "ce nom est déjà pris dans cette room — choisis-en un autre"

/** BRIEF-21: the OTHER `name-claimed` situation — this browser once held the
 *  name, but the secret it presented did not match. Rendered as a different
 *  sentence from `NAME_TAKEN_MESSAGE`, because "pick another name" is the
 *  wrong instruction for someone who already owns this one; a wrong-secret
 *  refusal names the state without building the recovery path (brief 23). */
const NAME_STALE_MESSAGE =
  "ce nom est le tien, mais ce navigateur ne peut plus le prouver — choisis un autre nom pour l'instant"

function nameClaimedMessage(reason: NameClaimedReason): string {
  return reason === "stale" ? NAME_STALE_MESSAGE : NAME_TAKEN_MESSAGE
}

/** `POST /rooms/:code/claim` (PLAN-02 §3-D3 amended) — the browser's join
 *  handshake. The page sends the name it typed plus the join secret it holds
 *  in localStorage, if any; the service mints one on the join that first
 *  claims the name and returns it EXACTLY once. The response carries this
 *  member's bearer token for `GET /rooms/:code/outbox` — and nothing else
 *  ever does: the token is bound to a member whose name only the claim
 *  holder can assume, so this endpoint is the only door it leaves through.
 *  That is why the token is NOT embedded in the page HTML (see page.ts): the
 *  page is rendered before anyone has presented anything, and a spectator's
 *  HTML must hold no credential at all. */
/** `POST /rooms/:code/outbox/cursor` (PLAN-02 step 4, brief A) — the cursor
 *  acknowledgement. Same token family and same per-member server-side
 *  resolution as the drain (`resolveOutboxMember`); a separate endpoint,
 *  because a GET must not mutate. Body `{ "seq": <n> }` — the highest seq
 *  the client has RENDERED (the page acks after rendering, never on
 *  receipt). Monotonic server-side: an ack that would move the cursor
 *  backwards is ignored, not an error, and answered with the floor that
 *  stayed. */
async function handleRoomCursorAck(
  service: RoomService,
  req: IncomingMessage,
  res: ServerResponse,
  encodedCode: string,
): Promise<void> {
  const code = decodeURIComponent(encodedCode)
  const room = service.getRoom(code)
  if (room === undefined) {
    sendJson(res, 404, { error: "not_found" })
    return
  }
  const member = resolveOutboxMember(room, code, req.headers.authorization)
  if (member === undefined) {
    // A wrong or absent token must reveal nothing — not even the roster.
    sendJson(res, 401, { error: "unauthorized" })
    return
  }
  const body = await readJsonBody(req)
  if (!isRecord(body)) {
    sendJson(res, 400, { error: "invalid_body" })
    return
  }
  const seq = body.seq
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
    sendJson(res, 400, { error: "invalid_body" })
    return
  }
  const outcome = await service.deliveryEngine.ackCursor(room.code, member.id, seq)
  sendJson(res, 200, {
    applied: outcome === "applied",
    // The member's effective cursor either way: what the client may assume
    // the floor now is.
    ackedSeq: outcome === "applied" ? seq : member.ackedSeq ?? 0,
  })
}

async function handleRoomClaim(
  service: RoomService,
  req: IncomingMessage,
  res: ServerResponse,
  encodedCode: string,
): Promise<void> {
  const code = decodeURIComponent(encodedCode)
  const body = await readJsonBody(req)
  if (!isRecord(body)) {
    sendJson(res, 400, { error: "invalid_body" })
    return
  }
  const displayName = stringField(body, "displayName")
  const presented = stringField(body, "claim")
  if (displayName === undefined || displayName.trim().length === 0) {
    sendJson(res, 400, { error: "invalid_body" })
    return
  }
  const outcome = await service.claimRoomWeb(
    code,
    displayName,
    presented !== undefined && presented.trim().length > 0 ? presented.trim() : undefined,
  )
  if (outcome.kind === "unknown-code") {
    sendJson(res, 404, { error: "not_found" })
    return
  }
  if (outcome.kind === "name-claimed") {
    sendJson(res, 409, { error: "name_claimed", reason: outcome.reason, message: nameClaimedMessage(outcome.reason) })
    return
  }
  sendJson(res, 200, {
    memberId: outcome.member.id,
    displayName: outcome.member.displayName,
    memberToken: outcome.token,
    ...(outcome.claim !== undefined ? { claim: outcome.claim } : {}),
  })
}

/** How long the outbox SSE drain waits between looks at the room's store for
 *  records accepted after its replay. The store has no subscription
 *  mechanism (the session event stream is a different pipe), so the live
 *  half of the drain is a poll — coarse by design, because `accept` returns
 *  long before the agent's turn ends. */
const OUTBOX_POLL_MS = 1000

/** What one outbox response carries. `deliveries` is already scoped to the
 *  requesting member, server-side, before the bytes leave the process
 *  (PLAN-02 §3-D4). */
export interface OutboxPayload {
  memberId: string
  /** The room's current `deliverySeq` — how far the ROOM has got, for
   *  display. It is NOT the client's next `since`, and an earlier version of
   *  this comment said it was: the room's seq sits past records that were
   *  still `pending` when this snapshot was taken, so advancing to it skips
   *  the client's own undelivered mail, permanently. The next `since` is the
   *  highest seq the client actually RENDERED
   *  (`docs/OUTBOX.md` §3.1). D7 still holds:
   *  at-least-once, dedupe on `Delivery.id`. */
  cursor: number
  /** The gap marker (PLAN-02 §3-D6): true when the requested `since` is
   *  below the oldest delivery id still retained FOR THIS MEMBER. `since` is
   *  answered by filtering survivors, so without this a destroyed backlog is
   *  indistinguishable from "nothing new". `false` never means "you are up
   *  to date" — it means nothing observable was lost. Fires only for an
   *  explicitly presented `since`: omitting it means "give me everything
   *  retained", which is a request nothing can be lost from. */
  pruned: boolean
  deliveries: Delivery[]
}

function outboxFor(room: Room, member: Member, since: number, sinceGiven: boolean): OutboxPayload {
  const all = room.deliveries ?? []
  const mine = all.filter((delivery) => delivery.memberId === member.id)
  const oldestOfAll = (): number | undefined => {
    let oldest: number | undefined
    for (const delivery of all) {
      const seq = deliverySeqOf(delivery.id)
      if (oldest === undefined || seq < oldest) oldest = seq
    }
    return oldest
  }
  // brief 12: `deliveryLowWater` is present on every room created after this
  // field existed — it is written 0 at birth (rooms/store.ts `create`) — so
  // its presence is itself the signal. When present it is the EXACT and
  // COMPLETE answer (docs/OUTBOX.md §8) and nothing else may override it:
  // in particular, the per-member oldest-OWNED seq (`oldestOf(mine)`, now
  // deleted) is not a pruning signal at all — a member simply never
  // addressed by the room's earliest records has an oldest-owned seq above
  // zero having lost nothing, and using it as evidence of a gap is what
  // told every non-first room-web member it lost messages on its first
  // poll ever.
  //
  // Only when the mark is ABSENT — a room persisted before it existed,
  // whose pruned history genuinely cannot be read from any field — does the
  // room-wide oldest retained seq (step 4's fallback) apply, as the weaker,
  // over-triggering signal §8 accepts for that legacy case only.
  //
  // brief 16: within that legacy arm, retaining d1 is a proof, not a guess —
  // seqs are minted monotonically from Room.deliverySeq and a pruned seq is
  // never re-minted (docs/OUTBOX.md §2), so d1 surviving means nothing has
  // EVER been pruned in this room, for anyone. Only when d1 is gone does the
  // weaker room-wide-oldest fallback apply, per §8.
  const legacyOldestRetained = room.deliveryLowWater === undefined ? oldestOfAll() : undefined
  const legacyProvablyUnpruned = legacyOldestRetained === 1
  const pruned =
    sinceGiven &&
    (room.deliveryLowWater !== undefined
      ? since < room.deliveryLowWater
      : !legacyProvablyUnpruned && legacyOldestRetained !== undefined && since < legacyOldestRetained)
  return {
    memberId: member.id,
    cursor: room.deliverySeq ?? 0,
    pruned,
    deliveries: mine.filter((delivery) => deliverySeqOf(delivery.id) > since),
  }
}

/** Resolve the member a `memberToken` names: recompute the expected token
 *  per member of THIS room and compare constant-time (`tokensMatch`), the
 *  same recompute-and-compose binding the room MCP endpoint uses. The token
 *  is not reversible, so the room is fixed by the URL and the member by the
 *  recomputation — a token for member A matches member A and nothing else,
 *  here or on any other endpoint. */
function resolveOutboxMember(room: Room, code: string, authorization: string | undefined): Member | undefined {
  const provided = bearerOf(authorization)
  if (provided === undefined) return undefined
  for (const candidate of room.members) {
    if (tokensMatch(provided, memberToken(code, candidate.id, env.roomTokenSecret))) return candidate
  }
  return undefined
}

/** `GET /rooms/:code/outbox?since=<seq>` (PLAN-02 §3-D3/D4/D6) — one pull
 *  member's ordered delivery backlog, authorized by that member's
 *  `memberToken` bearer. Authorization: header ONLY — no `?t=` query arm;
 *  that workaround is `/mcp/room`'s (PLAN-02 §4.1) and is not to be
 *  propagated. Answers SSE (`Accept: text/event-stream`) or JSON by the
 *  same cursor and the same records — two readings of one endpoint. */
async function handleRoomOutbox(
  service: RoomService,
  req: IncomingMessage,
  res: ServerResponse,
  encodedCode: string,
  since: number,
  sinceGiven: boolean,
): Promise<void> {
  const code = decodeURIComponent(encodedCode)
  const room = service.getRoom(code)
  if (room === undefined) {
    sendJson(res, 404, { error: "not_found" })
    return
  }
  const member = resolveOutboxMember(room, code, req.headers.authorization)
  if (member === undefined) {
    // A wrong or absent token must reveal nothing — not even the roster.
    sendJson(res, 401, { error: "unauthorized" })
    return
  }

  const wantsSse = (req.headers.accept ?? "").includes("text/event-stream")
  if (!wantsSse) {
    const snapshot = service.getRoom(code) ?? room
    sendJson(res, 200, outboxFor(snapshot, member, since, sinceGiven))
    return
  }

  // The SSE reading: replay the same answer as a meta frame plus one frame
  // per record, then follow the room's outbox for records accepted later.
  // The client dedupes on `Delivery.id` (D7) — a reconnect repeats records.
  const controller = new AbortController()
  req.on("close", () => controller.abort())

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  res.flushHeaders()

  try {
    let lastSent = since
    const sendFrame = (payload: object, event?: string): void => {
      res.write(`${event !== undefined ? `event: ${event}\n` : ""}data: ${JSON.stringify(payload)}\n\n`)
    }
    const snapshot = service.getRoom(code) ?? room
    const initial = outboxFor(snapshot, member, since, sinceGiven)
    for (const delivery of initial.deliveries) {
      const seq = deliverySeqOf(delivery.id)
      if (seq > lastSent) lastSent = seq
      sendFrame(delivery)
    }
    sendFrame({ memberId: member.id, cursor: initial.cursor, pruned: initial.pruned }, "meta")

    while (!controller.signal.aborted) {
      await new Promise<void>((resolve) => setTimeout(resolve, OUTBOX_POLL_MS))
      if (controller.signal.aborted) break
      const fresh = service.getRoom(code)
      if (fresh === undefined) break
      for (const delivery of (fresh.deliveries ?? []).filter(
        (delivery) => delivery.memberId === member.id && deliverySeqOf(delivery.id) > lastSent,
      )) {
        const seq = deliverySeqOf(delivery.id)
        if (seq > lastSent) lastSent = seq
        sendFrame(delivery)
      }
    }
  } catch {
    // The client disconnected mid-drain — the EventSource reconnects from
    // its own last-seen `since`; nothing to do here.
  } finally {
    res.end()
  }
}

/** `RoomWebSendOutcome` → a `RUN_ERROR` message, or `undefined` for a send
 *  that succeeded. No `default` arm (`contract.ts`'s `kindOf` pattern): a
 *  new outcome kind must be routed here explicitly or this fails to
 *  compile, rather than silently falling through as success. */
function sendFailureMessage(outcome: RoomWebSendOutcome): string | undefined {
  switch (outcome.kind) {
    case "sent":
    case "delivered":
      return undefined
    case "unknown-code":
      return "room not found"
    case "no-session":
      return "room has no active session"
    case "name-claimed":
      return nameClaimedMessage(outcome.reason)
  }
}

/** `POST /rooms/:code/agui` (BRIEF-04) — the AG-UI reading of the same
 *  per-member outbox `handleRoomOutbox` drains, for any AG-UI client
 *  (CopilotKit and friends) to become a room surface the way a browser tab
 *  already does by polling the outbox. The room page is untouched and keeps
 *  polling; this is purely additive.
 *
 *  A run here is BOUNDED, unlike the outbox SSE arm's indefinite follow:
 *  one POST replays exactly what `outboxFor` returns for the presented
 *  `since` and closes with `RUN_FINISHED`. AG-UI has no resume-from-cursor
 *  concept of its own (the tension this brief exists to manage), so the
 *  `STATE_SNAPSHOT` emitted on every run is what a reconnecting client has
 *  to present `since` from on its NEXT run (D3) — the transport of the
 *  drain stays a client-side choice either way (`docs/OUTBOX.md` §10).
 *
 *  D7: nothing here acks a cursor. Writing bytes to a socket is not a human
 *  reading them (`docs/OUTBOX.md` §6) — an AG-UI client that never calls
 *  `POST /rooms/:code/outbox/cursor` simply never produces a `"recipient"`
 *  confirmation for what this endpoint sends, and that absence is the
 *  honest value, not a gap to paper over here. */
async function handleRoomAgui(
  service: RoomService,
  req: IncomingMessage,
  res: ServerResponse,
  encodedCode: string,
): Promise<void> {
  const code = decodeURIComponent(encodedCode)
  const room = service.getRoom(code)
  if (room === undefined) {
    sendJson(res, 404, { error: "not_found" })
    return
  }
  // D4: the member comes from the SAME bearer resolution the outbox drain
  // uses — never from a body field. AG-UI has no recipient concept, and
  // needs none: the per-member stream IS the addressing, whisper included.
  const member = resolveOutboxMember(room, code, req.headers.authorization)
  if (member === undefined) {
    // A wrong or absent token must reveal nothing — not even the roster.
    sendJson(res, 401, { error: "unauthorized" })
    return
  }

  const parsed = parseRunAgentInput(await readJsonBody(req))
  if ("error" in parsed) {
    sendJson(res, 400, { error: parsed.error })
    return
  }
  const { input } = parsed

  const controller = new AbortController()
  req.on("close", () => controller.abort())

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  res.flushHeaders()

  const writeEvent = (event: AguiEvent): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  // BRIEF-07: opened as the very first write, before ANY awaited work that
  // can take arbitrarily long — `sendFromRoomWeb` below can await a whole
  // agent turn. A client that gives up before that resolves must see a run
  // that unambiguously started, never a silent empty 200 (`docs/OUTBOX.md`
  // §1, absence must never read as delivery). This is the one and only
  // place this handler writes RUN_STARTED — everything below uses
  // `outboxToAguiEventBody`, the un-bracketed half of the translation
  // (agui.ts), so there is never a second one and never zero.
  writeEvent({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId })

  try {
    // D6: a new user message rides this SAME POST, routed to whatever
    // `/rooms/:code/send` already calls — never reimplemented, never
    // bypassing the fan-in. A run whose last message is not a fresh user
    // turn (a pure reconnect) sends nothing, which is normal.
    const text = newUserMessageText(input)
    if (text !== undefined) {
      const outcome = await service.sendFromRoomWeb(code, member.displayName, text, member.claim)
      const failure = sendFailureMessage(outcome)
      if (failure !== undefined) {
        writeEvent(runErrorEvent(failure))
        return
      }
    }

    // D3: the same `sinceGiven` distinction the HTTP outbox route makes —
    // an omitted `since` must never be told it lost something that never
    // existed (`docs/OUTBOX.md` §8).
    const { since, sinceGiven } = sinceFromInput(input)
    // D1: the SAME `outboxFor` the SSE outbox arm calls — no second read
    // path, no re-derived "which records are mine".
    const snapshot = service.getRoom(code) ?? room
    const outbox = outboxFor(snapshot, member, since, sinceGiven)
    for (const event of outboxToAguiEventBody({
      since,
      cursor: outbox.cursor,
      pruned: outbox.pruned,
      lowWater: snapshot.deliveryLowWater,
      deliveries: outbox.deliveries,
      roomCode: code,
    })) {
      writeEvent(event)
    }
    writeEvent({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId })
  } catch (error) {
    // A stream that ends quietly is absence reading as delivery: an actual
    // failure gets a RUN_ERROR frame, never a silent close. A genuine client
    // disconnect throws here too (the write above fails against a closed
    // socket) — `controller.signal.aborted` tells the two apart, so a
    // disconnect does not attempt a second, equally doomed write.
    if (!controller.signal.aborted) {
      try {
        writeEvent(runErrorEvent(error instanceof Error ? error.message : String(error)))
      } catch {
        // The write itself failed — the socket is genuinely gone.
      }
    }
  } finally {
    res.end()
  }
}

/** `GET /r/:code/media/:id` (docs/DELIVERABLE.md) — the link every delivery
 *  preview points at, extended to also serve ingress media records
 *  (docs/MULTIMODAL.md) with their stored mime. An unknown room or media id
 *  both 404; because the store is keyed `roomCode/mediaId`, a record landed
 *  in another room is not served under this code either. */
async function handleRoomMedia(
  service: RoomService,
  media: MediaIngress,
  res: ServerResponse,
  encodedCode: string,
  encodedId: string,
): Promise<void> {
  const code = decodeURIComponent(encodedCode)
  const id = decodeURIComponent(encodedId)
  const ingressRecord = media.store.getIngress(code, id)
  if (ingressRecord !== undefined) {
    const data = await media.store.readIngress(code, id)
    if (data === undefined) {
      sendJson(res, 404, { error: "not_found" })
      return
    }
    res.writeHead(200, { "content-type": ingressRecord.mime, "content-length": data.length })
    res.end(data)
    return
  }
  const data = await service.readMedia(code, id)
  if (data === undefined) {
    sendJson(res, 404, { error: "not_found" })
    return
  }
  res.writeHead(200, { "content-type": "application/pdf", "content-length": data.length })
  res.end(data)
}

/**
 * `parseAgentpushWebhook` already verifies the signature and does the
 * dedup-relevant shape checks; this only adds the one thing it can't know —
 * whether we have already processed this `messageId` — and maps a fresh
 * envelope onto `RoomService.handleInbound`. `fanIn` underneath posts with
 * `?wait=false`, so awaiting `handleInbound` here does not wait for the
 * agent's turn to finish, only for the queue-admission round trip — the
 * "respond fast" requirement is satisfied by that, not by skipping the await.
 */
async function handleAgentpushWebhook(
  service: RoomService,
  dedup: MessageDedup,
  media: MediaIngress,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const rawBody = await readRawBodyText(req)
  const result = parseAgentpushWebhook({
    rawBody,
    headers: flattenHeaders(req.headers),
    secret: env.agentpushWebhookSecret,
  })

  if (!result.ok) {
    sendJson(res, result.status, { error: result.reason })
    return
  }
  if ("ignored" in result) {
    sendJson(res, 200, { ignored: result.ignored })
    return
  }

  const envelope = result.envelope
  if (dedup.seen(envelope.messageId)) {
    sendJson(res, 200, { deduped: true })
    return
  }

  // Normalize at ingress (docs/MULTIMODAL.md): media becomes text + a stored
  // record BEFORE anything is enqueued. A media-only message (empty text)
  // fans in as the normalized line instead of being ignored.
  const ingested = await ingestEnvelopeMedia(envelope, media)

  // agentpush's envelope has no name field, so `displayName` arrives as the
  // contact ref itself — members would see each other as `700000002` and the
  // agent would address them that way. Resolve a real name where we can
  // (src/channels/display-name.ts); never fatal, falls back to the ref.
  const displayName = await resolveDisplayName(envelope.provider, envelope.contactRef)

  const outcome = await service.handleInbound({
    address: { provider: envelope.provider, source: envelope.source, contactRef: envelope.contactRef },
    displayName,
    tier: "messenger",
    text: ingested.text,
  })

  if (ingested.records.length > 0 && "room" in outcome) {
    // Records land room-less while membership is unresolved; re-key them
    // under the room the message actually landed in.
    for (const record of ingested.records) {
      await media.store.assignRoom(record.mediaId, outcome.room.code)
    }
  }
  sendJson(res, 200, outcome)
}

/**
 * `parseEmailInbound` verifies the signature and does the mail envelope's
 * own shape checks (docs/AGENTPUSH.md §8.2); this adds the dedup check (the
 * same `MessageDedup` instance the messenger webhook shares) and the
 * subject-line join: when the subject carried a room code hint and this
 * sender isn't yet a member of any room, an implicit `join <code>` runs
 * first so the actual message lands as a turn in that room rather than
 * bouncing as an unknown sender (docs/AGENTPUSH.md §8.5).
 */
async function handleAgentpushMailWebhook(
  service: RoomService,
  dedup: MessageDedup,
  media: MediaIngress,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const rawBody = await readRawBodyText(req)
  const result = parseEmailInbound({
    rawBody,
    headers: flattenHeaders(req.headers),
    secret: env.emailWebhookSecret,
  })

  if (!result.ok) {
    sendJson(res, result.status, { error: result.reason })
    return
  }
  if ("ignored" in result) {
    sendJson(res, 200, { ignored: result.ignored })
    return
  }

  const envelope = result.envelope
  if (dedup.seen(envelope.messageId)) {
    sendJson(res, 200, { deduped: true })
    return
  }

  // Same ingress normalization as the messenger webhook — a no-op today
  // (the mail envelope carries no media field, docs/AGENTPUSH.md §8.2), but
  // the one ingestion path stays the one path.
  const ingested = await ingestEnvelopeMedia(envelope, media)

  const address = {
    provider: envelope.provider,
    source: envelope.roomCodeHint ?? "email",
    contactRef: envelope.contactRef,
  }

  if (envelope.roomCodeHint !== undefined && !service.hasMemberAcrossRooms(envelope.provider, envelope.contactRef)) {
    await service.handleInbound({
      address,
      displayName: envelope.displayName,
      tier: "email",
      text: `join ${envelope.roomCodeHint}`,
    })
  }

  const outcome = await service.handleInbound({
    address,
    displayName: envelope.displayName,
    tier: "email",
    text: ingested.text,
  })

  if (ingested.records.length > 0 && "room" in outcome) {
    for (const record of ingested.records) {
      await media.store.assignRoom(record.mediaId, outcome.room.code)
    }
  }
  sendJson(res, 200, outcome)
}

/** `POST /mcp/canvakit` — the MCP-over-HTTP endpoint the sandbox agents'
 *  `render_artifact` tool calls through the tunnel (src/service/mcp-canvakit.ts).
 *  `POST /mcp/room` — the audience-tools endpoint (src/service/mcp-room.ts),
 *  same wire shape. Per-room bearer auth is enforced inside each handler
 *  (the token binds to the room), after the body is parsed — so the handler
 *  functions stay directly testable. */
/** Every request that reaches an MCP endpoint, one line, method + whether an
 *  Authorization header arrived. Low volume (a handful per turn) and it is the
 *  only way to tell the three failure modes apart from the outside: no line at
 *  all means the client never reached us (it 404'd on discovery and went to
 *  OAuth); a line with `auth=no` means the daemon did not forward the headers
 *  we mounted; `auth=yes` followed by a 401 means the token itself is wrong. */
function logMcpRequest(route: string, req: IncomingMessage): void {
  const hasAuth = typeof req.headers.authorization === "string" && req.headers.authorization.length > 0
  console.log(`mcp ${route}: ${req.method ?? "?"} auth=${hasAuth ? "yes" : "no"}`)
}

async function handleMcpPost(
  handler: (body: unknown, authorization: string | undefined, queryToken?: string) => Promise<McpResponse>,
  req: IncomingMessage,
  res: ServerResponse,
  queryToken?: string,
): Promise<void> {
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch {
    sendJson(res, 200, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "invalid JSON" },
    })
    return
  }
  const authorization = req.headers.authorization
  const mcpResponse = await handler(
    body,
    Array.isArray(authorization) ? authorization[0] : authorization,
    queryToken,
  )
  if (mcpResponse.status === 202) {
    res.writeHead(202)
    res.end()
    return
  }
  sendJson(res, mcpResponse.status, mcpResponse.body)
}

async function handle(
  service: RoomService,
  dedup: MessageDedup,
  media: MediaIngress,
  daemon: DaemonExtraOptions,
  mcpCanvakit: ReturnType<typeof createMcpCanvakitHandler>,
  mcpRoom: ReturnType<typeof createMcpRoomHandler>,
  mcpPersonal: ReturnType<typeof createMcpPersonalHandler>,
  hasStoredRender: (code: string) => Promise<boolean>,
  getStoredRender: (code: string) => Promise<ArtifactRenderRecord | undefined>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1")

  if (url.pathname === "/health" && req.method === "GET") {
    await handleHealth(service, res)
    return
  }

  if (url.pathname === "/mcp/canvakit" && req.method === "POST") {
    logMcpRequest("canvakit", req)
    await handleMcpPost(mcpCanvakit, req, res)
    return
  }

  if (url.pathname === "/mcp/room" && req.method === "POST") {
    logMcpRequest("room", req)
    // `?t=` is the token's second carrier — see `roomMcpMount`. The header is
    // still preferred; this only fires when it did not survive the box.
    await handleMcpPost(mcpRoom, req, res, url.searchParams.get("t") ?? undefined)
    return
  }

  // `POST /mcp` (BRIEF-18): the PERSON's surface, a third mount alongside
  // `/mcp/canvakit` and `/mcp/room`. It never rides through a sandbox tunnel
  // (there is no `?t=` carrier here — that workaround exists only for the
  // box's dropped Authorization header) and it gets no CORS header: it is
  // credentialed, and `ACAO: *` on a credentialed endpoint is the mistake
  // `setPublicCorsHeader` below already exists to avoid.
  if (url.pathname === "/mcp" && req.method === "POST") {
    logMcpRequest("personal", req)
    await handleMcpPost(mcpPersonal, req, res)
    return
  }

  // A POST-only Streamable HTTP MCP server must answer 405 on the methods it
  // does not implement — NOT 404. This is not pedantry about status codes: an
  // MCP client that gets a 404 on its opening `GET` concludes the endpoint
  // does not exist and falls back to OAuth discovery, which 404s in turn
  // (`/.well-known/*`, `/register` — we serve none), and the agent sees
  // "Dynamic Client Registration rejected (HTTP 404)". It never POSTs, so the
  // bearer we mounted is never sent and our handler never runs.
  //
  // Observed 2026-09-12 on the first live room of the tools protocol
  // (RDV-VPBB): the agent found `roster`/`say`, called them, and every call
  // died in that handshake. The same shape means the canvakit mount had never
  // worked from a box either — configured since day one, never once exercised,
  // which is exactly the silent failure this project exists to document.
  if (url.pathname === "/mcp/canvakit" || url.pathname === "/mcp/room" || url.pathname === "/mcp") {
    logMcpRequest(url.pathname === "/mcp" ? "personal" : url.pathname.slice("/mcp/".length), req)
    res.writeHead(405, { "content-type": "application/json", allow: "POST" })
    res.end(JSON.stringify({ error: "method_not_allowed", message: "This MCP endpoint is POST-only." }))
    return
  }

  if (url.pathname === "/inbound/simulated" && req.method === "POST") {
    await handleInboundSimulated(service, req, res)
    return
  }

  if (url.pathname === "/inbound/agentpush" && req.method === "POST") {
    await handleAgentpushWebhook(service, dedup, media, req, res)
    return
  }

  if (url.pathname === "/inbound/agentpush-mail" && req.method === "POST") {
    await handleAgentpushMailWebhook(service, dedup, media, req, res)
    return
  }

  const artifactMatch = /^\/r\/([^/]+)\/artifact(\/.*)?$/.exec(url.pathname)
  if (artifactMatch !== null && req.method === "OPTIONS") {
    sendCorsPreflight(res)
    return
  }
  if (artifactMatch !== null && (req.method === "GET" || req.method === "HEAD")) {
    setPublicCorsHeader(res)
    const encodedCode = artifactMatch[1]
    if (encodedCode === undefined) {
      sendJson(res, 400, { error: "invalid_code" })
      return
    }
    await handleRoomArtifact(service, media.renders, req, res, encodedCode, artifactMatch[2] ?? "", url.search)
    return
  }

  const mediaMatch = /^\/r\/([^/]+)\/media\/([^/]+)$/.exec(url.pathname)
  if (mediaMatch !== null && req.method === "GET") {
    const encodedCode = mediaMatch[1]
    const encodedId = mediaMatch[2]
    if (encodedCode === undefined || encodedId === undefined) {
      sendJson(res, 400, { error: "invalid_code" })
      return
    }
    await handleRoomMedia(service, media, res, encodedCode, encodedId)
    return
  }

  const pageMatch = /^\/r\/([^/]+)$/.exec(url.pathname)
  if (pageMatch !== null && req.method === "GET") {
    const encodedCode = pageMatch[1]
    if (encodedCode === undefined) {
      sendJson(res, 400, { error: "invalid_code" })
      return
    }
    await handleRoomPage(service, daemon, hasStoredRender, res, encodedCode)
    return
  }

  const stateMatch = /^\/r\/([^/]+)\/state$/.exec(url.pathname)
  if (stateMatch !== null && req.method === "OPTIONS") {
    sendCorsPreflight(res)
    return
  }
  if (stateMatch !== null && req.method === "GET") {
    setPublicCorsHeader(res)
    const encodedCode = stateMatch[1]
    if (encodedCode === undefined) {
      sendJson(res, 400, { error: "invalid_code" })
      return
    }
    await handleRoomState(service, daemon, getStoredRender, res, encodedCode)
    return
  }

  const streamMatch = /^\/rooms\/([^/]+)\/stream$/.exec(url.pathname)
  if (streamMatch !== null && req.method === "GET") {
    const encodedCode = streamMatch[1]
    if (encodedCode === undefined) {
      sendJson(res, 400, { error: "invalid_code" })
      return
    }
    await handleRoomStream(service, req, res, encodedCode, parseSince(url.searchParams.get("since")))
    return
  }

  const outboxMatch = /^\/rooms\/([^/]+)\/outbox$/.exec(url.pathname)
  if (outboxMatch !== null && req.method === "GET") {
    const encodedCode = outboxMatch[1]
    if (encodedCode === undefined) {
      sendJson(res, 400, { error: "invalid_code" })
      return
    }
    await handleRoomOutbox(service, req, res, encodedCode, parseSince(url.searchParams.get("since")), url.searchParams.has("since"))
    return
  }

  const aguiMatch = /^\/rooms\/([^/]+)\/agui$/.exec(url.pathname)
  if (aguiMatch !== null && req.method === "POST") {
    const encodedCode = aguiMatch[1]
    if (encodedCode === undefined) {
      sendJson(res, 400, { error: "invalid_code" })
      return
    }
    await handleRoomAgui(service, req, res, encodedCode)
    return
  }

  const cursorMatch = /^\/rooms\/([^/]+)\/outbox\/cursor$/.exec(url.pathname)
  if (cursorMatch !== null && req.method === "POST") {
    const encodedCode = cursorMatch[1]
    if (encodedCode === undefined) {
      sendJson(res, 400, { error: "invalid_code" })
      return
    }
    await handleRoomCursorAck(service, req, res, encodedCode)
    return
  }

  const claimMatch = /^\/rooms\/([^/]+)\/claim$/.exec(url.pathname)
  if (claimMatch !== null && req.method === "POST") {
    const encodedCode = claimMatch[1]
    if (encodedCode === undefined) {
      sendJson(res, 400, { error: "invalid_code" })
      return
    }
    await handleRoomClaim(service, req, res, encodedCode)
    return
  }

  const sendMatch = /^\/rooms\/([^/]+)\/send$/.exec(url.pathname)
  if (sendMatch !== null && req.method === "POST") {
    const encodedCode = sendMatch[1]
    if (encodedCode === undefined) {
      sendJson(res, 400, { error: "invalid_code" })
      return
    }
    await handleRoomSend(service, req, res, encodedCode)
    return
  }

  const roomMatch = /^\/rooms\/([^/]+)$/.exec(url.pathname)
  if (roomMatch !== null && req.method === "GET") {
    const encodedCode = roomMatch[1]
    if (encodedCode === undefined) {
      sendJson(res, 400, { error: "invalid_code" })
      return
    }
    handleGetRoom(service, hasStoredRender, res, encodedCode)
    return
  }

  sendJson(res, 404, { error: "not_found" })
}

/** Injectable daemon connection for the state route's busy lookup
 *  (`GET /sessions/:id`'s `busy` field). Defaults to the process env's
 *  daemon; tests point it at a fake daemon. */
export interface HttpStateHooks {
  daemon?: DaemonExtraOptions
}

export function createHttpServer(service: RoomService, mediaHooks?: HttpMediaHooks, stateHooks?: HttpStateHooks): Server {
  const dedup = new MessageDedup()
  const media = resolveMediaIngress(mediaHooks)
  const daemon: DaemonExtraOptions =
    stateHooks?.daemon ?? { baseUrl: env.daemonUrl, token: env.daemonToken }
  const hasStoredRender = (code: string) => media.renders.hasOrLoad(code)
  const getStoredRender = (code: string) => media.renders.getOrLoad(code)
  const mcpCanvakit = createMcpCanvakitHandler({
    ...defaultMcpCanvakitDeps(media.renders),
    roomExists: (code) => service.getRoom(code) !== undefined,
    rooms: () => service.listRooms(),
    // BRIEF-15: the SAME engine `say`/`whisper`/`system` go through, so a
    // render announcement inherits the cursor, the per-member scoping and
    // the gap marker instead of re-deriving them on a side channel.
    recordToolCall: async (code, toolName, args) => {
      await service.deliveryEngine.recordToolCall(code, toolName, args)
    },
  })
  const mcpRoom = createMcpRoomHandler({
    rooms: () => service.listRooms(),
    deliveries: service.deliveryEngine,
    // The SAME lookup `GET /r/:code/state` answers from, deliberately: the
    // agent's `room_view` and the members' page must never disagree about
    // whether a document exists.
    storedRender: getStoredRender,
  })
  const mcpPersonal = createMcpPersonalHandler({
    rooms: () => service.listRooms(),
    findByAddress: (address) => service.findByAddress(address),
    // BRIEF-19: `rendezvous_send` is THE inbound path, not a second one —
    // the same `handleInbound` a Telegram webhook and `/inbound/simulated`
    // call, so a message sent from the roster panel is fanned in, attributed,
    // suffixed and outboxed by exactly the code a real message is.
    sendInbound: (input) => service.handleInbound(input),
  })
  return createServer((req, res) => {
    handle(service, dedup, media, daemon, mcpCanvakit, mcpRoom, mcpPersonal, hasStoredRender, getStoredRender, req, res).catch(
      (error: unknown) => {
        if (!res.headersSent) {
          sendJson(res, 500, {
            error: "internal_error",
            message: error instanceof Error ? error.message : String(error),
          })
        }
      },
    )
  })
}

export function startHttpServer(service: RoomService, stateHooks?: HttpStateHooks): Server {
  const server = createHttpServer(service, undefined, stateHooks)
  server.listen(env.port)
  return server
}
