/**
 * Multimodal ingress — docs/MULTIMODAL.md, "normalize at ingress, fan out
 * by fidelity". A voice note or image arriving on an inbound webhook is
 * turned into TEXT plus a durable media reference BEFORE anything is
 * enqueued: the prompt queue stays text-only, the media ref is retained
 * forever as provenance, and nothing is ever silently dropped.
 *
 * `normalizeInboundMedia(envelope, deps)` fetches each media item's bytes
 * from the URL the envelope already carries, stores them through the same
 * `MediaStore` the deliverable flow uses, and returns the text lines to fan
 * in plus an `attributionSuffix` (`"voice"` / `"image"` / …) for the
 * webhook handlers to fold into the `[Name · channel · kind]` prefix.
 *
 * Transcription and captioning sit behind two injectable providers with NO
 * real implementation tonight: `SttProvider` and `VisionProvider`. The
 * shipped `NullProviders` returns `undefined`, so the fanned-in line is the
 * visible "(voice note, transcription unavailable, media:<id>)" /
 * "(image, caption unavailable, media:<id>)" shape — never a dropped turn
 * (docs/UPSTREAM.md, "The pattern"). Real STT and vision providers plug in
 * via env later (`@agstudio/integration-speech` and the image-reader
 * pattern) and are NOT wired tonight — see docs/MULTIMODAL.md status.
 *
 * Failures of the fetch itself (network error, HTTP error, oversize) fan in
 * as "(voice note, could not be fetched: <reason>, media:<id>)" so the
 * transcript shows exactly what happened, and the record still lands (empty
 * bytes, `error` set) — the reference resolves, the reason is recoverable.
 */

import { env } from "../env.ts"
import type { InboundEnvelope } from "./agentpush/inbound.ts"
import type { IngressMediaRecord, SaveIngressInput } from "../service/media-store.ts"

export type MediaKind = IngressMediaRecord["kind"]

export interface SttProvider {
  transcribe(bytes: Uint8Array, mime: string): Promise<string | undefined>
}

export interface VisionProvider {
  caption(bytes: Uint8Array, mime: string): Promise<string | undefined>
}

/** Tonight's providers: no real STT/vision behind them, by design. */
export const NullProviders: { readonly stt: SttProvider; readonly vision: VisionProvider } = {
  stt: {
    transcribe: () => Promise.resolve(undefined),
  },
  vision: {
    caption: () => Promise.resolve(undefined),
  },
}

/** Structural subset of `fetch`'s response ingress needs — injectable so
 *  tests can hand bytes back without a real server. */
export interface IngressFetchResponse {
  readonly ok: boolean
  readonly status: number
  arrayBuffer(): Promise<ArrayBuffer>
}

export type IngressFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<IngressFetchResponse>

const defaultFetch: IngressFetch = (url, init) => fetch(url, init)

/** What normalization writes through — structurally `MediaStore`'s ingress
 *  half, so tests can script it without touching the deliverable half. */
export interface IngressStore {
  saveIngress(data: Uint8Array, opts: SaveIngressInput): Promise<IngressMediaRecord>
}

export interface NormalizeInboundMediaDeps {
  /** Storage sink for the fetched bytes (and for empty-byte records on a
   *  failed fetch — the reference always lands). */
  readonly store: IngressStore
  readonly stt?: SttProvider
  readonly vision?: VisionProvider
  readonly fetch?: IngressFetch
  readonly maxBytes?: number
}

export interface NormalizedInboundMedia {
  /** The text lines to fan in for the envelope's media items, one per item
   *  joined by newlines; `undefined` when the envelope carried no media —
   *  the webhook handler then fans in the original text unchanged. */
  readonly text: string | undefined
  /** `"voice"` / `"image"` / `"file"` when every item has the same kind,
   *  `"media"` for a mix; `undefined` with no items. The handlers fold it
   *  into the attribution prefix as `[Name · channel · kind]`. */
  readonly attributionSuffix: string | undefined
  readonly records: readonly IngressMediaRecord[]
}

const FETCH_TIMEOUT_MS = 20_000

export function kindForMediaType(type: string): MediaKind {
  const normalized = type.trim().toLowerCase()
  if (normalized === "voice" || normalized === "audio" || normalized === "ptt" || normalized.endsWith("/audio")) {
    return "voice"
  }
  if (normalized === "image" || normalized === "photo" || normalized.startsWith("image/")) {
    return "image"
  }
  return "file"
}

