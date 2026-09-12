/**
 * Sends outbound messenger turns through the real agentpush REST API.
 *
 * Ground-truthed against the read-only checkout at
 * /Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/projects/agentpush
 * (never edited) — see docs/AGENTPUSH.md for the full contract with
 * file:line citations. Replaces the M5 version, which correctly identified
 * that the agentproto daemon's own agentpush path is MCP-mediated (no raw
 * HTTP endpoint to copy) but then inferred a fictional REST shape. This
 * version calls agentpush's real, generic tool-execution route directly via
 * `AgentpushToolClient` (tools-client.ts), shared with the email transport.
 *
 * `send`: `POST {baseUrl}/tools/send_message`
 * (packages/tools/src/tools/send-message.ts:198-250, dispatched by
 * apps/api/src/app.ts:984-1051), `Authorization: Bearer <key>`
 * (app.ts:138-178), body `{ to: { channel, address }, content: { text } }`.
 * Response is `{status:"sent"|"queued", message_id, cost?}` on success,
 * `{status:"blocked", blocked_reason, suggestion}` when agentpush's own
 * policy gate refuses the send (HTTP 200 either way — not an error), or
 * `{status:"failed", error}` (packages/core/src/contracts/api-shapes.ts:219-244).
 *
 * `sendMedia`: channel support is asymmetric, verified per driver
 * (docs/AGENTPUSH.md §2). WhatsApp's driver is the only one implementing
 * `uploadMediaFromBuffer`
 * (packages/messaging/src/providers/whatsapp/provider.ts:608-623), so only
 * WhatsApp gets the real two-call flow: `POST /tools/upload_media` with
 * base64 `data` (packages/tools/src/tools/upload-media.ts:47-64) to get a
 * `providerMediaId`, then `send_message` with `content.media[]` referencing
 * it. Telegram's driver has no buffer/URL upload path of its own and only
 * ever sends media by a public `content.media[].url`
 * (packages/messaging/src/providers/telegram/provider.ts:128-131) — since a
 * locally-generated QR PNG has no public URL, Telegram degrades to a
 * caption-only `send_message`. This is a verified channel limitation, not a
 * hedge against an unknown contract.
 *
 * `"sms"` (M11, Twilio, docs/AGENTPUSH.md §9) routes through the identical
 * `send_message` call as the other two, `channel: "sms"`. Its media
 * fallback is unconditional, not just unverified: Twilio's driver declares
 * `capabilities.media: false` and implements no upload method at all
 * (`packages/messaging/src/providers/twilio/twilio.provider.ts:41-54`), so
 * it shares Telegram's caption-only branch below rather than getting one of
 * its own.
 */

import type { OutboundMessage, Transport } from "../../fanout/types.ts"
import type { Member } from "../../rooms/types.ts"
import { AgentpushToolClient, type AgentpushToolClientOptions, isUploadMediaResult } from "./tools-client.ts"

type MessengerProvider = "whatsapp" | "telegram" | "sms"

function messengerProvider(provider: string): MessengerProvider | undefined {
  return provider === "whatsapp" || provider === "telegram" || provider === "sms" ? provider : undefined
}

export type AgentpushTransportOptions = AgentpushToolClientOptions

export class AgentpushTransport implements Transport {
  private readonly client: AgentpushToolClient

  constructor(opts: AgentpushTransportOptions) {
    this.client = new AgentpushToolClient(opts)
  }

  async send(member: Member, message: OutboundMessage): Promise<void> {
    const provider = messengerProvider(member.address.provider)
    if (provider === undefined) return
    await this.sendText(member.id, provider, member.address.contactRef, message.text)
  }

  /** Two real paths, one fallback:
   *
   *  - **WhatsApp** — upload the bytes (`upload_media`), then send by the
   *    returned `providerMediaId`.
   *  - **Telegram and the rest** — no buffer/base64 upload path exists in
   *    that driver at all; it can only send media by a public
   *    `content.media[].url`. So when the caller has published the bytes
   *    (`publicMediaUrl`, served by `GET /r/:code/media/:id`) we send the
   *    URL and the image actually arrives.
   *  - **No URL available** — caption-only text, as before. That fallback
   *    used to be the ONLY behaviour here, which meant every image to a
   *    Telegram member silently became a line of text. The limitation was
   *    real; treating it as unfixable was not.
   */
  async sendMedia(member: Member, png: Uint8Array, caption: string, publicUrl?: string): Promise<void> {
    const provider = messengerProvider(member.address.provider)
    if (provider === undefined) return

    if (provider !== "whatsapp") {
      if (publicUrl === undefined) {
        await this.sendText(member.id, provider, member.address.contactRef, caption)
        return
      }
      await this.client.call(`member ${member.id}`, "send_message", {
        to: { channel: provider, address: member.address.contactRef },
        content: { text: caption, media: [{ type: "image", url: publicUrl, caption }] },
      })
      return
    }

    const mediaId = await this.uploadImage(member.id, provider, png)
    if (mediaId === undefined) {
      await this.sendText(member.id, provider, member.address.contactRef, caption)
      return
    }

    await this.client.call(`member ${member.id}`, "send_message", {
      to: { channel: provider, address: member.address.contactRef },
      content: { text: caption, media: [{ type: "image", providerMediaId: mediaId, caption }] },
    })
  }

  private async sendText(memberId: string, provider: MessengerProvider, address: string, text: string): Promise<void> {
    await this.client.call(`member ${memberId}`, "send_message", { to: { channel: provider, address }, content: { text } })
  }

  private async uploadImage(memberId: string, provider: MessengerProvider, png: Uint8Array): Promise<string | undefined> {
    const result = await this.client.call(`member ${memberId}`, "upload_media", {
      channel: provider,
      type: "image",
      data: Buffer.from(png).toString("base64"),
      filename: "qr.png",
      mimeType: "image/png",
    })
    if (!isUploadMediaResult(result)) return undefined
    return result.media_id
  }
}
