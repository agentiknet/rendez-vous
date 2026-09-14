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
 * Scope (BRIEF-18 decided read-only; BRIEF-19 adds exactly one write):
 * `rendezvous_list` reads, and `rendezvous_send` sends AS the principal into
 * a room they are ALREADY in — identical in every respect to that person
 * typing the same words on WhatsApp, and routed through the very same
 * inbound path so fan-out, the outbox and BRIEF-13's R6 suffix all behave
 * identically. It is deliberately NOT `say`/`whisper`: those are the
 * AGENT's voice (`AudienceSendKind`), and a human borrowing them would make
 * the transcript lie about who spoke. Minting stays a CLI-only act
 * (`src/cli.ts`): there is no HTTP route that issues a principal token,
 * because a route that did would be an account system.
 *
 * HARD RULE, inherited from mcp-room.ts's file-top rule: every tool result
 * on this server carries ids, counts and booleans — NEVER message text.
 * `rendezvous_list` has nothing else to leak; `rendezvous_send` is HANDED
 * text and must never echo a word of it back, not in a result and not in an
 * error — its own result is a room slug, a member id and an outcome name.
 */

import { createHmac } from "node:crypto"
import { env } from "../env.ts"
import { joinLinks, type JoinLinks } from "../links/index.ts"
import { normalizeCode } from "../rooms/code.ts"
import type { AddressLookup, AddressMatch } from "../rooms/store.ts"
import { deliverySeqOf, pullMemberStale, type Address, type Member, type Room, type Tier } from "../rooms/types.ts"
import { normalizeSlug } from "../rooms/words.ts"
import { bearerOf, tokensMatch } from "./mcp-room.ts"
import { rosterPanelHtml } from "./roster-panel.html.ts"
import type { OutboxPayload } from "./outbox.ts"
import type { McpResponse } from "./mcp-canvakit.ts"

/** What a principal token is allowed to do (BRIEF-19, AMENDMENT 2). The
 *  capability lives in the token's own DERIVATION, never in a flag the
 *  server looks up: there is no record of a principal token anywhere, so
 *  there is nothing to look a flag up IN. Two labels, two different HMACs,
 *  two different 40-hex strings — a read token cannot be edited into a send
 *  token, because the secret is what produced it. */
export type PrincipalCapability = "read" | "send"

/** The label each capability HMACs under. `principal:` is BRIEF-18's
 *  original read-only derivation and MUST NOT change — every token minted
 *  before BRIEF-19 keeps working, and keeps being read-only. */
const PRINCIPAL_LABELS: Readonly<Record<PrincipalCapability, string>> = {
  read: "principal",
  send: "principal-rw",
}

/** The bearer token for `POST /mcp` (BRIEF-18): same family as
 *  `roomAudienceToken`/`memberToken`/`roomRenderToken` — an HMAC over
 *  `env.roomTokenSecret`, 40 hex chars, deterministic in its input so it is
 *  recomputed per call with no shared mutable state. The label is
 *  `principal:<provider>:<contactRef>` (read-only) or
 *  `principal-rw:<provider>:<contactRef>` (may send), deliberately ignoring
 *  `Address.source` — that field is per-membership incidental (a channel
 *  name, or for email, a subject-line room-code hint), while `provider` +
 *  `contactRef` is the same pair `deliveryFromAddress` treats as identity.
 *  `read` is the DEFAULT here and in the CLI: a caller who does not say
 *  `--can-send` does not get a writing token by accident.
 *
 *  CAPABILITY AMPLIFIER — say it here, where the token is derived: a leaked
 *  room code exposes exactly one room; a leaked principal token exposes
 *  EVERY room this address is a member of. It is minted by a CLI command
 *  only (`src/cli.ts`), printed once, to an operator. There is no HTTP
 *  route that issues one — that would be an account system.
 *
 *  THERE IS NO WAY TO REVOKE ONE. This is the real cost of BRIEF-19's write
 *  capability, and it is stated here because this is where the capability is
 *  created. A principal token is a PURE FUNCTION of (address, secret) with
 *  no stored state: nothing records that it was minted, so nothing can
 *  record that it was withdrawn. The only revocation that exists is rotating
 *  `env.roomTokenSecret`, which invalidates EVERY token of EVERY kind at
 *  once — every room's audience token, every member's outbox token, every
 *  render token, every other principal's token — and therefore is not a
 *  targeted action at all.
 *
 *  For a read-only token that is tolerable: the blast radius is reading
 *  counts and codes. For a `principal-rw` token it is genuinely dangerous:
 *  a leaked one can SPEAK AS THAT PERSON, in every room they are in,
 *  FOREVER, and the transcript will attribute every word to them. Mint them
 *  sparingly, and treat one as compromised the moment it leaves the
 *  operator's hands.
 *
 *  A revocation mechanism is deliberately NOT in this brief — adding one is
 *  a design with its own storage, its own failure modes and its own brief.
 *  What is in scope is that the next person cannot fail to know. */
