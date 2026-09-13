import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer as createHttpTestServer, type Server as HttpTestServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { DaemonClient } from "../../src/daemon/client.ts"
import { env } from "../../src/env.ts"
import type { Delivery, Member } from "../../src/rooms/types.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import { LocalBooter, type SessionBooter } from "../../src/service/booter.ts"
import { createHttpServer } from "../../src/service/http.ts"
import { memberToken } from "../../src/service/mcp-room.ts"
import { RoomService } from "../../src/service/room-service.ts"
import { MemoryTransport } from "../../src/service/transports.ts"
import { startExtendedFakeDaemon, type ExtendedFakeDaemon } from "./fake-daemon-extra.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const dirs: string[] = []
const daemons: ExtendedFakeDaemon[] = []
const services: RoomService[] = []
const servers: { close(): Promise<void> }[] = []
const upstreams: HttpTestServer[] = []

after(async () => {
  await Promise.all(servers.map((server) => server.close()))
  await Promise.all(services.map((service) => service.stop()))
  await Promise.all(daemons.map((daemon) => daemon.close()))
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  await Promise.all(upstreams.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-http-"))
  dirs.push(dir)
  return dir
}

async function freshDaemon(): Promise<ExtendedFakeDaemon> {
  const daemon = await startExtendedFakeDaemon()
  daemons.push(daemon)
  return daemon
}

function isAddressInfo(value: string | AddressInfo | null): value is AddressInfo {
  return value !== null && typeof value === "object"
}

async function listenOnRandomPort(
  service: RoomService,
  stateHooks?: Parameters<typeof createHttpServer>[2],
): Promise<string> {
  const server = createHttpServer(service, undefined, stateHooks)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!isAddressInfo(address)) throw new Error("failed to bind http server")
  servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
  return `http://127.0.0.1:${address.port}`
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) throw new Error(`expected a JSON object, got: ${text}`)
  return parsed
}

test("GET /health reports ok, the room count, and the daemon's own health when it is reachable", async () => {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })
  const transport = new MemoryTransport()
  const service = new RoomService({ store, client, booter, transport, daemon: { baseUrl: daemon.url, token: undefined } })
  services.push(service)

  const created = await service.handleInbound({
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+1" },
    displayName: "Alice",
    tier: "messenger",
    text: "new",
  })
  assert.equal(created.kind, "created")

  const baseUrl = await listenOnRandomPort(service)
  const res = await fetch(`${baseUrl}/health`)
  assert.equal(res.status, 200)
  const body = await readJson(res)

  assert.equal(body.status, "ok")
  assert.equal(body.rooms, 1)
  assert.ok(isRecord(body.daemon))
  if (!isRecord(body.daemon)) return
  assert.equal(body.daemon.status, "ok")
})

test("GET /health reports the daemon as unreachable when it cannot be reached", async () => {
  const dir = await freshDir()
  // Not tracked in `daemons`: it is closed explicitly below, and `after()`
  // closing an already-closed server would fail the hook.
  const deadDaemon = await startExtendedFakeDaemon()
  const client = new DaemonClient({ baseUrl: deadDaemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: deadDaemon.url, token: undefined })
  await deadDaemon.close()

  const store = await RoomStore.open(dir)
  const transport = new MemoryTransport()
  const service = new RoomService({ store, client, booter, transport, daemon: { baseUrl: deadDaemon.url, token: undefined } })
  services.push(service)

  const baseUrl = await listenOnRandomPort(service)
  const res = await fetch(`${baseUrl}/health`)
  assert.equal(res.status, 200)
  const body = await readJson(res)

  assert.equal(body.status, "ok")
  assert.equal(body.rooms, 0)
  assert.equal(body.daemon, "unreachable")
})

async function newRoomHarness(): Promise<{
  service: RoomService
  daemon: ExtendedFakeDaemon
  baseUrl: string
  code: string
  sessionId: string
}> {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })
  const transport = new MemoryTransport()
  const service = new RoomService({ store, client, booter, transport, daemon: { baseUrl: daemon.url, token: undefined } })
  services.push(service)

  const created = await service.handleInbound({
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+1" },
    displayName: "Alice",
    tier: "messenger",
    text: "new",
  })
  assert.equal(created.kind, "created")
  if (created.kind !== "created") throw new Error("unreachable")
  const sessionId = created.room.sessionId
  assert.ok(sessionId !== undefined)
  if (sessionId === undefined) throw new Error("unreachable")

  const baseUrl = await listenOnRandomPort(service, { daemon: { baseUrl: daemon.url, token: undefined } })
  return { service, daemon, baseUrl, code: created.room.code, sessionId }
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test("GET /r/:code renders the room page for a known room", async () => {
  const { baseUrl, code } = await newRoomHarness()
  const res = await fetch(`${baseUrl}/r/${code}`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get("content-type") ?? "", /text\/html/)
  const html = await res.text()
  assert.ok(html.includes(code))
  assert.ok(html.includes("Alice"))
})

test("GET /r/:code renders a 404 page with a hint for an unknown room", async () => {
  const { baseUrl } = await newRoomHarness()
  const res = await fetch(`${baseUrl}/r/RDV-ZZZZ`)
  assert.equal(res.status, 404)
  const html = await res.text()
  assert.ok(html.includes("RDV-ZZZZ"))
})

async function readSseRecords(res: Response, count: number): Promise<Record<string, unknown>[]> {
  if (res.body === null) throw new Error("stream response has no body")
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const records: Record<string, unknown>[] = []

  while (records.length < count) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf("\n\n")
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const dataLine = frame.split("\n").find((line) => line.startsWith("data:"))
      if (dataLine !== undefined) {
        const parsed: unknown = JSON.parse(dataLine.slice("data:".length).trim())
        if (isRecord(parsed)) records.push(parsed)
      }
      boundary = buffer.indexOf("\n\n")
    }
  }
  await reader.cancel().catch(() => undefined)
  return records
}

test("GET /rooms/:code/stream replays from since=0, filtered to the kinds the page renders", async () => {
  const { baseUrl, daemon, sessionId, code } = await newRoomHarness()

  daemon.pushRecord(sessionId, { seq: 1, kind: "text-delta", text: "hello" })
  daemon.pushRecord(sessionId, { seq: 2, kind: "usage_update" })
  daemon.pushRecord(sessionId, { seq: 3, kind: "turn-end", reason: "completed" })

  const res = await fetch(`${baseUrl}/rooms/${code}/stream?since=0`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/)

  const records = await readSseRecords(res, 2)
  assert.equal(records.length, 2)
  assert.equal(records[0]?.kind, "text-delta")
  assert.equal(records[1]?.kind, "turn-end")
})

