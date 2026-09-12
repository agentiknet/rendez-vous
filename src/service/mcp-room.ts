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
import type { Room } from "../rooms/types.ts"
import type { McpResponse, McpServerMount } from "./mcp-canvakit.ts"

/** The per-room bearer token for `POST /mcp/room`. Deterministic in the
 *  secret, so the booter can compute the mount's header at spawn time and
 *  the endpoint can recompute it per call with no shared mutable state.
 *  40 hex chars — same budget as `roomRenderToken`. The `audience:` label
 *  differs from canvakit's `render:` so a leaked token grants exactly one
 *  capability, never both. */
export function roomAudienceToken(code: string, secret: string): string {
  return createHmac("sha256", secret).update(`audience:${code}`).digest("hex").slice(0, 40)
}

function roomMcpMount(code: string, base: string): McpServerMount {
  return {
    name: "room",
    transport: "http",
    ref: `${base}/mcp/room`,
    headers: { authorization: `Bearer ${roomAudienceToken(code, env.roomTokenSecret)}` },
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
}

// --- JSON-RPC / MCP wire handling: same hand-rolled surface as canvakit's
// (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`),
// for the same reason — no SDK dependency for three methods. ----

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601

/** The one tool this server advertises in this step. NO arguments: the room
 *  is fixed by the bearer token, and an argument naming a room would be a
 *  way to address another room — exactly what the token exists to prevent. */
const ROSTER_TOOL = {
  name: "roster",
  description:
    "List the members of THIS room (fixed by your credentials — no argument). One entry per member: member_id (use this to address them — display names can collide and change), display_name (for prose only), surface (the channel they are on: telegram, whatsapp, email, room-web), tier (messenger/email/room-web — a room-web member is a screen, not a phone), joined_at. Re-read it when you need to address someone; do not cache ids across turns — a member who leaves and rejoins gets a new id.",
  inputSchema: { type: "object", properties: {} },
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function bearerOf(authorization: string | undefined): string | undefined {
  if (authorization === undefined) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  return match?.[1]?.trim() ?? undefined
}

function tokensMatch(a: string, b: string): boolean {
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
): Room | undefined {
  const provided = bearerOf(authorization)
  if (provided === undefined) return undefined
  for (const room of deps.rooms()) {
    if (tokensMatch(provided, roomAudienceToken(room.code, env.roomTokenSecret))) return room
  }
  return undefined
}

/** The `roster` result. Ids and surfaces only — see the file-top HARD RULE:
 *  this result is projected on the room's shared screen. */
function rosterResult(room: Room): Record<string, unknown> {
  const members = room.members.map((member) => ({
    member_id: member.id,
    display_name: member.displayName,
    surface: member.address.provider,
    tier: member.tier,
    joined_at: member.joinedAt,
  }))
  return {
    content: [{ type: "text", text: JSON.stringify({ members, count: members.length }) }],
    isError: false,
  }
}

/**
 * Handle one JSON-RPC 2.0 request body (already JSON.parse'd) with its
 * `Authorization` header value. Same method surface as canvakit's handler:
 * `initialize`, `notifications/initialized`, `tools/list`, `tools/call`.
 * Unknown methods are `-32601`; notifications (`id` absent) get `202`.
 */
export function createMcpRoomHandler(
  deps: McpRoomDeps,
): (body: unknown, authorization: string | undefined) => Promise<McpResponse> {
  return async (body, authorization) => {
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
        capabilities: { tools: {} },
        serverInfo: { name: "rdv-room", version: "1.0.0" },
      })
    }

    if (method === "tools/list") {
      return ok(id, { tools: [ROSTER_TOOL] })
    }

    if (method === "tools/call") {
      if (params.name !== ROSTER_TOOL.name) {
        return fail(id, METHOD_NOT_FOUND, `unknown tool: ${String(params.name)}`)
      }
      // Token checked before anything else: a rejected call must reveal
      // nothing, not even that a room exists.
      const room = resolveRoom(deps, authorization)
      if (room === undefined) return unauthorized(id)
      return ok(id, rosterResult(room))
    }

    return fail(id, METHOD_NOT_FOUND, `unknown method: ${method}`)
  }
}
