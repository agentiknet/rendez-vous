/**
 * Resolving inbound media through agentpush, for ANY messenger channel.
 *
 * Both drivers hand on a bare provider reference and no URL: Telegram sets
 * `providerMediaId` to a `file_id` (`telegram/provider.ts:330-387`), WhatsApp
 * sets it to a Meta media id (`whatsapp/provider.ts:512-520`). Neither is
 * resolvable without that provider's credentials, which a notify consumer
 * does not hold and should not hold.
 *
 * `messaging_attachment_fetch` is the supported way in: agentpush resolves and
 * downloads server-side and returns base64, so the bot token / Graph token
 * never leaves it. This replaces `TelegramMediaResolver`, which solved the
 * same problem by putting the Telegram bot token into THIS service — useful
 * while `fetchAttachment` did not exist upstream, and strictly worse now that
 * it does.
 *
 * It also fixes a bug of ours: the Telegram resolver was wired for every
 * channel, so a WhatsApp voice note's Meta media id was sent to Telegram's
 * `getFile`, which rejected it — the record landed at 0 bytes and the member
 * was told the file "could not be fetched". Provider-blind resolution looked
 * like a platform limit and was our own wiring.
 */

const REQUEST_TIMEOUT_MS = 30_000

export type ResolvedMedia =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly mime: string | undefined }
  | { readonly ok: false; readonly reason: string }

export interface MediaFetchResponse {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
  text(): Promise<string>
}

export type MediaFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<MediaFetchResponse>

export interface AgentpushMediaFetcherOptions {
  readonly baseUrl: string
  readonly apiKey: string | undefined
  readonly fetch?: MediaFetch
  readonly maxBytes?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** `{message_id, attachment_id, size, data}` on success. `size` is trusted
 *  only for the error message — the real length is the decoded buffer's. */
function readPayload(body: unknown): { data: string } | { error: string } {
  if (!isRecord(body)) return { error: "malformed response" }
  const data = body["data"]
  if (typeof data !== "string" || data.length === 0) {
    const message = body["message"] ?? body["error"]
    return { error: typeof message === "string" ? message : "no data in response" }
  }
  return { data }
}

export class AgentpushMediaFetcher {
  private readonly baseUrl: string
  private readonly apiKey: string | undefined
  private readonly doFetch: MediaFetch
  private readonly maxBytes: number | undefined

  constructor(opts: AgentpushMediaFetcherOptions) {
    this.baseUrl = opts.baseUrl
    this.apiKey = opts.apiKey
    this.doFetch =
      opts.fetch ??
      ((url, init) =>
        fetch(url, {
          method: init.method,
          headers: init.headers,
          body: init.body,
          ...(init.signal !== undefined ? { signal: init.signal } : {}),
        }))
    this.maxBytes = opts.maxBytes
  }

  /**
   * Never throws. `providerMediaId` is the envelope's own reference, and
   * `channel` is the provider that issued it.
   *
   * `channel` is not optional in practice. An attachment id only means
   * something to the provider that minted it, and agentpush's REST tool
   * surface otherwise resolves ONE static provider headed by WhatsApp — so
   * once the WhatsApp account was added for this demo, every Telegram
   * `file_id` was handed to Meta's Graph API, which answered
   * `Unsupported get request`. The member was told their voice note "could
   * not be fetched" and the agent generalised it into "I cannot hear audio".
   * The channel was known at every step; nothing carried it.
   */
  async resolve(providerMediaId: string, channel?: string): Promise<ResolvedMedia> {
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (this.apiKey !== undefined) headers["authorization"] = `Bearer ${this.apiKey}`

    try {
      const res = await this.doFetch(`${this.baseUrl}/tools/messaging_attachment_fetch`, {
        method: "POST",
        headers,
        // `message_id` is ignored by both chat providers (a file_id / media id
        // is self-contained) but the tool's schema requires it.
        body: JSON.stringify({
          message_id: providerMediaId,
          attachment_id: providerMediaId,
          ...(channel !== undefined ? { channel } : {}),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => "")
        return { ok: false, reason: `agentpush attachment fetch failed: HTTP ${res.status}${detail ? ` ${detail.slice(0, 120)}` : ""}` }
      }
      const parsed = readPayload(await res.json())
      if ("error" in parsed) return { ok: false, reason: parsed.error }

      const bytes = new Uint8Array(Buffer.from(parsed.data, "base64"))
      if (bytes.byteLength === 0) return { ok: false, reason: "provider returned no bytes" }
      if (this.maxBytes !== undefined && bytes.byteLength > this.maxBytes) {
        return { ok: false, reason: `too large (${bytes.byteLength} > ${this.maxBytes} bytes)` }
      }
      // The tool does not echo a mime type; ingress keeps the envelope's.
      return { ok: true, bytes, mime: undefined }
    } catch (error: unknown) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
}
