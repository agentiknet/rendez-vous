/**
 * The PERSON's surface (BRIEF-18), a deliberate sibling of `mcp-room.ts`:
 * same hand-rolled JSON-RPC shape, same method set, same recompute-and-
 * compare auth move — applied to an ADDRESS instead of a room code.
 *
 * Every route this service exposed before this file was scoped to one room:
 * the room code IS the capability. There is no `/rooms` index, and there
 * must never be one — a route that enumerates rooms hands out capabilities.
 * "Show me my rooms" needs its own surface, with its own authentication,
 * because it answers a question no room-scoped token is allowed to answer.
 *
 * Auth: `principalToken`, below — same family as `roomAudienceToken`
 * (mcp-room.ts) and `roomRenderToken` (mcp-canvakit.ts), HMAC over
 * `env.roomTokenSecret`, 40 hex chars, recomputed per call against every
 * distinct member address the store currently knows (`resolvePrincipal`),
 * exactly `resolveRoom`'s move against room codes. No new table, no new
 * file: the address is already in the store, so the token is a pure
 * function of it.
 *
 * Scope, decided (not optional): read-only. `rendezvous_list` is the only
 * tool this server will ever advertise — sending stays on the room-scoped
 * `/mcp/room` mount, which already authenticates a room, not a person.
 * Minting is a CLI-only act (`src/cli.ts`): there is no HTTP route that
 * issues a principal token, because a route that did would be an account
 * system, which is not in scope.
 *
 * HARD RULE, inherited from mcp-room.ts's file-top rule: every tool result
 * on this server carries ids, counts and booleans — NEVER message text.
 * `rendezvous_list` has nothing else to leak, and anything that lands on
 * top of this file must inherit the rule too.
 */

import { createHmac } from "node:crypto"
import { env } from "../env.ts"
import type { AddressLookup, AddressMatch } from "../rooms/store.ts"
import { deliverySeqOf, pullMemberStale, type Address, type Member, type Room } from "../rooms/types.ts"
import { bearerOf, tokensMatch } from "./mcp-room.ts"
import type { McpResponse } from "./mcp-canvakit.ts"

/** The bearer token for `POST /mcp` (BRIEF-18): same family as
 *  `roomAudienceToken`/`memberToken`/`roomRenderToken` — an HMAC over
 *  `env.roomTokenSecret`, 40 hex chars, deterministic in its input so it is
 *  recomputed per call with no shared mutable state. The label is
 *  `principal:<provider>:<contactRef>`, deliberately ignoring
 *  `Address.source` — that field is per-membership incidental (a channel
 *  name, or for email, a subject-line room-code hint), while `provider` +
 *  `contactRef` is the same pair `deliveryFromAddress` treats as identity.
 *
 *  CAPABILITY AMPLIFIER — say it here, where the token is derived: a leaked
 *  room code exposes exactly one room; a leaked principal token exposes
 *  EVERY room this address is a member of. It is minted by a CLI command
 *  only (`src/cli.ts`), printed once, to an operator. There is no HTTP
 *  route that issues one — that would be an account system. */
export function principalToken(address: Address, secret: string): string {
  return createHmac("sha256", secret).update(`principal:${address.provider}:${address.contactRef}`).digest("hex").slice(0, 40)
}

/** Injectable, so tests can prove auth/roster behaviour without a real
 *  store. `findByAddress` is BRIEF-13's roster query (`RoomStore`), reused
 *  unchanged — this file must not write a second scan. */
export interface McpPersonalDeps {
  /** All rooms this endpoint can serve, read fresh per call: membership
   *  changes between calls must be visible to the next `rendezvous_list`. */
  readonly rooms: () => readonly Room[]
  readonly findByAddress: (address: Address) => AddressLookup
}

// --- JSON-RPC / MCP wire handling: mcp-room.ts's dialect, unchanged. ----

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602

/** NO arguments: the principal is fixed by the bearer token, exactly the
 *  reasoning behind `roster`/`room_view` taking none (mcp-room.ts) — an
 *  argument naming an address would be a way to ask about someone else. */