export function principalToken(address: Address, secret: string, capability: PrincipalCapability = "read"): string {
  return createHmac("sha256", secret)
    .update(`${PRINCIPAL_LABELS[capability]}:${address.provider}:${address.contactRef}`)
    .digest("hex")
    .slice(0, 40)
}

/** What one inbound message needs to be indistinguishable from a real one.
 *  Structurally `RoomService.InboundInput` — spelled out here rather than
 *  imported so this file keeps depending on nothing but the store's shapes,
 *  exactly as `mcp-room.ts` depends on the audience CONTRACT and not on the
 *  delivery engine. */
export interface PersonalInboundInput {
  readonly address: Address
  readonly displayName: string
  readonly tier: Tier
  readonly text: string
}

/** `RoomService.handleInbound`'s outcome, narrowed to the one field this
 *  file reports. Every arm of that union has a `kind`; the panel and the
 *  agent both get the NAME of what happened and nothing else — never the
 *  text, never a fragment of it (file-top HARD RULE). */
export interface PersonalInboundOutcome {
  readonly kind: string
}

/** THE inbound path, injected. Not a second write path: `http.ts` wires this
 *  straight to `RoomService.handleInbound`, the same function a Telegram
 *  webhook and `/inbound/simulated` call, so a `rendezvous_send` message is
 *  fanned in, suffixed and outboxed by exactly the code a real message is. */
export type PersonalInboundSend = (input: PersonalInboundInput) => Promise<PersonalInboundOutcome>

/** Injectable, so tests can prove auth/roster behaviour without a real
 *  store. `findByAddress` is BRIEF-13's roster query (`RoomStore`), reused
 *  unchanged — this file must not write a second scan. */
export interface McpPersonalDeps {
  /** All rooms this endpoint can serve, read fresh per call: membership
   *  changes between calls must be visible to the next `rendezvous_list`. */
  readonly rooms: () => readonly Room[]
  readonly findByAddress: (address: Address) => AddressLookup
  /** The inbound path behind `rendezvous_send` (BRIEF-19). Omitting it
   *  leaves the tool unadvertised and uncallable — the BRIEF-18 read-only
   *  surface, unchanged — exactly as `McpRoomDeps.deliveries` gates
   *  `say`/`whisper`. */
  readonly sendInbound?: PersonalInboundSend
  /** The listening half (BRIEF-12): `rendezvous_drain`/`rendezvous_ack`, plus
   *  the lazy creation of the panel's own stable `room-web` member. Omitted
   *  leaves both unadvertised, exactly as `sendInbound` gates the send. */
  readonly roomRead?: PersonalRoomRead
}

/** What the personal mount needs to let a principal READ a room it is a
 *  member of, as its own `room-web` screen (BRIEF-12). Every field is
 *  injected from the service, so the personal mount reuses the one outbox
 *  filter and the one cursor writer rather than a second of either. */
export interface PersonalRoomRead {
  /** One member's own deliveries — the existing `outboxFor` (outbox.ts),
   *  verbatim: same per-member filter, same `pruned` honesty. */
  readonly drain: (roomCode: string, memberId: string, since: number, sinceGiven: boolean) => OutboxPayload
  /** The existing cursor writer (`DeliveryEngine.ackCursor`), verbatim. */
  readonly ackCursor: (roomCode: string, memberId: string, seq: number) => Promise<"applied" | "ignored">
  /** Resolve-or-create the principal's stable `room-web` member in a room
   *  (`RoomService.ensureRoomWebMember`). Called only from a drain/ack. */
  readonly ensureRoomWebMember: (roomCode: string, address: Address, displayName: string) => Promise<Member>
}

// --- JSON-RPC / MCP wire handling: mcp-room.ts's dialect, unchanged. ----

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602

/** The MCP Apps resource this server serves (spec `2026-01-26`,
 *  `modelcontextprotocol/ext-apps`): a host that recognises it renders the
 *  roster panel (`roster-panel.html.ts`) instead of (or alongside)
 *  `rendezvous_list`'s text result. */
const ROSTER_RESOURCE_URI = "ui://rendezvous/roster"

/** NO arguments: the principal is fixed by the bearer token, exactly the
 *  reasoning behind `roster`/`room_view` taking none (mcp-room.ts) — an
 *  argument naming an address would be a way to ask about someone else.
 *
 *  `_meta.ui.resourceUri` is carried BOTH here (the `tools/list` definition)
 *  AND on the `tools/call` result (`rendezvousListResult`) — deliberately
 *  redundant, for exactly the reason `ROOM_VIEW_TOOL` (mcp-room.ts:176) and
 *  `RENDER_ARTIFACT_TOOL` (mcp-canvakit.ts:166) spell out: hosts differ on
 *  which one they read, this server is hand-rolled so we own the envelope on
 *  both ends, and satisfying both readings costs nothing. */
