/**
 * `POST /inbound/agentpush` needs `env.agentpushWebhookSecret` set to
 * exercise signature verification, but `env` is a frozen singleton read
 * once from `process.env` at module load — and ESM hoists every *static*
 * import above this file's own code, so setting `process.env` here would
 * run too late for anything imported the normal way. Runtime values that
 * transitively touch `src/env.ts` are therefore imported dynamically,
 * *after* the env var below is set; pure types are still static (type-only
 * imports are erased, so they never trigger `env.ts` at runtime).
 */
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import type { RoomService } from "../../src/service/room-service.ts"
import { startExtendedFakeDaemon, type ExtendedFakeDaemon } from "./fake-daemon-extra.ts"

const WEBHOOK_SECRET = "test-agentpush-secret"
process.env.RDV_AGENTPUSH_WEBHOOK_SECRET = WEBHOOK_SECRET

const { DaemonClient } = await import("../../src/daemon/client.ts")
const { RoomStore } = await import("../../src/rooms/store.ts")
const { LocalBooter } = await import("../../src/service/booter.ts")
const { createHttpServer } = await import("../../src/service/http.ts")
const { RoomService: RoomServiceCtor } = await import("../../src/service/room-service.ts")
const { MemoryTransport } = await import("../../src/service/transports.ts")

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAddressInfo(value: string | AddressInfo | null): value is AddressInfo {
  return value !== null && typeof value === "object"
}

const dirs: string[] = []
const daemons: ExtendedFakeDaemon[] = []
const services: RoomService[] = []
const servers: { close(): Promise<void> }[] = []

after(async () => {
  await Promise.all(servers.map((server) => server.close()))
  await Promise.all(services.map((service) => service.stop()))
  await Promise.all(daemons.map((daemon) => daemon.close()))
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-agentpush-"))
  dirs.push(dir)
  return dir
}

async function buildServer(
  opts: { vision?: (bytes: Uint8Array, mime: string) => Promise<string | undefined> } = {},
): Promise<{ baseUrl: string; daemon: ExtendedFakeDaemon }> {
  const dir = await freshDir()
  const daemon = await startExtendedFakeDaemon()
  daemons.push(daemon)
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })
  // Shared with the http server's own media hooks below (same temp dir): the
  // QR handleInbound("new") mints, and any render, must not leak into
  // env.mediaDir either.
  const { MediaStore: MediaStoreCtor } = await import("../../src/service/media-store.ts")
  const { ArtifactRenderStore: ArtifactRenderStoreCtor } = await import("../../src/service/artifact-renders.ts")
  const mediaStore = new MediaStoreCtor(dir)
  const renders = new ArtifactRenderStoreCtor(dir)
  const service = new RoomServiceCtor({
    store,
    client,
    booter,
    transport: new MemoryTransport(),
    daemon: { baseUrl: daemon.url, token: undefined },
    mediaStore,
  })
  services.push(service)

  const server = await createHttpServer(service, {
    mediaStore,
    renders,
    ...(opts.vision !== undefined ? { vision: { caption: opts.vision } } : {}),
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!isAddressInfo(address)) throw new Error("failed to bind http server")
  servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })

  return { baseUrl: `http://127.0.0.1:${address.port}`, daemon }
}