test("GET /rooms/:code/stream replays only records after the given since", async () => {
  const { baseUrl, daemon, sessionId, code } = await newRoomHarness()

  daemon.pushRecord(sessionId, { seq: 1, kind: "text-delta", text: "old" })
  daemon.pushRecord(sessionId, { seq: 2, kind: "turn-end", reason: "completed" })
  daemon.pushRecord(sessionId, { seq: 3, kind: "text-delta", text: "new" })
  daemon.pushRecord(sessionId, { seq: 4, kind: "turn-end", reason: "completed" })

  const res = await fetch(`${baseUrl}/rooms/${code}/stream?since=2`)
  const records = await readSseRecords(res, 2)
  assert.equal(records[0]?.text, "new")
  assert.equal(records[1]?.kind, "turn-end")
})

test("GET /rooms/:code/stream closes the upstream daemon connection when the browser disconnects", async () => {
  const { baseUrl, daemon, sessionId, code } = await newRoomHarness()
  // `newRoomHarness` already starts the room's own RoomFanout reader (M3), which
  // holds a persistent upstream subscription of its own, established some time
  // after `handleInbound` returns — wait for it to land before taking the
  // baseline, so the browser's stream below is measured as the *only* addition.
  await waitFor(() => daemon.subscriberCount(sessionId) >= 1)
  const baseline = daemon.subscriberCount(sessionId)

  const controller = new AbortController()
  const res = await fetch(`${baseUrl}/rooms/${code}/stream?since=0`, { signal: controller.signal })
  assert.equal(res.status, 200)
  await waitFor(() => daemon.subscriberCount(sessionId) === baseline + 1)

  controller.abort()
  await waitFor(() => daemon.subscriberCount(sessionId) === baseline)
})

test("GET /rooms/:code/stream returns 409 when the room has no live session", async () => {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })
  const service = new RoomService({
    store,
    client,
    booter,
    transport: new MemoryTransport(),
    daemon: { baseUrl: daemon.url, token: undefined },
  })
  services.push(service)
  const room = await store.create()

  const baseUrl = await listenOnRandomPort(service)
  const res = await fetch(`${baseUrl}/rooms/${room.code}/stream`)
  assert.equal(res.status, 409)
})

test("GET /rooms/:code/stream returns 404 for an unknown room", async () => {
  const { baseUrl } = await newRoomHarness()
  const res = await fetch(`${baseUrl}/rooms/RDV-ZZZZ/stream`)
  assert.equal(res.status, 404)
})

interface MinimalMember {
  displayName: string
  tier: string
}

function isMinimalMember(value: unknown): value is MinimalMember {
  return isRecord(value) && typeof value.displayName === "string" && typeof value.tier === "string"
}

function isArrayOf<T>(value: unknown, guard: (v: unknown) => v is T): value is T[] {
  return Array.isArray(value) && value.every(guard)
}

test("POST /rooms/:code/send registers a room-web member once (idempotent) and puts queue:true plus the [Name · room-web] prefix on the wire", async () => {
  const { baseUrl, daemon, sessionId, code } = await newRoomHarness()

  // The page's flow: claim the name first (mints the join secret), then send
  // with it. Two sends under the same claimed name are one member.
  const claimRes = await fetch(`${baseUrl}/rooms/${code}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Chloe" }),
  })
  assert.equal(claimRes.status, 200)
  const claimBody = await readJson(claimRes)
  const claim = typeof claimBody.claim === "string" ? claimBody.claim : undefined
  assert.ok(typeof claim === "string", "the first claim mints the secret and returns it once")

  const send = async (): Promise<Record<string, unknown>> => {
    const res = await fetch(`${baseUrl}/rooms/${code}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Chloe", text: "hi from the web", claim }),
    })
    assert.equal(res.status, 200)
    return readJson(res)
  }
  await send()
  await send()

  const roomBody = await readJson(await fetch(`${baseUrl}/rooms/${code}`))
  const members = isArrayOf(roomBody.members, isMinimalMember) ? roomBody.members : []
  const chloes = members.filter((m) => m.displayName === "Chloe" && m.tier === "room-web")
  assert.equal(chloes.length, 1, "Chloe should be registered once, not once per send")

  const promptRequests = daemon.requestsReceived.filter((r) => r.path === `/sessions/${sessionId}/prompt`)
  assert.equal(promptRequests.length, 2)
  const firstBody = promptRequests[0]?.body
  assert.ok(isRecord(firstBody))
  if (!isRecord(firstBody)) return
  assert.equal(firstBody.queue, true)
  assert.equal(firstBody.prompt, "[Chloe · room-web] hi from the web")
})

test("POST /rooms/:code/send treats new/join/resume as plain text, not commands", async () => {
  const { baseUrl, daemon, sessionId, code } = await newRoomHarness()

  const res = await fetch(`${baseUrl}/rooms/${code}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Dana", text: "new" }),
  })
  assert.equal(res.status, 200)

  const promptRequests = daemon.requestsReceived.filter((r) => r.path === `/sessions/${sessionId}/prompt`)
  assert.equal(promptRequests.length, 1)
  const body = promptRequests[0]?.body
  assert.ok(isRecord(body))
  if (isRecord(body)) assert.equal(body.prompt, "[Dana · room-web] new")

  const spawnCalls = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent").length
  assert.equal(spawnCalls, 1, "no second room should have been created")
})

test("POST /rooms/:code/send moves a web member registered in another room, so the same rule applies to every tier", async () => {
  const { baseUrl, service, daemon, sessionId, code } = await newRoomHarness()

  const otherCreated = await service.handleInbound({
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+2" },
    displayName: "Bob",
    tier: "messenger",
    text: "new",
  })
  assert.equal(otherCreated.kind, "created")
  if (otherCreated.kind !== "created") throw new Error("unreachable")
  const otherCode = otherCreated.room.code

  const sendTo = async (roomCode: string): Promise<void> => {
    const res = await fetch(`${baseUrl}/rooms/${roomCode}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Chloe", text: "hi" }),
    })
    assert.equal(res.status, 200)
  }

  const promptsBefore = daemon.requestsReceived.filter((r) => r.path === `/sessions/${sessionId}/prompt`).length
  await sendTo(otherCode)
  await sendTo(code)

  const otherRoomBody = await readJson(await fetch(`${baseUrl}/rooms/${otherCode}`))
  const otherMembers = isArrayOf(otherRoomBody.members, isMinimalMember) ? otherRoomBody.members : []
  assert.equal(
    otherMembers.filter((m) => m.displayName === "Chloe").length,
    0,
    "Chloe is no longer a member of the room she first sent from",
  )

  const roomBody = await readJson(await fetch(`${baseUrl}/rooms/${code}`))
  const members = isArrayOf(roomBody.members, isMinimalMember) ? roomBody.members : []
  const chloes = members.filter((m) => m.displayName === "Chloe" && m.tier === "room-web")
  assert.equal(chloes.length, 1, "Chloe is now a member of the room she moved to")

  const promptsAfter = daemon.requestsReceived.filter((r) => r.path === `/sessions/${sessionId}/prompt`).length
  assert.equal(promptsAfter - promptsBefore, 2, "both sends still landed as turns, on top of whichever session backs each room")
})

