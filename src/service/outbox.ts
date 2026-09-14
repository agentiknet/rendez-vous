/**
 * The per-member outbox READ (PLAN-02 §3-D4/D6) — one implementation, shared
 * by the HTTP drain (`GET /rooms/:code/outbox`, http.ts) and the personal
 * mount's `rendezvous_drain` (mcp-personal.ts, BRIEF-12). It lives here, not
 * in http.ts, because mcp-personal must call it without importing the HTTP
 * server (which imports mcp-personal), and because "do not re-implement the
 * filter" is only true if there is one filter to call.
 */
import { deliverySeqOf, type Delivery, type Member, type Room } from "../rooms/types.ts"

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

export function outboxFor(room: Room, member: Member, since: number, sinceGiven: boolean): OutboxPayload {
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
