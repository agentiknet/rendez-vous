/**
 * Shared HTTP client for agentpush's generic tool-execution route,
 * `POST {baseUrl}/tools/:name` (packages/tools/src/tools/*, dispatched by
 * apps/api/src/app.ts:984-1051 in the read-only agentpush checkout; see
 * docs/AGENTPUSH.md §1). Used by both the messenger transport
 * (`send_message`/`upload_media` with `channel: "whatsapp"|"telegram"`) and
 * the email transport (`send_message` with `channel: "mail"`, docs/AGENTPUSH.md
 * §8) — same auth header, same response envelope, same never-throw contract.
 */

import { isRecord } from "../json.ts"

export interface SentResult {
  status: "sent" | "queued"
  message_id: string
}

export interface BlockedResult {
  status: "blocked"
  blocked_reason: string
  suggestion: string
}

export interface FailedResult {
  status: "failed"
  error: string
}

export type SendMessageResult = SentResult | BlockedResult | FailedResult

export interface UploadMediaResult {
  media_id: string
}

export function isSendMessageResult(value: unknown): value is SendMessageResult {
  if (!isRecord(value)) return false
  const status = value.status
  return status === "sent" || status === "queued" || status === "blocked" || status === "failed"
}

export function isUploadMediaResult(value: unknown): value is UploadMediaResult {
  return isRecord(value) && typeof value.media_id === "string"
}

export interface AgentpushToolClientOptions {
  /** `RDV_AGENTPUSH_URL`, no trailing slash. */
  baseUrl: string
  /** `RDV_AGENTPUSH_KEY`, a workspace API key minted per docs/AGENTPUSH.md §4. */
  apiKey: string | undefined
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

export class AgentpushToolClient {
  private readonly baseUrl: string
  private readonly apiKey: string | undefined
  private readonly fetchImpl: typeof fetch

  constructor(opts: AgentpushToolClientOptions) {
    this.baseUrl = opts.baseUrl.endsWith("/") ? opts.baseUrl.slice(0, -1) : opts.baseUrl
    this.apiKey = opts.apiKey
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  /** POST {baseUrl}/tools/{toolName}. Never throws — logs and resolves
   *  `undefined` on any transport error, non-2xx, or a `blocked`/`failed`
   *  tool result (still returned, for the caller to fall back on). */
  async call(logLabel: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
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
        console.error(`[channels/agentpush] ${toolName} failed for ${logLabel}: HTTP ${res.status}`)
        return undefined
      }
      if (isSendMessageResult(body) && (body.status === "blocked" || body.status === "failed")) {
        const reason = body.status === "blocked" ? body.blocked_reason : body.error
        console.error(`[channels/agentpush] ${toolName} ${body.status} for ${logLabel}: ${reason}`)
      }
      return body
    } catch (err) {
      console.error(
        `[channels/agentpush] ${toolName} error for ${logLabel}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return undefined
    }
  }
}