test("POST /rooms/:code/send returns 404 for an unknown room", async () => {
  const { baseUrl } = await newRoomHarness()
  const res = await fetch(`${baseUrl}/rooms/RDV-ZZZZ/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "X", text: "hi" }),
  })
  assert.equal(res.status, 404)
})

/** A fake e2b-shaped upstream, standing in for the box's own served app. */
async function startFakeArtifactUpstream(): Promise<string> {
  const server = createHttpTestServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end(`artifact:${req.url}`)
  })
  upstreams.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!isAddressInfo(address)) throw new Error("failed to bind fake artifact upstream")
  return `http://127.0.0.1:${address.port}`
}

/** A room booted with a scripted `SessionBooter` that hands back a fixed
 *  `artifactUrl` — `LocalBooter` never sets one, so the artifact-proxy route
 *  needs its own harness (architecture.md §9.3b). */
async function newRoomHarnessWithArtifact(
  artifactUrl: string,
): Promise<{ baseUrl: string; code: string; daemon: ExtendedFakeDaemon; sessionId: string; store: RoomStore }> {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booted = { sessionId: "sess-artifact", sandboxId: "box-1", artifactUrl, artifactReady: true }
  const booter: SessionBooter = {
    async boot() {
      return booted
    },
    async resume() {
      return booted
    },
  }
  const transport = new MemoryTransport()
  const service = new RoomService({ store, client, booter, transport, daemon: { baseUrl: daemon.url, token: undefined } })
  services.push(service)

  const created = await service.handleInbound({
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+9" },
    displayName: "Alice",
    tier: "messenger",
    text: "new",
  })
  assert.equal(created.kind, "created")
  if (created.kind !== "created") throw new Error("unreachable")

  const baseUrl = await listenOnRandomPort(service, { daemon: { baseUrl: daemon.url, token: undefined } })
  return { baseUrl, code: created.room.code, daemon, sessionId: booted.sessionId, store }
}

test("GET /r/:code/artifact/ reverse-proxies to the room's current artifactUrl", async () => {
  const upstreamUrl = await startFakeArtifactUpstream()
  const { baseUrl, code } = await newRoomHarnessWithArtifact(upstreamUrl)

  const res = await fetch(`${baseUrl}/r/${code}/artifact/`)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), "artifact:/")
})

test("GET /r/:code/artifact/* appends the sub-path and preserves the query on the upstream request", async () => {
  const upstreamUrl = await startFakeArtifactUpstream()
  const { baseUrl, code } = await newRoomHarnessWithArtifact(upstreamUrl)

  const res = await fetch(`${baseUrl}/r/${code}/artifact/deep/page?x=1`)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), "artifact:/deep/page?x=1")
})

test("GET /r/:code/artifact/ returns 404 for an unknown room code — nothing to self-heal toward", async () => {
  const res = await fetch(`${(await newRoomHarness()).baseUrl}/r/RDV-ZZZZ/artifact/`)
  assert.equal(res.status, 404)
})

test("GET /r/:code/artifact/ self-heals with a refreshing 503 when the room has no artifactUrl yet", async () => {
  // LocalBooter never sets an artifactUrl.
  const { baseUrl, code } = await newRoomHarness()
  const res = await fetch(`${baseUrl}/r/${code}/artifact/`)
  assert.equal(res.status, 503)
  assert.match(res.headers.get("content-type") ?? "", /text\/html/)
  assert.match(await res.text(), /not available yet/i)
})

test("a room whose artifactReady is false emits no artifact URL to clients — the page shows its paused state instead", async () => {
  const upstreamUrl = await startFakeArtifactUpstream()
  const { baseUrl, code, store } = await newRoomHarnessWithArtifact(upstreamUrl)
  await store.update(code, { artifactReady: false })

  const json = await fetch(`${baseUrl}/rooms/${code}`)
  assert.equal(json.status, 200)
  const body = await readJson(json)
  assert.equal(body.artifactUrl, undefined, "the JSON API must not advertise a dead box's URL")

  const page = await fetch(`${baseUrl}/r/${code}`)
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.ok(!html.includes(`/r/${code}/artifact/`), "the page must not embed a clickable dead artifact link")
})

// Ingress media on the media route (docs/MULTIMODAL.md): the same
// `MediaStore` the deliverable flow uses also serves ingress records, with
// the stored mime type, room-scoped.

test("GET /r/:code/media/:id serves an ingress record with its stored mime type, and refuses another room's code", async () => {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })
  const service = new RoomService({ store, client, booter, transport: new MemoryTransport(), daemon: { baseUrl: daemon.url, token: undefined } })
  services.push(service)
  const created = await service.handleInbound({
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+1" },
    displayName: "Alice",
    tier: "messenger",
    text: "new",
  })
  assert.equal(created.kind, "created")
  if (created.kind !== "created") throw new Error("unreachable")

  const { MediaStore: MediaStoreCtor } = await import("../../src/service/media-store.ts")
  const mediaStore = new MediaStoreCtor(dir)
  const bytes = new Uint8Array([1, 2, 3, 4])
  const record = await mediaStore.saveIngress(bytes, {
    kind: "image",
    source: "https://cdn.example/img.jpg",
    mime: "image/jpeg",
    caption: "screenshot of the error",
  })
  const assigned = await mediaStore.assignRoom(record.mediaId, created.room.code)
  assert.ok(assigned !== undefined)

  const server = createHttpServer(service, { mediaStore })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!isAddressInfo(address)) throw new Error("failed to bind http server")
  servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
  const baseUrl = `http://127.0.0.1:${address.port}`

  const ok = await fetch(`${baseUrl}/r/${created.room.code}/media/${record.mediaId}`)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get("content-type"), "image/jpeg")
  const served = new Uint8Array(await ok.arrayBuffer())
  assert.deepEqual(served, bytes)

  const crossRoom = await fetch(`${baseUrl}/r/RDV-ZZZZ/media/${record.mediaId}`)
  assert.equal(crossRoom.status, 404, "a record must not be served under another room's code")

  const unknownId = await fetch(`${baseUrl}/r/${created.room.code}/media/00000000-0000-4000-8000-000000000000`)
  assert.equal(unknownId.status, 404)
})

