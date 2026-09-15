/**
 * The room's audience tools, exposed to the sandbox agent as MCP over HTTP.
 *
 * A deliberate sibling of `mcp-canvakit.ts` — same shape, same reasoning: a
 * tool with a return value beats a text marker the agent cannot verify. The
 * markers it starts to replace ([[to]], [[whisper]]) resolve members by
 * display NAME and have no return value, so an agent never learns a target
 * was wrong. `roster` is the first tool: it hands the agent the room's
 * members as ids and surfaces, so step 2's `say`/`whisper` can address by
 * `member_id` — ids that never collide, unlike names.
 *
 * Why HTTP and not stdio: same as canvakit — the box has no tool back into
 * this service, so the endpoint lives here and the box reaches it over the
 * public tunnel (`env.publicUrl`) as a real MCP server mounted on the room's
 * agent session (`DaemonClient.spawnAgent`'s `mcpServers`). Local rooms
 * (no sandbox) get the same server over this service's own loopback address
 * (`localRoomMcpServer`), so the test harness exercises the tool path exactly
 * as production does.
 *
 * Auth: a per-room HMAC bearer token (`roomAudienceToken`, derived from
 * `env.roomTokenSecret` and the room code), recomputed per call so there is
 * no shared mutable state. The token binds a call to its room: a token for
 * room A cannot list room B's members.
 *
 * HARD RULE on return values (PLAN §3.1b): every tool result and error
 * string on this server carries member ids, booleans and counts — NEVER
 * message text, never a fragment of it. `STREAM_KINDS` already forwards
 * `tool-result` records to the room web page (src/service/http.ts) and the
 * page renders the result to 200 chars (src/web/page.ts), so anything a
 * result echoes is projected on the shared screen every member is watching.
 * `roster` has no message text to leak; the `say`/`whisper`/`ask` tools that
 * land on top of this file MUST inherit the rule — an unknown-id error says
 * `unknown member id: m7`, never what was being sent to m7.
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import { env } from "../env.ts"
import {
  listAudience,
  parseAudienceSendArgs,
  resolveTargets,
  sendAudience,
  type AudienceSendBackend,
  type AudienceSendOutcome,
} from "../audience/contract.ts"
import type { MessageRef, Room } from "../rooms/types.ts"
import { sendReachedNobody } from "./post-turn-assertions.ts"
import { roomViewHtml } from "./room-view.html.ts"
import type { McpResponse, McpServerMount } from "./mcp-canvakit.ts"
import type { TtsProvider } from "../media/openai.ts"
import type { SpeechMediaStore } from "../markers.ts"
import { parseSpeech, renderSpeech } from "../markers.ts"
import { attachmentUrl, kindAndMimeFor, parseAttachments, sanitizeName } from "../fanout/attach.ts"
import { publicArtifactUrl } from "./artifact-proxy.ts"
import type { OutboundAttachment } from "./transports.ts"
import type { MessageActionOutcome } from "./member-send.ts"

/** The delivery half of the audience tools (PLAN §3.2): the `say`/`whisper`
 *  handlers below only ACCEPT — validation, `pending` `Delivery` records and
 *  the actual provider sends live in the engine, off the agent's turn.
 *  Injectable so tests can run the tools against a real engine and a fake
 *  transport.
 *
 *  Since the contract step (PLAN-02 §5 step 6, Option C) this is the
 *  contract's `AudienceSendBackend`: the tool surface owns NOTHING but the
 *  MCP envelope — the shapes, the validation, the outcome vocabulary and
 *  the semantics live in src/audience/contract.ts, and a second
 *  implementation (daemon builtin, HTTP driver) can consume the contract
 *  without ever hearing of MCP. `DeliveryEngine` satisfies this
 *  structurally. */
export type McpRoomDeliveries = AudienceSendBackend

/** The per-room bearer token for `POST /mcp/room`. Deterministic in the
 *  secret, so the booter can compute the mount's header at spawn time and
 *  the endpoint can recompute it per call with no shared mutable state.
 *  40 hex chars — same budget as `roomRenderToken`. The `audience:` label
 *  differs from canvakit's `render:` so a leaked token grants exactly one
 *  capability, never both. */
export function roomAudienceToken(code: string, secret: string): string {
  return createHmac("sha256", secret).update(`audience:${code}`).digest("hex").slice(0, 40)
}

/** The per-member bearer token for `GET /rooms/:code/outbox` (PLAN-02
 *  §3-D3), same family as `roomAudienceToken` above and `roomRenderToken`:
 *  HMAC over the room's `roomTokenSecret`, 40 hex chars, deterministic in
 *  the secret so it is recomputed per request — never stored, never
 *  handed to the agent. `memberId`s are public within the room (the roster
 *  hands them to the agent), so they can never authorize anything; this
 *  token can.
 *
 *  Revocation is per room only (rotating the room's secret), and identity is
 *  a display name typed into a public page — the impersonation risk D3
 *  records and does not solve. */
export function memberToken(code: string, memberId: string, secret: string): string {
  return createHmac("sha256", secret).update(`member:${code}:${memberId}`).digest("hex").slice(0, 40)
}

/**
 * The token rides in BOTH the `authorization` header and a `?t=` query
 * parameter, and the endpoint accepts either.
 *
 * The header is the right way and stays. The query parameter exists because
 * the header does not survive the trip: observed live on 2026-09-12, every
 * MCP request arriving from an e2b box carried `auth=no` (the
 * `logMcpRequest` line in src/service/http.ts). The host daemon does forward
 * the mount's `headers` to the box (`toMcpServerMounts`,
 * agentproto/ts/packages/runtime/src/session-spawn.ts), so the loss is
 * further down — the box daemon or the ACP client — and it is why the
 * canvakit mount had never once worked from a box either.
 *
 * A bearer in a URL is weaker hygiene than a header: URLs end up in logs and
 * referrers. Accepted deliberately here because the tunnel is ours, the token
 * grants exactly one room's audience and nothing else, and the alternative is
 * a capability that does not function at all. Remove the query arm the day
 * the header survives the box.
 */