const RENDEZVOUS_LIST_TOOL = {
  name: "rendezvous_list",
  description:
    "List every room YOUR principal (fixed by your bearer credential — no argument) is currently a member of. Each entry: slug, member_id and display_name (your identity in that room), tier, presence (your OWN presence there), presence_basis (\"acked\" if it is backed by a real acknowledgement, \"never-acked\" if it is only dated from when you joined — treat \"never-acked\" as NOT evidence of absence), member_count, unread (records addressed to you above your acked position), active (whether this is your one canonical room), and last_activity_at. The slug is the room's NAME and is safe to say, print and screenshot; the room's join CODE is never in this payload. `ambiguous: true` means this address holds a membership in more than one room at once — a broken invariant surfaced, not hidden or resolved to a guess; when it is true, no room in the list is `active`, because there is no honest way to pick one. Ids, counts and slugs only — never message content.",
  inputSchema: { type: "object", properties: {} },
  _meta: { ui: { resourceUri: ROSTER_RESOURCE_URI } },
} as const

/** `rendezvous_send` (BRIEF-19). `roomSlug` IS an argument here, unlike every
 *  other tool on the person-scoped surface: a principal can be in more than
 *  one room, so "which room" is a real question with no credential to answer
 *  it. It is not a capability the argument grants — the handler refuses any
 *  slug the principal is not a member of, by name — it only picks among the
 *  rooms they are already in. BRIEF-24: the argument is the slug (the room's
 *  NAME), never the code (the capability to join it): a code-shaped argument
 *  is refused with its own message rather than used, so this tool cannot be
 *  turned back into a way to exercise a leaked code. See `codeShapedRefusal`.
 *
 *  This is an INBOUND message, not an agent utterance: it is fanned in as
 *  that person, on the same path a WhatsApp message takes. Commands (`new`,
 *  `join`, `leave`, `where`) therefore behave here exactly as they do when
 *  typed on a phone — deliberately, because "identical in every respect" is
 *  the whole specification. */
const RENDEZVOUS_SEND_TOOL = {
  name: "rendezvous_send",
  description:
    "Send a message AS YOU into one of the rooms you are already in — exactly as if you had typed it on your phone. It is attributed to you, not to the agent. `roomSlug` must name a room YOUR principal is a member of (see rendezvous_list); any other room is refused, and a room CODE passed here is refused because a slug is expected. Requires a send-capable credential; a read-only one is refused. Returns {room_slug, member_id, outcome, accepted} — ids and an outcome name only, never the text back.",
  inputSchema: {
    type: "object",
    properties: {
      roomSlug: { type: "string", description: "A room slug from rendezvous_list — one you are a member of." },
      text: { type: "string", description: "The message, in your own voice." },
    },
    required: ["roomSlug", "text"],
  },
} as const

/** `rendezvous_drain` (BRIEF-12) — this mount's one LISTENING tool: the
 *  member's own deliveries, the transcript the person could not otherwise
 *  hear. Keyed by `roomSlug` (BRIEF-20: the slug identifies) and authorised
 *  by the principal token; the principal's own `room-web` member is resolved
 *  or created server-side, so the panel never holds a room credential.
 *
 *  ⚠️ THE DELIBERATE EXCEPTION TO THIS FILE'S HARD RULE. Every other result
 *  on this mount carries ids, counts and slugs — NEVER message text. This
 *  one returns `deliveries`, which carry `text`, because a transcript is the
 *  entire point of the tool: "you have no way to hear the answer" is the
 *  defect BRIEF-12 exists to fix. It is scoped server-side to THIS member
 *  (`outboxFor`'s per-member filter) and reads only the caller's own mail.
 *  Do not "fix" it back to ids-only; that would delete the feature. */
const RENDEZVOUS_DRAIN_TOOL = {
  name: "rendezvous_drain",
  description:
    "Read YOUR OWN undelivered records in one of the rooms you are a member of, addressed by `roomSlug`. Returns {memberId, cursor, pruned, deliveries}; each delivery carries the message text. This is your private mail in that room, never anyone else's. Pass `since` (the highest seq you have already RENDERED) to fetch only what is new; omit it to get everything retained. `pruned: true` means records below `since` were already dropped and cannot be recovered.",
  inputSchema: {
    type: "object",
    properties: {
      roomSlug: { type: "string", description: "A room slug from rendezvous_list — one you are a member of." },
      since: { type: "number", description: "The highest delivery seq you have already rendered. Omit for everything retained." },
    },
    required: ["roomSlug"],
  },
} as const