test("GET /r/:code/state returns the full shape for an active room with a session, with busy read from the daemon descriptor", async () => {
  const upstreamUrl = await startFakeArtifactUpstream()
  const { baseUrl, code, daemon, sessionId } = await newRoomHarnessWithArtifact(upstreamUrl)
  daemon.setSessionStatus(sessionId, "running")
  daemon.setSessionBusy(sessionId, true)

  const res = await fetch(`${baseUrl}/r/${code}/state`)
  assert.equal(res.status, 200)
  const body = await readJson(res)

  assert.equal(body.code, code)
  assert.equal(body.state, "active")
  assert.ok(isRecord(body.artifact))
  if (!isRecord(body.artifact)) return
  // The member-facing proxied URL — never the raw e2b host (finding 6).
  const artifactUrl = body.artifact.url
  assert.equal(typeof artifactUrl, "string")
  if (typeof artifactUrl !== "string") return
  assert.ok(artifactUrl.endsWith(`/r/${code}/artifact/`), `unexpected artifact url: ${artifactUrl}`)
  assert.ok(!artifactUrl.includes("e2b.app"))
  assert.equal(body.artifact.ready, true)
  const members = isArrayOf(body.members, isMinimalMember) ? body.members : []
  assert.ok(members.some((m) => m.displayName === "Alice" && m.tier === "messenger"))
  assert.ok(isRecord(body.agent))
  if (!isRecord(body.agent)) return
  assert.equal(body.agent.busy, true)
  assert.equal(typeof body.agent.lastActivityAt, "string")
  assert.equal(typeof body.updatedAt, "string")
})

test("GET /r/:code/state reports busy false again once the daemon descriptor clears it", async () => {
  const { baseUrl, code, daemon, sessionId } = await newRoomHarnessWithArtifact(
    await startFakeArtifactUpstream(),
  )
  daemon.setSessionStatus(sessionId, "running")
  daemon.setSessionBusy(sessionId, true)
  daemon.setSessionBusy(sessionId, false)

  const body = await readJson(await fetch(`${baseUrl}/r/${code}/state`))
  assert.ok(isRecord(body.agent))
  if (isRecord(body.agent)) assert.equal(body.agent.busy, false)
})

test("GET /r/:code/state marks a paused room's artifact not ready and with no url", async () => {
  const { baseUrl, service, code } = await newRoomHarness()
  await service.pauseRoom(code)

  const res = await fetch(`${baseUrl}/r/${code}/state`)
  assert.equal(res.status, 200)
  const body = await readJson(res)
  assert.equal(body.state, "paused")
  assert.ok(isRecord(body.artifact))
  if (isRecord(body.artifact)) {
    assert.equal(body.artifact.ready, false)
    assert.equal(body.artifact.url, undefined)
  }
})

test("GET /r/:code/state returns 404 JSON for an unknown room", async () => {
  const { baseUrl } = await newRoomHarness()
  const res = await fetch(`${baseUrl}/r/RDV-ZZZZ/state`)
  assert.equal(res.status, 404)
  const body = await readJson(res)
  assert.equal(body.error, "not_found")
})

test("GET /r/:code embeds the polling state script, member badges and the artifact section while active", async () => {
  const upstreamUrl = await startFakeArtifactUpstream()
  const { baseUrl, code } = await newRoomHarnessWithArtifact(upstreamUrl)

  const res = await fetch(`${baseUrl}/r/${code}`)
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.ok(html.includes("/state"), "should poll the state endpoint")
  assert.ok(html.includes("pollState"))
  assert.ok(html.includes("pollState, 3000"))
  assert.ok(html.includes('class="tier-badge tier-messenger"'), "member tier badges")
  assert.ok(html.includes("member-joined"), "member joined-at")
  assert.ok(html.includes('id="artifact-pane"'))
  assert.ok(html.includes(`/r/${code}/artifact/`), "artifact section wired to the proxied url")
  assert.ok(html.includes('id="state-pill"'))
  assert.ok(html.includes("connection lost, retrying"))
  assert.ok(html.includes("Stay here"), "join chooser still present")
  assert.match(html, /class="join-qr"[^>]*>\s*<svg/, "QR still present")
})

test("GET /r/:code for a paused room shows the paused pill, the paused artifact message and no clickable dead link", async () => {
  const { baseUrl, service, code } = await newRoomHarness()
  await service.pauseRoom(code)

  const res = await fetch(`${baseUrl}/r/${code}`)
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.ok(html.includes(">paused</span>"))
  assert.ok(html.includes("artifact paused, the link will come back when the room wakes"))
  assert.ok(!html.includes(`/r/${code}/artifact/`), "no dead artifact link is rendered at all")
  assert.match(html, /id="artifact-frame"[^>]*style="display:none"/)
})


// --- GET /rooms/:code/outbox (PLAN-02 step 2: the D3 member token, D4
// --- server-side per-member scoping, and the D6 pruned gap marker) --------

async function outboxHarness(): Promise<{
  store: RoomStore
  baseUrl: string
  code: string
  alice: Member
  bob: Member
}> {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })
  const service = new RoomService({
    store,
    client,
    booter,
    transport: new MemoryTransport(),
    daemon: { baseUrl: daemon.url, token: undefined },
  })
  services.push(service)

  const room = await store.create()
  const alice = await store.addMember(room.code, {
    displayName: "Chloe",
    tier: "room-web",
    address: { provider: "room-web", source: "room-web", contactRef: "chloe" },
  })
  const bob = await store.addMember(room.code, {
    displayName: "Bob",
    tier: "messenger",
    address: { provider: "telegram", source: "agentpush", contactRef: "700" },
  })
  const baseUrl = await listenOnRandomPort(service)
  return { store, baseUrl, code: room.code, alice, bob }
}

function outboxDelivery(
  id: string,
  memberId: string,
  text: string,
  status: Delivery["status"] = "pending",
  kind: Delivery["kind"] = "say",
): Delivery {
  return {
    id,
    memberId,
    kind,
    text,
    status,
    failures: 0,
    lastError: undefined,
    createdAt: "2026-09-12T10:00:00.000Z",
    ...(status === "delivered" ? { deliveredAt: "2026-09-12T10:00:01.000Z" } : { deliveredAt: undefined }),
  }
}

function aliceHeaders(code: string, alice: Member): { authorization: string } {
  return { authorization: `Bearer ${memberToken(code, alice.id, env.roomTokenSecret)}` }
}

test("GET /rooms/:code/outbox refuses a wrong or absent member token, and 404s an unknown room", async () => {
  const { baseUrl, code, alice } = await outboxHarness()

  const absent = await fetch(`${baseUrl}/rooms/${code}/outbox`)
  assert.equal(absent.status, 401)

  const wrong = await fetch(`${baseUrl}/rooms/${code}/outbox`, {
    headers: { authorization: `Bearer ${memberToken(code, alice.id, "wrong-secret")}` },
  })
  assert.equal(wrong.status, 401)
  assert.equal((await readJson(wrong)).error, "unauthorized")

  // A token minted for another room must not resolve here either.
  const wrongRoom = await fetch(`${baseUrl}/rooms/${code}/outbox`, {
    headers: { authorization: `Bearer ${memberToken("RDV-OTHER", alice.id, env.roomTokenSecret)}` },
  })
  assert.equal(wrongRoom.status, 401)

  const unknown = await fetch(`${baseUrl}/rooms/RDV-ZZZZ/outbox`, { headers: aliceHeaders(code, alice) })
  assert.equal(unknown.status, 404)
})

