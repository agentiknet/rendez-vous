/**
 * Sends outbound messenger turns through the real agentpush REST API.
 *
 * Ground-truthed against the read-only checkout at
 * /Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/projects/agentpush
 * (never edited) — see docs/AGENTPUSH.md for the full contract with
 * file:line citations. Replaces the M5 version, which correctly identified
 * that the agentproto daemon's own agentpush path is MCP-mediated (no raw
 * HTTP endpoint to copy) but then inferred a fictional REST shape. This
 * version calls agentpush's real, generic tool-execution route directly.
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
 */

import type { OutboundMessage, Transport } from "../../fanout/types.ts"
import type { Member } from "../../rooms/types.ts"

type MessengerProvider = "whatsapp" | "telegram"

function messengerProvider(provider: string): MessengerProvider | undefined {
  return provider === "whatsapp" || provider === "telegram" ? provider : undefined
}

interface SentResult {
  status: "sent" | "queued"
  message_id: string
}

interface BlockedResult {
  status: "blocked"
  blocked_reason: string
  suggestion: string
}

interface FailedResult {
  status: "failed"
  error: string
}

type SendMessageResult = SentResult | BlockedResult | FailedResult

interface UploadMediaResult {
  media_id: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSendMessageResult(value: unknown): value is SendMessageResult {
  if (!isRecord(value)) return false
  const status = value.status
  return status === "sent" || status === "queued" || status === "blocked" || status === "failed"
}

function isUploadMediaResult(value: unknown): value is UploadMediaResult {
  return isRecord(value) && typeof value.media_id === "string"
}

export interface AgentpushTransportOptions {
  /** `RDV_AGENTPUSH_URL`, no trailing slash. */
  baseUrl: string
  /** `RDV_AGENTPUSH_KEY`, a workspace API key minted per docs/AGENTPUSH.md §4. */
  apiKey: string | undefined
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

export class AgentpushTransport implements Transport {
  private readonly baseUrl: string
  private readonly apiKey: string | undefined
  private readonly fetchImpl: typeof fetch

  constructor(opts: AgentpushTransportOptions) {
    this.baseUrl = opts.baseUrl.endsWith("/") ? opts.baseUrl.slice(0, -1) : opts.baseUrl
    this.apiKey = opts.apiKey
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async send(member: Member, message: OutboundMessage): Promise<void> {
    const provider = messengerProvider(member.address.provider)
    if (provider === undefined) return
    await this.sendText(member.id, provider, member.address.contactRef, message.text)
  }

  /** WhatsApp gets a real upload + media send. Telegram (or any other
   *  messenger provider) degrades to a caption-only text send — see the
   *  module doc comment for why that is a verified limitation, not a
   *  shortcut. */
  async sendMedia(member: Member, png: Uint8Array, caption: string): Promise<void> {
    const provider = messengerProvider(member.address.provider)
    if (provider === undefined) return

    if (provider !== "whatsapp") {
      await this.sendText(member.id, provider, member.address.contactRef, caption)
      return
    }

    const mediaId = await this.uploadImage(member.id, provider, png)
    if (mediaId === undefined) {
      await this.sendText(member.id, provider, member.address.contactRef, caption)
      return
    }

    await this.callTool(member.id, "send_message", {
      to: { channel: provider, address: member.address.contactRef },
      content: { text: caption, media: [{ type: "image", providerMediaId: mediaId, caption }] },
    })
  }

  private async sendText(memberId: string, provider: MessengerProvider, address: string, text: string): Promise<void> {
    await this.callTool(memberId, "send_message", { to: { channel: provider, address }, content: { text } })
  }

  private async uploadImage(memberId: string, provider: MessengerProvider, png: Uint8Array): Promise<string | undefined> {
    const result = await this.callTool(memberId, "upload_media", {
      channel: provider,
      type: "image",
      data: Buffer.from(png).toString("base64"),
      filename: "qr.png",
      mimeType: "image/png",
    })
    if (!isUploadMediaResult(result)) return undefined
    return result.media_id
  }

  private async callTool(memberId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (this.apiKey !== undefined) {
      headers.authorization = `Bearer ${this.apiKey}`
    }

    try {
      const res = await this.fetchImpl(`${this.baseUrl}/tools/${toolName}`, {
        method: "POST",
        headers,
        body: JSON.stringify(args),
      })
      const body: unknown = await res.json().catch(() => undefined)
      if (!res.ok) {
        console.error(`[channels/agentpush] ${toolName} failed for member ${memberId}: HTTP ${res.status}`)
        return undefined
      }
      if (isSendMessageResult(body) && (body.status === "blocked" || body.status === "failed")) {
        const reason = body.status === "blocked" ? body.blocked_reason : body.error
        console.error(`[channels/agentpush] ${toolName} ${body.status} for member ${memberId}: ${reason}`)
      }
      return body
    } catch (err) {
      console.error(
        `[channels/agentpush] ${toolName} error for member ${memberId}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return undefined
    }
  }
}