function roomMcpMount(code: string, base: string): McpServerMount {
  const token = roomAudienceToken(code, env.roomTokenSecret)
  return {
    name: "room",
    transport: "http",
    ref: `${base}/mcp/room?t=${token}`,
    headers: { authorization: `Bearer ${token}` },
  }
}

/** The room-scoped mount the e2b booter passes to the daemon, reaching this
 *  endpoint through the public tunnel like canvakit's does. */
export function roomMcpServer(code: string): McpServerMount {
  return roomMcpMount(code, env.publicUrl)
}

/** The same mount for LOCAL rooms (no sandbox, no tunnel): the box-less
 *  agent session runs on this host, so the ref points at this service's own
 *  loopback address rather than `env.publicUrl`, which may name a tunnel the
 *  local daemon has no reason to leave the machine for. `env.port` is the
 *  port this service actually listens on (src/env.ts) — no new env knob. */
export function localRoomMcpServer(code: string): McpServerMount {
  return roomMcpMount(code, `http://127.0.0.1:${env.port}`)
}

/** Injectable room lookup, so tests can prove auth/roster behaviour without
 *  a real store — and so the room-binding test can scope a server instance
 *  to room B alone and watch room A's token bounce off it. */
export interface McpRoomDeps {
  /** All rooms this endpoint can serve, read fresh per call: membership
   *  changes between calls must be visible to the next `roster`. */
  readonly rooms: () => readonly Room[]
  /** The delivery engine behind `say`/`whisper`. Omitting it leaves the
   *  tools unadvertised and uncallable — the step-1 surface, unchanged. */
  readonly deliveries?: McpRoomDeliveries
  /** The stored-render lookup behind `room_view`'s `artifact` fact. Omitting
   *  it makes `room_view` report `artifact.rendered: false` — which is why
   *  it is wired at every real call site: the spectator page and the agent
   *  must not disagree about whether a document exists. */
  readonly storedRender?: (code: string) => Promise<{ readonly renderedAt: string } | undefined>
  /** BRIEF-23: the sink behind `recover_identity`. It resolves the member
   *  server-side, mints the one-time link and sends it to that member's own
   *  surface; the tool only ever learns a status, never the URL (file-top
   *  HARD RULE). A narrow status union rather than the service's outcome
   *  type keeps this adapter free of a `room-service` import cycle
   *  (`room-service` imports `memberToken`/`tokensMatch` from here).
   *  Omitting it leaves `recover_identity` unadvertised and uncallable. */
  readonly recoverIdentity?: (
    code: string,
    memberId: string,
  ) => Promise<"accepted" | "no-surface" | "conflict" | "unknown">
  /** TTS provider for rendering `[[say …]]` markers inside say/whisper
   *  calls. Both `tts` and `mediaStore` must be set for audio to be
   *  produced; when either is absent the spoken words are delivered as
   *  text. */
  readonly tts?: TtsProvider
  readonly mediaStore?: SpeechMediaStore
  /** BRIEF-10 step 2: the outbox recorder behind `room_view`'s announcement.
   *  The same dep `mcp-canvakit.ts` takes for `render_artifact`, for the same
   *  reason — the announcement rides the real engine, which already mints for
   *  PULL members only (`DeliveryEngine.recordToolCall`'s tier filter lives at
   *  the mint, so this surface cannot get it wrong). Omitting it leaves
   *  `room_view` exactly as the step-1 surface: announced to nobody, which —
   *  unlike a record minted for a member with no surface — claims nothing. */
  readonly recordToolCall?: (code: string, toolName: string, args: unknown) => Promise<void>
  /** BRIEF-48 (docs/REACT-REPLY.md §2): the citable-message tail behind
   *  `room_view`'s `recent_messages` — the one place the agent can learn a
   *  message HANDLE, because tool results here are agent-only (the member
   *  never sees them; the attribution line is deliberately untouched). The
   *  refs carry ids, directions and timestamps, never message text (the
   *  file-top HARD RULE). Omitting it leaves `room_view` exactly its
   *  pre-BRIEF-48 shape — no `recent_messages` key at all. */
  readonly recentMessages?: (code: string) => readonly MessageRef[]
  /** Deliver a voice-note attachment (the result of rendering a `[[say …]]`
   *  marker inside a say/whisper call) to one member. When absent, spoken
   *  words from markers are included in the delivery text instead. */
  readonly deliverAttachment?: (
    code: string,
    memberId: string,
    attachment: OutboundAttachment,
  ) => Promise<void>
  /** BRIEF-47: the sink behind `send_file`, the typed path beside the
   *  `[[attach …]]` marker. The SAME sink `deliverAttachment` is in
   *  production — `RoomService.deliverAttachment` → `MemberSender
   *  .sendAttachment` → `DeliveryEngine.accept` → `attempt` — so a file
   *  sent by the tool crosses the exact machinery a marker's file crosses,
   *  probe and honest-failure arms included. Omitting it leaves `send_file`
   *  unadvertised and uncallable. */
  readonly sendFile?: (
    code: string,
    memberId: string,
    attachment: OutboundAttachment,
  ) => Promise<void>
  /** BRIEF 49: the sinks behind `react` and `reply`. Each resolves the
   *  handle server-side (RoomStore.resolveMessageRef), draws the
   *  capability line from the member's own channel, and — only when the
   *  handle resolves AND the channel can do the act — mints the record
   *  through the engine, so the send crosses `attempt` like everything
   *  else. The outcome union's named arms are the whole agent-facing
   *  contract; the tool below only maps them onto the wire. Omitting one
   *  leaves that tool unadvertised and uncallable. */
  readonly reactMessage?: (code: string, handle: string, emoji: string) => Promise<MessageActionOutcome>
  readonly replyToMessage?: (code: string, handle: string, text: string) => Promise<MessageActionOutcome>
}

