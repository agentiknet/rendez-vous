/**
 * Resolving inbound Telegram media that arrives with no URL.
 *
 * agentpush parses a voice note or photo correctly but hands on only the raw
 * `file_id` — `providerMediaId`, no `url` — because turning one into a
 * downloadable link needs a `getFile` call authenticated with the bot token
 * (docs/UPSTREAM.md §11). A notify consumer has no token, so the reference is
 * unresolvable to it, and the message used to vanish between the two systems
 * with no error anywhere.
 *
 * The upstream fix belongs in agentpush, behind its own auth. Until it lands,
 * this service can do the same job itself when an operator gives it the token
 * (`RDV_TELEGRAM_BOT_TOKEN`), with one hard rule:
 *
 * **The token-bearing URL never leaves this module.** `getFile` returns a
 * `file_path`, and the download URL built from it embeds the bot token in the
 * path — a full credential. It is used for one fetch and discarded: never
 * stored on a media record, never logged, never handed to a member or to a
 * provider. That is precisely the leak docs/UPSTREAM.md §11 warns agentpush
 * away from, so introducing it here would be no better.
 *
 * Everything returns a reason instead of throwing. A voice note we cannot
 * read is a visible line in the room, never a 500 on the webhook.
 */

const TELEGRAM_API = "https://api.telegram.org"
const RESOLVE_TIMEOUT_MS = 15_000

export type ResolvedMedia =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly mime: string | undefined }
  | { readonly ok: false; readonly reason: string }

/** Structural subset of `fetch` — injectable so tests never touch the network
 *  and never need a real token. */
export interface ResolverFetchResponse {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
}

export type ResolverFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<ResolverFetchResponse>

export interface TelegramMediaResolverOptions {
  readonly token: string
  readonly fetch?: ResolverFetch
  readonly maxBytes?: number
  /** Overridable so tests can point at a local server. */
  readonly apiBase?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Pull `result.file_path` out of a `getFile` response without trusting its
 *  shape. Telegram answers `{ok, result:{file_id, file_path, file_size}}` on
 *  success and `{ok:false, description}` on failure. */
function readFilePath(body: unknown): { path: string } | { error: string } {
  if (!isRecord(body)) return { error: "malformed getFile response" }
  if (body["ok"] !== true) {
    const description = body["description"]
    return { error: typeof description === "string" ? description : "getFile reported failure" }
  }
  const result = body["result"]
  if (!isRecord(result)) return { error: "getFile returned no result" }
  const filePath = result["file_path"]
  if (typeof filePath !== "string" || filePath.length === 0) {
    // Genuinely possible: Telegram refuses `file_path` for files over 20 MB.
    return { error: "getFile returned no file_path (file too large for the bot API?)" }
  }
  return { path: filePath }
}

export class TelegramMediaResolver {
  private readonly token: string
  private readonly doFetch: ResolverFetch
  private readonly maxBytes: number | undefined
  private readonly apiBase: string

  constructor(opts: TelegramMediaResolverOptions) {
    this.token = opts.token
    this.doFetch = opts.fetch ?? ((url, init) => fetch(url, init))
    this.maxBytes = opts.maxBytes
    this.apiBase = opts.apiBase ?? TELEGRAM_API
  }

  /** `file_id` → bytes. Never throws. */
  async resolve(fileId: string): Promise<ResolvedMedia> {
    let filePath: string
    try {
      const res = await this.doFetch(`${this.apiBase}/bot${this.token}/getFile?file_id=${encodeURIComponent(fileId)}`, {
        signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
      })
      if (!res.ok) return { ok: false, reason: `getFile failed: HTTP ${res.status}` }
      const parsed = readFilePath(await res.json())
      if ("error" in parsed) return { ok: false, reason: parsed.error }
      filePath = parsed.path
    } catch (error: unknown) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }

    try {
      // This URL carries the bot token. One use, no storage, no logging.
      const res = await this.doFetch(`${this.apiBase}/file/bot${this.token}/${filePath}`, {
        signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
      })
      if (!res.ok) return { ok: false, reason: `download failed: HTTP ${res.status}` }
      const buffer = await res.arrayBuffer()
      if (this.maxBytes !== undefined && buffer.byteLength > this.maxBytes) {
        return { ok: false, reason: `too large (${buffer.byteLength} > ${this.maxBytes} bytes)` }
      }
      return { ok: true, bytes: new Uint8Array(buffer), mime: mimeForPath(filePath) }
    } catch (error: unknown) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
}

/** Telegram's `file_path` carries the real extension even when the envelope's
 *  `mimeType` was absent — useful because Whisper rejects an upload whose
 *  filename has no recognisable audio extension. */
export function mimeForPath(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf(".")
  if (dot === -1) return undefined
  const extension = filePath.slice(dot + 1).toLowerCase()
  const known: Readonly<Record<string, string>> = {
    oga: "audio/ogg",
    ogg: "audio/ogg",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    webm: "audio/webm",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    pdf: "application/pdf",
    mp4: "video/mp4",
  }
  return known[extension]
}
