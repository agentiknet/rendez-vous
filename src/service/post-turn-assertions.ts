/**
 * The post-turn assertion set (plan doc BRIEF-15, post-turn-assertions —
 * distinct from the unrelated AG-UI "BRIEF-15" already in this codebase's
 * comments/docs/OUTBOX.md, a numbering collision between two separate brief
 * sequences).
 *
 * The rule that decides what belongs here: an assertion goes in only if a
 * fact ALREADY IN THE RECORD decides it — never a judgement about quality,
 * tone or relevance, and never a model call. Every violation is reported the
 * same way: a warning in the service log naming the assertion and the room,
 * and a `system` delivery — the room's own voice (`AudienceSendKind`
 * deliberately excludes it from what an agent can send) — broadcast to
 * every current member, so the failure is visible exactly where it
 * happened. This module only ever ADDS a message: it never mutates the
 * turn, retries a send, or alters an existing delivery — an assertion that
 * quietly fixed things would re-create the class of bug it exists to catch.
 */

import type { Delivery, Member, Room } from "../rooms/types.ts"
import type { MemberSender } from "./member-send.ts"

export type PostTurnAssertion =
  | "silent-turn"
  | "send-reached-nobody"
  | "ambiguous-sender"
  | "turn-answered-nobody"

/** Assertion 2: `AudienceSendOutcome` with `accepted` empty and `unknown`
 *  non-empty — every id the agent explicitly named was unknown, so the send
 *  reached nobody. `unknown` must be non-empty too: a send with no targets
 *  at all (nobody was named, or the room has no members) named nothing
 *  wrong, so it is not this. */
export function sendReachedNobody(outcome: {
  readonly accepted: readonly string[]
  readonly unknown: readonly string[]
}): boolean {
  return outcome.accepted.length === 0 && outcome.unknown.length > 0
}

/** Assertion 4: an inbound message from `triggerMemberId` started this turn,
 *  and none of the say/whisper/system deliveries minted during it named them
 *  back — a `system` record delivered to that member is the room telling them
 *  something and counts as having been answered. `tool` records are never
 *  audience speech (`delivery.ts`'s `spokenSeqFor` draws the same line) and
 *  play no part here. */
export function turnAnsweredNobody(
  triggerMemberId: string,
  mintedThisTurn: readonly Pick<Delivery, "kind" | "memberId">[],
): boolean {
  return !mintedThisTurn.some(
    (delivery) =>
      (delivery.kind === "say" || delivery.kind === "whisper" || delivery.kind === "system") &&
      delivery.memberId === triggerMemberId,
  )
}

/** How every violation in the set is reported — the one mechanism shared by
 *  all four assertions, so folding assertion 1 (the pre-existing silent-turn
 *  detector) into the set means it inherits this too, on top of its
 *  unchanged detection logic.
 *
 *  `memberId` is the member the assertion is about — the only recipient.
 *  `humanText` is what the member sees: plain language, no UUIDs, no room
 *  codes, no assertion names. A violation with no member subject must log
 *  directly at the call site instead. */
export async function reportAssertionViolation(
  sender: MemberSender,
  room: Room,
  assertion: PostTurnAssertion,
  detail: string,
  memberId: string,
  humanText: string,
): Promise<void> {
  console.warn(`post-turn assertion violated: "${assertion}" in room ${room.code} — ${detail}`)
  const member = room.members.find((m: Member) => m.id === memberId)
  if (member === undefined) {
    console.warn(`post-turn assertion: member ${memberId} not found in room ${room.code} — nothing delivered`)
    return
  }
  await sender.send(room.code, member, { text: humanText, artifactUrl: undefined })
}
