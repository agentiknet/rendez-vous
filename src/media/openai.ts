/**
 * The three media capabilities, behind one API key.
 *
 * `docs/MULTIMODAL.md` shipped `SttProvider` and `VisionProvider` as
 * injection points with `NullProviders` behind them: a voice note landed as
 * "(voice note, transcription unavailable, media:<id>)" — visible, never
 * silent, but the agent could not know what had been said. These are the real
 * implementations, plus TTS for the other direction.
 *
 * Two deliberate constraints, both from `docs/MULTIMODAL.md`'s principles:
 *
 * 1. **The key stays at the service.** It is never put into the box. A
 *    capability granted to the room would be granted to every member, and a
 *    sandbox-reachable API key is a credential handed to whoever is in the
 *    room (§9.3).
 * 2. **Nothing here throws.** A provider that is down produces a visible
 *    "transcription failed: <reason>" line and the turn still lands. The one
 *    outcome we never accept is a message that quietly does not arrive.
 */

import type { SttProvider, VisionProvider } from "../channels/media-ingress.ts"

const OPENAI_API = "https://api.openai.com/v1"
const REQUEST_TIMEOUT_MS = 60_000

const TRANSCRIBE_MODEL = "whisper-1"
const VISION_MODEL = "gpt-4o-mini"
const TTS_MODEL = "gpt-4o-mini-tts"
const TTS_VOICE = "alloy"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** `{error: {message}}` is OpenAI's shape for every failure; fall back to the
 *  status when the body is not what we expect. */
function errorMessage(body: unknown, status: number): string {
  if (isRecord(body)) {
    const error = body["error"]
    if (isRecord(error) && typeof error["message"] === "string") return error["message"]
  }
  return `HTTP ${status}`
}

/** Whisper infers the format from the upload's filename, and rejects an
 *  extension it does not recognise — so a blob named "file" fails even when
 *  the bytes are perfectly good audio. Derive one from the mime we were
 *  given, defaulting to the format Telegram voice notes actually use. */
function audioFilename(mime: string): string {
  const normalized = mime.split(";")[0]?.trim().toLowerCase() ?? ""
  const extension =
    normalized === "audio/mpeg"
      ? "mp3"
      : normalized === "audio/mp4" || normalized === "audio/m4a"
        ? "m4a"
        : normalized === "audio/wav" || normalized === "audio/x-wav"
          ? "wav"
          : normalized === "audio/webm"
            ? "webm"
            : "ogg"
  return `audio.${extension}`
}

export class OpenAiSttProvider implements SttProvider {
  private readonly apiKey: string
  private readonly baseUrl: string

  constructor(apiKey: string, baseUrl: string = OPENAI_API) {
    this.apiKey = apiKey
    this.baseUrl = baseUrl
  }

  async transcribe(bytes: Uint8Array, mime: string): Promise<string | undefined> {
    const form = new FormData()
    form.append("file", new Blob([bytes], { type: mime }), audioFilename(mime))
    form.append("model", TRANSCRIBE_MODEL)

    const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const body: unknown = await res.json()
    if (!res.ok) throw new Error(errorMessage(body, res.status))
    if (!isRecord(body) || typeof body["text"] !== "string") return undefined
    const text = body["text"].trim()
    return text.length > 0 ? text : undefined
  }
}

export class OpenAiVisionProvider implements VisionProvider {
  private readonly apiKey: string
  private readonly baseUrl: string

  constructor(apiKey: string, baseUrl: string = OPENAI_API) {
    this.apiKey = apiKey
    this.baseUrl = baseUrl
  }

  async caption(bytes: Uint8Array, mime: string): Promise<string | undefined> {
    // Sent as a data URL rather than a hosted link on purpose: an inbound
    // image belongs to the room, and publishing it to get a caption would put
    // a member's photo on a URL nobody asked for.
    const dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Describe this image for someone who cannot see it, in at most three sentences. " +
                  "If it contains text, a diagram, a screenshot or a document, transcribe the text content — " +
                  "that is usually the point of someone sending it. Reply with the description only.",
              },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        max_tokens: 400,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const body: unknown = await res.json()
    if (!res.ok) throw new Error(errorMessage(body, res.status))
    if (!isRecord(body)) return undefined
    const choices = body["choices"]
    if (!Array.isArray(choices) || choices.length === 0) return undefined
    const first: unknown = choices[0]
    if (!isRecord(first)) return undefined
    const message = first["message"]
    if (!isRecord(message) || typeof message["content"] !== "string") return undefined
    const text = message["content"].trim()
    return text.length > 0 ? text : undefined
  }
}

export interface TtsProvider {
  /** Spoken audio for `text`, or `undefined` when nothing could be produced.
   *  Throws only on a transport/API error, which callers turn into a visible
   *  line rather than a dropped turn. */
  speak(text: string): Promise<{ bytes: Uint8Array; mime: string; extension: string } | undefined>
}

export class OpenAiTtsProvider implements TtsProvider {
  private readonly apiKey: string
  private readonly baseUrl: string

  constructor(apiKey: string, baseUrl: string = OPENAI_API) {
    this.apiKey = apiKey
    this.baseUrl = baseUrl
  }

  async speak(text: string): Promise<{ bytes: Uint8Array; mime: string; extension: string } | undefined> {
    const trimmed = text.trim()
    if (trimmed.length === 0) return undefined

    const res = await fetch(`${this.baseUrl}/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      // opus in an ogg container is what Telegram and WhatsApp both render as
      // a playable voice note rather than a file to download.
      body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: trimmed, response_format: "opus" }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) {
      let body: unknown
      try {
        body = await res.json()
      } catch {
        body = undefined
      }
      throw new Error(errorMessage(body, res.status))
    }
    const buffer = await res.arrayBuffer()
    if (buffer.byteLength === 0) return undefined
    return { bytes: new Uint8Array(buffer), mime: "audio/ogg", extension: "ogg" }
  }
}
