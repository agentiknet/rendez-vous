import type { OutboundMessage, Transport } from "../fanout/types.ts"
import { deliveryModeOf, type Member, type MessageRef } from "../rooms/types.ts"
import type { RoomStore } from "../rooms/store.ts"
import type { DeliveryEngine } from "./delivery.ts"
import { attachmentFallbackText, canReact, canReply, hasSendMedia, type OutboundAttachment } from "./transports.ts"

/** BRIEF 49 (docs/REACT-REPLY.md §3): the outcome of a `react`/`reply`
 *  act, resolved BEFORE anything is minted. Four named arms, never a
 *  throw at the agent:
 *  - `accepted` — the act was minted as a record through the engine and
 *    crossed `attempt`; NOT a delivery claim.
 *  - `unknown-handle` — the handle does not resolve (unknown, malformed,
 *    pruned, expired, foreign room). NOTHING is minted and NOTHING is
 *    sent: never a send to a guessed message.
 *  - `channel-cannot-react` — the handle RESOLVED, but the member's
 *    channel cannot do the act (mail/sms cannot react; sms cannot reply;
 *    room-web has no provider at all). Distinct from `unknown-handle` on
 *    purpose: one says "retrying differently is pointless", the other
 *    says "cite the right message". Nothing minted, nothing sent, no text
 *    degrade.
 *  - `member-not-in-room` — the handle resolved but its author has
 *    left; the act has no surface to land on. */
export type MessageActionOutcome =
  | { readonly kind: "accepted"; readonly ref: MessageRef }
  | { readonly kind: "unknown-handle" }
  | { readonly kind: "channel-cannot-react"; readonly channel: string }
  | { readonly kind: "member-not-in-room" }

/** R6/BRIEF-20: every outbound push message carries its room's SLUG — the
 *  one affordance that makes the active room legible on a surface (Telegram,
 *  WhatsApp) with no other way to tell which room a reply came from. A short
 *  suffix, not a banner, and skipped when the text already names the room
 *  (the join/resume/QR notices already open with it) so it never doubles up.
 *
 *  This used to append the room CODE — the actual join capability — to
 *  every single push message, unconditionally. Forwarding or screenshotting
 *  any ordinary reply handed the room's access away with it (BRIEF-20). The
 *  slug identifies the room just as legibly and is not secret: safe to
 *  print, forward, screenshot, log. `slug === ""` is the "sender in no room
 *  at all" placeholder send (`RoomService.replyGuidance`) — nothing to name,
 *  so nothing is appended. */
function withRoomSlugSuffix(slug: string, message: OutboundMessage): OutboundMessage {
  if (slug === "" || message.text.includes(slug)) return message
  return { ...message, text: `${message.text}\n[${slug}]` }
}

/** The ONE way anything outside `DeliveryEngine` sends to a member
 *  (brief A): every call site branches here, and the helper branches on
 *  `deliveryModeOf(member)` —
 *
 *  - **push** → `transport.send` / `sendAttachment` / `sendMedia`, exactly
 *    as the call site did before this helper existed. Byte-for-byte.
 *  - **pull** → a `kind: "system"` outbox record via `DeliveryEngine.accept`,
 *    so the member's tab drains it like everything else. No transport call,
 *    ever — `CompositeTransport` throws for pull recipients, and throwing
 *    here would take a room lifecycle down with it (the bug this fixes).
 *
 *  No call site outside this helper (and the delivery engine itself) may
 *  call `transport.send` on a member; a test greps the source for that
 *  invariant. A second bypass is how the original bug got in: every send the
 *  room itself makes went straight to the transport and fell into the old
 *  console fallback, so a web member never received its own join link.
 *
 *  A pull record carries only text — an attachment rides as its URL spelled
 *  out (`attachmentFallbackText`), media as caption plus the published URL.
 *  The member's tab already reaches the artifact/media proxy; it does not
 *  need the bytes pushed at it. */
export class MemberSender {
  private readonly store: RoomStore
  private readonly transport: Transport
  private readonly engine: DeliveryEngine

  constructor(opts: { store: RoomStore; transport: Transport; engine: DeliveryEngine }) {
    this.store = opts.store
    this.transport = opts.transport
    this.engine = opts.engine
  }