/** `rendezvous_ack` (BRIEF-12) — record the highest seq the caller has
 *  actually RENDERED. This is a liveness statement about the READER, not a
 *  write into the room, so it needs only the read capability. Monotonic
 *  server-side: an ack that would move backwards is ignored, not an error. */
const RENDEZVOUS_ACK_TOOL = {
  name: "rendezvous_ack",
  description:
    "Acknowledge that you have RENDERED every record up to `seq` in `roomSlug`. Ack the highest seq you actually rendered, AFTER rendering it — never what you merely fetched. The ack is what keeps your room-web membership live (a member that stops acking goes stale after 90s) and what lets the room prune what you have already read. Returns {applied, ackedSeq}.",
  inputSchema: {
    type: "object",
    properties: {
      roomSlug: { type: "string", description: "A room slug from rendezvous_list — one you are a member of." },
      seq: { type: "number", description: "The highest delivery seq you have actually rendered." },
    },
    required: ["roomSlug", "seq"],
  },
} as const

/** `rendezvous_invite` (BRIEF-13 step 2). Read-capable (`principal:`) is
 *  enough — an invite hands out a way IN, it does not speak as the person, so
 *  it needs no more than `rendezvous_list` needs.
 *
 *  ⚠️ THE SAME TRAP `a5b211b` closed for `rendezvous_list`, closed again here:
 *  every join link CONTAINS the room's join code, so none of them may reach
 *  `content[0].text` — that would hand the model (and the transcript that
 *  keeps its output) the capability to join, not merely a fact that an invite
 *  exists. The text names the room by SLUG and nothing else; the links ride
 *  in `_meta.invite`, which only the HOST's panel reads (see
 *  `RENDEZVOUS_LIST_TOOL`'s `_meta.rooms` for the precedent this follows). */
const RENDEZVOUS_INVITE_TOOL = {
  name: "rendezvous_invite",
  description:
    "Get the links that bring someone else into a room YOUR principal is already a member of, addressed by `roomSlug`. The links themselves are never returned in this result's text — they all contain the room's join code, which this server never puts in front of a model. They ride in the result's `_meta.invite` instead, for the HOST's app to build a share control from. `roomSlug` must name a room you are a member of; any other room is refused.",
  inputSchema: {
    type: "object",
    properties: {
      roomSlug: { type: "string", description: "A room slug from rendezvous_list — one you are a member of." },
    },
    required: ["roomSlug"],
  },
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

/** The address a bearer named, and what that bearer is allowed to do. The
 *  capability is not stored anywhere and not looked up — it is WHICH
 *  derivation matched, which is why it cannot be escalated without the
 *  secret. */
interface ResolvedPrincipal {
  readonly address: Address
  readonly capability: PrincipalCapability
}

/** Resolve the bearer to the address it names: recompute `principalToken`
 *  per member address currently in the store and compare with
 *  `timingSafeEqual` (via `tokensMatch`), as `resolveRoom` does for room
 *  codes. The token is not reversible, so recompute-and-compare is the only
 *  honest binding. BRIEF-19: BOTH derivations are recomputed per address,
 *  so a `principal-rw` token authenticates everything a `principal` one
 *  does — a send capability is a superset, never a separate account. */
function resolvePrincipal(deps: McpPersonalDeps, authorization: string | undefined): ResolvedPrincipal | undefined {
  const provided = bearerOf(authorization)
  if (provided === undefined) return undefined
  for (const room of deps.rooms()) {
    for (const member of room.members) {
      if (tokensMatch(provided, principalToken(member.address, env.roomTokenSecret, "read"))) {
        return { address: member.address, capability: "read" }
      }
      if (tokensMatch(provided, principalToken(member.address, env.roomTokenSecret, "send"))) {
        return { address: member.address, capability: "send" }
      }
    }
  }
  return undefined
}

/** The display name the rooms know this address by — the panel's header, and
 *  the name a `rendezvous_send` message is attributed under. Taken from the
 *  membership itself, never from an argument: a name a caller could supply
 *  would be a way to speak under someone else's. */
function principalDisplayName(matches: readonly AddressMatch[]): string | undefined {
  return matches[0]?.member.displayName
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
    // BRIEF-20: the slug is the room's NAME and is not secret — it is what a
    // surface may display and what `rendezvous_send` addresses. See
    // `roomIdentityLabel`.
    slug: room.slug,
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
            displayName: principalDisplayName(matches),
          },
          rooms,
          ambiguous: lookup.kind === "ambiguous",
        }),
      },
    ],
    isError: false,
    _meta: {
      // Redundant with the `tools/list` definition's `_meta` — see
      // `RENDEZVOUS_LIST_TOOL`'s doc comment for why both are written.
      ui: { resourceUri: ROSTER_RESOURCE_URI },
      // BRIEF-24: the join code is the CAPABILITY, so it leaves the payload a
      // model reads and a transcript keeps. The panel still needs it to fetch
      // `/r/:code/state`, and the panel is the HOST's app, not the model — so
      // it travels here, in `_meta`. This reduces the exposure; it does not
      // eliminate it: a host that echoes `_meta` back into the model's context
      // has re-created the leak, and that is a finding, not something to
      // paper over here.
      rooms: matches.map(({ room }) => ({ slug: room.slug, code: room.code })),
    },
  }
}

