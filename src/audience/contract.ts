/**
 * The audience contract (PLAN-02 §5 step 6, Option C): `audience_list` and
 * `audience_send` as a transport-free module, separate from the MCP server
 * that currently implements them.
 *
 * Ownership is separable, the record shape is not (REVIEW-adversarial-02,
 * answer 2): whoever ends up owning this surface — the `kind: mcp` server in
 * src/service/mcp-room.ts today, a daemon builtin, an HTTP driver — the
 * agent-facing shapes below are identical. This module is what a second
 * implementation must satisfy, and it is written so that a second
 * implementation is POSSIBLE AND SAFE, not to add a feature: nothing an
 * agent can do today may stop working.
 *
 * It MUST NOT import anything MCP-shaped — no JSON-RPC codes, no
 * `inputSchema`, no `tools/list` envelope — so an HTTP handler that has
 * never heard of MCP can consume it. A test greps this file for that
 * invariant (test/audience/contract.test.ts).
 *
 * The semantics encoded here are NOT re-decidable: they are normative in
 * `.plans/audience/APPENDIX-cursor-semantics.md`, and each rule cites the
 * appendix section it comes from rather than restating it loosely. The
 * governing invariant of that document — ABSENCE MUST NEVER READ AS
 * DELIVERY — is why several shapes below look over-specified: five separate
 * defects in this series were that invariant violated, four of them passing
 * a test suite (appendix §1's table).
 *
 * Validation is hand-rolled in the style of `isRecord` (mcp-room.ts) — no
 * zod, no new dependency.
 */

import { UnroutedDeliveryError, deliveryModeOf, pullMemberStale } from "../rooms/types.ts"
import type { Room, Tier } from "../rooms/types.ts"

// --- audience_list: what the room can honestly say about its members ---

/** Push vs pull (PLAN-02 §2.1): a push recipient has a durable address a
 *  third party holds — we hand off, they hold. A pull recipient has no
 *  address — we hold, they connect and drain. It is the axis of the type,
 *  not a detail: a dashboard that cannot tell them apart will mislead
 *  exactly when it matters. */
export type AudienceDeliveryMode = "push" | "pull"

/** Presence is NOT membership (appendix §7.1): `"away"` marks a stale PULL
 *  member — one that has not drained its outbox for over `PULL_STALE_MS`.
 *  It is still a member, still holding its id, and MUST NOT be removed
 *  (removing it would make the next tab visit a new principal whose cursor
 *  starts past everything sent meanwhile). The union — rather than a
 *  boolean that invites `if (!present) skip` — exists so a caller must
 *  spell out what away means to it; treating away as gone is the `Ecran`
 *  failure this shape exists to prevent. Push members are never away: their
 *  transport hand-off is the whole story. */
export type AudiencePresence = "present" | "away"

export interface AudienceMember {
  /** The stable id. Address by THIS, never by display name — names collide
   *  and change (mcp-room.ts's roster rationale). */
  readonly memberId: string
  /** For prose only. */
  readonly displayName: string
  readonly mode: AudienceDeliveryMode
  /** The channel the member is on: telegram, whatsapp, email, console,
   *  room-web. Two messengers share a tier and differ by surface. */
  readonly surface: string
  readonly tier: Tier
  readonly presence: AudiencePresence
  readonly joinedAt: string
}

export interface AudienceListResult {
  readonly members: readonly AudienceMember[]
  readonly count: number
}

/** `audience_list` (generalises the `roster` tool). The room is fixed by
 *  the caller's credential, never by an argument — an argument naming a
 *  room would be a way to address another room, exactly what the token
 *  exists to prevent (mcp-room.ts, ROSTER_TOOL). `nowMs` is injectable so
 *  staleness is testable; production passes the wall clock. */
export function listAudience(room: Room, nowMs: number): AudienceListResult {
  const members = room.members.map((member) => ({
    memberId: member.id,
    displayName: member.displayName,
    mode: deliveryModeOf(member),
    surface: member.address.provider,
    tier: member.tier,
    presence: pullMemberStale(member, nowMs) ? ("away" as const) : ("present" as const),
    joinedAt: member.joinedAt,
  }))
  return { members, count: members.length }
}

