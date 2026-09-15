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
import { SendBlockedError } from "../fanout/types.ts"
import { whisperNoticeOf } from "../audience/contract.ts"
import type { RoomStore } from "../rooms/store.ts"
import { hasSendAttachment } from "./transports.ts"
import {
  MAX_DELIVERY_ATTEMPTS,
  type Delivery,
  type DeliveryAttachment,
  type Member,
  deliveryModeOf,
  deliverySeqOf,
  retentionFloors,
  sameHumanName,
} from "../rooms/types.ts"

/** Per-send hard timeout. Deliberately NOT the 2s house budget (that is for
 *  probes of things on our own tunnel, reader.ts): this wait covers a real
 *  provider send — tunnel → agentpush → WhatsApp/Telegram — where 2s cuts
 *  off healthy sends. 10s bounds one member's failure so a hanging provider
 *  cannot stall the other members' deliveries behind it. */
export const SEND_TIMEOUT_MS = 10_000

/** How many times `whenIdle` re-checks for drains a drain itself started
 *  before it gives up waiting. A real shutdown settles on the first or
 *  second pass; the cap only exists so a report→accept→drain cycle that
 *  never converges cannot hang the caller instead of failing it. */
const WHEN_IDLE_MAX_PASSES = 32

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
    // A turn that ONLY rendered a document did not speak. Moving the counter
    // here would silence the silent-turn warning for exactly the turn most
    // likely to need it: the agent produced an artifact and told nobody.
    case "tool":
      return undefined
    // BRIEF-44: an attachment is a file, not speech. The say/whisper turn
    // that carried the `[[attach …]]` marker already moved the counter with
    // its own record, so moving it again here would double-count; treating
    // the file as speech would silence the silent-turn warning for exactly
    // the turn that produced a file and said nothing.
    case "attachment":
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
  /** Brief 36: called synchronously on every accepted mint, with the room
   *  code, the record kind and the members the records were minted FOR
   *  (the accepted ids — unknown ids mint nothing and never appear). The
   *  post-turn assertion set's trigger obligation discharges HERE rather
   *  than in the fan-out's window check: the delivery that answers a member
   *  can be minted while no fan-out reader exists (the resume banner) and
   *  be swallowed into the next baseline, so a window can never witness
   *  it. Optional — unwired in every engine-level harness. */
  readonly onMint?: (code: string, kind: Delivery["kind"], memberIds: readonly string[]) => void
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
  private readonly onMint: ((code: string, kind: Delivery["kind"], memberIds: readonly string[]) => void) | undefined
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
    this.onMint = opts.onMint
  }

  /** The tool handler's half: resolve `memberIds` against the room's CURRENT
   *  members, write one `pending` record per resolved member, and schedule
   *  the drain WITHOUT awaiting it — the return value means *accepted for
   *  delivery*, not *delivered*. An id matching nobody goes in `unknown`
   *  and is delivered to nobody; there is no fallback to broadcast
   *  (`Member.id` is not stable across a leave/rejoin, so a stale cached id
   *  is a normal occurrence, not an anomaly).
   *
   *  BRIEF-43 — a resolved recipient mints for THAT recipient, and for that
   *  recipient alone. A `member_id` is a surface, and the agent can see
   *  surfaces (the inbound prefix carries the channel, `roster` returns each
   *  member's id next to their surface), so one id in, one record minted:
   *  the accept outcome `{accepted, unknown}` means exactly what it says
   *  again. Addressing the whole human is the agent's own deliberate act —
   *  naming all of the person's ids in `to`, or broadcasting — and
   *  `booter.ts`'s prompt is what teaches that distinction. This reverses
   *  BRIEF-38's display-name expansion, which overwrote the agent's choice
   *  of surface in the engine and made per-surface addressing impossible by
   *  construction; the BRIEF-38 hole it guarded against (an answer landing
   *  on one device of the human who asked) is closed by the prompt instead.
   *  No other kind is touched (`system` records are per-surface facts,
   *  `tool` records are minted per pull member and a push member must never
   *  receive one), and an unknown id is still unknown — no rescue, ever.
   *
   *  `sameHumanName` stays, for the things that are not addressing:
   *  `announceJoin`'s silence about a second device and `announceWhisper`'s
   *  treatment of a human's own other surface as not-an-outsider. */
  async accept(
    code: string,
    kind: Delivery["kind"],
    text: string,
    memberIds: readonly string[],
    toolName?: string,
    /** BRIEF-44: the file a `kind: "attachment"` mint carries. Present on
     *  attachment records only, like `toolName` on tool records. */
    attachment?: DeliveryAttachment,
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
      await this.mintRecords(code, kind, text, accepted, toolName, true, attachment)
    }

    return { accepted, unknown }
  }

  /** The one mint body: append one `pending` record per recipient, advance the
   *  room's delivery seq, prune, and optionally discharge brief 36's
   *  turn-answered-nobody obligation through `onMint`. `accept` uses it with
   *  `discharge: true`; BRIEF-39's whisper notice mints through it with
   *  `discharge: false` — see `announceWhisper` for why. */
  private async mintRecords(
    code: string,
    kind: Delivery["kind"],
    text: string,
    recipients: readonly string[],
    toolName: string | undefined,
    discharge: boolean,
    attachment?: DeliveryAttachment,
  ): Promise<void> {
    const room = this.store.get(code)
    if (room === undefined) return
    const now = this.now()
    // The counter, never the array length: the array is pruned, so a
    // length-derived id would be handed out twice and `mark` would patch
    // the wrong record. `deliveries.length` is only the fallback for a room
    // written before the counter existed, whose ids are exactly `d1..dN`.
    const lastSeq = room.deliverySeq ?? room.deliveries?.length ?? 0
    const created: Delivery[] = recipients.map((memberId, index) => ({
      id: `d${lastSeq + index + 1}`,
      memberId,
      kind,
      // Written only when supplied, so a non-tool record round-trips
      // through `JSON.stringify` with the key genuinely absent rather than
      // present-and-undefined (the rule `confirmedBy` follows).
      ...(toolName !== undefined ? { toolName } : {}),
      text,
      // BRIEF-44: written only when supplied — a text record round-trips with
      // the key genuinely absent, same rule as `toolName`.
      ...(attachment !== undefined ? { attachment } : {}),
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
    // The mint is the event (see `onMint`'s doc): discharged the moment
    // the records exist, never waiting for a flush that may never see
    // them. Exactly the accepted ids now (BRIEF-43): a mint is for the
    // surfaces the agent named, and no mint exists for a surface the
    // agent did not name — the obligation of a device whose question was
    // not answered must still fire, and the prompt is what tells the
    // agent to name all of a human's ids when the answer concerns them.
    if (discharge) this.onMint?.(code, kind, recipients)
    if (this.autoDrain) {
      // Off the handler's critical path: the tool has already returned
      // "accepted"; provider latency must not stall the agent's turn.
      void this.drain(code)
    }
  }

  /** Record that the agent called a tool, as one `kind: "tool"` record per
   *  PULL member — and per pull member only.
   *
   *  The tier filter is the whole point and lives HERE, at the mint, not in
   *  a transport guard downstream. A messenger member has no surface that
   *  can render a tool call: giving them a record would mean either shipping
   *  `args` JSON to a phone, or minting a record that can never be sent and
   *  then marking it `delivered` anyway — §1's invariant, wearing costume
   *  eleven. A push member simply gets no record, and the absence claims
   *  nothing.
   *
   *  `args` is serialised once, here, so `text` holds exactly the bytes
   *  `TOOL_CALL_ARGS.delta` will carry. Returns the ids of the members that
   *  got a record, so a caller can tell "nobody was watching" from "the room
   *  was told" — the two must never look alike. */
  async recordToolCall(code: string, toolName: string, args: unknown): Promise<AcceptOutcome> {
    const room = this.store.get(code)
    if (room === undefined) throw new Error(`unknown room: ${code}`)
    const watching = room.members.filter((member) => deliveryModeOf(member) === "pull").map((member) => member.id)
    if (watching.length === 0) return { accepted: [], unknown: [] }
    return this.accept(code, "tool", JSON.stringify(args), watching, toolName)
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

  /** Settle every drain currently in flight, including the ones nobody is
   *  holding. `accept` fires its drain off the handler's critical path
   *  (`void this.drain(code)`) and returns before a single byte of the
   *  delivery attempt has been written, so at any instant the engine may
   *  own writes with no awaiter — which is exactly what made
   *  `revive-outcome.test.ts` flake: the room's failure notice was accepted,
   *  the test's assertions ran and passed, and the drain's `mark` was still
   *  persisting into the temp directory when teardown removed it
   *  (`ENOTEMPTY`, seen 2026-09-14). Shutdown is the one place that must
   *  wait.
   *
   *  Re-checks after each pass because a drain can legitimately produce more
   *  work — `reportFinalFailure` reports the correction into the room, which
   *  can accept another record and kick another drain. Capped so a
   *  pathological report/accept cycle cannot hang a shutdown forever; the
   *  caller is already on its way out, and the cap is far above anything a
   *  real room reaches. */
  async whenIdle(): Promise<void> {
    const settled = new Set<Promise<void>>()
    for (let pass = 0; pass < WHEN_IDLE_MAX_PASSES; pass += 1) {
      const pending = Array.from(this.locks.values()).filter((lock) => !settled.has(lock))
      if (pending.length === 0) return
      await Promise.allSettled(pending)
      for (const lock of pending) settled.add(lock)
    }
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
    // Records minted WHILE a drain is running — a BRIEF-39 whisper notice is
    // minted by the very attempt delivering the whisper — must not wait for
    // another drain: they are attempted here, the moment the mint lands.
    // Only NEW ids are picked up (each record attempted at most once per
    // drain call), so the retry semantics — one attempt per record per
    // drain, the cap counted across drains — are untouched. Terminates:
    // the notice mints are finite per whisper (the sibling guard).
    const attempted = new Set<string>()
    for (;;) {
      const room = this.store.get(code)
      if (room === undefined) return
      const fresh = (room.deliveries ?? []).filter(
        (delivery) => delivery.status === "pending" && delivery.failures < MAX_DELIVERY_ATTEMPTS && !attempted.has(delivery.id),
      )
      if (fresh.length === 0) return
      for (const delivery of fresh) {
        attempted.add(delivery.id)
        await this.attempt(code, delivery)
      }
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
      if (message === undefined && deliveryModeOf(member) === "pull") {
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
        // BRIEF-39: the outbox record IS the pull member's delivery — it
        // landed as surely as a transport send. A whisper delivered to a
        // pull member (the projected screen, the camera's surface) must
        // announce exactly like a push one; skipping this arm is the first
        // gate that hid the notice from room-web.
        if (delivery.kind === "whisper") {
          await this.announceWhisper(code, member, delivery)
        }
        return
      }
      if (delivery.attachment !== undefined) {
        // BRIEF-44: an attachment is sent through the transport's attachment
        // hand (`sendAttachment`), not rendered as text — the record carries
        // the file. A transport with no attachment concept still gets it: as
        // the URL spelled out, never dropped. `renderFor` returned
        // `undefined` for it, so `message` plays no part here.
        try {
          await withTimeout(this.sendAttachmentTo(member, delivery.attachment, delivery.text), this.sendTimeoutMs)
          // A push hand-off the provider accepted is confirmed by the
          // transport — the only confirmation that exists today (D2/F8).
          await this.mark(code, delivery.id, {
            status: "delivered",
            deliveredAt: this.now(),
            confirmedBy: "transport",
          })
          return
        } catch (error: unknown) {
          if (error instanceof SendBlockedError) {
            // BRIEF-42: the provider itself refused (its policy gate, HTTP
            // 200) — a deterministic, permanent refusal, not a flaky send.
            // Retrying would replay the same refusal four more times, so the
            // record goes straight to `failed` with the blocked_reason
            // verbatim as `lastError`, and the agent is told once. No
            // `confirmedBy` here — nobody confirmed anything.
            const failures = MAX_DELIVERY_ATTEMPTS
            await this.mark(code, delivery.id, {
              failures,
              status: "failed",
              lastError: error.blockedReason,
            })
            await this.reportFinalFailure(code, delivery, failures, error.blockedReason)
            await this.tellMemberAttachmentFailed(code, delivery)
            return
          }
          lastError = messageOf(error)
        }
      } else if (message === undefined) {
        // Nothing to render for a member we WOULD have pushed to. Nobody
        // received anything, so this falls through to the failure path
        // below — never to the `delivered` arm above, which is the pull
        // tier's alone (§1: the console-fallback bug, one layer up).
        lastError = `nothing to render for a ${member.tier} member from a ${delivery.kind} record`
      } else {
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
            await this.announceWhisper(code, member, delivery)
          }
          return
        } catch (error: unknown) {
          if (error instanceof SendBlockedError) {
            // BRIEF-42: the provider itself refused (its policy gate, HTTP
            // 200) — a deterministic, permanent refusal, not a flaky send.
            // Retrying would replay the same refusal four more times, so the
            // record goes straight to `failed` with the blocked_reason
            // verbatim as `lastError`, and the agent is told once. No
            // `confirmedBy` here — nobody confirmed anything.
            const failures = MAX_DELIVERY_ATTEMPTS
            await this.mark(code, delivery.id, {
              failures,
              status: "failed",
              lastError: error.blockedReason,
            })
            await this.reportFinalFailure(code, delivery, failures, error.blockedReason)
            return
          }
          lastError = messageOf(error)
        }
      }
    }

    const failures = delivery.failures + 1
    const failed = failures >= MAX_DELIVERY_ATTEMPTS
    await this.mark(code, delivery.id, {
      failures,
      status: failed ? "failed" : "pending",
      lastError,
    })
if (failed) {
      await this.reportFinalFailure(code, delivery, failures, lastError)
      // BRIEF-44: a failed ATTACHMENT reaches the member too — a text failure
      // needs no apology beyond the agent's correction, but a file that never
      // arrived leaves the member waiting on a download that will never
      // come. Guarded on `attachment`, or a failed system notice would mint
      // a notice of its own, forever.
      if (delivery.attachment !== undefined) await this.tellMemberAttachmentFailed(code, delivery)
    }
  }

  /** The attachment hand, shared by every attachment attempt: the
   *  transport's `sendAttachment` when it has one (`hasSendAttachment`),
   *  otherwise the URL spelled out — the same fallback
   *  `MemberSender.sendAttachment` applied before this went through the
   *  engine. Never `undefined`-tolerant: an error here IS the failure
   *  path. */
  private async sendAttachmentTo(member: Member, attachment: DeliveryAttachment, fallbackText: string): Promise<void> {
    if (hasSendAttachment(this.transport)) {
      await this.transport.sendAttachment(member, attachment)
      return
    }
    await this.transport.send(member, { text: fallbackText, artifactUrl: undefined })
  }

  /** BRIEF-44: the member's own words when their attachment is finally
   *  recorded `failed` — the same sentence shape the unservable case uses
   *  (`unservableNotice`, src/fanout/reader.ts:68), not a second apology.
   *  Minted as a `kind: "system"` record with `discharge: false`: it is a
   *  notice about a file, not an answer to anything the member asked, and
   *  must not silence their turn-answered obligation. If THIS notice's own
   *  send fails, the ordinary failure path takes it — the record carries no
   *  attachment, so there is no recursion. */
  private async tellMemberAttachmentFailed(code: string, delivery: Delivery): Promise<void> {
    const filename = delivery.attachment?.filename ?? "a file"
    await this.mintRecords(
      code,
      "system",
      `Sorry — the room said it attached "${filename}", but the file was not actually sent. Nothing to download yet; the room has been told to fix it.`,
      [delivery.memberId],
      undefined,
      false,
    )
  }

  /** The content-free notice every OTHER member sees once a whisper has
   *  actually landed on its target — the same observable visibility an
   *  announced `[[whisper]]` marker gets (whisper.ts:209-211: the room is
   *  told the whisper happened, never its content). Sent only after the
   *  whisper has actually LANDED — push via a transport-confirmed send, pull
   *  via its outbox record — because announcing a whisper that failed to
   *  arrive would be a lie (BRIEF-39: both tiers announce, from both
   *  delivered arms of `attempt`).
   *
    *  BRIEF-43: a whisper mints for exactly the surface the agent named, so
    *  one whisper is normally ONE record — but the agent may deliberately
    *  name all of a human's ids, and then this runs once per record of the
    *  SAME whisper. Two consequences are handled here, both driven by
    *  `sameHumanName`:
   *  - the target's OTHER surfaces are not "other members" — they just
   *    received the whisper itself, and must not be told it happened as if
   *    they were outsiders;
   *  - the outsider notice must fire ONCE per whisper, not once per record:
   *    a sibling record of the same whisper that already announced silences
   *    this one (whichever surface drains first announces; the rest see it
   *    and stay quiet).
   *
   *  BRIEF-39 — the notice is a `system` RECORD, not a direct send. The old
   *  loop rendered per tier and shipped over the transport, which made
   *  `renderForTier`'s correct `room-web → undefined` the second gate: the
   *  projected screen (a pull member) could never learn a whisper happened,
   *  and the camera filmed the one surface showing nothing. A record routes
   *  by delivery mode instead — push members get it over the transport
   *  through `attempt` (rendered `Room: …`), pull members through their
   *  outbox — with no change to `renderForTier`.
   *
   *  THE MINT-DISCHARGE CALL (the one judgement in this brief): the notice
   *  does NOT go through `accept`, because `accept` discharges brief 36's
   *  turn-answered-nobody obligation for whoever a mint is addressed to —
   *  and that is a lie for this record. "The agent whispered to Jeremy"
   *  tells Mathilde nothing about HER message; if she started the turn and
   *  the answer went to Jeremy as a whisper, her genuine "you got no reply"
   *  must still fire. (The resume banner's discharge is a different fact:
   *  the room speaking to the room, not a notice about someone else's
   *  private message.) So the mint goes through `mintRecords` with
   *  `discharge: false` — same records, same transports, no obligation
   *  silenced. */
  private async announceWhisper(code: string, target: Member, delivery: Delivery): Promise<void> {
    const room = this.store.get(code)
    if (room === undefined) return
    const siblingAnnounced = (room.deliveries ?? []).some(
      (other) =>
        other.id !== delivery.id &&
        other.kind === "whisper" &&
        other.text === delivery.text &&
        other.status === "delivered" &&
        room.members.some(
          (member) => member.id === other.memberId && sameHumanName(member.displayName, target.displayName),
        ),
    )
    if (siblingAnnounced) return
    const outsiders = room.members
      .filter((member) => !sameHumanName(member.displayName, target.displayName))
      .map((member) => member.id)
    if (outsiders.length === 0) return
    await this.mintRecords(code, "system", whisperNoticeOf(target.displayName), outsiders, undefined, false)
  }

  /** Per-tier rendering, shared with `RoomFanout.flush`. `artifactUrl` is
   *  deliberately `undefined`: a tool-addressed message is a conversational
   *  send, not a turn flush, and must not append an artifact notice of its
   *  own. For a whisper, the target gets the text and every other
   *  messenger/email member gets the content-free notice — the same
   *  observable visibility `renderWhisperForMember` gives an announced
   *  whisper (whisper.ts). */
  private renderFor(code: string, delivery: Delivery, member: Member): OutboundMessage | undefined {
    // A tool record never travels a transport, whatever the member's tier:
    // its `text` is `args` JSON, not prose. `recordToolCall` already mints
    // these for pull members only; this is the second lock, and `attempt`
    // below refuses to call a push member's empty render "delivered", so a
    // future caller that mints one wrongly gets a loud `failed` record
    // rather than a silent lie.
    if (delivery.kind === "tool") return undefined
    // An attachment never travels as prose: `attempt` sends it through the
    // transport's attachment hand (`sendAttachmentTo`) using the file on the
    // record. Returning `undefined` here also routes a pull member into the
    // delivered-outbox arm — their record's `text` already carries the URL
    // spelled out.
    if (delivery.kind === "attachment") return undefined
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
    } else if (delivery.kind === "system") {
      text = `Room: ${delivery.text}`
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
    const subject =
      delivery.kind === "attachment"
        ? "An attachment you sent"
        : `A ${delivery.kind} message you sent`
    const correction =
      `[system · delivery] ${subject} did NOT reach member ${delivery.memberId}: ` +
      `the transport failed ${failures} times (last error: ${lastError ?? "unknown"}). ` +
      `Re-read the roster — the member may have left — and send it again if it still matters.`
    try {
      await report(code, correction)
    } catch (error: unknown) {
      console.error(`failed to report delivery failure in ${code}: ${messageOf(error)}`)
    }
  }
}