const RENDEZVOUS_LIST_TOOL = {
  name: "rendezvous_list",
  description:
    "List every room YOUR principal (fixed by your bearer credential — no argument) is currently a member of. Each entry: code, member_id and display_name (your identity in that room), tier, presence (your OWN presence there), presence_basis (\"acked\" if it is backed by a real acknowledgement, \"never-acked\" if it is only dated from when you joined — treat \"never-acked\" as NOT evidence of absence), member_count, unread (records addressed to you above your acked position), active (whether this is your one canonical room), and last_activity_at. `ambiguous: true` means this address holds a membership in more than one room at once — a broken invariant surfaced, not hidden or resolved to a guess; when it is true, no room in the list is `active`, because there is no honest way to pick one. Ids, counts and codes only — never message content.",
  inputSchema: { type: "object", properties: {} },
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function ok(id: string | number | null, result: Record<string, unknown>): McpResponse {
  return { status: 200, body: { jsonrpc: "2.0", id, result } }
}

function fail(id: string | number | null, code: number, message: string): McpResponse {
  return { status: 200, body: { jsonrpc: "2.0", id, error: { code, message } } }
}

/** Deliberately generic: this message is returned for EVERY reason a bearer
 *  fails to resolve — missing, malformed, or naming no known address. A
 *  bearer that resolves to no known address must be indistinguishable from a
 *  garbled one, or the endpoint becomes an address oracle (BRIEF-18). There
 *  is exactly one call site below, so that is true by construction, not by
 *  discipline. */
function unauthorized(id: string | number | null): McpResponse {
  return {
    status: 401,
    body: {
      jsonrpc: "2.0",
      id,
      error: { code: INVALID_REQUEST, message: "unauthorized: missing or invalid bearer token" },
    },
  }
}

/** Resolve the bearer to the address it names: recompute `principalToken`
 *  per member address currently in the store and compare with
 *  `timingSafeEqual` (via `tokensMatch`), as `resolveRoom` does for room
 *  codes. The token is not reversible, so recompute-and-compare is the only
 *  honest binding. */
function resolvePrincipal(deps: McpPersonalDeps, authorization: string | undefined): Address | undefined {
  const provided = bearerOf(authorization)
  if (provided === undefined) return undefined
  for (const room of deps.rooms()) {
    for (const member of room.members) {
      if (tokensMatch(provided, principalToken(member.address, env.roomTokenSecret))) return member.address
    }
  }
  return undefined
}

/** `AddressLookup`'s matches, uniformly: `"none"` cannot occur here (the
 *  caller only reaches this after `resolvePrincipal` already found the
 *  address among the store's members), but the union is exhaustive so a
 *  future arm cannot be forgotten silently. */
function matchesOf(lookup: AddressLookup): readonly AddressMatch[] {
  switch (lookup.kind) {
    case "none":
      return []
    case "one":
      return [{ room: lookup.room, member: lookup.member }]
    case "ambiguous":
      return lookup.matches
  }
}

/** `unread` (BRIEF-18): records owned by this member (`Delivery.memberId`)
 *  whose seq is above their `ackedSeq`. Absent `ackedSeq` is the same "holds
 *  everything" floor `retentionFloors`/`ackCursor` already use (`?? 0`) —
 *  not a separate zero-unread reading; every real seq is `>= 1`, so a member
 *  who has never acked reports every one of their records as unread, which
 *  is the honest answer, not a naive "no ack info, report 0" shortcut. */
function unreadCountOf(room: Room, member: Member): number {
  const floor = member.ackedSeq ?? 0
  return (room.deliveries ?? []).filter((delivery) => delivery.memberId === member.id && deliverySeqOf(delivery.id) > floor).length
}

/** The `rendezvous_list` result. Ids, counts and codes only — the file-top
 *  HARD RULE. `active` is BRIEF-13's R1 pointer (`ensureMembership`'s "the
 *  pointer off whatever room they were in"): the invariant is AT MOST ONE
 *  membership per address, so when it holds (`lookup.kind === "one"`) that
 *  single room honestly IS the address's active room. When it is broken
 *  (`"ambiguous"`), there are two or more simultaneous "pointers" and no
 *  honest way to crown one of them the active one — `active` is `false` on
 *  every entry, the same "surface it, do not resolve it" posture
 *  `findByAddress` itself takes. */
function rendezvousListResult(address: Address, lookup: AddressLookup, nowMs: number): Record<string, unknown> {
  const matches = matchesOf(lookup)
  const active = lookup.kind === "one"
  const rooms = matches.map(({ room, member }) => ({
    code: room.code,
    memberId: member.id,
    displayName: member.displayName,
    tier: member.tier,
    presence: pullMemberStale(member, nowMs) ? "away" : "present",
    presenceBasis: member.ackedAt === undefined ? "never-acked" : "acked",
    memberCount: room.members.length,
    unread: unreadCountOf(room, member),
    active,
    lastActivityAt: room.lastActivityAt,
  }))
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          principal: {
            provider: address.provider,
            contactRef: address.contactRef,
            displayName: matches[0]?.member.displayName,
          },
          rooms,
          ambiguous: lookup.kind === "ambiguous",
        }),
      },
    ],
    isError: false,
  }
}