/** `audience_list` takes NO input: the room comes from the credential and
 *  everything else is derived. Every argument key is ignored — including a
 *  hostile `roomCode` — which is the documented behaviour of the `roster`
 *  tool this generalises, and a test pins it (mcp-room.test.ts). */
export interface AudienceListInput {}

export function parseAudienceListArgs(_args: Record<string, unknown>): { value: AudienceListInput } {
  return { value: {} }
}

// --- the confirmation vocabulary (appendix §6) ---

/** Three-valued, never boolean (appendix §6):
 *
 *  - `"transport"` — a push provider accepted the hand-off. There is no
 *    read receipt and there never will be.
 *  - `"recipient"` — the member acked a cursor at or above the record's
 *    seq. The genuinely stronger guarantee.
 *  - **absent** — honest ignorance. It MUST NOT be backfilled by any
 *    migration.
 *
 *  A contract that flattens these into `delivered: boolean` is actively
 *  worse than one that omits the field, because a caller will believe it.
 *
 *  Where confirmation appears: on a DELIVERY RECORD (Delivery.confirmedBy),
 *  read through the per-member outbox drain — never on this list (a member
 *  is not a record) and never on a send result (below). */
export type AudienceConfirmation = "transport" | "recipient"

// --- audience_send: one send, per-recipient outcomes ---

/** The agent-callable send kinds. `"system"` (brief 07) is deliberately
 *  ABSENT: system records are the ROOM's voice, not an agent-callable
 *  audience — exposing one would let an agent mint a join link or a room
 *  notice and impersonate the room. There is no arm for it anywhere below,
 *  and the exhaustive switches make adding one a compile error rather than
 *  an oversight. */
export type AudienceSendKind = "say" | "whisper"

/** `"public"` is `say` (the audience the agent chose, or everyone);
 *  `"private"` is `whisper` — audience_send with a privacy property, NOT a
 *  separate verb. */
export type AudiencePrivacy = "public" | "private"

export interface AudienceSendInput {
  /** The message. Non-empty: an empty send is a bug, not a broadcast. */
  readonly text: string
  /** Address by id, EXPLICITLY (mcp-room.ts, SAY_TOOL / PLAN-02 §3.1):
   *  omitting it means "every current member" DELIBERATELY — the
   *  deliberately-chosen whole, resolved at call time by `resolveTargets`.
   *  It must never become a fallback a mangled id falls into: an id that
   *  matches nobody is reported in `unknown` and delivers to NOBODY — not a
   *  partial send, not a broadcast, not a throw. For `"private"` there is
   *  exactly one id. */
  readonly to?: readonly string[]
  readonly privacy: AudiencePrivacy
}

/** `isRecord`'s sibling (mcp-room.ts): a guard, so validation narrows
 *  without a cast. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

/** Runtime validation of raw tool arguments, in `isRecord`'s style. Error
 *  strings name the ARGUMENT, never its value (mcp-room.ts, HARD RULE): a
 *  bad call must not project the message onto the shared screen. */
export function parseAudienceSendArgs(
  args: Record<string, unknown>,
  privacy: AudiencePrivacy,
): { input: AudienceSendInput } | { error: string } {
  const text = args.text
  if (typeof text !== "string" || text.trim().length === 0) {
    return { error: `invalid arguments: audience_send requires a non-empty text string` }
  }
  const to = args.to
  if (privacy === "private") {
    if (typeof to !== "string" || to.trim().length === 0) {
      return { error: "invalid arguments: a private send requires a `to` member_id string (from audience_list)" }
    }
    return { input: { text, privacy, to: [to] } }
  }
  if (to === undefined) return { input: { text, privacy } }
  if (!isStringArray(to) || to.some((id) => id.trim().length === 0)) {
    return { error: "invalid arguments: audience_send's `to` must be an array of member_id strings (from audience_list)" }
  }
  return { input: { text, privacy, to: to.map((id) => id.trim()) } }
}

