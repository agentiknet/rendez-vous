/**
 * Off-turn delivery for the room's `say`/`whisper` tools (PLAN §3.2/§3.3).
 *
 * The MCP tool handler only ACCEPTS: it validates member ids, writes one
 * `pending` `Delivery` record per resolved member, and returns immediately —
 * a provider send must never stall the agent's turn, and the persisted
 * record (not a tool receipt) is the at-least-once guarantee. This engine
 * drains those records: after the handler returns, and again on boot for
 * whatever a dead process left `pending`.
 *
 * Delivery reuses the SAME transport and the SAME per-tier rendering as
 * `RoomFanout.flush` (`renderForTier`), so a `room-web` member draws no
 * transport call at all (render.ts returns `undefined` for that tier) and
 * the messenger length cap still applies. It is strictly additive: nothing
 * here reads `Room.protocol`, and bare agent text keeps flowing exactly as
 * it does today.
 */

import { renderForTier } from "../fanout/render.ts"
import type { OutboundMessage, Transport } from "../fanout/types.ts"
import type { RoomStore } from "../rooms/store.ts"
import {
  MAX_DELIVERY_ATTEMPTS,
  type Delivery,
  type Member,
  deliverySeqOf,
  retentionFloors,
} from "../rooms/types.ts"

/** Per-send hard timeout. Deliberately NOT the 2s house budget (that is for
 *  probes of things on our own tunnel, reader.ts): this wait covers a real
 *  provider send — tunnel → agentpush → WhatsApp/Telegram — where 2s cuts
 *  off healthy sends. 10s bounds one member's failure so a hanging provider
 *  cannot stall the other members' deliveries behind it. */
export const SEND_TIMEOUT_MS = 10_000

/** How many `delivered` records one room keeps, newest first.
 *
 *  `deliveries` is a work queue, not a log — but a completed record is worth
 *  keeping for a moment: it is the only way to answer "did that whisper
 *  actually land, and when?" while the conversation it belongs to is still
 *  happening. Past that, it is dead weight with three costs, and the count cap
 *  and the age window below each close one the other cannot:
 *
 *  - `RoomStore.persist` serializes the WHOLE store on every write
 *    (store.ts:277-283), so an unbounded array in one busy room taxes every
 *    unrelated room's update. Only a COUNT cap bounds that: a room can take
 *    thousands of deliveries inside any time window.
 *  - a `whisper` record holds private text at rest, in a room whose whole
 *    point is that the content was private. Only an AGE window retires that:
 *    a quiet room that took five whispers and stopped never reaches a count
 *    cap, and would keep them forever.
 *  - the file is re-read and re-validated on boot (`RoomStore.open`).
 *
 *  20 records is roughly a couple of turns' worth of fan-out in a full room
 *  (one per member per `say`), so the answer to "did it land" survives the
 *  turn that asked. One hour outlives any single conversation without
 *  outliving the day.
 *
 *  `pending` and `failed` are NEVER pruned, whatever their age: `drainAll`
 *  retries `pending` on boot — that is the at-least-once guarantee — and a
 *  `failed` record is the evidence behind the correction the agent was sent. */
export const MAX_RETAINED_DELIVERED = 20

/** How long a `delivered` record is kept. See `MAX_RETAINED_DELIVERED`. */
export const DELIVERED_RETENTION_MS = 60 * 60 * 1000

/** What `Room.spokenSeq` becomes when a batch of `kind` records is minted at
 *  `seq` (brief 08): the detector's counter moves ONLY for the agent's own
 *  audience kinds, so a `system` record — a join link, a QR caption, a
 *  resume notice, a pull member's turn text — must never silence the
 *  silent-turn warning (absence reading as delivery, appendix §1, sixth
 *  row). A `switch` over the union with no `default` arm, so the compiler —
 *  not a forgotten `if` — is what tells the next kind added here to decide.
 *  Returns `undefined` when the kind must not move the counter; the caller
 *  omits the key, and absent reads as 0 ("has not spoken"), erring toward
 *  the warning. */