test("GET /rooms/:code/outbox never puts another member's record on the wire (D4, filtered before the bytes leave)", async () => {
  const { store, baseUrl, code, alice, bob } = await outboxHarness()
  await store.update(code, {
    deliverySeq: 2,
    deliveries: [
      outboxDelivery("d1", alice.id, "for Chloe's eyes only"),
      outboxDelivery("d2", bob.id, "for Bob's phone only"),
    ],
  })

  const body = await readJson(await fetch(`${baseUrl}/rooms/${code}/outbox`, { headers: aliceHeaders(code, alice) }))

  assert.equal(body.memberId, alice.id)
  const deliveries = isArrayOf(body.deliveries, (v): v is Record<string, unknown> => isRecord(v)) ? body.deliveries : []
  assert.deepEqual(
    deliveries.map((record) => record.id),
    ["d1"],
  )
  assert.ok(!JSON.stringify(body).includes("for Bob's phone only"), "member B's record must not be on the wire")
  assert.equal(body.pruned, false)
  assert.equal(body.cursor, 2)
})

test("GET /rooms/:code/outbox answers ?since with exactly the tail, id > since, in order (D7)", async () => {
  const { store, baseUrl, code, alice } = await outboxHarness()
  await store.update(code, {
    deliverySeq: 3,
    deliveries: [
      outboxDelivery("d1", alice.id, "one"),
      outboxDelivery("d2", alice.id, "two", "delivered"),
      outboxDelivery("d3", alice.id, "three"),
    ],
  })

  const omitted = await readJson(await fetch(`${baseUrl}/rooms/${code}/outbox`, { headers: aliceHeaders(code, alice) }))
  const everything = isArrayOf(omitted.deliveries, (v): v is Record<string, unknown> => isRecord(v)) ? omitted.deliveries : []
  assert.deepEqual(everything.map((record) => record.id), ["d1", "d2", "d3"])

  const sinceTwo = await readJson(await fetch(`${baseUrl}/rooms/${code}/outbox?since=2`, { headers: aliceHeaders(code, alice) }))
  const tail = isArrayOf(sinceTwo.deliveries, (v): v is Record<string, unknown> => isRecord(v)) ? sinceTwo.deliveries : []
  assert.deepEqual(tail.map((record) => record.id), ["d3"], "since replays exactly the records after it")

  const sinceThree = await readJson(await fetch(`${baseUrl}/rooms/${code}/outbox?since=3`, { headers: aliceHeaders(code, alice) }))
  assert.deepEqual(isArrayOf(sinceThree.deliveries, (v): v is Record<string, unknown> => isRecord(v)) ? sinceThree.deliveries : [], [])
  assert.equal(sinceThree.pruned, false, "a since at the newest id is 'nothing new', not 'you lost something'")
})

test("GET /rooms/:code/outbox fires the pruned gap marker when since predates what survived (D6)", async () => {
  const { store, baseUrl, code, alice, bob } = await outboxHarness()
  // Alice's d1..d4 were pruned; the oldest retained delivery FOR HER is d5.
  // Bob's record (d2) still sits in the tail, which must not mask her gap.
  // The low-water mark is what a real prune would have set (brief 12: it is
  // now the ONLY signal consulted for a room that has one).
  await store.update(code, {
    deliverySeq: 5,
    deliveryLowWater: 4,
    deliveries: [
      outboxDelivery("d2", bob.id, "his phone got this one", "delivered"),
      outboxDelivery("d5", alice.id, "oldest she still has", "delivered"),
      outboxDelivery("d6", alice.id, "the newest"),
    ],
  })

  const sinceTwo = await readJson(await fetch(`${baseUrl}/rooms/${code}/outbox?since=2`, { headers: aliceHeaders(code, alice) }))
  assert.equal(sinceTwo.pruned, true, "her cursor points below what survived — the response must say so")
  const tail = isArrayOf(sinceTwo.deliveries, (v): v is Record<string, unknown> => isRecord(v)) ? sinceTwo.deliveries : []
  assert.deepEqual(tail.map((record) => record.id), ["d5", "d6"])

  // At the oldest retained id there is no gap to report.
  const sinceFive = await readJson(await fetch(`${baseUrl}/rooms/${code}/outbox?since=5`, { headers: aliceHeaders(code, alice) }))
  assert.equal(sinceFive.pruned, false)
})

test("GET /rooms/:code/outbox: a member never addressed by the room's earliest records is not told it lost them, on its first poll ever (brief 12, defect 1)", async () => {
  const { store, baseUrl, code, alice, bob } = await outboxHarness()
  // alice owns d1/d2; bob owns d3..d5. Nothing has EVER been pruned — this
  // room is fresh, so `deliveryLowWater` is the 0 it is born with
  // (rooms/store.ts `create`). Bob's oldest-OWNED seq (3) is not evidence
  // that anything of his was pruned: he simply was never addressed by d1/d2.
  await store.update(code, {
    deliverySeq: 5,
    deliveries: [
      outboxDelivery("d1", alice.id, "for alice"),
      outboxDelivery("d2", alice.id, "for alice too"),
      outboxDelivery("d3", bob.id, "for bob"),
      outboxDelivery("d4", bob.id, "for bob too"),
      outboxDelivery("d5", bob.id, "for bob thrice"),
    ],
  })

  const bobsFirstPoll = await readJson(await fetch(`${baseUrl}/rooms/${code}/outbox?since=0`, { headers: aliceHeaders(code, bob) }))
  assert.equal(bobsFirstPoll.pruned, false, "an oldest-owned seq above zero is ownership, not a lost record")
})

test("GET /rooms/:code/outbox: a member whose own backlog is entirely pruned reports no gap once its cursor sits at or above the low-water mark (brief 12, defect 2)", async () => {
  const { store, baseUrl, code, alice, bob } = await outboxHarness()
  // Everything up through d11 is provably gone (the mark says so). Alice
  // owns nothing surviving; bob is the only member with anything left
  // (d12/d13, RDV-RZUF's live shape). Alice's cursor already sits at the
  // mark — nothing has been dropped for her SINCE then.
  await store.update(code, {
    deliverySeq: 13,
    deliveryLowWater: 11,
    deliveries: [outboxDelivery("d12", bob.id, "for bob"), outboxDelivery("d13", bob.id, "for bob too")],
  })

  const body = await readJson(await fetch(`${baseUrl}/rooms/${code}/outbox?since=11`, { headers: aliceHeaders(code, alice) }))
  assert.equal(
    body.pruned,
    false,
    "the room-wide oldest retained (bob's d12) must not stand in for alice's own history once a mark is present",
  )
})

