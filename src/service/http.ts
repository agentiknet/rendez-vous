import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { MessageDedup, parseAgentpushWebhook, parseEmailInbound } from "../channels/index.ts"
import type { TranscriptRecord } from "../daemon/records.ts"
import { env } from "../env.ts"
import { joinLinks } from "../links/index.ts"
import type { Room, Tier } from "../rooms/types.ts"
import { renderRoomNotFoundPage, renderRoomPage } from "../web/page.ts"
import { proxyArtifact, publicArtifactUrl } from "./artifact-proxy.ts"
import type { RoomService } from "./room-service.ts"

/** The `Room` shape handed to any client-facing surface — the JSON API and
 *  the page's server-side embed alike: the raw box `artifactUrl` swapped for
 *  the stable, room-code-keyed proxy URL, so the raw e2b URL never reaches a
 *  browser (architecture.md §9.3b; mirrors `RoomService`'s own
 *  `memberFacingArtifactUrl` for messenger/email replies). */
function toPublicRoom(room: Room): Room {
  if (room.artifactUrl === undefined) return room
  return { ...room, artifactUrl: publicArtifactUrl(room.code) }
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

  const outcome = await service.handleInbound({
    address: { provider, source, contactRef },
    displayName,
    tier,
    text,
  })
  sendJson(res, 200, outcome)
}

function handleGetRoom(service: RoomService, res: ServerResponse, encodedCode: string): void {
  const code = decodeURIComponent(encodedCode)
  const room = service.getRoom(code)
  if (room === undefined) {
    sendJson(res, 404, { error: "not_found" })
    return
  }
  sendJson(res, 200, toPublicRoom(room))
}

async function handleHealth(service: RoomService, res: ServerResponse): Promise<void> {
  const rooms = service.roomCount()
  const daemon = await service.daemonHealth()
  sendJson(res, 200, { status: "ok", rooms, daemon })
}

function handleRoomPage(service: RoomService, res: ServerResponse, encodedCode: string): void {
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
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  res.end(renderRoomPage(toPublicRoom(room), links))
}

/** `GET /r/:code/artifact/` and `GET /r/:code/artifact/*` — the stable,
 *  room-code-keyed URL members are actually given (architecture.md §9.3b,
 *  `publicArtifactUrl`). A room with no `artifactUrl` yet is handed to
 *  `proxyArtifact` the same as an unreachable upstream: both self-heal with
 *  the same refreshing 503 page, so this route never needs its own 404 for
 *  "no artifact". An unknown room code, though, is a 404 — there is nothing
 *  to self-heal toward. */
async function handleRoomArtifact(
  service: RoomService,
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
  await proxyArtifact({ artifactUrl: room.artifactUrl, method: req.method, subPath, search }, res)
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
  if (displayName === undefined || text === undefined || displayName.trim().length === 0 || text.trim().length === 0) {
    sendJson(res, 400, { error: "invalid_body" })
    return
  }

  const outcome = await service.sendFromRoomWeb(code, displayName, text)
  if (outcome.kind === "unknown-code") {
    sendJson(res, 404, { error: "not_found" })
    return
  }
  if (outcome.kind === "no-session") {
    sendJson(res, 409, { error: "no_session" })
    return
  }
  if (outcome.kind === "delivered") {
    sendJson(res, 200, { delivered: true, text: outcome.text })
    return
  }
  sendJson(res, 200, outcome.result)
}

/** `GET /r/:code/media/:id` (docs/DELIVERABLE.md) — the link every delivery
 *  preview points at. An unknown room or media id both 404; there is
 *  nothing to self-heal toward the way a momentarily-dead artifact box is
 *  (`handleRoomArtifact`) — a rendered PDF that's gone is gone. */
async function handleRoomMedia(
  service: RoomService,
  res: ServerResponse,
  encodedCode: string,
  encodedId: string,
): Promise<void> {
  const code = decodeURIComponent(encodedCode)
  const id = decodeURIComponent(encodedId)
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

  const outcome = await service.handleInbound({
    address: { provider: envelope.provider, source: envelope.source, contactRef: envelope.contactRef },
    displayName: envelope.displayName,
    tier: "messenger",
    text: envelope.text,
  })
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
    text: envelope.text,
  })
  sendJson(res, 200, outcome)
}

async function handle(service: RoomService, dedup: MessageDedup, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1")

  if (url.pathname === "/health" && req.method === "GET") {
    await handleHealth(service, res)
    return
  }

  if (url.pathname === "/inbound/simulated" && req.method === "POST") {
    await handleInboundSimulated(service, req, res)
    return
  }

  if (url.pathname === "/inbound/agentpush" && req.method === "POST") {
    await handleAgentpushWebhook(service, dedup, req, res)
    return
  }

  if (url.pathname === "/inbound/agentpush-mail" && req.method === "POST") {
    await handleAgentpushMailWebhook(service, dedup, req, res)
    return
  }

  const artifactMatch = /^\/r\/([^/]+)\/artifact(\/.*)?$/.exec(url.pathname)
  if (artifactMatch !== null && (req.method === "GET" || req.method === "HEAD")) {
    const encodedCode = artifactMatch[1]
    if (encodedCode === undefined) {
      sendJson(res, 400, { error: "invalid_code" })
      return
    }
    await handleRoomArtifact(service, req, res, encodedCode, artifactMatch[2] ?? "", url.search)
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
    await handleRoomMedia(service, res, encodedCode, encodedId)
    return
  }

  const pageMatch = /^\/r\/([^/]+)$/.exec(url.pathname)
  if (pageMatch !== null && req.method === "GET") {
    const encodedCode = pageMatch[1]
    if (encodedCode === undefined) {
      sendJson(res, 400, { error: "invalid_code" })
      return
    }
    handleRoomPage(service, res, encodedCode)
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
    handleGetRoom(service, res, encodedCode)
    return
  }

  sendJson(res, 404, { error: "not_found" })
}

export function createHttpServer(service: RoomService): Server {
  const dedup = new MessageDedup()
  return createServer((req, res) => {
    handle(service, dedup, req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error", message: error instanceof Error ? error.message : String(error) })
      }
    })
  })
}

export function startHttpServer(service: RoomService): Server {
  const server = createHttpServer(service)
  server.listen(env.port)
  return server
}