function spokenSeqFor(kind: Delivery["kind"], seq: number): number | undefined {
  switch (kind) {
    case "say":
    case "whisper":
      return seq
    case "system":
      return undefined
  }
}

/** Drop `delivered` records that are past the retention window or beyond the
 *  newest `MAX_RETAINED_DELIVERED`; keep every `pending` and `failed` one, and
 *  keep the surviving records in their original order.
 *
 *  Drop `delivered` records that are past the retention window or beyond the
 *  newest `MAX_RETAINED_DELIVERED`; keep every `pending` and `failed` one, and
 *  keep the surviving records in their original order.
 *
 *  `floors` is the room's per-member retention floors (PLAN-02 §3-D6 as
 *  amended by brief A, `retentionFloors`): a `delivered` record is kept iff
 *  its OWNER is a live pull member AND its seq is above THAT member's floor —
 *  it is that member's undrained mail, not completed work, and pruning it
 *  would be the silent-loss fault D6 exists to prevent. Everything else
 *  prunes exactly as it does today.
 *
 *  THE FLOOR IS PER-MEMBER (brief A): a delivery belongs to exactly one
 *  member (`Delivery.memberId`), so one laggard tab pins ONLY its own
 *  records. The room-wide floor this replaces was a conservative
 *  over-approximation with a real cost — one laggard tab held every other
 *  member's records, including push records that had nothing to do with it,
 *  and the count cap stopped bounding anything above the floor.
 *
 *  THE COST THIS REOPENS, RE-BUDGETED (brief A): the count cap existed
 *  because `RoomStore.persist` serializes the whole store on every write.
 *  What the floors hold is now, per live pull member, exactly that member's
 *  own undrained tail — bounded by its liveness, and the stale release is
 *  the bound: a member's unacked holdings are capped at ~PULL_STALE_MS (90 s)
 *  of fan-out ≈ 45 records per member. Worst case accepted: five pull
 *  members ALL lagging at a sustained turn every 10 s ≈ 225 records ≈ a few
 *  hundred KB of JSON per persist — the same ceiling as before, but reached
 *  only when every member lags at once; one laggard now costs ~45 records,
 *  not 225, and the push tail is bounded by the cap and the age window
 *  again. Released automatically once a member goes stale, with the gap
 *  marker telling its tab what happened.
 *
 *  A `delivered` record whose timestamps cannot be parsed is dropped rather
 *  than kept: an undateable record can never age out, which is exactly the
 *  unbounded retention this prune exists to prevent — unless its owner's
 *  floor holds it, in which case the stale release is what eventually drops
 *  it. Survivors are selected by ARRAY INDEX, not by id, so the prune is
 *  correct even on a legacy room whose length-derived ids collide
 *  (`Room.deliverySeq`). */
export function pruneDeliveries(
  deliveries: readonly Delivery[],
  nowMs: number,
  floors?: ReadonlyMap<string, number>,
): Delivery[] {
  const keep = new Set<number>()
  // The floors first: these records survive whatever their age and whatever
  // the count cap says — overriding BOTH axes (brief C), including the
  // undateable drop, until the stale release takes the floor away. A record
  // whose owner has no floor (push, or a stale-released pull member) is
  // never held by someone else's lag (brief A). The cap below then only
  // counts records it keeps ON ITS OWN authority, so floor-protected records
  // never crowd the retained tail out.
  if (floors !== undefined) {
    for (let index = 0; index < deliveries.length; index += 1) {
      const delivery = deliveries[index]
      if (delivery === undefined || delivery.status !== "delivered") continue
      const floor = floors.get(delivery.memberId)
      if (floor === undefined) continue
      if (deliverySeqOf(delivery.id) > floor) keep.add(index)
    }
  }
  let capped = 0
  for (let index = deliveries.length - 1; index >= 0 && capped < MAX_RETAINED_DELIVERED; index -= 1) {
    const delivery = deliveries[index]
    if (delivery === undefined || delivery.status !== "delivered" || keep.has(index)) continue
    const stamp = Date.parse(delivery.deliveredAt ?? delivery.createdAt)
    if (Number.isNaN(stamp) || nowMs - stamp > DELIVERED_RETENTION_MS) continue
    keep.add(index)
    capped += 1
  }
  return deliveries.filter((delivery, index) => delivery.status !== "delivered" || keep.has(index))
}