/** The one thing a send backend must do: accept the send for delivery and
 *  resolve the ids against the room's CURRENT members. `DeliveryEngine`
 *  satisfies this structurally (its `kind` also admits `"system"` — wider
 *  parameter, still assignable). The return means ACCEPTED FOR DELIVERY,
 *  never delivered (mcp-room.ts, SAY_TOOL): the persisted `pending` record,
 *  not a tool receipt, is the at-least-once guarantee (appendix §4.1). */
export interface AudienceSendBackend {
  accept(
    code: string,
    kind: AudienceSendKind,
    text: string,
    memberIds: readonly string[],
  ): Promise<{ accepted: readonly string[]; unknown: readonly string[] }>
}

/** Omitted `to` = every current member, EXPLICITLY. Deliberate, not a
 *  default-by-omission: resolution happens here, against the roster at call
 *  time, so a stale cached id can never silently widen into a broadcast. */
export function resolveTargets(room: Room, to: readonly string[] | undefined): readonly string[] {
  return to ?? room.members.map((member) => member.id)
}

/** The outcome of one send. EITHER arm is a normal return — nothing here
 *  throws at an agent:
 *
 *  - `ok: true` carries the PER-RECIPIENT outcomes: `accepted` means
 *    accepted for delivery (NOT delivered — the wording is load-bearing,
 *    mcp-room.ts), `unknown` lists ids that matched nobody and received
 *    nothing.
 *  - `ok: false, reason: "unroutable"` — an unroutable member is an
 *    OUTCOME, not an exception (brief 07's lesson: `UnroutedDeliveryError`
 *    was escaping through `transport.send` and taking room creation down
 *    with it; the room lifecycle boundary now catches it, and this contract
 *    makes the conversion explicit so a second implementation inherits it).
 *    The message names the member, never the message text (the HARD RULE). */
export type AudienceSendOutcome =
  | { readonly ok: true; readonly accepted: readonly string[]; readonly unknown: readonly string[] }
  | { readonly ok: false; readonly reason: "unroutable"; readonly message: string }

/** Privacy → kind, as an exhaustive switch with no default: adding a privacy
 *  arm forces the author to name the kind it maps to. There is no arm that
 *  reaches `"system"` — see `AudienceSendKind`. */
function kindOf(privacy: AudiencePrivacy): AudienceSendKind {
  switch (privacy) {
    case "public":
      return "say"
    case "private":
      return "whisper"
  }
}

/** One send, end to end: resolve the targets (omitted `to` = every member,
 *  deliberately), hand them to the backend, and convert an
 *  `UnroutedDeliveryError` into the `unroutable` outcome instead of letting
 *  it escape as an exception. Any OTHER error still throws — only the
 *  routing failure has an honest outcome. */
export async function sendAudience(
  room: Room,
  backend: AudienceSendBackend,
  input: AudienceSendInput,
): Promise<AudienceSendOutcome> {
  const targets = resolveTargets(room, input.to)
  try {
    const outcome = await backend.accept(room.code, kindOf(input.privacy), input.text, targets)
    return { ok: true, accepted: outcome.accepted, unknown: outcome.unknown }
  } catch (error) {
    if (error instanceof UnroutedDeliveryError) {
      return { ok: false, reason: "unroutable", message: error.message }
    }
    throw error
  }
}

// --- the private-send notices (part of the semantics, not a side effect) ---

/** What the TARGET of a private send receives, once: the text, marked
 *  private. Expressed here because the marking IS the privacy semantics —
 *  a backend that delivered the bare text would leak it to whatever the
 *  target's surface projects (mcp-room.ts HARD RULE). */
export function privateDeliveryText(text: string): string {
  return `(private) ${text}`
}

/** What every OTHER member is told when a private send LANDS on its target
 *  (mcp-room.ts, WHISPER_TOOL; the same observable visibility the announced
 *  `[[whisper]]` marker had): the fact that a whisper happened, NEVER its
 *  content. Sent only on success — announcing a whisper that failed to
 *  arrive would be a lie. This is contract, not implementation detail: a
 *  second backend MUST emit it, and the tests pin its exact text. */
export function whisperNoticeOf(displayName: string): string {
  return `(the agent whispered to ${displayName})`
}
