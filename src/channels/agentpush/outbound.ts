/**
 * Sends outbound messenger turns through agentpush.
 *
 * The daemon's own agentpush outbound path is NOT a raw HTTP endpoint we can
 * mirror: `sendAgentpush` (outbound-adapters.ts:81-159 in the read-only
 * agentproto checkout) calls `deps.mcpProxy.callTool(alias, "send_message",
 * { to: { channel, address }, content })` — an MCP tool call on an imported
 * agentpush MCP server, not a fetch. Agentpush's real REST surface behind
 * that MCP server lives entirely outside this repo; the auth skill's own
 * worked example uses a placeholder `apiBase: "https://api.agentpush.example"`
 * (skill-pack-agentpush/skills/auth/SKILL.md), so there is no ground-truthed
 * HTTP path or header name to copy verbatim.
 *
 * `send` below calls `POST {RDV_AGENTPUSH_URL}/send_message` with the same
 * JSON body shape the daemon hands to the MCP tool call
 * (`{ to: { channel, address }, content: { text } }`) and a bare
 * `Authorization: Bearer <RDV_AGENTPUSH_KEY>` header (the shape
 * `CredentialBroker.resolveHeaders` produces for a `pat` provider,
 * auth/SKILL.md). This is our own inferred integration contract against
 * agentpush's actual hosted API, not a verified endpoint from the checkout.
 *
 * `sendMedia` degrades to a caption-only text send. The daemon's media path
 * (outbound-adapters.ts:90-142) uploads via a second MCP tool,
 * `upload_media`, then references the returned `media_id` in
 * `content.media[]` — but that two-step contract is, again, only ever
 * observed as an MCP tool JSON shape, never as a documented REST endpoint.
 * Fabricating a base64-upload HTTP route with no ground truth for its path,
 * response shape, or error modes is worse than not sending the image: the
 * brief for this module explicitly allows a caption + link fallback when
 * media can't be verified, so callers should fold the join link into
 * `caption` themselves — the QR is a convenience, the link is the fallback.
 */

import type { OutboundMessage, Transport } from "../../fanout/types.ts"
import type { Member } from "../../rooms/types.ts"

const MESSENGER_PROVIDERS: readonly string[] = ["whatsapp", "telegram"]

export interface AgentpushTransportOptions {
  /** `RDV_AGENTPUSH_URL`, no trailing slash. */
  baseUrl: string
  /** `RDV_AGENTPUSH_KEY`. Sent as `Authorization: Bearer <key>` when set. */
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
    if (!MESSENGER_PROVIDERS.includes(member.address.provider)) return
    await this.postSendMessage(member, message.text)
  }

  /** `png` is accepted for interface symmetry with the QR the caller
   *  generated, but is never transmitted — see the module doc comment for
   *  why. `caption` should already carry the join link. */
  async sendMedia(member: Member, _png: Uint8Array, caption: string): Promise<void> {
    if (!MESSENGER_PROVIDERS.includes(member.address.provider)) return
    await this.postSendMessage(member, caption)
  }

  private async postSendMessage(member: Member, text: string): Promise<void> {
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (this.apiKey !== undefined) {
      headers.authorization = `Bearer ${this.apiKey}`
    }

    const body = JSON.stringify({
      to: { channel: member.address.provider, address: member.address.contactRef },
      content: { text },
    })

    try {
      const res = await this.fetchImpl(`${this.baseUrl}/send_message`, { method: "POST", headers, body })
      if (!res.ok) {
        console.error(`[channels/agentpush] send_message failed for member ${member.id}: HTTP ${res.status}`)
      }
    } catch (err) {
      console.error(
        `[channels/agentpush] send_message error for member ${member.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