/** The room's new low-water mark after a prune (brief B): the HIGHEST seq the
 *  prune actually dropped, whoever owned it. Per-member floors mean different
 *  members' records prune at different times, so the mark must be the max
 *  over what was ACTUALLY dropped — never a guess from what survived. The
 *  mark is monotonic (`RoomStore.update` never lets it decrease), so callers
 *  may pass `undefined` when nothing was dropped: the previous mark stands. */
export function prunedUpTo(before: readonly Delivery[], after: readonly Delivery[]): number | undefined {
  const kept = new Set(after.map((delivery) => delivery.id))
  let highest: number | undefined
  for (const delivery of before) {
    if (delivery.status !== "delivered" || kept.has(delivery.id)) continue
    const seq = deliverySeqOf(delivery.id)
    if (highest === undefined || seq > highest) highest = seq
  }
  return highest
}

export interface DeliveryEngineOpts {
  readonly store: RoomStore
  readonly transport: Transport
  /** The reactive fan-in for a FINAL failure — the same `queue: true`
   *  prompt path `reportUnservableArtifacts` uses (room-service.ts). One
   *  ingestion path stays the only path; no second outbound-failure channel
   *  is added here. */
  readonly reportFailure?: (code: string, correction: string) => Promise<void>
  /** Injectable clock for tests. */
  readonly now?: () => string
  /** Overrides `SEND_TIMEOUT_MS` — tests inject a small value so a hanging
   *  provider is provable without waiting real seconds. */
  readonly sendTimeoutMs?: number
  /** `false` only in tests: the engine-level suites then drive `drain`
   *  explicitly, so each assertion is deterministic. */
  readonly autoDrain?: boolean
}