/**
 * Handle one JSON-RPC 2.0 request body (already JSON.parse'd) with its
 * `Authorization` header value. `mcp-room.ts`'s method surface
 * (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`,
 * `resources/list`, `resources/read`) — this server serves no resources
 * yet, so `resources/list` is always empty and `resources/read` always
 * names an unknown uri, but both methods exist rather than 404ing, for the
 * same reason `http.ts` answers a POST-only MCP endpoint 405 and not 404:
 * an MCP client that gets an unrecognised method shape falls back to OAuth
 * discovery instead of ever calling `tools/call`.
 */
export function createMcpPersonalHandler(
  deps: McpPersonalDeps,
): (body: unknown, authorization: string | undefined) => Promise<McpResponse> {
  return async (body, authorization) => {
    if (!isRecord(body) || typeof body.method !== "string") {
      return fail(null, PARSE_ERROR, "request must be a JSON-RPC 2.0 object with a method")
    }
    const method = body.method
    const id = typeof body.id === "string" || typeof body.id === "number" ? body.id : body.id === null ? null : undefined

    if (id === undefined) {
      // A notification (no id): acknowledged, no response body — covers the
      // client's `notifications/initialized` after `initialize`.
      return { status: 202, body: undefined }
    }

    const params = isRecord(body.params) ? body.params : {}

    if (method === "initialize") {
      return ok(id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "rdv-personal", version: "1.0.0" },
      })
    }

    if (method === "tools/list") {
      return ok(id, { tools: [RENDEZVOUS_LIST_TOOL] })
    }

    if (method === "resources/list") {
      return ok(id, { resources: [] })
    }

    if (method === "resources/read") {
      // Bearer checked before the uri, same reason `mcp-room.ts` checks it
      // first: a rejected call must reveal nothing.
      const address = resolvePrincipal(deps, authorization)
      if (address === undefined) return unauthorized(id)
      return fail(id, INVALID_PARAMS, `unknown resource uri: ${String(params.uri)}`)
    }

    if (method === "tools/call") {
      // Token checked before anything else: a rejected call must reveal
      // nothing, not even that a principal token would succeed for this
      // shape of request.
      const address = resolvePrincipal(deps, authorization)
      if (address === undefined) return unauthorized(id)

      if (params.name === RENDEZVOUS_LIST_TOOL.name) {
        const lookup = deps.findByAddress(address)
        return ok(id, rendezvousListResult(address, lookup, Date.now()))
      }

      return fail(id, METHOD_NOT_FOUND, `unknown tool: ${String(params.name)}`)
    }

    return fail(id, METHOD_NOT_FOUND, `unknown method: ${method}`)
  }
}
