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
  /** Deliver one rendered message to one member. Must not throw for one member's failure to block the others. */
  send(member: Member, message: OutboundMessage): Promise<void>
}