function labelFor(kind: MediaKind): string {
  return kind === "voice" ? "voice note" : kind
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type ProviderOutcome = { ok: true; text: string } | { ok: false; reason: string }

/** Providers are behind a try/catch too — a throwing provider becomes a
 *  visible "transcription failed: …" line, not a dropped turn and not a
 *  500 on the webhook. */
async function runProvider(run: () => Promise<string | undefined>): Promise<ProviderOutcome> {
  try {
    const text = await run()
    return text === undefined ? { ok: false, reason: "unavailable" } : { ok: true, text }
  } catch (error: unknown) {
    return { ok: false, reason: reasonOf(error) }
  }
}

function unavailableLine(kind: MediaKind, mediaId: string): string {
  return kind === "image"
    ? `(image, caption unavailable, media:${mediaId})`
    : `(${labelFor(kind)}, transcription unavailable, media:${mediaId})`
}

function providerFailedLine(kind: MediaKind, mediaId: string, reason: string): string {
  const what = kind === "image" ? "caption failed" : "transcription failed"
  return `(${labelFor(kind)}, ${what}: ${reason}, media:${mediaId})`
}

function failureLine(kind: MediaKind, mediaId: string, reason: string): string {
  return `(${labelFor(kind)}, could not be fetched: ${reason}, media:${mediaId})`
}

function successLine(kind: MediaKind, mediaId: string, text: string): string {
  return `(${labelFor(kind)}) ${text}  media:${mediaId}`
}

export async function normalizeInboundMedia(
  envelope: InboundEnvelope,
  deps: NormalizeInboundMediaDeps,
): Promise<NormalizedInboundMedia> {
  const items = envelope.media
  if (items.length === 0) {
    return { text: undefined, attributionSuffix: undefined, records: [] }
  }

  const doFetch = deps.fetch ?? defaultFetch
  const stt = deps.stt ?? NullProviders.stt
  const vision = deps.vision ?? NullProviders.vision
  const maxBytes = deps.maxBytes ?? env.mediaMaxBytes

  const lines: string[] = []
  const records: IngressMediaRecord[] = []
  const kinds = new Set<MediaKind>()

  for (const item of items) {
    const kind = kindForMediaType(item.type)
    kinds.add(kind)

    let record: IngressMediaRecord
    let line: string

    if (item.url === undefined) {
      // No URL to fetch from — the provider sent only its own reference
      // (every Telegram voice note and photo, see `parseMedia`). Resolving
      // it needs that provider's credentials, which this service does not
      // hold. Land the record and SAY SO: the member sees the turn was
      // received and why it could not be read, instead of the silence this
      // path used to produce.
      const reference = item.providerMediaId ?? "no reference"
      const reason = `no fetchable URL from the provider (reference: ${reference})`
      record = await deps.store.saveIngress(new Uint8Array(0), {
        kind,
        source: item.providerMediaId ?? "",
        mime: item.mimeType,
        error: reason,
      })
      line = failureLine(kind, record.mediaId, reason)
    } else if (item.size !== undefined && item.size > maxBytes) {
      const reason = `too large (${item.size} > ${maxBytes} bytes)`
      record = await deps.store.saveIngress(new Uint8Array(0), {
        kind,
        source: item.url,
        mime: item.mimeType,
        error: reason,
      })
      line = failureLine(kind, record.mediaId, reason)
    } else {
      let bytes: Uint8Array | undefined
      let fetchError: string | undefined
      try {
        const response = await doFetch(item.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        if (!response.ok) {
          fetchError = `HTTP ${response.status}`
        } else {
          const buffer = await response.arrayBuffer()
          if (buffer.byteLength > maxBytes) {
            fetchError = `too large (${buffer.byteLength} > ${maxBytes} bytes)`
          } else {
            bytes = new Uint8Array(buffer)
          }
        }
      } catch (error: unknown) {
        fetchError = reasonOf(error)
      }

      if (bytes === undefined) {
        const reason = fetchError ?? "unknown error"
        record = await deps.store.saveIngress(new Uint8Array(0), {
          kind,
          source: item.url,
          mime: item.mimeType,
          error: reason,
        })
        line = failureLine(kind, record.mediaId, reason)
      } else {
        const data: Uint8Array = bytes
        const outcome =
          kind === "voice"
            ? await runProvider(() => stt.transcribe(data, item.mimeType))
            : kind === "image"
              ? await runProvider(() => vision.caption(data, item.mimeType))
              : undefined

        const providerText = outcome !== undefined && outcome.ok ? outcome.text : undefined
        const saveOpts: SaveIngressInput = { kind, source: item.url, mime: item.mimeType }
        if (kind === "voice" && providerText !== undefined) saveOpts.transcript = providerText
        if (kind === "image" && providerText !== undefined) saveOpts.caption = providerText
        record = await deps.store.saveIngress(data, saveOpts)

        if (outcome === undefined) {
          line = `(file, media:${record.mediaId})`
        } else if (providerText !== undefined) {
          line = successLine(kind, record.mediaId, providerText)
        } else if (!outcome.ok && outcome.reason !== "unavailable") {
          line = providerFailedLine(kind, record.mediaId, outcome.reason)
        } else {
          line = unavailableLine(kind, record.mediaId)
        }
      }
    }

    lines.push(line)
    records.push(record)
  }

  const unique: MediaKind[] = []
  for (const kind of kinds) unique.push(kind)
  const suffix = unique.length === 1 && unique[0] !== undefined ? unique[0] : "media"
  return { text: lines.join("\n"), attributionSuffix: suffix, records }
}