import type { OutboundMessage, Transport } from "../fanout/types.ts"
import type { Member } from "../rooms/types.ts"

export class ConsoleTransport implements Transport {
  async send(member: Member, message: OutboundMessage): Promise<void> {
    console.log(`→ [${member.displayName}/${member.tier}] ${message.text}`)
  }
}

export interface RecordedSend {
  member: Member
  message: OutboundMessage
}

/** Records every send in order; used by tests and the no-phone simulator. */
export class MemoryTransport implements Transport {
  readonly sends: RecordedSend[] = []

  async send(member: Member, message: OutboundMessage): Promise<void> {
    this.sends.push({ member, message })
  }
}
