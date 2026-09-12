import type { AttachmentKind } from "../fanout/attach.ts"
import type { OutboundMessage, Transport } from "../fanout/types.ts"
import type { Member } from "../rooms/types.ts"

/** A file the agent asked to send (`[[attach …]]`, src/fanout/attach.ts),
 *  already addressable at a public, room-keyed URL the provider fetches
 *  server-side. No bytes pass through this service. */
export interface OutboundAttachment {
  readonly url: string
  readonly filename: string
  readonly mimeType: string
  readonly kind: AttachmentKind
  readonly caption: string | undefined
}

/** A `Transport` that can optionally also deliver an image. Detect support
 *  with `hasSendMedia`/`"sendMedia" in transport` rather than assuming it —
 *  most transports (console, memory, room-web fan-out) don't have it. */
export interface MediaTransport extends Transport {
  /** `publicUrl`, when given, is a already-published URL for the same
   *  bytes (`publicMediaUrl`). Providers with no upload path of their own —
   *  Telegram — can ONLY send media that way, so omitting it is what makes
   *  an image silently degrade to text there. */
  sendMedia?(member: Member, png: Uint8Array, caption: string, publicUrl?: string): Promise<void>
  /** Deliver an agent-authored attachment. Absent on transports with no
   *  media concept; callers detect with `hasSendAttachment` and fall back to
   *  sending the URL as text, so a file is never silently not-sent. */
  sendAttachment?(member: Member, attachment: OutboundAttachment): Promise<void>
}

export function hasSendAttachment(
  transport: Transport,
): transport is Transport & { sendAttachment(member: Member, attachment: OutboundAttachment): Promise<void> } {
  return "sendAttachment" in transport && typeof transport.sendAttachment === "function"
}

/** The text a tier without attachment support gets instead: the same public
 *  URL, spelled out. Worse than a real attachment, but never silence. */
export function attachmentFallbackText(attachment: OutboundAttachment): string {
  return attachment.caption === undefined
    ? `${attachment.filename}: ${attachment.url}`
    : `${attachment.caption}\n${attachment.filename}: ${attachment.url}`
}

export function hasSendMedia(
  transport: Transport,
): transport is Transport & {
  sendMedia(member: Member, png: Uint8Array, caption: string, publicUrl?: string): Promise<void>
} {
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
  publicUrl: string | undefined
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

  readonly attachmentSends: { member: Member; attachment: OutboundAttachment }[] = []

  async sendMedia(member: Member, png: Uint8Array, caption: string, publicUrl?: string): Promise<void> {
    this.mediaSends.push({ member, png, caption, publicUrl })
  }

  async sendAttachment(member: Member, attachment: OutboundAttachment): Promise<void> {
    this.attachmentSends.push({ member, attachment })
  }
}

/** Routes by `member.address.provider`: `whatsapp`/`telegram`/`sms` go to
 *  `messenger` (an `AgentpushTransport` in production), `email` goes to
 *  `email` when one is configured (an `EmailTransport` in production),
 *  everything else (room-web, or `email` with no transport wired) goes to
 *  `fallback`. `sendMedia` delegates to whichever side handled the `send`,
 *  falling back to a caption-only text send when that side doesn't support
 *  media. */
export class CompositeTransport implements MediaTransport {
  private readonly messenger: Transport
  private readonly fallback: Transport
  private readonly email: Transport | undefined

  constructor(messenger: Transport, fallback: Transport, email?: Transport) {
    this.messenger = messenger
    this.fallback = fallback
    this.email = email
  }

  private routeFor(member: Member): Transport {
    const provider = member.address.provider
    if (provider === "whatsapp" || provider === "telegram" || provider === "sms") return this.messenger
    if (provider === "email" && this.email !== undefined) return this.email
    return this.fallback
  }

  async send(member: Member, message: OutboundMessage): Promise<void> {
    await this.routeFor(member).send(member, message)
  }

  async sendMedia(member: Member, png: Uint8Array, caption: string, publicUrl?: string): Promise<void> {
    const target = this.routeFor(member)
    if (hasSendMedia(target)) {
      await target.sendMedia(member, png, caption, publicUrl)
      return
    }
    await target.send(member, { text: caption, artifactUrl: undefined })
  }

  async sendAttachment(member: Member, attachment: OutboundAttachment): Promise<void> {
    const target = this.routeFor(member)
    if (hasSendAttachment(target)) {
      await target.sendAttachment(member, attachment)
      return
    }
    // room-web and any transport with no media concept still get the file —
    // as its URL, in the transcript. Never a dropped attachment.
    await target.send(member, { text: attachmentFallbackText(attachment), artifactUrl: undefined })
  }
}