// --- JSON-RPC / MCP wire handling: same hand-rolled surface as canvakit's
// (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`),
// for the same reason — no SDK dependency for three methods. ----

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602

/** The MCP Apps resource this server serves (spec `2026-01-26`,
 *  `modelcontextprotocol/ext-apps`): a host that recognises it renders
 *  `room_view`'s tool as a panel instead of (or alongside) its text result. */
const ROOM_VIEW_RESOURCE_URI = "ui://room_view/view"

/** The roster tool. NO arguments: the room is fixed by the bearer token,
 *  and an argument naming a room would be a way to address another room —
 *  exactly what the token exists to prevent. */
const ROSTER_TOOL = {
  name: "roster",
  description:
    "List the members of THIS room (fixed by your credentials — no argument). One entry per member: member_id (use this to address them — display names can collide and change), display_name (for prose only), surface (the channel they are on: telegram, whatsapp, email, room-web), tier (messenger/email/room-web — a room-web member is a screen, not a phone), mode (push = a phone whose provider holds the address for them; pull = a screen that drains its outbox from the room), joined_at, presence/away (away = a room-web member whose tab has not drained its outbox for over 90 seconds — nobody is there; do not address them and do not expect an answer; the member itself is NOT gone — its id stays valid). Re-read it when you need to address someone; do not cache ids across turns — a messenger/email member who leaves and rejoins gets a new id (a room-web member's id is stable across its tab closing and reopening).",
  inputSchema: { type: "object", properties: {} },
} as const

/** The `room_view` tool (BRIEF-01). NO arguments, same reasoning as
 *  `roster`: the room is fixed by the bearer, and an argument naming a room
 *  would address another one. It is the SPECTATOR projection only (D1) — no
 *  whisper, no addressed traffic, nothing `memberToken` would gate — so it
 *  needs no `deliveries` dependency and is always advertised, unlike
 *  `say`/`whisper` below.
 *
 *  `_meta.ui.resourceUri` is carried BOTH here (the `tools/list` definition)
 *  AND on the `tools/call` result (`roomViewResult`) — deliberately
 *  redundant. Hosts differ on which one they read: the sibling
 *  `agentik-studio` monorepo's `@agstudio/mcp-apps` puts it on the
 *  definition only, because Mastra 1.11 JSON-stringifies handler results and
 *  a result-level `_meta` is invisible there. This server is hand-rolled —
 *  we own the envelope on both ends, so satisfying both readings costs
 *  nothing and breaks no host either way. */
const ROOM_VIEW_TOOL = {
  name: "room_view",
  description:
    "Render THIS room as a live panel for whoever is looking at this conversation. It shows the SHARED view every member and spectator can already see — code, state, roster, artifact — and nothing private: no whispers, no addressed traffic. The text result reports whether a document is currently rendered (`artifact.rendered` and `artifact.rendered_at`) but NOT its contents: if `rendered` is true, say so — the humans are already looking at it — and do not claim nothing has been rendered. When the result carries `recent_messages`, each entry is a citable message: `handle` (quote it verbatim when asked to react to or reply to a specific message — a handle you invent is refused), `member_id` (who sent/received it), `direction` (`inbound` = a member's message, `outbound` = something the room sent), `channel` and `created_at`. Handles are for YOU only — never mention them to members; correlate a transcript line to a handle by its member_id and recency.",
  inputSchema: { type: "object", properties: {} },
  _meta: { ui: { resourceUri: ROOM_VIEW_RESOURCE_URI } },
} as const

/** `say` — address members BY ID (PLAN §3.1). `to` omitted means every
 *  member, explicitly — never a default-by-omission that silently becomes
 *  broadcast when the agent mangles an id. An id that matches nobody goes
 *  into the result's `unknown` and the text is delivered to NOBODY — the
 *  opposite of the old markers' fall-back-to-broadcast. */
const SAY_TOOL = {
  name: "say",
  description:
    "Send a message to one or more members of THIS room, addressed by member_id (from roster). Pass `to` as an array of member_id values, or omit `to` to send to every member. Returns immediately with {accepted, unknown}: accepted means accepted for delivery, not delivered; an unknown member_id is reported in `unknown` and receives nothing — re-read the roster and retry if an id came back unknown.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The message to send." },
      to: { type: "array", items: { type: "string" }, description: "member_id values from roster. Omit for every member." },
    },
    required: ["text"],
  },
} as const

/** `whisper` — confidential, so the room is TOLD it happened (the
 *  content-free "(the agent whispered to X)" notice), exactly like the
 *  `[[whisper]]` marker it starts to replace. */
const WHISPER_TOOL = {
  name: "whisper",
  description:
    "Send a private message to exactly ONE member of THIS room by member_id (from roster). Everyone else is told a whisper happened, but not its content. Returns {accepted, unknown}: an unknown member_id delivers nothing to nobody — re-read the roster and retry.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The private message to send." },
      to: { type: "string", description: "The member_id to whisper to, from roster." },
    },
    required: ["text", "to"],
  },
} as const

/** `send_file` (BRIEF-47) — the typed replacement for `[[attach …]]`, living
 *  BESIDE it for now: the marker parser stays, and both paths deliver.
 *  `file` is a path relative to the served artifact directory (sanitized
 *  exactly as the marker parser sanitizes — `..` dropped outright, no
 *  spaces). The tool result means ACCEPTED, never delivered: the file is
 *  minted as a `kind: "attachment"` record through the same engine the
 *  marker path uses, and THAT engine's URL probe decides whether anything
 *  is ever handed to a provider. A file that is not actually being served
 *  is never delivered — the agent is corrected, the member told the file
 *  never went — because the tool rides the same `attempt` everything else
 *  rides, not a second probe. */
