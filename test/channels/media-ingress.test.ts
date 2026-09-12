/**
 * Multimodal ingress normalization — docs/MULTIMODAL.md, "normalize at
 * ingress, fan out by fidelity". Uses a real local HTTP server as the fake
 * provider media URL host (the envelope's `media[].url` is fetched with the
 * default fetch), and the real `MediaStore` over a temp dir.
 */

import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { NullProviders, normalizeInboundMedia, kindForMediaType } from "../../src/channels/media-ingress.ts"
import type { InboundEnvelope } from "../../src/channels/agentpush/inbound.ts"
import { MediaStore } from "../../src/service/media-store.ts"

const dirs: string[] = []
const servers: Server[] = []

after(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshMediaStore(): Promise<MediaStore> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-media-ingress-"))
  dirs.push(dir)
  return new MediaStore(dir)
}

const AUDIO_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
const IMAGE_BYTES = new Uint8Array([9, 8, 7, 6, 5, 4])

/** Fake provider URL host: the URLs an inbound envelope's `media[].url`
 *  carries. `/audio.webm` and `/img.jpg` return bytes, `/boom` returns 500,
 *  anything else 404. */
async function startProviderHost(): Promise<string> {
  const server = createServer((req, res) => {
    if (req.url === "/audio.webm") {
      res.writeHead(200, { "content-type": "audio/webm" })
      res.end(AUDIO_BYTES)
      return
    }
    if (req.url === "/img.jpg") {
      res.writeHead(200, { "content-type": "image/jpeg" })
      res.end(IMAGE_BYTES)
      return
    }
    res.writeHead(500, { "content-type": "text/plain" })
    res.end("upstream exploded")
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("failed to bind provider host")
  return `http://127.0.0.1:${address.port}`
}

function envelope(overrides: Partial<InboundEnvelope> = {}): InboundEnvelope {
  return {
    provider: "whatsapp",
    source: "whatsapp",
    contactRef: "+15550001111",
    displayName: "+15550001111",
    text: "",
    messageId: "m-1",
    roomCodeHint: undefined,
    media: [],
    ...overrides,
  }
}

test("kindForMediaType maps the free-string type to voice/image/file", () => {
  assert.equal(kindForMediaType("audio"), "voice")
  assert.equal(kindForMediaType("voice"), "voice")
  assert.equal(kindForMediaType("ptt"), "voice")
  assert.equal(kindForMediaType("image"), "image")
  assert.equal(kindForMediaType("image/png"), "image")
  assert.equal(kindForMediaType("document"), "file")
})

test("a Telegram-shaped voice note with no url fans in a visible line instead of vanishing", async () => {
  // The live failure of 2026-09-12: agentpush's Telegram driver sends a bare
  // `file_id` and no url, so this item used to be dropped at parse, which
  // emptied the array and sent the media-only message to the "ignored"
  // path. No reply, no log line, no error anywhere. Whatever we cannot
  // fetch, we still have to SAY.
  const store = await freshMediaStore()
  const result = await normalizeInboundMedia(
    envelope({
      provider: "telegram",
      source: "telegram",
      contactRef: "6371794295",
      media: [
        { type: "audio", providerMediaId: "AwACAgQAAx0CZ", url: undefined, mimeType: "audio/ogg", size: 8452 },
      ],
    }),
    { store },
  )

  assert.equal(result.records.length, 1, "the record must land even though nothing could be fetched")
  const record = result.records[0]
  assert.ok(record !== undefined)
  assert.equal(result.attributionSuffix, "voice")
  assert.ok(result.text !== undefined, "a media-only turn must never normalize to nothing")
  assert.match(result.text, /could not be fetched/, "the member is told the turn arrived and could not be read")
  assert.match(result.text, /AwACAgQAAx0CZ/, "the provider reference is named, so the drop is diagnosable")
  assert.equal(record.kind, "voice")
  assert.equal(record.error, "no fetchable URL from the provider (reference: AwACAgQAAx0CZ)")
})

test("null providers: a voice note fans in the unavailable line and stores the record with source and mime", async () => {
  const store = await freshMediaStore()
  const host = await startProviderHost()
  const result = await normalizeInboundMedia(
    envelope({
      media: [{ type: "audio", providerMediaId: undefined, url: `${host}/audio.webm`, mimeType: "audio/webm", size: AUDIO_BYTES.length }],
    }),
    { store },
  )

  assert.equal(result.records.length, 1)
  const record = result.records[0]
  assert.ok(record !== undefined)
  assert.equal(result.attributionSuffix, "voice")
  assert.equal(result.text, `(voice note, transcription unavailable, media:${record.mediaId})`)
  assert.equal(record.kind, "voice")
  assert.equal(record.source, `${host}/audio.webm`)
  assert.equal(record.mime, "audio/webm")
  assert.equal(record.transcript, undefined)
  assert.equal(record.caption, undefined)
  assert.equal(record.confidence, undefined)
  assert.equal(record.error, undefined)
  assert.match(record.receivedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(record.bytes, AUDIO_BYTES.length)
})

test("an image with null providers fans in the caption-unavailable line", async () => {
  const store = await freshMediaStore()
  const host = await startProviderHost()
  const result = await normalizeInboundMedia(
    envelope({
      media: [{ type: "image", providerMediaId: undefined, url: `${host}/img.jpg`, mimeType: "image/jpeg", size: IMAGE_BYTES.length }],
    }),
    { store },
  )
  const record = result.records[0]
  assert.ok(record !== undefined)
  assert.equal(result.attributionSuffix, "image")
  assert.equal(result.text, `(image, caption unavailable, media:${record.mediaId})`)
  assert.equal(record.kind, "image")
  assert.equal(record.bytes, IMAGE_BYTES.length)
})

test("a provider that returns text produces the transcript/caption line and fills the record", async () => {
  const store = await freshMediaStore()
  const host = await startProviderHost()

  const voice = await normalizeInboundMedia(
    envelope({
      media: [{ type: "audio", providerMediaId: undefined, url: `${host}/audio.webm`, mimeType: "audio/webm", size: AUDIO_BYTES.length }],
    }),
    { store, stt: { transcribe: () => Promise.resolve("let's ship the blue version") } },
  )
  const voiceRecord = voice.records[0]
  assert.ok(voiceRecord !== undefined)
  assert.equal(voice.text, `(voice note) let's ship the blue version  media:${voiceRecord.mediaId}`)
  assert.equal(voiceRecord.transcript, "let's ship the blue version")
  assert.equal(voiceRecord.caption, undefined)

  const image = await normalizeInboundMedia(
    envelope({
      media: [{ type: "image", providerMediaId: undefined, url: `${host}/img.jpg`, mimeType: "image/jpeg", size: IMAGE_BYTES.length }],
    }),
    { store, vision: { caption: () => Promise.resolve("screenshot of the error") } },
  )
  const imageRecord = image.records[0]
  assert.ok(imageRecord !== undefined)
  assert.equal(image.text, `(image) screenshot of the error  media:${imageRecord.mediaId}`)
  assert.equal(imageRecord.caption, "screenshot of the error")
  assert.equal(imageRecord.transcript, undefined)
})

test("oversize (envelope size and actual bytes both enforced) fans in a visible failure line", async () => {
  const store = await freshMediaStore()
  const host = await startProviderHost()

  const declared = await normalizeInboundMedia(
    envelope({
      media: [{ type: "audio", providerMediaId: undefined, url: `${host}/audio.webm`, mimeType: "audio/webm", size: 100 }],
    }),
    { store, maxBytes: 10 },
  )
  const declaredRecord = declared.records[0]
  assert.ok(declaredRecord !== undefined)
  assert.match(declared.text ?? "", /\(voice note, could not be fetched: too large \(100 > 10 bytes\), media:/)
  assert.equal(declaredRecord.bytes, 0)
  assert.equal(declaredRecord.error, "too large (100 > 10 bytes)")

  const actual = await normalizeInboundMedia(
    envelope({
      media: [{ type: "audio", providerMediaId: undefined, url: `${host}/audio.webm`, mimeType: "audio/webm", size: undefined }],
    }),
    { store, maxBytes: 4 },
  )
  assert.match(actual.text ?? "", /\(voice note, could not be fetched: too large \(8 > 4 bytes\), media:/)
})

test("a fetch failure (HTTP error, unreachable host) fans in a visible failure line, record kept", async () => {
  const store = await freshMediaStore()
  const host = await startProviderHost()

  const httpError = await normalizeInboundMedia(
    envelope({
      media: [{ type: "audio", providerMediaId: undefined, url: `${host}/boom`, mimeType: "audio/webm", size: undefined }],
    }),
    { store },
  )
  const httpRecord = httpError.records[0]
  assert.ok(httpError !== undefined && httpRecord !== undefined)
  assert.match(httpError.text ?? "", /^\(voice note, could not be fetched: HTTP 500, media:/)
  assert.equal(httpRecord.error, "HTTP 500")
  assert.equal(httpRecord.source, `${host}/boom`)

  const unreachable = await normalizeInboundMedia(
    envelope({
      media: [{ type: "image", providerMediaId: undefined, url: "http://127.0.0.1:1/img.jpg", mimeType: "image/jpeg", size: undefined }],
    }),
    { store },
  )
  assert.match(unreachable.text ?? "", /^\(image, could not be fetched: .+, media:/)
})

test("no media means no normalization: text and suffix are undefined", async () => {
  const store = await freshMediaStore()
  const result = await normalizeInboundMedia(envelope(), { store })
  assert.equal(result.text, undefined)
  assert.equal(result.attributionSuffix, undefined)
  assert.deepEqual(result.records, [])
})

test("mixed kinds get the generic 'media' suffix and one line per item", async () => {
  const store = await freshMediaStore()
  const host = await startProviderHost()
  const result = await normalizeInboundMedia(
    envelope({
      media: [
        { type: "audio", providerMediaId: undefined, url: `${host}/audio.webm`, mimeType: "audio/webm", size: undefined },
        { type: "image", providerMediaId: undefined, url: `${host}/img.jpg`, mimeType: "image/jpeg", size: undefined },
      ],
    }),
    { store },
  )
  assert.equal(result.attributionSuffix, "media")
  const lines = (result.text ?? "").split("\n")
  assert.equal(lines.length, 2)
  assert.match(lines[0] ?? "", /^\(voice note, transcription unavailable, media:/)
  assert.match(lines[1] ?? "", /^\(image, caption unavailable, media:/)
})

test("a file-kind item fans in a plain file line with the media ref", async () => {
  const store = await freshMediaStore()
  const result = await normalizeInboundMedia(
    envelope({
      media: [{ type: "document", providerMediaId: undefined, url: "https://cdn.example/x.bin", mimeType: "application/octet-stream", size: undefined }],
    }),
    { store, fetch: () => Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) }) },
  )
  const record = result.records[0]
  assert.ok(record !== undefined)
  assert.equal(result.attributionSuffix, "file")
  assert.equal(result.text, `(file, media:${record.mediaId})`)
  assert.equal(record.bytes, 4)
})

test("stored ingress records keep the source URL and mime and are readable back through the same store", async () => {
  const store = await freshMediaStore()
  const host = await startProviderHost()
  const result = await normalizeInboundMedia(
    envelope({
      media: [{ type: "image", providerMediaId: undefined, url: `${host}/img.jpg`, mimeType: "image/jpeg", size: IMAGE_BYTES.length }],
    }),
    { store, vision: { caption: () => Promise.resolve("a cat") } },
  )
  const record = result.records[0]
  assert.ok(record !== undefined)
  const data = await store.readIngress("__unassigned__", record.mediaId)
  assert.ok(data !== undefined)
  assert.deepEqual(new Uint8Array(data), IMAGE_BYTES)
  assert.equal(store.getIngress("RDV-AAAA", record.mediaId), undefined, "not served under another room's code")
})

test("NullProviders is the shipped no-implementation pair", async () => {
  assert.equal(await NullProviders.stt.transcribe(new Uint8Array(1), "audio/webm"), undefined)
  assert.equal(await NullProviders.vision.caption(new Uint8Array(1), "image/jpeg"), undefined)
})