test("GET /rooms/:code/outbox: a real prune still reports pruned:true below the mark — the fix must not go quiet (brief 12)", async () => {
  const { store, baseUrl, code, alice } = await outboxHarness()
  await store.update(code, {
    deliverySeq: 8,
    deliveryLowWater: 6,
    deliveries: [outboxDelivery("d7", alice.id, "oldest she still has"), outboxDelivery("d8", alice.id, "newest")],
  })

  const below = await readJson(await fetch(`${baseUrl}/rooms/${code}/outbox?since=3`, { headers: aliceHeaders(code, alice) }))
  assert.equal(below.pruned, true, "since sits below the mark — records were genuinely dropped")

  const atMark = await readJson(await fetch(`${baseUrl}/rooms/${code}/outbox?since=6`, { headers: aliceHeaders(code, alice) }))
  assert.equal(atMark.pruned, false, "at the mark itself nothing below it was lost from here")
})

test("GET /rooms/:code/outbox answers Accept: text/event-stream with the same records, as a meta frame plus one frame per record", async () => {
  const { store, baseUrl, code, alice } = await outboxHarness()
  await store.update(code, {
    deliverySeq: 2,
    deliveries: [outboxDelivery("d1", alice.id, "first", "delivered"), outboxDelivery("d2", alice.id, "second")],
  })

  const res = await fetch(`${baseUrl}/rooms/${code}/outbox`, {
    headers: { ...aliceHeaders(code, alice), accept: "text/event-stream" },
  })
  assert.equal(res.status, 200)
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/)

  const frames = await readSseRecords(res, 3)
  assert.equal(frames[0]?.id, "d1", "the replay comes first, same records as the JSON reading")
  assert.equal(frames[1]?.id, "d2")
  assert.equal(frames[2]?.memberId, alice.id, "the meta frame carries the cursor and the gap marker")
  assert.equal(frames[2]?.pruned, false)
  assert.equal(frames[2]?.cursor, 2)
})

// --- POST /rooms/:code/outbox/cursor (PLAN-02 step 4: the ack) --------------

test("GET /rooms/:code/outbox fires the gap marker from the room-wide oldest, but ONLY for a legacy room with no low-water mark (brief E; scope narrowed by brief 12)", async () => {
  // brief 12: a room created after `deliveryLowWater` existed writes it 0 at
  // birth, so it is never absent for a modern room — the room-wide-oldest
  // fallback below is dead code for anything `store.create()` produces
  // today. The only way to exercise it honestly is a room that predates the
  // field, simulated here the same way test/rooms/store.test.ts's migration
  // test simulates a pre-`delivery` member: write the field out, reopen.
  const dir = await freshDir()
  let store = await RoomStore.open(dir)
  const room = await store.create()
  const alice = await store.addMember(room.code, {
    displayName: "Chloe",
    tier: "room-web",
    address: { provider: "room-web", source: "room-web", contactRef: "chloe" },
  })
  const bob = await store.addMember(room.code, {
    displayName: "Bob",
    tier: "messenger",
    address: { provider: "telegram", source: "agentpush", contactRef: "700" },
  })
  // Alice has NO records of her own left — her backlog was pruned to
  // nothing. Her own oldest-owned seq is deleted code (brief 12); the
  // room-wide oldest retained (bob's d2) is the only legacy signal left.
  await store.update(room.code, {
    deliverySeq: 5,
    deliveries: [outboxDelivery("d2", bob.id, "his phone got this one", "delivered"), outboxDelivery("d5", bob.id, "newest", "delivered")],
  })

  const filePath = join(dir, "rooms.json")
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as { rooms: Record<string, unknown>[] }
  delete parsed.rooms[0]!.deliveryLowWater
  await writeFile(filePath, JSON.stringify(parsed), "utf8")
  store = await RoomStore.open(dir)

  const daemon = await freshDaemon()
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })
  const service = new RoomService({
    store,
    client,
    booter,
    transport: new MemoryTransport(),
    daemon: { baseUrl: daemon.url, token: undefined },
  })
  services.push(service)
  const baseUrl = await listenOnRandomPort(service)

  const sinceOne = await readJson(await fetch(`${baseUrl}/rooms/${room.code}/outbox?since=1`, { headers: aliceHeaders(room.code, alice) }))
  assert.equal(sinceOne.pruned, true, "total loss must not read as 'nothing new', even from the weaker legacy signal")
  assert.deepEqual(
    isArrayOf(sinceOne.deliveries, (v): v is Record<string, unknown> => isRecord(v)) ? sinceOne.deliveries : [],
    [],
  )

  // At the room-wide oldest there is no gap to report.
  const sinceTwo = await readJson(await fetch(`${baseUrl}/rooms/${room.code}/outbox?since=2`, { headers: aliceHeaders(room.code, alice) }))
  assert.equal(sinceTwo.pruned, false)

  // A member with records of her own still reads the gap from the mark when
  // one is present, not any oldest-owned proxy (the D6 test pins that).
})

test("GET /rooms/:code/outbox: a legacy room that still retains d1 has provably pruned nothing, even for a member owning none of it (brief 16)", async () => {
  // Seqs are minted monotonically from Room.deliverySeq and a pruned seq is
  // never re-minted (docs/OUTBOX.md §2), so d1 surviving proves nothing has
  // ever been pruned here — regardless of what the weaker room-wide-oldest
  // fallback would otherwise guess.
  const dir = await freshDir()
  let store = await RoomStore.open(dir)
  const room = await store.create()
  const alice = await store.addMember(room.code, {
    displayName: "Chloe",
    tier: "room-web",
    address: { provider: "room-web", source: "room-web", contactRef: "chloe" },
  })
  const bob = await store.addMember(room.code, {
    displayName: "Bob",
    tier: "messenger",
    address: { provider: "telegram", source: "agentpush", contactRef: "700" },
  })
  await store.update(room.code, {
    deliverySeq: 1,
    deliveries: [outboxDelivery("d1", bob.id, "the very first record ever minted", "delivered")],
  })

  const filePath = join(dir, "rooms.json")
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as { rooms: Record<string, unknown>[] }
  delete parsed.rooms[0]!.deliveryLowWater
  await writeFile(filePath, JSON.stringify(parsed), "utf8")
  store = await RoomStore.open(dir)

  const daemon = await freshDaemon()
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })
  const service = new RoomService({
    store,
    client,
    booter,
    transport: new MemoryTransport(),
    daemon: { baseUrl: daemon.url, token: undefined },
  })
  services.push(service)
  const baseUrl = await listenOnRandomPort(service)

  const sinceZero = await readJson(await fetch(`${baseUrl}/rooms/${room.code}/outbox?since=0`, { headers: aliceHeaders(room.code, alice) }))
  assert.equal(sinceZero.pruned, false, "d1 is still here — nothing has ever been pruned in this room")
})