export interface AcceptOutcome {
  readonly accepted: readonly string[]
  readonly unknown: readonly string[]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`transport send timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export class DeliveryEngine {
  private readonly store: RoomStore
  private readonly transport: Transport
  private readonly reportFailure: ((code: string, correction: string) => Promise<void>) | undefined
  private readonly now: () => string
  private readonly sendTimeoutMs: number
  private readonly autoDrain: boolean
  /** Per-room serialization for drains (same shape as `RoomService`'s
   *  `withRoomLock`): a background drain kicked by `accept` and a caller's
   *  explicit `drain` must never attempt the same record concurrently —
   *  two readers of the same `failures` counter would lose an increment
   *  and could double-send. Each slot holds only the tail of that room's
   *  own chain. */
  private readonly locks = new Map<string, Promise<void>>()

  constructor(opts: DeliveryEngineOpts) {
    this.store = opts.store
    this.transport = opts.transport
    this.reportFailure = opts.reportFailure
    this.now = opts.now ?? (() => new Date().toISOString())
    this.sendTimeoutMs = opts.sendTimeoutMs ?? SEND_TIMEOUT_MS
    this.autoDrain = opts.autoDrain ?? true
  }

  /** The tool handler's half: resolve `memberIds` against the room's CURRENT
   *  members, write one `pending` record per resolved member, and schedule
   *  the drain WITHOUT awaiting it — the return value means *accepted for
   *  delivery*, not *delivered*. An id matching nobody goes in `unknown`
   *  and is delivered to nobody; there is no fallback to broadcast
   *  (`Member.id` is not stable across a leave/rejoin, so a stale cached id
   *  is a normal occurrence, not an anomaly). */
  async accept(
    code: string,
    kind: Delivery["kind"],
    text: string,
    memberIds: readonly string[],
  ): Promise<AcceptOutcome> {
    const room = this.store.get(code)
    if (room === undefined) throw new Error(`unknown room: ${code}`)

    const known = new Set(room.members.map((member) => member.id))
    const accepted: string[] = []
    const unknown: string[] = []
    for (const memberId of memberIds) {
      if (known.has(memberId)) accepted.push(memberId)
      else unknown.push(memberId)
    }

    if (accepted.length > 0) {
      const now = this.now()
      // The counter, never the array length: the array is pruned, so a
      // length-derived id would be handed out twice and `mark` would patch
      // the wrong record. `deliveries.length` is only the fallback for a room
      // written before the counter existed, whose ids are exactly `d1..dN`.
      const lastSeq = room.deliverySeq ?? room.deliveries?.length ?? 0
      const created: Delivery[] = accepted.map((memberId, index) => ({
        id: `d${lastSeq + index + 1}`,
        memberId,
        kind,
        text,
        status: "pending",
        failures: 0,
        lastError: undefined,
        createdAt: now,
        deliveredAt: undefined,
      }))
      const nowMs = this.nowMs()
      const before = [...(room.deliveries ?? []), ...created]
      // The prune carries the room's per-member retention floors: a live pull
      // member's undrained records survive the cap and the age window — its
      // own records only, never anyone else's (brief A). Whatever the prune
      // dropped raises the room's low-water mark (brief B).
      const after = pruneDeliveries(before, nowMs, retentionFloors(room, nowMs))
      const pruned = prunedUpTo(before, after)
      // `spokenSeq` moves with the mint, in the SAME patch that mints the
      // records: the mint is the event, not the later `delivered`/`failed`
      // status (an agent that called `say` into a dead transport did speak —
      // the failure is reported on its own channel). `system` mints leave it
      // where it was, so the room's own notices never read as speech.
      const spoken = spokenSeqFor(kind, lastSeq + created.length)
      await this.store.update(code, {
        deliveries: after,
        ...(pruned !== undefined ? { deliveryLowWater: pruned } : {}),
        deliverySeq: lastSeq + created.length,
        ...(spoken !== undefined ? { spokenSeq: spoken } : {}),
      })
      if (this.autoDrain) {
        // Off the handler's critical path: the tool has already returned
        // "accepted"; provider latency must not stall the agent's turn.
        void this.drain(code)
      }
    }

    return { accepted, unknown }
  }

  /** Attempt every `pending` delivery still under the retry cap for one
   *  room. Never throws. */
  drain(code: string): Promise<void> {
    const previous = this.locks.get(code) ?? Promise.resolve()
    const run = previous.then(
      () => this.drainRoom(code),
      () => this.drainRoom(code),
    )
    this.locks.set(
      code,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    return run
  }

  /** Boot-time retry: every `pending` record under the cap, in every room.
   *  This is the at-least-once guarantee for a process that died between
   *  acceptance and delivery — per member, on top of the cursor's per-turn
   *  one, which stays untouched. */
  async drainAll(): Promise<void> {
    await Promise.all(this.store.list().map((room) => this.drain(room.code)))
  }

  /** The cursor acknowledgement (PLAN-02 step 4, brief A): the client claims
   *  it has rendered everything up to `seq`. Monotonic — a backwards ack is
   *  IGNORED, not an error, so a client replaying an old response can never
   *  rewind the retention floor. On an advancing ack, every delivered record
   *  of this member at or below `seq` becomes `confirmedBy: "recipient"`:
   *  the genuinely stronger guarantee (D2), real only because the client
   *  itself asserted receipt. Never backfilled by a migration — records that
   *  predate the ack stay honestly unconfirmed until THIS member's own ack
   *  covers them.
   *
   *  CURSOR SEMANTICS (brief F, the cursor-outran-the-record gap): a cursor
   *  may only advance past records the client ACTUALLY RECEIVED — never to
   *  the room-wide `deliverySeq`, which can sit past records still `pending`
   *  (this member's or anyone's). The page therefore acks the highest seq it
   *  rendered, after rendering (src/web/page.ts), and this endpoint is a
   *  POST, never a side effect on the GET. A record still pending below an
   *  acked cursor is closed honestly: when its drain completes it, the pull
   *  branch above marks it `confirmedBy: "recipient"` — the recipient did
   *  already receive it. */
  async ackCursor(code: string, memberId: string, seq: number): Promise<"applied" | "ignored"> {
    const room = this.store.get(code)
    if (room === undefined) throw new Error(`unknown room: ${code}`)
    const member = room.members.find((candidate) => candidate.id === memberId)
    if (member === undefined) return "ignored"
    const outcome = await this.store.ackCursor(code, memberId, seq, this.now())
    if (outcome === "applied") {
      const deliveries = (this.store.get(code)?.deliveries ?? []).map((delivery) =>
        delivery.memberId === memberId &&
        delivery.status === "delivered" &&
        delivery.confirmedBy === undefined &&
        deliverySeqOf(delivery.id) <= seq
          ? { ...delivery, confirmedBy: "recipient" as const }
          : delivery,
      )
      await this.store.update(code, { deliveries })
    }
    return outcome
  }

  private async drainRoom(code: string): Promise<void> {
    const room = this.store.get(code)
    if (room === undefined) return
    const pending = (room.deliveries ?? []).filter(
      (delivery) => delivery.status === "pending" && delivery.failures < MAX_DELIVERY_ATTEMPTS,
    )
    for (const delivery of pending) {
      await this.attempt(code, delivery)
    }
  }

  /** One delivery to one member. A member who left between acceptance and
   *  drain is an ordinary failure (failures + 1, retry, then `failed`) —
   *  their text is never broadcast to anyone else. */
  private async attempt(code: string, delivery: Delivery): Promise<void> {
    const room = this.store.get(code)
    if (room === undefined) return
    const member = room.members.find((candidate) => candidate.id === delivery.memberId)

    let lastError: string | undefined
    if (member === undefined) {
      lastError = `member ${delivery.memberId} is no longer in the room`
    } else {
      const message = this.renderFor(code, delivery, member)
      if (message === undefined) {
        // The pull tier gets nothing over the transport (render.ts) — the
        // record sits in the outbox where the member drains it. Confirmed by
        // the transport it is not: either the recipient's cursor already
        // covers this seq (it drained it while the record was still
        // `pending` — see `ackCursor`'s cursor-semantics note), or it stays
        // honestly unconfirmed until the ack lands.
        const alreadyAcked = member.ackedSeq !== undefined && deliverySeqOf(delivery.id) <= member.ackedSeq
        await this.mark(code, delivery.id, {
          status: "delivered",
          deliveredAt: this.now(),
          ...(alreadyAcked ? { confirmedBy: "recipient" as const } : {}),
        })
        return
      }
      try {
        await withTimeout(this.transport.send(member, message), this.sendTimeoutMs)
        // A push hand-off the provider accepted is confirmed by the
        // transport — the only confirmation that exists today (D2/F8).
        await this.mark(code, delivery.id, {
          status: "delivered",
          deliveredAt: this.now(),
          confirmedBy: "transport",
        })
        if (delivery.kind === "whisper") {
          await this.announceWhisper(code, member)
        }
        return
      } catch (error: unknown) {
        lastError = messageOf(error)
      }
    }

    const failures = delivery.failures + 1
    const failed = failures >= MAX_DELIVERY_ATTEMPTS
    await this.mark(code, delivery.id, {
      failures,
      status: failed ? "failed" : "pending",
      lastError,
    })
    if (failed) await this.reportFinalFailure(code, delivery, failures, lastError)
  }

  /** The content-free notice every OTHER member sees once a whisper has
   *  actually landed on its target — the same observable visibility an
   *  announced `[[whisper]]` marker gets (whisper.ts:209-211: the room is
   *  told the whisper happened, never its content; room-web is a screen,
   *  and `renderForTier` already returns `undefined` for it). Sent only on
   *  success: announcing a whisper that failed to arrive would be a lie.
   *  A notice send that throws is logged, never fatal. */
  private async announceWhisper(code: string, target: Member): Promise<void> {
    const room = this.store.get(code)
    if (room === undefined) return
    const notice = `(the agent whispered to ${target.displayName})`
    for (const member of room.members) {
      if (member.id === target.id) continue
      const message = renderForTier(member.tier, notice, undefined, false)
      if (message === undefined) continue
      try {
        await withTimeout(this.transport.send(member, message), this.sendTimeoutMs)
      } catch (error: unknown) {
        console.error(`failed to announce a whisper to ${member.id} in ${code}: ${messageOf(error)}`)
      }
    }
  }

  /** Per-tier rendering, shared with `RoomFanout.flush`. `artifactUrl` is
   *  deliberately `undefined`: a tool-addressed message is a conversational
   *  send, not a turn flush, and must not append an artifact notice of its
   *  own. For a whisper, the target gets the text and every other
   *  messenger/email member gets the content-free notice — the same
   *  observable visibility `renderWhisperForMember` gives an announced
   *  whisper (whisper.ts). */
  private renderFor(code: string, delivery: Delivery, member: Member): OutboundMessage | undefined {
    let text: string
    if (delivery.kind === "whisper") {
      if (delivery.memberId === member.id) {
        text = `(private) ${delivery.text}`
      } else {
        const targetName =
          this.store.get(code)?.members.find((candidate) => candidate.id === delivery.memberId)?.displayName ??
          "a member"
        text = `(the agent whispered to ${targetName})`
      }
    } else {
      text = delivery.text
    }
    return renderForTier(member.tier, text, undefined, false)
  }

  private async mark(
    code: string,
    deliveryId: string,
    patch: Partial<Pick<Delivery, "status" | "failures" | "confirmedBy" | "lastError" | "deliveredAt">>,
  ): Promise<void> {
    const room = this.store.get(code)
    if (room === undefined) return
    const deliveries = (room.deliveries ?? []).map((delivery) =>
      delivery.id === deliveryId ? { ...delivery, ...patch } : delivery,
    )
    // Prune on the same write that completes a record, so a long-lived room
    // never carries more than the retained tail between two drains. A record
    // just marked `delivered` always survives its own prune — it is dated
    // `now`, and `drainRoom` walks pending records in array order, so it is
    // also the highest-indexed delivered one. A caller can still read back the
    // status it just caused. The prune carries the room's per-member retention
    // floors (brief A): a live pull member's undrained records survive both
    // axes — its own records only. Whatever the prune dropped raises the
    // room's low-water mark (brief B).
    const nowMs = this.nowMs()
    const after = pruneDeliveries(deliveries, nowMs, retentionFloors(room, nowMs))
    const pruned = prunedUpTo(deliveries, after)
    await this.store.update(code, {
      deliveries: after,
      ...(pruned !== undefined ? { deliveryLowWater: pruned } : {}),
    })
  }

  /** `now()` as epoch millis, for the retention window. Falls back to the real
   *  clock if an injected clock returns something `Date.parse` cannot read —
   *  an unparseable "now" would make every record look infinitely old and
   *  prune the whole tail. */
  private nowMs(): number {
    const parsed = Date.parse(this.now())
    return Number.isNaN(parsed) ? Date.now() : parsed
  }

  /** The reactive correction on final failure — same `queue: true` fan-in
   *  path as `reportUnservableArtifacts`. Ids and counts only: the raw
   *  transport error stays in `lastError` and is deliberately NOT echoed
   *  into the session, because a provider error can echo payload fragments
   *  and this prompt is projected on the shared transcript. Never throws:
   *  a failed correction is logged, and the record is already `failed`. */
  private async reportFinalFailure(
    code: string,
    delivery: Delivery,
    failures: number,
    lastError: string | undefined,
  ): Promise<void> {
    const report = this.reportFailure
    if (report === undefined) return
    const correction =
      `[system · delivery] A ${delivery.kind} message you sent did NOT reach member ${delivery.memberId}: ` +
      `the transport failed ${failures} times (last error: ${lastError ?? "unknown"}). ` +
      `Re-read the roster — the member may have left — and send it again if it still matters.`
    try {
      await report(code, correction)
    } catch (error: unknown) {
      console.error(`failed to report delivery failure in ${code}: ${messageOf(error)}`)
    }
  }
}