const SEND_FILE_TOOL = {
  name: "send_file",
  description:
    "Send a file to members of THIS room as a real attachment. `file` is the path you wrote it to, relative to the served artifact directory (no spaces, no directory traversal — the path the [[attach …]] marker would name); `caption` optional; `to` an array of member_id values from roster, or omitted to send to every member. Returns immediately with {accepted, file, recipients, unknown}: `accepted` is a boolean and means accepted FOR DELIVERY, not delivered — a file that is not actually being served is never delivered to anyone; you will be told and the members are told the file never went. `recipients` lists the member_ids the file was accepted for. An unknown member_id receives nothing and is reported in `unknown`.",
  inputSchema: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description: "Path relative to the served artifact directory, e.g. report.pdf. No spaces, no `..`.",
      },
      caption: { type: "string", description: "Optional one-line caption sent with the file." },
      to: {
        type: "array",
        items: { type: "string" },
        description: "member_id values from roster. Omit for every member.",
      },
    },
    required: ["file"],
  },
} as const

/** `recover_identity` (BRIEF-23) — the one way back for a member whose own
 *  name refuses them because the browser that held the claim secret is gone.
 *  The link is minted and sent server-side to that member's OWN proven
 *  surface; the agent names WHO, never where, so it can never hand the
 *  capability to an address it chose. The result carries ids/status only —
 *  never the URL: `tools/call` results are projected on the room's shared
 *  screen (file-top HARD RULE), and a capability shown to the room is a
 *  capability given to the room. */
/** `react` (BRIEF 49, docs/REACT-REPLY.md §3) — react to a message the
 *  agent CITES by handle (from `room_view`'s `recent_messages`). The tool
 *  resolves the handle server-side and refuses namedly when it does not
 *  (`unknown-message-handle`: unknown, pruned, expired, or another room's)
 *  and separately when the member's channel cannot react
 *  (`channel-cannot-react`: whatsapp and telegram only — mail/sms/room-web
 *  are refused, never degraded into a text "👍"). `emoji: ""` removes a
 *  reaction previously placed. The result means ACCEPTED FOR DELIVERY,
 *  never delivered — and the same `send_file`-family vocabulary. */
const REACT_TOOL = {
  name: "react",
  description:
    "React with an emoji to a specific message of THIS room, cited by its `handle` (from room_view's recent_messages — a handle you invent is refused). `emoji` is the emoji, or an empty string \"\" to REMOVE a reaction you placed. Only whatsapp and telegram members can receive reactions: for any other channel the call is refused with reason \"channel-cannot-react\" and NOTHING is sent — never send the emoji as a text instead. An unresolvable handle is refused with reason \"unknown-message-handle\" and nothing is sent. Returns {accepted, handle, recipients} or {accepted: false, reason, ...}: accepted means accepted for delivery, not delivered.",
  inputSchema: {
    type: "object",
    properties: {
      handle: { type: "string", description: "The message handle to react to, verbatim from room_view's recent_messages." },
      emoji: { type: "string", description: "The reaction emoji (e.g. \"👍\"), or \"\" to remove a reaction." },
    },
    required: ["handle", "emoji"],
  },
} as const

/** `reply` (BRIEF 49) — answer a specific message the agent CITES by its
 *  handle, threaded: the room resolves the handle to the provider's native
 *  id and the send quotes it (WhatsApp/Telegram natively; mail threads
 *  server-side). Refusals mirror `react` — an unresolvable handle is
 *  `unknown-message-handle`, a channel without a reply concept (sms,
 *  room-web) is `channel-cannot-react` — and nothing is ever minted or
 *  sent for either. */
const REPLY_TOOL = {
  name: "reply",
  description:
    "Reply to a specific message of THIS room, cited by its `handle` (from room_view's recent_messages — a handle you invent is refused), with the reply threaded onto the original (the member sees it quoted). `text` is the reply. Threads on whatsapp, telegram and email; another channel is refused with reason \"channel-cannot-react\" — send an ordinary `say` there instead. An unresolvable handle is refused with reason \"unknown-message-handle\" and nothing is sent. Returns {accepted, handle, recipients} or {accepted: false, reason, ...}: accepted means accepted for delivery, not delivered.",
  inputSchema: {
    type: "object",
    properties: {
      handle: { type: "string", description: "The message handle to reply to, verbatim from room_view's recent_messages." },
      text: { type: "string", description: "The reply to send." },
    },
    required: ["handle", "text"],
  },
} as const