function sign(rawBody: string): string {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(rawBody, "utf8").digest("hex")}`
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: "whatsapp",
    from: "+15550001111",
    text: "new",
    messageId: "msg-1",
    displayName: "Alice",
    ...overrides,
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) throw new Error(`expected a JSON object, got: ${text}`)
  return parsed
}

test("POST /inbound/agentpush with a validly signed envelope reaches handleInbound with tier messenger", async () => {
  const { baseUrl } = await buildServer()
  const rawBody = JSON.stringify(envelope())

  const res = await fetch(`${baseUrl}/inbound/agentpush`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agentpush-signature": sign(rawBody) },
    body: rawBody,
  })
  assert.equal(res.status, 200)
  const body = await readJson(res)
  assert.equal(body.kind, "created")
  assert.ok(isRecord(body.room))
  if (!isRecord(body.room)) return
  const members = body.room.members
  assert.ok(Array.isArray(members) && members.length === 1)
  const first = members[0]
  assert.ok(isRecord(first))
  if (!isRecord(first)) return
  assert.equal(first.tier, "messenger")
  assert.ok(isRecord(first.address))
  if (!isRecord(first.address)) return
  assert.equal(first.address.provider, "whatsapp")
  assert.equal(first.address.contactRef, "+15550001111")
})

test("POST /inbound/agentpush replays the same messageId and returns deduped:true, without fanning in twice", async () => {
  const { baseUrl, daemon } = await buildServer()
  const rawBody = JSON.stringify(envelope({ messageId: "msg-replay" }))
  const headers = { "content-type": "application/json", "x-agentpush-signature": sign(rawBody) }

  const first = await fetch(`${baseUrl}/inbound/agentpush`, { method: "POST", headers, body: rawBody })
  assert.equal(first.status, 200)
  const firstBody = await readJson(first)
  assert.equal(firstBody.kind, "created")

  const second = await fetch(`${baseUrl}/inbound/agentpush`, { method: "POST", headers, body: rawBody })
  assert.equal(second.status, 200)
  const secondBody = await readJson(second)
  assert.deepEqual(secondBody, { deduped: true })

  const spawnCalls = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent").length
  assert.equal(spawnCalls, 1, "the replayed webhook must not create a second room")
})

test("POST /inbound/agentpush with a bad signature returns 401", async () => {
  const { baseUrl } = await buildServer()
  const rawBody = JSON.stringify(envelope({ messageId: "msg-bad-sig" }))

  const res = await fetch(`${baseUrl}/inbound/agentpush`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agentpush-signature": "sha256=deadbeef" },
    body: rawBody,
  })
  assert.equal(res.status, 401)
})

// Multimodal ingress (docs/MULTIMODAL.md): a media-only webhook message is
// normalized into text + a stored media record and fans in with the
// [Name · channel · kind] attribution — never ignored, never dropped.

async function startProviderHost(): Promise<string> {
  const { createServer } = await import("node:http")
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/boom" ? 500 : 200, { "content-type": req.url === "/img.jpg" ? "image/jpeg" : "text/plain" })
    res.end(req.url === "/img.jpg" ? "IMG" : "nope")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("failed to bind provider host")
  daemons.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) } as unknown as ExtendedFakeDaemon)
  return `http://127.0.0.1:${address.port}`
}

test("POST /inbound/agentpush fans a media-only message in as the normalized line with the [from · whatsapp · image] attribution", async () => {
  const { baseUrl, daemon } = await buildServer({ vision: () => Promise.resolve("screenshot of the error") })
  const providerHost = await startProviderHost()

  // Become a member first, so the media message lands as a turn.
  const joined = await fetch(`${baseUrl}/inbound/agentpush`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agentpush-signature": sign(JSON.stringify(envelope())) },
    body: JSON.stringify(envelope()),
  })
  assert.equal(joined.status, 200)
  assert.equal((await readJson(joined)).kind, "created")

  const mediaBody = JSON.stringify(
    envelope({
      messageId: "msg-media",
      text: "",
      media: [{ type: "image", url: `${providerHost}/img.jpg`, mimeType: "image/jpeg", size: 3 }],
    }),
  )
  const res = await fetch(`${baseUrl}/inbound/agentpush`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agentpush-signature": sign(mediaBody) },
    body: mediaBody,
  })
  assert.equal(res.status, 200)
  const outcome = await readJson(res)
  assert.equal(outcome.kind, "message")

  const prompts = daemon.requestsReceived.filter((r) => r.path.endsWith("/prompt"))
  const last = prompts[prompts.length - 1]
  assert.ok(isRecord(last?.body))
  if (!isRecord(last.body)) return
  const prompt = last.body.prompt
  assert.ok(typeof prompt === "string")
  assert.match(prompt, /\[\+15550001111 · whatsapp · image\] \(image\) screenshot of the error {2}media:/)
  assert.equal(last.body.queue, true, "the media line rides the same queue:true path as any text")
})

test("POST /inbound/agentpush fans in a fetch-failing media item with the reason visible in the prompt", async () => {
  const { baseUrl, daemon } = await buildServer()
  const providerHost = await startProviderHost()

  const joined = await fetch(`${baseUrl}/inbound/agentpush`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agentpush-signature": sign(JSON.stringify(envelope())) },
    body: JSON.stringify(envelope()),
  })
  assert.equal((await readJson(joined)).kind, "created")

  const mediaBody = JSON.stringify(
    envelope({
      messageId: "msg-media-fail",
      text: "",
      media: [{ type: "image", url: `${providerHost}/boom`, mimeType: "image/jpeg", size: 3 }],
    }),
  )
  const res = await fetch(`${baseUrl}/inbound/agentpush`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agentpush-signature": sign(mediaBody) },
    body: mediaBody,
  })
  assert.equal(res.status, 200)

  const prompts = daemon.requestsReceived.filter((r) => r.path.endsWith("/prompt"))
  const last = prompts[prompts.length - 1]
  assert.ok(isRecord(last?.body))
  if (!isRecord(last.body)) return
  const prompt = last.body.prompt
  assert.ok(typeof prompt === "string")
  assert.match(prompt, /\(image, could not be fetched: HTTP 500, media:/)
})
