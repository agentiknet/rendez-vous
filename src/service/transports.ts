import type { DeliveryAttachment } from "../rooms/types.ts"
import type { OutboundMessage, Transport } from "../fanout/types.ts"
import { UnroutedDeliveryError, deliveryFromAddress, type Member, type MemberDelivery } from "../rooms/types.ts"

/** A file the agent asked to send (`[[attach …]]`, src/fanout/attach.ts),
 *  already addressable at a public, room-keyed URL the provider fetches
 *  server-side. No bytes pass through this service. BRIEF-44: it is the SAME
 *  shape a `kind: "attachment"` delivery record carries
 *  (`DeliveryAttachment`, src/rooms/types.ts) — one type, not two that can
 *  drift, because the record is what the engine's drain sends. */
export type OutboundAttachment = DeliveryAttachment

/** A `Transport` that can optionally also deliver an image. Detect support
 *  with `hasSendMedia`/`"sendMedia" in transport` rather than assuming it —
 *  most transports (console, memory, room-web fan-out) don't have it. */
export interface MediaTransport extends Transport {
  /** `publicUrl`, when given, is a already-published URL for the same
   *  bytes (`publicMediaUrl`). Providers with no upload path of their own —
   *  Telegram — can ONLY send media that way, so omitting it is what makes
   *  an image silently degrade to text there. BRIEF-48: resolves to the
   *  provider's message id for the media send, same rule as `send`. */
  sendMedia?(member: Member, png: Uint8Array, caption: string, publicUrl?: string): Promise<string | void>
  /** Deliver an agent-authored attachment. Absent on transports with no
   *  media concept; callers detect with `hasSendAttachment` and fall back to
   *  sending the URL as text, so a file is never silently not-sent.
   *  BRIEF-48: resolves to the provider's message id, same rule as `send`. */
  sendAttachment?(member: Member, attachment: OutboundAttachment): Promise<string | void>
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

/** BRIEF 49 (docs/REACT-REPLY.md): a transport that can also react to a
 *  provider-native message and send a threaded reply. Same optional-method
 *  pattern as `sendMedia`/`sendAttachment`: callers detect with the guards
 *  below, and a transport without the concept is never asked to fake one —
 *  the engine records the honest failure instead of degrading (constraint
 *  4: refus, jamais dégradation). `sendReaction`'s `emoji: ""` REMOVES a
 *  reaction (agentpush's own contract, send-reaction.ts). `sendReply`
 *  resolves to the provider's message id for the reply, same rule as
 *  `send`. */
export interface ReactiveTransport extends Transport {
  sendReaction?(member: Member, providerMessageId: string, emoji: string): Promise<string | void>
  sendReply?(member: Member, text: string, replyToProviderMessageId: string): Promise<string | void>
}

export function hasSendReaction(
  transport: Transport,
): transport is Transport & { sendReaction(member: Member, providerMessageId: string, emoji: string): Promise<string | void> } {
  return "sendReaction" in transport && typeof transport.sendReaction === "function"
}

export function hasSendReply(
  transport: Transport,
): transport is Transport & { sendReply(member: Member, text: string, replyToProviderMessageId: string): Promise<string | void> } {
  return "sendReply" in transport && typeof transport.sendReply === "function"
}

/** Which channels a REACTION can be delivered on — ground-truthed against
 *  agentpush's provider capabilities (whatsapp provider.ts:92 and telegram
 *  provider.ts:36 declare `reactions: true`; twilio declares
 *  `reactions: false`; gmail declares `reactions: false`; room-web has no
 *  provider at all). A mail handle RESOLVES fine — resolution ≠ capability
 *  — and the react tool refuses on these channels namedly instead of
 *  degrading the emoji into a text message. Keep in step with the
 *  `ReactiveTransport` implementations. */
export function canReact(provider: string): boolean {
  return provider === "whatsapp" || provider === "telegram"
}

/** Which channels a THREADED REPLY can be delivered on — same ground truth:
 *  whatsapp/telegram quote natively (provider.ts `replies: true`), gmail
 *  threads via `resolveThreading`; twilio declares `replies: false`;
 *  room-web has no reply concept. Mail's threading truth is the provider's
 *  own (non-Gmail sends go out unthreaded and say so) — the send is still
 *  real, and the tool result claims only `accepted`. */
export function canReply(provider: string): boolean {
  return provider === "whatsapp" || provider === "telegram" || provider === "email"
}

export class ConsoleTransport implements Transport {
  async send(member: Member, message: OutboundMessage): Promise<string | undefined> {
    console.log(`→ [${member.displayName}/${member.tier}] ${message.text}`)
    return undefined
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

  async send(member: Member, message: OutboundMessage): Promise<string | undefined> {
    this.sends.push({ member, message })
    return undefined
  }

  readonly attachmentSends: { member: Member; attachment: OutboundAttachment }[] = []

  async sendMedia(member: Member, png: Uint8Array, caption: string, publicUrl?: string): Promise<string | void> {
    this.mediaSends.push({ member, png, caption, publicUrl })
    return undefined
  }

  async sendAttachment(member: Member, attachment: OutboundAttachment): Promise<string | void> {
    this.attachmentSends.push({ member, attachment })
    return undefined
  }
}

/** Routes by `member.delivery` (PLAN-02 §3-D1): `telegram`/`whatsapp`/`sms`
 *  push to `messenger` (an `AgentpushTransport` in production), `email` push
 *  to `email` when one is configured, `console` push to the explicit console
 *  target cli.ts wires for local/dev rooms. There is NO fallback arm and no
 *  `default` branch: a `pull` recipient has no push transport at all — their
 *  drain is the outbox (`GET /rooms/:code/outbox`) — and a push provider with
 *  no wired transport throws, so "nobody routed this" can never masquerade as
 *  "delivered" again. `sendMedia` delegates to whichever side handled the
 *  `send`, falling back to a caption-only text send when that side doesn't
 *  support media. */
export class CompositeTransport implements MediaTransport {
  private readonly messenger: Transport
  private readonly consoleTarget: Transport
  private readonly email: Transport | undefined

