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
import { MAX_DELIVERY_ATTEMPTS, type Delivery, type Member } from "../rooms/types.ts"

/** Per-send hard timeout. Deliberately NOT the 2s house budget (that is for
 *  probes of things on our own tunnel, reader.ts): this wait covers a real
 *  provider send — tunnel → agentpush → WhatsApp/Telegram — where 2s cuts
 *  off healthy sends. 10s bounds one member's failure so a hanging provider
 *  cannot stall the other members' deliveries behind it. */
export const SEND_TIMEOUT_MS = 10_000

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
   *  two readers of the same `attempts` counter would lose an increment
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
      const created: Delivery[] = accepted.map((memberId, index) => ({
        id: `d${(room.deliveries?.length ?? 0) + index + 1}`,
        memberId,
        kind,
        text,
        status: "pending",
        attempts: 0,
        lastError: undefined,
        createdAt: now,
        deliveredAt: undefined,
      }))
      await this.store.update(code, { deliveries: [...(room.deliveries ?? []), ...created] })
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

  private async drainRoom(code: string): Promise<void> {
    const room = this.store.get(code)
    if (room === undefined) return
    const pending = (room.deliveries ?? []).filter(
      (delivery) => delivery.status === "pending" && delivery.attempts < MAX_DELIVERY_ATTEMPTS,
    )
    for (const delivery of pending) {
      await this.attempt(code, delivery)
    }
  }

  /** One delivery to one member. A member who left between acceptance and
   *  drain is an ordinary failure (attempts + 1, retry, then `failed`) —
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
        // The room-web tier gets nothing over the transport (render.ts) —
        // the shared screen already saw the tool call. Nothing left to do.
        await this.mark(code, delivery.id, { status: "delivered", deliveredAt: this.now() })
        return
      }
      try {
        await withTimeout(this.transport.send(member, message), this.sendTimeoutMs)
        await this.mark(code, delivery.id, { status: "delivered", deliveredAt: this.now() })
        if (delivery.kind === "whisper") {
          await this.announceWhisper(code, member)
        }
        return
      } catch (error: unknown) {
        lastError = messageOf(error)
      }
    }

    const attempts = delivery.attempts + 1
    const failed = attempts >= MAX_DELIVERY_ATTEMPTS
    await this.mark(code, delivery.id, {
      attempts,
      status: failed ? "failed" : "pending",
      lastError,
    })
    if (failed) await this.reportFinalFailure(code, delivery, attempts, lastError)
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
    patch: Partial<Pick<Delivery, "status" | "attempts" | "lastError" | "deliveredAt">>,
  ): Promise<void> {
    const room = this.store.get(code)
    if (room === undefined) return
    const deliveries = (room.deliveries ?? []).map((delivery) =>
      delivery.id === deliveryId ? { ...delivery, ...patch } : delivery,
    )
    await this.store.update(code, { deliveries })
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
    attempts: number,
    lastError: string | undefined,
  ): Promise<void> {
    const report = this.reportFailure
    if (report === undefined) return
    const correction =
      `[system · delivery] A ${delivery.kind} message you sent did NOT reach member ${delivery.memberId}: ` +
      `the transport failed ${attempts} times (last error: ${lastError ?? "unknown"}). ` +
      `Re-read the roster — the member may have left — and send it again if it still matters.`
    try {
      await report(code, correction)
    } catch (error: unknown) {
      console.error(`failed to report delivery failure in ${code}: ${messageOf(error)}`)
    }
  }
}
