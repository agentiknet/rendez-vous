import type { OutboundMessage, Transport } from "../fanout/types.ts"
import type { Member } from "../rooms/types.ts"

/** A `Transport` that can optionally also deliver an image. Detect support
 *  with `hasSendMedia`/`"sendMedia" in transport` rather than assuming it —
 *  most transports (console, memory, room-web fan-out) don't have it. */
export interface MediaTransport extends Transport {
  sendMedia?(member: Member, png: Uint8Array, caption: string): Promise<void>
}

export function hasSendMedia(
  transport: Transport,
): transport is Transport & { sendMedia(member: Member, png: Uint8Array, caption: string): Promise<void> } {
  return "sendMedia" in transport && typeof transport.sendMedia === "function"
}

export class ConsoleTransport implements Transport {
  async send(member: Member, message: OutboundMessage): Promise<void> {
    console.log(`→ [${member.displayName}/${member.tier}] ${message.text}`)
  }
}

export interface RecordedSend {
  member: Member
  message: OutboundMessage
}

export interface RecordedMediaSend {
  member: Member
  png: Uint8Array
  caption: string
}

/** Records every send in order; used by tests and the no-phone simulator.
 *  Media sends land in `mediaSends`, kept separate from `sends` so existing
 *  assertions on text replies are unaffected by a room also getting a QR. */
export class MemoryTransport implements MediaTransport {
  readonly sends: RecordedSend[] = []
  readonly mediaSends: RecordedMediaSend[] = []

  async send(member: Member, message: OutboundMessage): Promise<void> {
    this.sends.push({ member, message })
  }

  async sendMedia(member: Member, png: Uint8Array, caption: string): Promise<void> {
    this.mediaSends.push({ member, png, caption })
  }
}

/** Routes by `member.address.provider`: `whatsapp`/`telegram` go to `inner`
 *  (an `AgentpushTransport` in production), everything else (room-web,
 *  email, anything future) goes to `fallback`. `sendMedia` delegates to
 *  whichever side handled the `send`, falling back to a caption-only text
 *  send when that side doesn't support media. */
export class CompositeTransport implements MediaTransport {
  private readonly inner: Transport
  private readonly fallback: Transport

  constructor(inner: Transport, fallback: Transport) {
    this.inner = inner
    this.fallback = fallback
  }

  private routeFor(member: Member): Transport {
    return member.address.provider === "whatsapp" || member.address.provider === "telegram" ? this.inner : this.fallback
  }

  async send(member: Member, message: OutboundMessage): Promise<void> {
    await this.routeFor(member).send(member, message)
  }

  async sendMedia(member: Member, png: Uint8Array, caption: string): Promise<void> {
    const target = this.routeFor(member)
    if (hasSendMedia(target)) {
      await target.sendMedia(member, png, caption)
      return
    }
    await target.send(member, { text: caption, artifactUrl: undefined })
  }
}