  /** `consoleTarget` is the explicit target of a `console` delivery mode in
   *  local/dev rooms — never a catch-all: only a member whose delivery (or
   *  legacy address provider) says `console` reaches it. */
  constructor(messenger: Transport, consoleTarget: Transport, email?: Transport) {
    this.messenger = messenger
    this.consoleTarget = consoleTarget
    this.email = email
  }

  private routeFor(member: Member): Transport {
    const delivery = member.delivery ?? deliveryFromAddress(member.address)
    switch (delivery.mode) {
      case "push":
        return this.routePush(member, delivery)
      case "pull":
        // Not a fallback: a pull recipient is drained from their outbox
        // (GET /rooms/:code/outbox), never pushed. Reaching a push transport
        // with one is a caller bug, so it fails loudly — and as an
        // `UnroutedDeliveryError`, so the room lifecycle boundary can answer
        // it instead of 500-ing (brief D).
        throw new UnroutedDeliveryError(
          `unrouted delivery: member ${member.id} is a pull recipient and has no push transport`,
        )
    }
    return unrouted(member, delivery)
  }

  private routePush(member: Member, delivery: Extract<MemberDelivery, { mode: "push" }>): Transport {
    switch (delivery.provider) {
      case "telegram":
      case "whatsapp":
      case "sms":
        return this.messenger
      case "email": {
        if (this.email === undefined) {
          throw new Error(`unrouted delivery: member ${member.id} is push/email but no email transport is wired`)
        }
        return this.email
      }
      case "console":
        return this.consoleTarget
    }
    return unrouted(member, delivery)
  }

  async send(member: Member, message: OutboundMessage): Promise<string | void> {
    return await this.routeFor(member).send(member, message)
  }

  async sendMedia(member: Member, png: Uint8Array, caption: string, publicUrl?: string): Promise<string | void> {
    const target = this.routeFor(member)
    if (hasSendMedia(target)) {
      return await target.sendMedia(member, png, caption, publicUrl)
    }
    return await target.send(member, { text: caption, artifactUrl: undefined })
  }

  async sendAttachment(member: Member, attachment: OutboundAttachment): Promise<string | void> {
    const target = this.routeFor(member)
    if (hasSendAttachment(target)) {
      return await target.sendAttachment(member, attachment)
    }
    // Any routed push transport with no attachment concept still gets the
    // file — as its URL, in the record. Never a dropped attachment. (A pull
    // recipient never gets here at all: `routeFor` throws for them — their
    // drain is the outbox.)
    return await target.send(member, { text: attachmentFallbackText(attachment), artifactUrl: undefined })
  }
}

/** The documented exhaustiveness assert (PLAN-02 §3-D1): every arm above
 *  returns or throws, so both `switch`es leave `delivery` narrowed to
 *  `never` here — and if a `MemberDelivery` variant is ever added without a
 *  routing arm, passing it to this `never`-typed parameter fails
 *  `pnpm check-types`. Unreachable when exhaustive. */
function unrouted(member: Member, delivery: never): never {
  throw new Error(`unrouted delivery: member ${member.id} has delivery ${JSON.stringify(delivery)}`)
}