/** A `rendezvous_send` refusal that is NOT a credential problem. It is
 *  returned as a tool-level JSON-RPC error (200 + `error`), deliberately not
 *  the 401 `unauthorized` above: a caller with a perfectly good token who
 *  named a room they are not in needs to be told about MEMBERSHIP, not sent
 *  down a "check your permissions" dead end — the same distinction
 *  `callRenderTool` draws in mcp-canvakit.ts. It names no room that was not
 *  already named by the caller, so it reveals nothing: a slug the principal
 *  is not in produces this answer whether or not the room exists. */
function membershipRefusal(id: string | number | null, roomSlug: string): McpResponse {
  return fail(
    id,
    INVALID_PARAMS,
    `rendezvous_send: you are not a member of ${roomSlug}. This is a membership question — you can only send into rooms you have already joined, and rendezvous_list shows which those are.`,
  )
}

/** A `rendezvous_send` refusal for a room CODE passed where a slug belongs
 *  (BRIEF-24). Kept deliberately separate from `membershipRefusal`: "you
 *  named a code in a tool that takes a slug" and "you are not a member of
 *  that room" are two different situations, and collapsing them is the
 *  defect family this whole series is about. It is also the whole point of
 *  the change — accepting a code "for compatibility" would leave a leaked
 *  code working as a send capability and make the swap cosmetic. The
 *  message names the shape, never the value. */
function codeShapedRefusal(id: string | number | null): McpResponse {
  return fail(
    id,
    INVALID_PARAMS,
    "rendezvous_send: arguments.roomSlug looks like a room code. This tool takes the room's SLUG — its name from rendezvous_list — not its join code.",
  )
}

/** A `rendezvous_send` refusal for a READ-ONLY principal token (AMENDMENT
 *  2). Names the reason, because the reason is fixable and the fix is not
 *  guessable: the capability is baked into the token's derivation, so the
 *  only remedy is a new token. Never a silent no-op. */
function readOnlyRefusal(id: string | number | null): McpResponse {
  return fail(
    id,
    INVALID_REQUEST,
    "rendezvous_send: this principal token was derived read-only, so it can list your rooms but not speak in them. The send capability is part of the token itself, not a setting — mint a new one with `principal-token <provider> <contactRef> --can-send`.",
  )
}

/** Outcome kinds from the inbound path that mean NOTHING was routed. Listed
 *  explicitly rather than inferred, so a new failure arm in
 *  `InboundOutcome` cannot quietly start reporting `accepted: true`. */
const UNROUTED_OUTCOMES: readonly string[] = [
  "unknown-code",
  "unknown-sender",
  "not-in-room",
  "ambiguous",
  "undeliverable",
]

/** The `rendezvous_send` result: a room slug, a member id and the NAME of
 *  what the inbound path did. Never the text, never a fragment of it — the
 *  file-top HARD RULE applies with full force here, because this is the one
 *  tool on this server that is handed message content at all. BRIEF-24: the
 *  slug, never the code — the result must not narrate the join capability. */
function sendResult(roomSlug: string, memberId: string, outcome: PersonalInboundOutcome): Record<string, unknown> {
  const accepted = !UNROUTED_OUTCOMES.includes(outcome.kind)
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ roomSlug, memberId, outcome: outcome.kind, accepted }),
      },
    ],
    isError: !accepted,
  }
}

/** `rendezvous_send`'s whole body. Membership is checked against the SAME
 *  `findByAddress` lookup `rendezvous_list` reports from — one scan, one
 *  truth — and the send itself is `deps.sendInbound`, which is
 *  `RoomService.handleInbound` verbatim. Nothing here reimplements routing,
 *  attribution, fan-out or the R6 suffix; that is the point.
 *
 *  BRIEF-24: the room is addressed by SLUG. The room's own `slug` is unique
 *  and carried on every `Room` (`RoomStore`'s slug index enforces it), so the
 *  match below compares normalized slugs rather than reaching for a second
 *  lookup. A code-shaped argument never reaches the membership check at all —
 *  see `codeShapedRefusal` — and a slug the principal is not in gets the
 *  unchanged `membershipRefusal`, which is the same answer for an existing
 *  room and a nonexistent one. */
