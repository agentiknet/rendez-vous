import type { TtsProvider } from "./media/openai.ts"
import type { MediaRecord, SaveMediaInput } from "./service/media-store.ts"
import { publicMediaUrl } from "./service/artifact-proxy.ts"
import type { OutboundAttachment } from "./service/transports.ts"

export interface ParsedSpeech {
  readonly text: string
  readonly spoken: readonly string[]
}

const SAY_LINE = /^[ \t]*\[\[say[ \t]+([^\]]+)\]\][ \t]*$/i

export function parseSpeech(text: string): ParsedSpeech {
  const spoken: string[] = []
  const kept: string[] = []

  for (const line of text.split("\n")) {
    const match = SAY_LINE.exec(line)
    if (match === null) {
      kept.push(line)
      continue
    }
    const body = match[1]?.trim()
    if (body === undefined || body.length === 0) {
      kept.push(line)
      continue
    }
    spoken.push(body)
  }

  return { text: kept.join("\n").trim(), spoken }
}

export interface SpeechMediaStore {
  save(roomCode: string, data: Buffer, opts: SaveMediaInput): Promise<MediaRecord>
}

export async function renderSpeech(
  code: string,
  spoken: readonly string[],
  tts: TtsProvider | undefined,
  mediaStore: SpeechMediaStore | undefined,
): Promise<OutboundAttachment[]> {
  if (spoken.length === 0) return []
  if (tts === undefined || mediaStore === undefined) {
    return spoken.map((text) => ({
      url: "",
      filename: "",
      mimeType: "",
      kind: "audio" as const,
      caption: text,
    }))
  }

  const notes: OutboundAttachment[] = []
  for (const text of spoken) {
    try {
      const audio = await tts.speak(text)
      if (audio === undefined) {
        notes.push({ url: "", filename: "", mimeType: "", kind: "audio", caption: text })
        continue
      }
      const record = await mediaStore.save(code, Buffer.from(audio.bytes), {
        contentType: audio.mime,
        pages: 1,
      })
      notes.push({
        url: publicMediaUrl(code, record.id),
        filename: `voice.${audio.extension}`,
        mimeType: audio.mime,
        kind: "audio",
        caption: text,
      })
    } catch (error: unknown) {
      console.error(
        `tts failed for room ${code}: ${error instanceof Error ? error.message : String(error)}`,
      )
      notes.push({ url: "", filename: "", mimeType: "", kind: "audio", caption: text })
    }
  }
  return notes
}