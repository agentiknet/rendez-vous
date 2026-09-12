/**
 * Attachment verification before delivery — the MilanoTripItinerary bug: the
 * agent wrote `[[attach MilanoTripItinerary.txt]]` without ever writing the
 * file into the served directory, every member got a 404 link, and the agent
 * went on believing it had sent the file. Nothing noticed. These tests pin
 * the three halves of the fix: probe before claiming, an honest line to the
 * member instead of a dead link, and a correction fanned back to the agent
 * over the injected callback (RoomService's `queue: true` prompt path — the
 * queue:true wiring itself is proven in test/service/room-service.test.ts).
 */
import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { RoomFanout, probeArtifactUrl, servedDir } from "../../src/fanout/reader.ts"
import { attachmentUrl } from "../../src/fanout/attach.ts"
import type { OutboundMessage, Transport } from "../../src/fanout/types.ts"
import type { OutboundAttachment } from "../../src/service/transports.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Member } from "../../src/rooms/types.ts"
import { publicArtifactUrl } from "../../src/service/artifact-proxy.ts"
import { FakeSource, waitFor } from "./support.ts"

const dirs: string[] = []
const servers: Server[] = []

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-fanout-attach-"))
  dirs.push(dir)
  return dir
}

/** A transport that supports real attachment sends — the shape Telegram and
 *  the other file-capable providers expose (`hasSendAttachment`). */
class AttachTransport implements Transport {
  readonly sends: { member: Member; message: OutboundMessage }[] = []
  readonly attachmentSends: { member: Member; attachment: OutboundAttachment }[] = []

  async send(member: Member, message: OutboundMessage): Promise<void> {
    this.sends.push({ member, message })
  }

  async sendAttachment(member: Member, attachment: OutboundAttachment): Promise<void> {
    this.attachmentSends.push({ member, attachment })
  }
}

/** The full harness: one room, one messenger member, an attach turn pushed
 *  through the reader. Returns what the transport saw. */
async function flushAttachTurn(opts: {
  probeUrl: (url: string) => Promise<boolean>
  reportUnservable?: (code: string, correction: string) => Promise<void>
  text?: string
}): Promise<{ transport: AttachTransport; store: RoomStore; code: string }> {
  const dir = await freshDir()
  const store = await RoomStore.open(dir)
  const room = await store.create()
  await store.addMember(room.code, {
    displayName: "Alice",
    tier: "messenger",
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+1" },
  })
  await store.update(room.code, { sessionId: "sess-1" })

  const source = new FakeSource()
  const transport = new AttachTransport()
  const fanout = new RoomFanout({
    store,
    transport,
    source: source.read(),
    probeUrl: opts.probeUrl,
    ...(opts.reportUnservable !== undefined ? { reportUnservable: opts.reportUnservable } : {}),
  })

  source.push({ seq: 1, kind: "text-delta", text: opts.text ?? "Here you go.\n[[attach MilanoTripItinerary.txt]]" })
  source.push({ seq: 2, kind: "turn-end", reason: "completed" })
  fanout.start(room.code)
  await waitFor(() => store.get(room.code)?.cursor === 2)
  await fanout.stopAll()

  return { transport, store, code: room.code }
}

test("a probe returning 200 delivers the attachment exactly as before: real attachment send, no notice", async () => {
  const seen: string[] = []
  const { transport } = await flushAttachTurn({
    probeUrl: (url) => {
      seen.push(url)
      return Promise.resolve(true)
    },
  })

  assert.equal(seen.length, 1)
  assert.ok(seen[0]?.endsWith("/artifact/MilanoTripItinerary.txt"))
  assert.equal(transport.attachmentSends.length, 1)
  assert.equal(transport.attachmentSends[0]?.attachment.filename, "MilanoTripItinerary.txt")
  const notices = transport.sends.filter((send) => send.message.text.includes("not actually sent"))
  assert.equal(notices.length, 0, "no honest-line notice may go out when the file is really served")
})

test("a probe returning 404 delivers NO attachment and NO fallback link to any member", async () => {
  const { transport } = await flushAttachTurn({ probeUrl: () => Promise.resolve(false) })

  assert.equal(transport.attachmentSends.length, 0)
  for (const send of transport.sends) {
    assert.ok(!send.message.text.includes("http"), "a dead attachment must never degrade to a link")
    assert.ok(!send.message.text.includes("artifact"), "no artifact URL may leak into the member's notice")
  }
})