async function callSendTool(
  deps: McpPersonalDeps,
  principal: ResolvedPrincipal,
  params: Record<string, unknown>,
  id: string | number | null,
): Promise<McpResponse> {
  const sendInbound = deps.sendInbound
  if (sendInbound === undefined) {
    return fail(id, METHOD_NOT_FOUND, `unknown tool: ${RENDEZVOUS_SEND_TOOL.name}`)
  }

  // Capability before arguments: a read-only token must learn nothing about
  // whether the room it named exists or holds it as a member.
  if (principal.capability !== "send") return readOnlyRefusal(id)

  const args = isRecord(params.arguments) ? params.arguments : {}
  const roomSlug = typeof args.roomSlug === "string" ? args.roomSlug.trim() : ""
  const text = typeof args.text === "string" ? args.text : ""
  if (roomSlug.length === 0) {
    return fail(id, INVALID_PARAMS, "rendezvous_send: arguments.roomSlug must be a room slug you are a member of")
  }
  if (normalizeCode(roomSlug) !== undefined) {
    // A code-shaped argument is refused by SHAPE, before membership: it is a
    // different mistake from "not a member", and accepting it would leave the
    // capability this brief removes still working.
    return codeShapedRefusal(id)
  }
  if (text.trim().length === 0) {
    // The error names the FIELD, never the value — an empty message has
    // nothing to echo, but the rule that keeps it that way is the file-top
    // HARD RULE, not the emptiness.
    return fail(id, INVALID_PARAMS, "rendezvous_send: arguments.text must be a non-empty message")
  }

  const normalized = normalizeSlug(roomSlug)
  const match = matchPrincipalRoom(deps, principal, normalized)
  if (match === undefined) return membershipRefusal(id, roomSlug)

  const outcome = await sendInbound({
    address: principal.address,
    // The member's OWN name and tier, from the membership — never from an
    // argument. Attribution has to be a fact about the room, not a claim
    // the caller makes about itself.
    displayName: match.member.displayName,
    tier: match.member.tier,
    text,
  })
  return ok(id, sendResult(match.room.slug, match.member.id, outcome))
}

/** The principal's membership in the room a (normalized) slug names, if any.
 *  THE one principal→membership resolution on this mount: `rendezvous_send`,
 *  `rendezvous_drain` and `rendezvous_ack` all go through it, so there is no
 *  second path to drift. */
function matchPrincipalRoom(
  deps: McpPersonalDeps,
  principal: ResolvedPrincipal,
  normalizedSlug: string,
): AddressMatch | undefined {
  const matches = matchesOf(deps.findByAddress(principal.address))
  return matches.find((candidate) => normalizeSlug(candidate.room.slug) === normalizedSlug)
}

/** The `rendezvous_invite` result. `content[0].text` names only the room, by
 *  SLUG — never a link, never the code (see `RENDEZVOUS_INVITE_TOOL`'s
 *  warning). `_meta.invite` carries every link `joinLinks` built for THIS
 *  room's code; a channel `joinLinks` left `undefined` (no number/bot
 *  configured) is OMITTED here entirely, never written as an empty string —
 *  the panel must be able to tell "not configured" from "configured, empty"
 *  without inspecting the string. */
function inviteResult(roomSlug: string, links: JoinLinks): Record<string, unknown> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ roomSlug }),
      },
    ],
    isError: false,
    _meta: {
      invite: {
        slug: roomSlug,
        web: links.web,
        ...(links.whatsapp !== undefined ? { whatsapp: links.whatsapp } : {}),
        ...(links.telegram !== undefined ? { telegram: links.telegram } : {}),
        ...(links.sms !== undefined ? { sms: links.sms } : {}),
      },
    },
  }
}

/** `rendezvous_invite`'s whole body. Membership is resolved through the same
 *  `matchPrincipalRoom` send/drain/ack already share — one truth about
 *  "which room does this slug name for this principal" — and the refusal for
 *  a slug the principal is not in is `membershipRefusal`, VERBATIM: the drain
 *  tool below already reuses it byte-for-byte, and there must never be a
 *  second wording of the same refusal. */
function callInviteTool(
  deps: McpPersonalDeps,
  principal: ResolvedPrincipal,
  params: Record<string, unknown>,
  id: string | number | null,
): McpResponse {
  const args = isRecord(params.arguments) ? params.arguments : {}
  const roomSlug = typeof args.roomSlug === "string" ? args.roomSlug.trim() : ""
  if (roomSlug.length === 0) {
    return fail(id, INVALID_PARAMS, "rendezvous_invite: arguments.roomSlug must be a room slug you are a member of")
  }
  if (normalizeCode(roomSlug) !== undefined) {
    // A code-shaped argument is refused by SHAPE, before membership, exactly
    // as callSendTool positions the same guard: this is the ONE tool whose
    // whole payload IS the join capability, so it is the last place to rely
    // on the accident that a code never matches a three-word slug.
    return codeShapedRefusal(id)
  }

  const match = matchPrincipalRoom(deps, principal, normalizeSlug(roomSlug))
  if (match === undefined) return membershipRefusal(id, roomSlug)

  const links = joinLinks(match.room.code, {
    publicUrl: env.publicUrl,
    whatsappNumber: env.whatsappNumber,
    telegramBot: env.telegramBot,
    smsNumber: env.smsNumber,
  })
  return ok(id, inviteResult(match.room.slug, links))
}