test("GET /rooms/:code/outbox: a legacy room that does NOT retain d1 keeps the weaker room-wide-oldest fallback (brief 16 pair)", async () => {
  // The pair to the test above: without this, reporting pruned:false whenever
  // a member owns nothing would pass trivially by hard-wiring the answer
  // rather than actually reading d1's presence.
  const dir = await freshDir()
  let store = await RoomStore.open(dir)
  const room = await store.create()
  const alice = await store.addMember(room.code, {
    displayName: "Chloe",
    tier: "room-web",
    address: { provider: "room-web", source: "room-web", contactRef: "chloe" },
  })
  const bob = await store.addMember(room.code, {
    displayName: "Bob",
    tier: "messenger",
    address: { provider: "telegram", source: "agentpush", contactRef: "700" },
  })
  // d1 is gone — the room genuinely may have pruned, so the weaker room-wide
  // oldest-retained fallback (d2) still governs.
  await store.update(room.code, {
    deliverySeq: 2,
    deliveries: [outboxDelivery("d2", bob.id, "oldest survivor", "delivered")],
  })

  const filePath = join(dir, "rooms.json")
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as { rooms: Record<string, unknown>[] }
  delete parsed.rooms[0]!.deliveryLowWater
  await writeFile(filePath, JSON.stringify(parsed), "utf8")
  store = await RoomStore.open(dir)

  const daemon = await freshDaemon()
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })
  const service = new RoomService({
    store,
    client,
    booter,
    transport: new MemoryTransport(),
    daemon: { baseUrl: daemon.url, token: undefined },
  })
  services.push(service)
  const baseUrl = await listenOnRandomPort(service)

  const sinceZero = await readJson(await fetch(`${baseUrl}/rooms/${room.code}/outbox?since=0`, { headers: aliceHeaders(room.code, alice) }))
  assert.equal(sinceZero.pruned, true, "d1 is gone — the room-wide oldest-retained fallback must still fire")
})

test("GET /rooms/:code/outbox fires the gap marker from the low-water mark when NOTHING is retained (brief B)", async () => {
  const { store, baseUrl, code, alice } = await outboxHarness()
  // The room pruned EVERYTHING it ever held — deliveries is empty, so there
  // is no record left to compare `since` against. The low-water mark is the
  // only remaining fact: seqs up to 4 were dropped at some point.
  await store.update(code, { deliverySeq: 5, deliveryLowWater: 4, deliveries: [] })

  const sinceOne = await readJson(await fetch(`${baseUrl}/rooms/${code}/outbox?since=1`, { headers: aliceHeaders(code, alice) }))
  assert.equal(sinceOne.pruned, true, "a cursor below the low-water mark means a destroyed backlog, even in an empty room")

  const sinceFour = await readJson(await fetch(`${baseUrl}/rooms/${code}/outbox?since=4`, { headers: aliceHeaders(code, alice) }))
  assert.equal(sinceFour.pruned, false, "at the mark itself there is nothing below it to have lost")

  const omitted = await readJson(await fetch(`${baseUrl}/rooms/${code}/outbox`, { headers: aliceHeaders(code, alice) }))
  assert.equal(omitted.pruned, false, "an omitted since asks for everything retained — nothing can be lost from that")
})

