import type { Member } from "../rooms/types.ts"

/** Minimal structural view of a daemon transcript record; matches the daemon's `data:` frames. */
export interface FanoutRecord {
  seq: number
  kind: string
  text?: string
  reason?: string
}

export interface OutboundMessage {
  text: string
  artifactUrl: string | undefined
}

export interface Transport {
  /** Deliver one rendered message to one member. Must not throw for one member's failure to block the others.
   *
   *  BRIEF-42: "not throw for one member's failure" means the CALLER scopes
   *  the failure to that member (delivery.ts `attempt` catches per member) —
   *  it does not mean a refused send may resolve silently. A provider that
   *  refuses (agentpush's `blocked` result, HTTP 200) MUST throw a
   *  `SendBlockedError` carrying the provider's `blocked_reason` verbatim;
   *  anything else stamps a `confirmedBy: "transport"` that is false. */
  send(member: Member, message: OutboundMessage): Promise<void>
}

/** The provider refused the send — its own policy gate, HTTP 200, not a
 *  transport error. `blockedReason` is the provider's `blocked_reason`
 *  verbatim, so it survives into the delivery record's `lastError` and to
 *  the agent unchanged. Permanent by nature: the refusal is deterministic,
 *  so the engine must not retry it. */
export class SendBlockedError extends Error {
  readonly blockedReason: string
  constructor(blockedReason: string) {
    super(blockedReason)
    this.name = "SendBlockedError"
    this.blockedReason = blockedReason
  }
}