const RECOVER_TOOL = {  name: "recover_identity",
  description:
    "When a member says they cannot get back into the web page under their name — they lost their link, changed device or browser, or cleared their data — call this with their member_id (from roster). The room sends a one-time recovery link to that member's OWN surface (the one they are already talking to you on), never to anywhere else, and the link restores only their own name. Returns {accepted: true} or {accepted: false, reason}. Do not paste any link yourself and do not promise anyone a name they did not already hold: a name someone else holds stays theirs.",
  inputSchema: {
    type: "object",
    properties: {
      member_id: {
        type: "string",
        description: "member_id from roster — the member asking to get their web name back.",
      },
    },
    required: ["member_id"],
  },
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function bearerOf(authorization: string | undefined): string | undefined {
  if (authorization === undefined) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  return match?.[1]?.trim() ?? undefined
}

/** Constant-time comparison, shared with the outbox endpoint (http.ts). */
export function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8")
  const bufB = Buffer.from(b, "utf8")
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

function ok(id: string | number | null, result: Record<string, unknown>): McpResponse {
  return { status: 200, body: { jsonrpc: "2.0", id, result } }
}

function fail(id: string | number | null, code: number, message: string): McpResponse {
  return { status: 200, body: { jsonrpc: "2.0", id, error: { code, message } } }
}

function unauthorized(id: string | number | null): McpResponse {
  return {
    status: 401,
    body: {
      jsonrpc: "2.0",
      id,
      error: { code: INVALID_REQUEST, message: "unauthorized: missing or invalid bearer token for this room" },
    },
  }
}

/** Resolve the room the bearer token names: recompute the expected token per
 *  known room and compare with `timingSafeEqual`, as canvakit does. The
 *  token is not reversible, so the only honest binding is recompute-and-
 *  compare — a token for room A matches room A's recomputation and nothing
 *  else, on this endpoint or any other. */
function resolveRoom(
  deps: McpRoomDeps,
  authorization: string | undefined,
  queryToken?: string,
): Room | undefined {
  // Header first — it is the right channel. The `?t=` fallback is why this
  // works at all from a box today; see `roomMcpMount`.
  const provided = bearerOf(authorization) ?? (queryToken !== undefined && queryToken.length > 0 ? queryToken : undefined)
  if (provided === undefined) return undefined
  for (const room of deps.rooms()) {
    if (tokensMatch(provided, roomAudienceToken(room.code, env.roomTokenSecret))) return room
  }
  return undefined
}

/** The `roster` result: the contract's `listAudience` mapped onto the MCP
 *  wire. Ids and surfaces only — see the file-top HARD RULE: this result is
 *  projected on the room's shared screen.
 *
 *  Presence (brief D / contract `AudiencePresence`): a stale pull member is
 *  `away`, STILL a member, still holding its id — the agent stops
 *  addressing a ghost, the `Ecran` failure solved once; push members are
 *  never away. The wire carries BOTH the contract's `presence` union and
 *  the legacy `away` boolean: the boolean predates the contract and a live
 *  room runs against it (removing a key is a change an agent can observe),
 *  while `presence` is the shape a second implementation renders. Neither
 *  is an invitation to treat away as gone — the member stays in the
 *  roster; only its liveness claim is withdrawn. `mode` is the contract's
 *  push/pull axis, exposed since the contract step. */
function rosterResult(room: Room): Record<string, unknown> {
  const listed = listAudience(room, Date.now())
  const members = listed.members.map((member) => ({
    member_id: member.memberId,
    display_name: member.displayName,
    mode: member.mode,
    surface: member.surface,
    tier: member.tier,
    joined_at: member.joinedAt,
    presence: member.presence,
    away: member.presence === "away",
  }))
  return {
    content: [{ type: "text", text: JSON.stringify({ members, count: members.length }) }],
    isError: false,
  }
}

/** The `room_view` result (D2): ids-and-counts only, same file-top HARD
 *  RULE as `roster` — this result is projected on the room's shared screen
 *  too. `state` is normalised to the page's own vocabulary ("live"/"paused"),
 *  not the internal `RoomState` union, so the result reads the same as the
 *  panel it points at. No member name, no transcript fragment: the panel
 *  fetches its own data from the spectator endpoint instead.
 *
 *  `artifact` is a PRESENCE fact, not the document: a boolean and the
 *  render timestamp, which is ids-and-counts by the file-top HARD RULE (no
 *  title, no body — the panel and the room page render those themselves).
 *  It exists because without it the agent has no token anywhere in its
 *  context saying a document exists, and answers "nothing has been
 *  rendered" to a human who is looking at the rendered document. That is
 *  `docs/OUTBOX.md` §1 again — absence read as fact — this time about the
 *  artifact instead of a delivery.
 *
 *  `rendered` mirrors `GET /r/:code/state`'s `artifact.ready` rule for the
 *  stored-render half ONLY: a stored render counts even in a paused room,
 *  because that is exactly when a member is still looking at one. A live
 *  e2b box with no stored render is NOT claimed here — this server has no
 *  liveness probe, and claiming a box answers when we have not asked is the
 *  same defect pointed the other way. */
async function roomViewResult(
  room: Room,
  storedRender: McpRoomDeps["storedRender"],
  /** BRIEF-48: the citable-message tail, listed newest-first. Optional dep,
   *  so a harness without it leaves the result EXACTLY its pre-BRIEF-48
   *  shape — the key is genuinely absent, not present-and-empty (an empty
   *  list would claim "nothing citable", which the absence of a dep cannot
   *  know). */
  recentMessages: McpRoomDeps["recentMessages"],
): Promise<{
  result: Record<string, unknown>
  /** BRIEF-10 step 2: the summary recorded in the outbox when this view
   *  succeeds. Ids, counts and booleans ONLY — the file-top HARD RULE is
   *  doubly binding here, because delivery `text` lands in a member's
   *  transcript, so a display name recorded in it is a leak, not a
   *  projection. The shape is fixed by what a roster card can show without
   *  a migration: which room, how many members, whether a document exists. */
  summary: { roomCode: string; memberCount: number; artifactRendered: boolean }
}> {
  const render = storedRender === undefined ? undefined : await storedRender(room.code)
  const artifactRendered = render !== undefined
  // Newest-first, capped at 20: the agent correlates a transcript line it
  // just read with a handle by SENDER (member_id) and recency, so the head
  // of the tail is what is ever useful — and ids only, HARD RULE (no text).
  const messageRefs = recentMessages === undefined ? undefined : recentMessages(room.code).slice(-20).reverse()
  const result: Record<string, unknown> = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          code: room.code,
          state: room.state === "paused" ? "paused" : "live",
          member_count: room.members.length,
          artifact:
            artifactRendered
              ? { rendered: true, rendered_at: render.renderedAt }
              : { rendered: false },
          ...(messageRefs !== undefined
            ? {
                recent_messages: messageRefs.map((ref) => ({
                  handle: ref.handle,
                  member_id: ref.memberId,
                  direction: ref.direction,
                  channel: ref.channel,
                  created_at: ref.createdAt,
                })),
              }
            : {}),
        }),
      },
    ],
    isError: false,
    // Redundant with the `tools/list` definition's `_meta` — see
    // `ROOM_VIEW_TOOL`'s doc comment for why both are written.
    _meta: { ui: { resourceUri: ROOM_VIEW_RESOURCE_URI } },
  }
  return {
    result,
    summary: {
      roomCode: room.code,
      memberCount: room.members.length,
      artifactRendered,
    },
  }
}

