/**
 * Sends the tier-2 email digest through the real agentpush REST API.
 *
 * Ground-truthed against the read-only checkout at
 * /Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/projects/agentpush
 * (never edited) — see docs/AGENTPUSH.md §8. Same endpoint and auth as the
 * messenger tier (`AgentpushToolClient`, src/channels/agentpush/tools-client.ts):
 * `POST {RDV_AGENTPUSH_URL}/tools/send_message`, `Authorization: Bearer
 * <RDV_AGENTPUSH_KEY>`, but with `to.channel: "mail"` and mail-only
 * `content` fields (`subject`, `reply_to_message_id`) documented at
 * packages/tools/src/tools/send-message.ts:33-97, 175-196.
 *
 * Threading: `content.reply_to_message_id` set to the id of the last
 * message in this member's thread (kept in memory, per member) makes Gmail
 * resolve real RFC 2822 `In-Reply-To`/`References` headers server-side
 * (packages/messaging/src/providers/gmail/provider.ts:296-341,
 * `resolveThreading`) — genuine threading, not a synthetic id we invented.
 * Non-Gmail mail providers send unthreaded regardless
 * (send-message.ts:187) — nothing to do differently on our side either way.
 */

import type { OutboundMessage, Transport } from "../../fanout/types.ts"
import type { Member } from "../../rooms/types.ts"
import { normalizeCode } from "../../rooms/code.ts"
import { AgentpushToolClient, type AgentpushToolClientOptions, isSendMessageResult } from "../agentpush/tools-client.ts"

const GENERIC_SUBJECT = "Rendez-vous update"

export type EmailTransportOptions = AgentpushToolClientOptions

export class EmailTransport implements Transport {
  private readonly client: AgentpushToolClient
  private readonly threadRefByMember = new Map<string, string>()

  constructor(opts: EmailTransportOptions) {
    this.client = new AgentpushToolClient(opts)
  }

  async send(member: Member, message: OutboundMessage): Promise<string | undefined> {
    if (member.address.provider !== "email") return undefined
    const artifactLine =
      message.artifactUrl !== undefined && !message.text.includes(message.artifactUrl)
        ? `\n\n${message.artifactUrl}`
        : ""
    return await this.sendWith(member, message.text + artifactLine, this.threadRefByMember.get(member.id))
  }

  /** BRIEF 49 (docs/REACT-REPLY.md §3): the threaded reply hand. The
   *  `replyToMessageId` is the provider-native id the room's resolver
   *  handed up — Gmail turns it into real `In-Reply-To`/`References`
   *  headers server-side; a non-Gmail mail provider sends it unthreaded
   *  and says so on its own result. One send body shared with `send`, so
   *  the tool path and the ordinary path cannot drift. */
  async sendReply(member: Member, text: string, replyToMessageId: string): Promise<string | undefined> {
    if (member.address.provider !== "email") return undefined
    return await this.sendWith(member, text, replyToMessageId)
  }

  private async sendWith(member: Member, text: string, replyToMessageId: string | undefined): Promise<string | undefined> {
    const content: Record<string, unknown> = { subject: this.subjectFor(member), text }
    if (replyToMessageId !== undefined) {
      content.reply_to_message_id = replyToMessageId
    }

    const result = await this.client.call(`member ${member.id}`, "send_message", {
      to: { channel: "mail", address: member.address.contactRef },
      content,
    })

    if (isSendMessageResult(result) && (result.status === "sent" || result.status === "queued")) {
      this.threadRefByMember.set(member.id, result.message_id)
      // BRIEF-48: the id no longer stays in this in-memory map alone — it is
      // returned so the delivery engine can put it on the record and mint
      // the room's citable outbound ref. The map keeps its thread role
      // (Gmail threading needs the LAST message id, not any citable one).
      return result.message_id
    }
    return undefined
  }

  private subjectFor(member: Member): string {
    const code = normalizeCode(member.address.source)
    return code !== undefined ? `Room ${code} update` : GENERIC_SUBJECT
  }
}