  /** One message to one member. `code` is the room the member belongs to —
   *  the outbox record needs its room; for a push member it is unused.
   *  BRIEF-48: resolves to the provider's message id for a push send
   *  (`Transport.send`'s own return), `undefined` for a pull member — their
   *  delivery is the outbox record, and no provider ever saw it. Most
   *  callers (system notices) ignore the value; it exists so the identity
   *  plumbing has one shape at every send path. */
  async send(code: string, member: Member, message: OutboundMessage): Promise<string | void> {
    if (this.isPull(member)) {
      // The outbox record has no separate artifact field; a notice whose
      // artifact line the push rendering would have appended gets it spelled
      // into the text — unless the text already carries it (the join-links
      // reply embeds the web link itself).
      const text =
        message.artifactUrl !== undefined && !message.text.includes(message.artifactUrl)
          ? `${message.text}\n${message.artifactUrl}`
          : message.text
      await this.acceptSystemRecord(code, member, text)
      return undefined
    }
    // `code` is the room's own key into the store (always resolvable here —
    // BRIEF-20's backfill guarantees every room has a `slug` by the time it
    // is ever loaded); `""` is the no-room placeholder, which resolves to no
    // room and so appends nothing, same as before.
    const slug = code === "" ? "" : (this.store.get(code)?.slug ?? "")
    return await this.transport.send(member, withRoomSlugSuffix(slug, message))
  }

/** An agent- or room-authored attachment. A pull member gets the URL as a
 *  record; their tab fetches it. A push member is a delivery like any other
 *  (BRIEF-44): minted as a `kind: "attachment"` record through the engine
 *  and sent by the drain, so a refused file is `failed` with the provider's
 *  reason as `lastError`, retried, reported to the agent, and apologised for
 *  to the member — instead of vanishing between the caller and the
 *  transport, which is how the WhatsApp images of 2026-09-14 left no trace.
 *  The drain is awaited, so a caller that resolves has seen the send
 *  attempted, exactly as when the transport was called directly. */
  async sendAttachment(code: string, member: Member, attachment: OutboundAttachment): Promise<void> {
    if (this.isPull(member)) {
      await this.acceptSystemRecord(code, member, attachmentFallbackText(attachment))
      return
    }
    const outcome = await this.engine.accept(
      code,
      "attachment",
      attachmentFallbackText(attachment),
      [member.id],
      undefined,
      attachment,
    )
    if (outcome.unknown.includes(member.id)) {
      const room = this.store.get(code)
      console.warn(
        `member-send: push member ${member.id} is not in room ${code} (${room === undefined ? "no such room" : "roster mismatch"}) — nothing was delivered`,
      )
      return
    }
    await this.engine.drain(code)
  }

  /** Media (the join QR). A pull member cannot be pushed bytes; the record
   *  carries the caption and, when it published, the public URL of the
   *  image. The join links themselves ride the room-created text record, so
   *  a member whose QR failed to publish still has everything it needs. */
  async sendMedia(code: string, member: Member, png: Uint8Array, caption: string, publicUrl?: string): Promise<void> {
    if (this.isPull(member)) {
      await this.acceptSystemRecord(code, member, publicUrl !== undefined ? `${caption}\n${publicUrl}` : caption)
      return
    }
    if (hasSendMedia(this.transport)) {
      await this.transport.sendMedia(member, png, caption, publicUrl)
      return
    }
    await this.transport.send(member, { text: caption, artifactUrl: undefined })
  }

  /** BRIEF 49: react to a message cited by its handle, or (with `emoji: ""`)
   *  remove a reaction previously placed. `canReact` draws the capability
   *  line from the member's own provider — the channel the reaction would
   *  be delivered on — never from a guess about the handle. */
  async react(code: string, handle: string, emoji: string): Promise<MessageActionOutcome> {
    return await this.messageAction(code, handle, "reaction", emoji)
  }

  /** Reply to a message cited by its handle, threaded: the record carries
   *  the resolved provider id, and the drain hands it to the transport's
   *  `sendReply` (agentpush `content.reply_to_message_id`, Gmail
   *  `resolveThreading`) — threading decided by the provider, never
   *  re-derived here. */
  async reply(code: string, handle: string, text: string): Promise<MessageActionOutcome> {
    return await this.messageAction(code, handle, "reply", text)
  }

  private async messageAction(
    code: string,
    handle: string,
    kind: "reaction" | "reply",
    payload: string,
  ): Promise<MessageActionOutcome> {
    const ref = await this.store.resolveMessageRef(code, handle)
    if (ref === undefined) return { kind: "unknown-handle" }
    const room = this.store.get(code)
    const member = room?.members.find((candidate) => candidate.id === ref.memberId)
    if (room === undefined || member === undefined) return { kind: "member-not-in-room" }
    const capable = kind === "reaction" ? canReact(member.address.provider) : canReply(member.address.provider)
    if (!capable) return { kind: "channel-cannot-react", channel: member.address.provider }
    const outcome = await this.engine.accept(
      code,
      kind,
      payload,
      [member.id],
      kind === "reaction" ? "react" : "reply",
      undefined,
      kind === "reaction"
        ? { reactsTo: ref.providerId, emoji: payload }
        : { reactsTo: ref.providerId },
    )
    if (outcome.unknown.includes(member.id)) {
      console.warn(
        `member-send: ${kind} for member ${member.id} in room ${code} minted nothing (roster mismatch) — nothing was sent`,
      )
      return { kind: "member-not-in-room" }
    }
    await this.engine.drain(code)
    return { kind: "accepted", ref }
  }

  private isPull(member: Member): boolean {    try {
      return deliveryModeOf(member) === "pull"
    } catch {
      // An unroutable address stays push-shaped here: the transport arm
      // below throws the loud UnroutedDeliveryError for it, where it always
      // did — the room lifecycle boundary catches that (brief D).
      return false
    }
  }

  /** Write the `kind: "system"` record through the same accept path as the
   *  agent's say/whisper: one `pending` record, drained (for a pull member
   *  that means completed into their outbox), pruned and cursored by the
   *  exact rules the appendix specifies. A member id that matches nobody in
   *  the room (a guidance placeholder for someone in no room at all) is not
   *  recordable — there is no outbox to hold it — so it is logged loudly,
   *  never silently dropped. */
  private async acceptSystemRecord(code: string, member: Member, text: string): Promise<void> {
    const outcome = await this.engine.accept(code, "system", text, [member.id])
    if (outcome.unknown.includes(member.id)) {
      const room = this.store.get(code)
      console.warn(
        `member-send: pull member ${member.id} is not in room ${code} (${room === undefined ? "no such room" : "roster mismatch"}) — nothing was delivered`,
      )
    }
  }
}