/** The `say`/`whisper` result, from the contract's outcome: member ids and
 *  counts ONLY (file-top HARD RULE). `accepted` entries carry the id and
 *  `ok: true` — "accepted for delivery", never the text, never a
 *  per-member delivery claim, and NO confirmation field: confirmation is
 *  three-valued on the delivery record (appendix §6), and a send result
 *  that claimed `delivered: true` would be absence reading as delivery. */
function acceptResult(outcome: Extract<AudienceSendOutcome, { ok: true }>): Record<string, unknown> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          accepted: outcome.accepted.map((memberId) => ({ member_id: memberId, ok: true })),
          unknown: [...outcome.unknown],
        }),
      },
    ],
    isError: false,
  }
}

/** BRIEF 49: the `react`/`reply` result — the outcome union mapped onto
 *  the `send_file`-family vocabulary, ids and named reasons ONLY (the
 *  file-top HARD RULE). `accepted` never claims a delivery; the two
 *  refusal arms stay DISTINCT so the agent can tell "cite a real message"
 *  (`unknown-message-handle`) from "this channel cannot do it"
 *  (`channel-cannot-react`). */
function messageActionResult(outcome: MessageActionOutcome): Record<string, unknown> {
  switch (outcome.kind) {
    case "accepted":
      return {
        accepted: true,
        handle: outcome.ref.handle,
        recipients: [{ member_id: outcome.ref.memberId, ok: true }],
      }
    case "unknown-handle":
      return { accepted: false, reason: "unknown-message-handle" }
    case "member-not-in-room":
      return { accepted: false, reason: "member-not-in-room" }
    case "channel-cannot-react":
      return { accepted: false, reason: "channel-cannot-react", channel: outcome.channel }
  }
}

/**
 * Handle one JSON-RPC 2.0 request body (already JSON.parse'd) with its
 * `Authorization` header value. Canvakit's method surface
 * (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`)
 * plus `resources/list` / `resources/read` (BRIEF-01), the MCP Apps half
 * `room_view`'s panel is served from. Unknown methods are `-32601`;
 * notifications (`id` absent) get `202`.
 */