async function postCursor(
  baseUrl: string,
  roomCode: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/rooms/${roomCode}/outbox/cursor`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await readJson(res) }
}

test("POST /rooms/:code/outbox/cursor acks monotonically, persists on the member, and confirms by recipient (brief A/B)", async () => {
  const { store, baseUrl, code, alice, bob } = await outboxHarness()
  await store.update(code, {
    deliverySeq: 2,
    deliveries: [outboxDelivery("d1", alice.id, "hers", "delivered"), outboxDelivery("d2", alice.id, "hers too", "delivered")],
  })

  // Same token family as the drain: wrong or absent is 401, unknown room 404.
  const absent = await postCursor(baseUrl, code, {}, { seq: 1 })
  assert.equal(absent.status, 401)
  const wrong = await postCursor(baseUrl, code, { authorization: `Bearer ${memberToken(code, alice.id, "wrong")}` }, { seq: 1 })
  assert.equal(wrong.status, 401)
  const unknownRoom = await postCursor(baseUrl, "RDV-ZZZZ", aliceHeaders(code, alice), { seq: 1 })
  assert.equal(unknownRoom.status, 404)

  // Malformed bodies are a validated 400.
  for (const bad of [undefined, { seq: "1" }, { seq: -1 }, { seq: 1.5 }]) {
    const badBody = await postCursor(baseUrl, code, aliceHeaders(code, alice), bad)
    assert.equal(badBody.status, 400, `seq ${JSON.stringify(bad)} must be rejected`)
  }

  // An advancing ack lands: persisted on the member (seq + wall-clock), and
  // the covered record becomes confirmedBy "recipient" (brief B).
  const first = await postCursor(baseUrl, code, aliceHeaders(code, alice), { seq: 1 })
  assert.equal(first.status, 200)
  assert.equal(first.body.applied, true)
  assert.equal(first.body.ackedSeq, 1)
  const acked = store.get(code)?.members.find((candidate) => candidate.id === alice.id)
  assert.ok(acked !== undefined)
  assert.equal(acked.ackedSeq, 1)
  assert.ok(acked.ackedAt !== undefined)
  const d1 = store.get(code)?.deliveries?.find((record) => record.id === "d1")
  assert.equal(d1?.confirmedBy, "recipient")

  // A backwards ack is IGNORED, not an error: the floor does not rewind, and
  // the response states the cursor that still holds.
  const backwards = await postCursor(baseUrl, code, aliceHeaders(code, alice), { seq: 0 })
  assert.equal(backwards.status, 200)
  assert.equal(backwards.body.applied, false)
  assert.equal(backwards.body.ackedSeq, 1)
  assert.equal(store.get(code)?.members.find((candidate) => candidate.id === alice.id)?.ackedSeq, 1)

  // A record above the cursor stays unconfirmed; acking past it confirms it.
  const d2 = store.get(code)?.deliveries?.find((record) => record.id === "d2")
  assert.equal(d2?.confirmedBy, undefined)
  const second = await postCursor(baseUrl, code, aliceHeaders(code, alice), { seq: 2 })
  assert.equal(second.body.applied, true)
  const d2after = store.get(code)?.deliveries?.find((record) => record.id === "d2")
  assert.equal(d2after?.confirmedBy, "recipient")
  void bob
})

// --- POST /rooms/:code/claim (PLAN-02 step 3: the D3-amended name claim, ---
// --- the spectator/member split, and the drain the page runs) ---------------

async function postClaim(
  baseUrl: string,
  code: string,
  displayName: string,
  claim?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/rooms/${code}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(claim === undefined ? { displayName } : { displayName, claim }),
  })
  return { status: res.status, body: await readJson(res) }
}

test("POST /rooms/:code/claim mints the join secret once and returns it exactly once; absent or wrong is refused with the name-taken outcome", async () => {
  const { baseUrl, code, alice } = await outboxHarness()

  // Chloe has no member yet: the first claim creates her and hands the
  // secret over — exactly once.
  const first = await postClaim(baseUrl, code, "Chloe")
  assert.equal(first.status, 200)
  const minted = typeof first.body.claim === "string" ? first.body.claim : undefined
  assert.ok(typeof minted === "string", "the minting claim returns the secret once")
  assert.equal(typeof first.body.memberToken, "string")
  const token = first.body.memberToken

  // A returning tab that presents the secret: accepted, same member, same
  // token — and the secret is NOT handed out again.
  const again = await postClaim(baseUrl, code, "Chloe", minted)
  assert.equal(again.status, 200)
  assert.equal(again.body.claim, undefined, "the secret is never returned to a second presentation")
  assert.equal(again.body.memberToken, token)
  assert.equal(again.body.memberId, first.body.memberId)

  // Anyone else typing the name without the secret is refused, with the
  // distinct outcome the UI renders — not a generic 500.
  const impostor = await postClaim(baseUrl, code, "Chloe")
  assert.equal(impostor.status, 409)
  assert.equal(impostor.body.error, "name_claimed")
  assert.ok(
    typeof impostor.body.message === "string" && (impostor.body.message as string).includes("déjà pris"),
    "the refusal message is the one the page renders",
  )

  const wrongSecret = await postClaim(baseUrl, code, "Chloe", "not-the-secret")
  assert.equal(wrongSecret.status, 409)
  assert.equal(wrongSecret.body.error, "name_claimed")

  void alice
})

test("the grandfather path adopts a pre-claim member exactly once (brief A)", async () => {
  const { baseUrl, code, alice } = await outboxHarness()
  // `alice` (Chloe) was persisted by the harness WITHOUT a claim — the live
  // store's pre-claim members. The first join that presents no claim is the
  // same human coming back: adopt them, mint once, hand it over once.
  const grandfathered = await postClaim(baseUrl, code, "Chloe")
  assert.equal(grandfathered.status, 200)
  const minted = typeof grandfathered.body.claim === "string" ? grandfathered.body.claim : undefined
  assert.ok(typeof minted === "string", "the adopting join mints and returns the secret once")
  assert.equal(grandfathered.body.memberId, alice.id, "the SAME member is adopted, not a new one")

  // Exactly once: a second secret-less join is now an impostor.
  const second = await postClaim(baseUrl, code, "Chloe")
  assert.equal(second.status, 409)
  const withSecret = await postClaim(baseUrl, code, "Chloe", minted)
  assert.equal(withSecret.status, 200)
})

test("a spectator tab gets a working page and NO token in the HTML (brief C)", async () => {
  const { baseUrl, code, alice, bob } = await outboxHarness()

  const res = await fetch(`${baseUrl}/r/${code}`)
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.ok(html.includes(code), "the page renders for a visitor with no name claimed at all")
  assert.ok(html.includes("/outbox?since="), "the outbox drain is in the page script")
  for (const member of [alice, bob]) {
    const token = memberToken(code, member.id, env.roomTokenSecret)
    assert.ok(!html.includes(token), "no member's bearer token is embedded in the HTML")
  }
})

test("a member's drain shows its own whisper and never another's, authorized by the token the claim exchange returned", async () => {
  const { store, baseUrl, code, alice, bob } = await outboxHarness()
  await store.update(code, {
    deliverySeq: 2,
    deliveries: [
      outboxDelivery("d1", alice.id, "whisper for Chloe alone", "pending", "whisper"),
      outboxDelivery("d2", bob.id, "whisper for Bob alone", "pending", "whisper"),
    ],
  })

  // The claim exchange adopts the pre-claim member under her own name and
  // returns her D3 token; the drain presents it.
  const adopted = await postClaim(baseUrl, code, "Chloe")
  assert.equal(adopted.status, 200)
  const token = adopted.body.memberToken
  assert.ok(typeof token === "string")
  assert.equal(token, memberToken(code, alice.id, env.roomTokenSecret), "the claim exchange returns the D3 member token")

  const drain = await readJson(
    await fetch(`${baseUrl}/rooms/${code}/outbox`, { headers: { authorization: `Bearer ${token}` } }),
  )
  const records = isArrayOf(drain.deliveries, (v): v is Record<string, unknown> => isRecord(v)) ? drain.deliveries : []
  assert.deepEqual(
    records.map((record) => record.id),
    ["d1"],
  )
  assert.ok(!JSON.stringify(drain).includes("whisper for Bob alone"), "another member's whisper is never on the wire")
})

test("POST /rooms/:code/send refuses a claimed name presented without its secret, and accepts it with the secret", async () => {
  const { baseUrl, code, daemon, sessionId } = await newRoomHarness()

  const first = await postClaim(baseUrl, code, "Chloe")
  assert.equal(first.status, 200)
  const minted = typeof first.body.claim === "string" ? first.body.claim : undefined
  assert.ok(typeof minted === "string")

  const impostor = await fetch(`${baseUrl}/rooms/${code}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Chloe", text: "hi" }),
  })
  assert.equal(impostor.status, 409)
  assert.equal((await readJson(impostor)).error, "name_claimed")

  const holder = await fetch(`${baseUrl}/rooms/${code}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Chloe", text: "hi", claim: minted }),
  })
  assert.equal(holder.status, 200)
  const prompts = daemon.requestsReceived.filter((r) => r.path === `/sessions/${sessionId}/prompt`)
  assert.equal(prompts.length, 1)
})

test("POST /inbound/simulated answers an unroutable provider with a validated 400 naming it, not an uncaught 500 (brief E)", async () => {
  const { baseUrl, code } = await newRoomHarness()
  void code
  const res = await fetch(`${baseUrl}/inbound/simulated`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "sim",
      source: "sim",
      contactRef: "someone",
      displayName: "Someone",
      text: "hello",
      tier: "messenger",
    }),
  })
  assert.equal(res.status, 400)
  const body = await readJson(res)
  assert.equal(body.error, "unknown_provider")
  assert.equal(body.provider, "sim")
})
