import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer as createHttpTestServer, type Server as HttpTestServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { DaemonClient } from "../../src/daemon/client.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import { LocalBooter, type SessionBooter } from "../../src/service/booter.ts"
import { createHttpServer } from "../../src/service/http.ts"
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

async function listenOnRandomPort(service: RoomService): Promise<string> {
  const server = createHttpServer(service)
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

  const baseUrl = await listenOnRandomPort(service)
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

  const send = async (): Promise<Record<string, unknown>> => {
    const res = await fetch(`${baseUrl}/rooms/${code}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Chloe", text: "hi from the web" }),
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
async function newRoomHarnessWithArtifact(artifactUrl: string): Promise<{ baseUrl: string; code: string }> {
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

  const baseUrl = await listenOnRandomPort(service)
  return { baseUrl, code: created.room.code }
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