/** `rendezvous_drain`'s whole body. Resolves membership exactly as send does,
 *  materialises the principal's stable `room-web` member (lazily — this is
 *  the ONLY creator), then returns that member's own outbox through the one
 *  existing filter. It deliberately does NOT ack: rendering happens in the
 *  client, and only the client knows what it actually RENDERED. */
async function callDrainTool(
  deps: McpPersonalDeps,
  principal: ResolvedPrincipal,
  params: Record<string, unknown>,
  id: string | number | null,
): Promise<McpResponse> {
  const roomRead = deps.roomRead
  if (roomRead === undefined) {
    return fail(id, METHOD_NOT_FOUND, `unknown tool: ${RENDEZVOUS_DRAIN_TOOL.name}`)
  }

  const args = isRecord(params.arguments) ? params.arguments : {}
  const roomSlug = typeof args.roomSlug === "string" ? args.roomSlug.trim() : ""
  if (roomSlug.length === 0) {
    return fail(id, INVALID_PARAMS, "rendezvous_drain: arguments.roomSlug must be a room slug you are a member of")
  }
  if (normalizeCode(roomSlug) !== undefined) {
    // Same guard, same position as callSendTool/callInviteTool: refused by
    // SHAPE, before membership — a code-shaped argument is a different
    // mistake from "not a member" and must not be accepted as a slug.
    return codeShapedRefusal(id)
  }
  const sinceGiven = args.since !== undefined
  if (sinceGiven && (typeof args.since !== "number" || !Number.isInteger(args.since) || args.since < 0)) {
    return fail(id, INVALID_PARAMS, "rendezvous_drain: arguments.since must be a non-negative integer when given")
  }
  const since = sinceGiven && typeof args.since === "number" ? args.since : 0

  const match = matchPrincipalRoom(deps, principal, normalizeSlug(roomSlug))
  if (match === undefined) return membershipRefusal(id, roomSlug)

  const member = await roomRead.ensureRoomWebMember(match.room.code, principal.address, match.member.displayName)
  const payload = roomRead.drain(match.room.code, member.id, since, sinceGiven)
  return ok(id, { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false })
}

/** `rendezvous_ack`'s whole body. Same resolution and same stable member as
 *  drain, then the ONE cursor writer. Allowed on the read capability: an ack
 *  is a liveness statement about the reader, not a word spoken into the
 *  room. */
async function callAckTool(
  deps: McpPersonalDeps,
  principal: ResolvedPrincipal,
  params: Record<string, unknown>,
  id: string | number | null,
): Promise<McpResponse> {
  const roomRead = deps.roomRead
  if (roomRead === undefined) {
    return fail(id, METHOD_NOT_FOUND, `unknown tool: ${RENDEZVOUS_ACK_TOOL.name}`)
  }

  const args = isRecord(params.arguments) ? params.arguments : {}
  const roomSlug = typeof args.roomSlug === "string" ? args.roomSlug.trim() : ""
  if (roomSlug.length === 0) {
    return fail(id, INVALID_PARAMS, "rendezvous_ack: arguments.roomSlug must be a room slug you are a member of")
  }
  if (normalizeCode(roomSlug) !== undefined) {
    // Same guard, same position as callSendTool/callInviteTool/callDrainTool:
    // refused by SHAPE, before membership.
    return codeShapedRefusal(id)
  }
  const seq = args.seq
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
    return fail(id, INVALID_PARAMS, "rendezvous_ack: arguments.seq must be a non-negative integer")
  }

  const match = matchPrincipalRoom(deps, principal, normalizeSlug(roomSlug))
  if (match === undefined) return membershipRefusal(id, roomSlug)

  const member = await roomRead.ensureRoomWebMember(match.room.code, principal.address, match.member.displayName)
  const outcome = await roomRead.ackCursor(match.room.code, member.id, seq)
  return ok(id, {
    content: [
      {
        type: "text",
        // `ackCursor` mutates `member` in place when it applies, so the
        // member's field is the effective cursor either way — the same
        // answer the HTTP cursor route returns.
        text: JSON.stringify({ applied: outcome === "applied", ackedSeq: member.ackedSeq ?? 0 }),
      },
    ],
    isError: false,
  })
}