export function createMcpRoomHandler(
  deps: McpRoomDeps,
): (body: unknown, authorization: string | undefined, queryToken?: string) => Promise<McpResponse> {
  return async (body, authorization, queryToken) => {
    if (!isRecord(body) || typeof body.method !== "string") {
      return fail(null, PARSE_ERROR, "request must be a JSON-RPC 2.0 object with a method")
    }
    const method = body.method
    const id = typeof body.id === "string" || typeof body.id === "number" ? body.id : body.id === null ? null : undefined

    if (id === undefined) {
      // A notification (no id): acknowledged, no response body. Covers the
      // client's `notifications/initialized` after `initialize`.
      return { status: 202, body: undefined }
    }

    const params = isRecord(body.params) ? body.params : {}

    if (method === "initialize") {
      return ok(id, {
        protocolVersion: "2025-06-18",
        // `resources: {}` (BRIEF-01) advertises `room_view`'s panel. A host
        // that does not see this capability never calls `resources/list`,
        // so a client stuck on the plain-tools reading of this server keeps
        // working exactly as before.
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "rdv-room", version: "1.0.0" },
      })
    }

    if (method === "tools/list") {
      // `room_view` has no `deliveries` dependency (D1: it is the spectator
      // projection, never member-scoped) so it is always advertised, unlike
      // `say`/`whisper` below.
      const base = [ROSTER_TOOL, ROOM_VIEW_TOOL]
      const tools =
        deps.deliveries === undefined
          ? base
          : [
              ...base,
              SAY_TOOL,
              WHISPER_TOOL,
              ...(deps.sendFile !== undefined ? [SEND_FILE_TOOL] : []),
              ...(deps.reactMessage !== undefined ? [REACT_TOOL] : []),
              ...(deps.replyToMessage !== undefined ? [REPLY_TOOL] : []),
              ...(deps.recoverIdentity !== undefined ? [RECOVER_TOOL] : []),
            ]
      return ok(id, { tools })
    }

    if (method === "resources/list") {
      return ok(id, {
        resources: [
          { uri: ROOM_VIEW_RESOURCE_URI, name: "room_view", mimeType: "text/html;profile=mcp-app" },
        ],
      })
    }

    if (method === "resources/read") {
      // Bearer checked before the uri, same reason `tools/call` checks it
      // first: a rejected call must reveal nothing, not even that a room
      // exists.
      const room = resolveRoom(deps, authorization, queryToken)
      if (room === undefined) return unauthorized(id)

      if (params.uri !== ROOM_VIEW_RESOURCE_URI) {
        return fail(id, INVALID_PARAMS, `unknown resource uri: ${String(params.uri)}`)
      }

      return ok(id, {
        contents: [
          {
            uri: ROOM_VIEW_RESOURCE_URI,
            mimeType: "text/html;profile=mcp-app",
            text: roomViewHtml(room.code, env.publicUrl),
            // Load-bearing, not decoration: the panel polls `env.publicUrl`
            // itself, and a host that sandboxes the iframe without this
            // allowlist renders the panel once and then never updates it —
            // the exact silent-stop failure this repo exists to avoid.
            _meta: { ui: { csp: { connectDomains: [env.publicUrl] } } },
          },
        ],
      })
    }

    if (method === "tools/call") {
      // Token checked before anything else: a rejected call must reveal
      // nothing, not even that a room exists.
      const room = resolveRoom(deps, authorization, queryToken)
      if (room === undefined) return unauthorized(id)

      if (params.name === ROSTER_TOOL.name) {
        return ok(id, rosterResult(room))
      }

      if (params.name === ROOM_VIEW_TOOL.name) {
        const view = await roomViewResult(room, deps.storedRender, deps.recentMessages)
        // BRIEF-10 step 2, after the result exists — never before, so a
        // failed view cannot announce itself (the same ordering rule
        // `render_artifact`'s arm follows). Nothing here selects the
        // audience: the engine's mint is where the pull-only tier filter
        // lives, so a messenger member gets no record and the absence
        // claims nothing. Never fatal: the view succeeded and the agent
        // must be told so even if the outbox refused.
        if (deps.recordToolCall !== undefined) {
          try {
            await deps.recordToolCall(room.code, ROOM_VIEW_TOOL.name, view.summary)
          } catch (error) {
            const why = error instanceof Error ? error.message : String(error)
            console.error(`failed to record the room_view of ${room.code} in the outbox: ${why}`)
          }
        }
        return ok(id, view.result)
      }

      if (params.name === SAY_TOOL.name || params.name === WHISPER_TOOL.name) {
        const deliveries = deps.deliveries
        if (deliveries === undefined) {
          return fail(id, METHOD_NOT_FOUND, `unknown tool: ${String(params.name)}`)
        }
        // `whisper` is the contract's private send, not a separate verb:
        // same envelope, one id, and the content-free notice semantics live
        // in the contract (`whisperNoticeOf`), not in this adapter.
        const privacy = params.name === WHISPER_TOOL.name ? ("private" as const) : ("public" as const)
        const args = isRecord(params.arguments) ? params.arguments : {}
        const parsed = parseAudienceSendArgs(args, privacy)
        if ("error" in parsed) return fail(id, INVALID_REQUEST, parsed.error)
        // BRIEF-31: parse markers from the text so `[[say …]]` is stripped
        // from delivery and rendered as a voice note (or its text fallback).
        // One extractor shared with RoomFanout — never a second parser.
        // BRIEF-41: same for `[[attach …]]` — the fanout reader parses it
        // (src/fanout/reader.ts), so the tool path must too, or the marker
        // reaches members as literal text. Attachments go out to exactly the
        // members this send reached, via the same `deliverAttachment` sink
        // the voice notes use.
        const withoutAttachments = parseAttachments(parsed.input.text)
        const { text: cleanText, spoken } = parseSpeech(withoutAttachments.text)
        let textToDeliver = cleanText
        if (spoken.length > 0) {
          if (deps.deliverAttachment === undefined) {
            textToDeliver = [cleanText, ...spoken].filter((s) => s.length > 0).join("\n")
          } else if (cleanText.length === 0) {
            textToDeliver = spoken.join("\n")
          }
        }
        // BRIEF 46: `parseAttachments`/`parseSpeech` strip the marker lines
        // AFTER `parseAudienceSendArgs` validated the ORIGINAL text as
        // non-empty, so a send reduced to a single `[[attach …]]` (or
        // `[[say …]]`) marker leaves `textToDeliver === ""` — and minting a
        // say/whisper record at text "" pushed a literally empty message to
        // the provider. The fanout path is immune (a marker-only turn mints
        // no text record, reader.ts's `buffer.length > 0`); the tool path
        // matches it now: an empty remainder mints NO text record, while
        // the attachments (and voice notes) still go to exactly the
        // audience the send resolved — the tool result keeps reporting the
        // honest accepted/unknown split.
        let outcome: AudienceSendOutcome
        if (textToDeliver.length > 0) {
          outcome = await sendAudience(room, deliveries, { ...parsed.input, text: textToDeliver })
        } else {
          const targets = resolveTargets(room, parsed.input.to)
          const known = new Set(room.members.map((member) => member.id))
          const accepted = targets.filter((id) => known.has(id))
          outcome = {
            ok: true,
            accepted,
            unknown: targets.filter((id) => !known.has(id)),
          }
        }
        if (!outcome.ok) return fail(id, INVALID_REQUEST, `unroutable delivery: ${outcome.message}`)
        if (withoutAttachments.attachments.length > 0 && outcome.accepted.length > 0 && deps.deliverAttachment !== undefined) {
          const artifactBase = publicArtifactUrl(room.code)
          for (const memberId of outcome.accepted) {
            for (const parsedAttachment of withoutAttachments.attachments) {
              const attachment: OutboundAttachment = {
                url: attachmentUrl(artifactBase, parsedAttachment.name),
                filename: parsedAttachment.name,
                mimeType: parsedAttachment.mimeType,
                kind: parsedAttachment.kind,
                caption: parsedAttachment.caption,
              }
              await deps.deliverAttachment(room.code, memberId, attachment)
            }
          }
        }
        if (spoken.length > 0 && outcome.accepted.length > 0 && deps.deliverAttachment !== undefined) {
          const notes = await renderSpeech(room.code, spoken, deps.tts, deps.mediaStore)
          for (const memberId of outcome.accepted) {
            for (const note of notes) {
              await deps.deliverAttachment(room.code, memberId, note)
            }
          }
        }
        // Assertion 2 (BRIEF-15, post-turn-assertions): every id the agent
        // explicitly named was unknown, so the send reached nobody — a fact
        // already in `outcome`, nothing new computed. Observed, never
        // corrected: the tool result below still reports the honest
        // `accepted: []` back to the agent unchanged.
        if (sendReachedNobody(outcome)) {
          console.warn(
            `post-turn assertion violated: "send-reached-nobody" in room ${room.code} — ` +
              `a ${privacy === "private" ? "whisper" : "say"} named ${outcome.unknown.length} member id(s) ` +
              `and none matched anyone in the room: ${outcome.unknown.join(", ")}`,
          )
        }
        return ok(id, acceptResult(outcome))
      }

      if (params.name === SEND_FILE_TOOL.name) {
        const sendFile = deps.sendFile
        if (sendFile === undefined) {
          return fail(id, METHOD_NOT_FOUND, `unknown tool: ${String(params.name)}`)
        }
        const args = isRecord(params.arguments) ? params.arguments : {}
        const file = args.file
        if (typeof file !== "string" || file.trim().length === 0) {
          return fail(id, INVALID_REQUEST, "invalid arguments: send_file requires a `file` path")
        }
        // Sanitized exactly as the marker parser sanitizes (sanitizeName):
        // `..` dropped outright, the URL is fetched by a third party.
        const name = sanitizeName(file)
        if (name === undefined) {
          // A normal, honest return — ids and booleans only (HARD RULE):
          // nothing minted, nobody notified, nothing probed.
          return ok(id, {
            content: [{ type: "text", text: JSON.stringify({ accepted: false, reason: "invalid-path" }) }],
            isError: false,
          })
        }
        const captionArg = args.caption
        const caption = typeof captionArg === "string" && captionArg.trim().length > 0 ? captionArg.trim() : undefined
        const to = args.to
        let targets: readonly string[]
        if (to === undefined) {
          targets = room.members.map((member) => member.id)
        } else if (Array.isArray(to) && to.every((item) => typeof item === "string")) {
          const ids: string[] = []
          for (const item of to) {
            if (typeof item === "string" && item.trim().length > 0) ids.push(item.trim())
          }
          targets = ids
        } else {
          return fail(id, INVALID_REQUEST, "invalid arguments: send_file's `to` must be an array of member_id strings (from roster)")
        }
        const known = new Set(room.members.map((member) => member.id))
        const accepted = targets.filter((memberId) => known.has(memberId))
        const unknownIds = targets.filter((memberId) => !known.has(memberId))
        const { kind, mime } = kindAndMimeFor(name)
        const attachment: OutboundAttachment = {
          url: attachmentUrl(publicArtifactUrl(room.code), name),
          filename: name,
          mimeType: mime,
          kind,
          caption,
        }
        // The ONE passage: each accepted member's file goes through the same
        // sink a marker's file goes through — MemberSender.sendAttachment →
        // DeliveryEngine.accept → drain → attempt, where the URL probe and
        // the honest-failure arms live. The tool result reports the accepted
        // split only; whether the send ultimately lands is the record's
        // business, never the tool receipt's.
        for (const memberId of accepted) {
          await sendFile(room.code, memberId, attachment)
        }
        return ok(id, {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                accepted: accepted.length > 0,
                file: name,
                recipients: accepted.map((memberId) => ({ member_id: memberId, ok: true })),
                unknown: [...unknownIds],
              }),
            },
          ],
          isError: false,
        })
      }

      if (params.name === REACT_TOOL.name || params.name === REPLY_TOOL.name) {
        const act = params.name === REACT_TOOL.name ? deps.reactMessage : deps.replyToMessage
        if (act === undefined) {
          return fail(id, METHOD_NOT_FOUND, `unknown tool: ${String(params.name)}`)
        }
        const args = isRecord(params.arguments) ? params.arguments : {}
        const handle = args.handle
        if (typeof handle !== "string" || handle.trim().length === 0) {
          return fail(id, INVALID_REQUEST, `invalid arguments: ${String(params.name)} requires a message \`handle\` (from room_view's recent_messages)`)
        }
        const isReact = params.name === REACT_TOOL.name
        const payloadArg = isReact ? args.emoji : args.text
        if (typeof payloadArg !== "string" || (isReact ? false : payloadArg.trim().length === 0)) {
          const what = isReact ? "an `emoji` (or \"\" to remove)" : "a non-empty `text`"
          return fail(id, INVALID_REQUEST, `invalid arguments: ${String(params.name)} requires ${what}`)
        }
        const outcome = await act(room.code, handle.trim(), payloadArg)
        return ok(id, {
          content: [{ type: "text", text: JSON.stringify(messageActionResult(outcome)) }],
          isError: false,
        })
      }

      if (params.name === RECOVER_TOOL.name) {
        const recover = deps.recoverIdentity
        if (recover === undefined) {
          return fail(id, METHOD_NOT_FOUND, `unknown tool: ${String(params.name)}`)
        }
        const args = isRecord(params.arguments) ? params.arguments : {}
        const memberId = typeof args.member_id === "string" ? args.member_id : undefined
        if (memberId === undefined || memberId.length === 0) {
          return fail(id, INVALID_REQUEST, "recover_identity requires a member_id")
        }
        const status = await recover(room.code, memberId)
        return ok(id, {
          content: [
            {
              type: "text",
              // Status and the named member id only — see RECOVER_TOOL's doc:
              // this result is projected on the room's shared screen, and the
              // recovery URL must never appear in it.
              text: JSON.stringify(
                status === "accepted"
                  ? { accepted: true, member_id: memberId }
                  : { accepted: false, member_id: memberId, reason: status },
              ),
            },
          ],
          isError: false,
        })
      }

      return fail(id, METHOD_NOT_FOUND, `unknown tool: ${String(params.name)}`)
    }

    return fail(id, METHOD_NOT_FOUND, `unknown method: ${method}`)
  }
}
