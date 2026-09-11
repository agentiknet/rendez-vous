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

  async send(member: Member, message: OutboundMessage): Promise<void> {
    if (member.address.provider !== "email") return

    const artifactLine =
      message.artifactUrl !== undefined && !message.text.includes(message.artifactUrl)
        ? `\n\n${message.artifactUrl}`
        : ""
    const text = message.text + artifactLine

    const content: Record<string, unknown> = { subject: this.subjectFor(member), text }
    const threadRef = this.threadRefByMember.get(member.id)
    if (threadRef !== undefined) {
      content.reply_to_message_id = threadRef
    }

    const result = await this.client.call(`member ${member.id}`, "send_message", {
      to: { channel: "mail", address: member.address.contactRef },
      content,
    })

    if (isSendMessageResult(result) && (result.status === "sent" || result.status === "queued")) {
      this.threadRefByMember.set(member.id, result.message_id)
    }
  }

  private subjectFor(member: Member): string {
    const code = normalizeCode(member.address.source)
    return code !== undefined ? `Room ${code} update` : GENERIC_SUBJECT
  }
}