test("a 404 gives members the honest one-liner naming the file, not the URL", async () => {
  const { transport } = await flushAttachTurn({ probeUrl: () => Promise.resolve(false) })

  const notice = transport.sends.find((send) => send.message.text.includes("not actually sent"))
  assert.ok(notice !== undefined)
  const text = notice?.message.text ?? ""
  assert.ok(text.includes("MilanoTripItinerary.txt"))
  assert.ok(!text.includes("http"))
})

test("a 404 feeds a correction to the injected fan-in callback naming the file and the served directory", async () => {
  const corrections: { code: string; correction: string }[] = []
  const flushed = await flushAttachTurn({
    probeUrl: () => Promise.resolve(false),
    reportUnservable: (code, correction) => {
      corrections.push({ code, correction })
      return Promise.resolve()
    },
  })
  const url = attachmentUrl(publicArtifactUrl(flushed.code), "MilanoTripItinerary.txt")

  assert.equal(corrections.length, 1)
  assert.equal(corrections[0]?.code, flushed.code)
  const correction = corrections[0]?.correction ?? ""
  assert.ok(correction.includes("MilanoTripItinerary.txt"), "the agent must be told which file failed")
  assert.ok(correction.includes(url), "the agent must be told the URL that 404'd")
  assert.ok(correction.includes(servedDir()), "the agent must be told the directory to write into")
  // The member-facing notice is unaffected by whether a correction channel exists.
  const notice = flushed.transport.sends.find((send) => send.message.text.includes("not actually sent"))
  assert.ok(notice !== undefined)
})

test("a probe that throws (timeout, DNS) is treated as a failure: never deliver on an unknown", async () => {
  const { transport } = await flushAttachTurn({
    probeUrl: () => Promise.reject(new Error("probe timed out")),
  })

  assert.equal(transport.attachmentSends.length, 0)
  const notice = transport.sends.find((send) => send.message.text.includes("not actually sent"))
  assert.ok(notice !== undefined)
  assert.ok(notice?.message.text.includes("MilanoTripItinerary.txt"))
})

test("two attachments, one served and one missing: the served one goes out, only the missing one is corrected", async () => {
  const corrections: string[] = []
  const dir = await freshDir()
  const store = await RoomStore.open(dir)
  const room = await store.create()
  await store.addMember(room.code, {
    displayName: "Alice",
    tier: "messenger",
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+1" },
  })
  await store.update(room.code, { sessionId: "sess-1" })

  const source = new FakeSource()
  const transport = new AttachTransport()
  const fanout = new RoomFanout({
    store,
    transport,
    source: source.read(),
    probeUrl: (url) => Promise.resolve(url.endsWith("/good.png")),
    reportUnservable: (_code, correction) => {
      corrections.push(correction)
      return Promise.resolve()
    },
  })

  source.push({
    seq: 1,
    kind: "text-delta",
    text: "[[attach good.png]]\n[[attach missing.png]]",
  })
  source.push({ seq: 2, kind: "turn-end", reason: "completed" })
  fanout.start(room.code)
  await waitFor(() => store.get(room.code)?.cursor === 2)
  await fanout.stopAll()

  assert.equal(transport.attachmentSends.length, 1)
  assert.equal(transport.attachmentSends[0]?.attachment.filename, "good.png")
  assert.equal(corrections.length, 1)
  assert.ok(corrections[0]?.includes("missing.png"))
})

test("the default probe accepts a live file and rejects a 404 over real HTTP", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/ok.txt") {
      res.writeHead(200, { "content-length": 3 })
      res.end("abc")
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(server)
  const address = server.address()
  assert.ok(address !== null && typeof address === "object")
  const base = `http://127.0.0.1:${address.port}`

  assert.equal(await probeArtifactUrl(`${base}/ok.txt`), true)
  assert.equal(await probeArtifactUrl(`${base}/gone.txt`), false)
})

test("the default probe falls back to a ranged GET when the upstream rejects HEAD", async () => {
  let sawGet = false
  const server = createServer((req, res) => {
    if (req.method === "HEAD") {
      res.writeHead(405)
      res.end()
      return
    }
    sawGet = req.method === "GET"
    res.writeHead(206, { "content-range": "bytes 0-0/3" })
    res.end("a")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(server)
  const address = server.address()
  assert.ok(address !== null && typeof address === "object")

  assert.equal(await probeArtifactUrl(`http://127.0.0.1:${address.port}/file`), true)
  assert.ok(sawGet, "a 405 on HEAD must be retried as a ranged GET, not taken as a failure")
})