/**
 * Handle one JSON-RPC 2.0 request body (already JSON.parse'd) with its
 * `Authorization` header value. `mcp-room.ts`'s method surface
 * (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`,
 * `resources/list`, `resources/read`) — the last two serve BRIEF-19's
 * roster panel (`ui://rendezvous/roster`), the MCP Apps half of this
 * server, exactly as they serve `room_view`'s panel on `/mcp/room`.
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
      // `rendezvous_send` is advertised only when something can perform it,
      // exactly as `say`/`whisper` are gated on `deps.deliveries`
      // (mcp-room.ts). The BRIEF-12 read tools are gated the same way on
      // `deps.roomRead`. Capability is NOT a listing concern: a read-only
      // token still sees the tools it can use and still gets a refusal that
      // names why for the one it cannot.
      const tools = [
        RENDEZVOUS_LIST_TOOL,
        RENDEZVOUS_INVITE_TOOL,
        ...(deps.sendInbound !== undefined ? [RENDEZVOUS_SEND_TOOL] : []),
        ...(deps.roomRead !== undefined ? [RENDEZVOUS_DRAIN_TOOL, RENDEZVOUS_ACK_TOOL] : []),
      ]
      return ok(id, { tools })
    }

    if (method === "resources/list") {
      return ok(id, {
        resources: [
          { uri: ROSTER_RESOURCE_URI, name: "rendezvous_roster", mimeType: "text/html;profile=mcp-app" },
        ],
      })
    }

    if (method === "resources/read") {
      // Bearer checked before the uri, same reason `mcp-room.ts` checks it
      // first: a rejected call must reveal nothing.
      const principal = resolvePrincipal(deps, authorization)
      if (principal === undefined) return unauthorized(id)

      if (params.uri !== ROSTER_RESOURCE_URI) {
        return fail(id, INVALID_PARAMS, `unknown resource uri: ${String(params.uri)}`)
      }

      // The identifying value is BAKED IN, resolved from the bearer — no
      // query param, no postMessage handshake for identity, no new auth
      // surface, and above all no token in the bytes: the panel is handed
      // WHO it is, never HOW to prove it.
      const matches = matchesOf(deps.findByAddress(principal.address))
      return ok(id, {
        contents: [
          {
            uri: ROSTER_RESOURCE_URI,
            mimeType: "text/html;profile=mcp-app",
            text: rosterPanelHtml(
              {
                provider: principal.address.provider,
                contactRef: principal.address.contactRef,
                displayName: principalDisplayName(matches),
              },
              env.publicUrl,
            ),
            // Load-bearing, not decoration. `connectDomains`: the panel
            // fetches `GET /r/:code/state` from `env.publicUrl` to expand a
            // row's roster, and a host that sandboxes the iframe without
            // this allowlist shows "who is there" failing forever.
            // `resourceDomains`/`frameDomains` are carried for the CSP
            // schema's own defaults — each maps to a directive that is
            // `'none'` when the field is omitted, and a spec-compliant host
            // (unlike the CopilotKit build this was verified against, which
            // wildcards them) enforces that. This panel nests no iframe
            // today; `frameDomains` is what keeps that from being a silent
            // wall the day one is added, and BRIEF-19 requires it.
            _meta: {
              ui: {
                csp: {
                  connectDomains: [env.publicUrl],
                  resourceDomains: [env.publicUrl],
                  frameDomains: [env.publicUrl],
                },
              },
            },
          },
        ],
      })
    }

    if (method === "tools/call") {
      // Token checked before anything else: a rejected call must reveal
      // nothing, not even that a principal token would succeed for this
      // shape of request.
      const principal = resolvePrincipal(deps, authorization)
      if (principal === undefined) return unauthorized(id)

      if (params.name === RENDEZVOUS_LIST_TOOL.name) {
        // Read works on BOTH derivations (AMENDMENT 2): a send-capable
        // token is a superset of a read-only one, and a read-only one keeps
        // doing exactly what BRIEF-18 minted it for.
        const lookup = deps.findByAddress(principal.address)
        return ok(id, rendezvousListResult(principal.address, lookup, Date.now()))
      }

      if (params.name === RENDEZVOUS_INVITE_TOOL.name) {
        return callInviteTool(deps, principal, params, id)
      }

      if (params.name === RENDEZVOUS_SEND_TOOL.name) {
        return callSendTool(deps, principal, params, id)
      }

      if (params.name === RENDEZVOUS_DRAIN_TOOL.name) {
        return callDrainTool(deps, principal, params, id)
      }

      if (params.name === RENDEZVOUS_ACK_TOOL.name) {
        return callAckTool(deps, principal, params, id)
      }

      return fail(id, METHOD_NOT_FOUND, `unknown tool: ${String(params.name)}`)
    }

    return fail(id, METHOD_NOT_FOUND, `unknown method: ${method}`)
  }
}
