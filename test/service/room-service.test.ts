import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { DaemonClient } from "../../src/daemon/client.ts"
import type { OutboundMessage, Transport } from "../../src/fanout/types.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Address, Member, Tier } from "../../src/rooms/types.ts"
import { LocalBooter } from "../../src/service/booter.ts"
import { RoomService } from "../../src/service/room-service.ts"
import { MemoryTransport, type RecordedSend } from "../../src/service/transports.ts"
import { startExtendedFakeDaemon, type ExtendedFakeDaemon } from "./fake-daemon-extra.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const dirs: string[] = []
const daemons: ExtendedFakeDaemon[] = []
const services: RoomService[] = []

after(async () => {
  // Fan-out readers retry forever on a dead connection (backoff, uncapped) —
  // any service left running would keep the process alive after the fake
  // daemons close, so every one built in this file must be stopped here.
  await Promise.all(services.map((service) => service.stop()))
  await Promise.all(daemons.map((daemon) => daemon.close()))
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-service-"))
  dirs.push(dir)
  return dir
}

async function freshDaemon(): Promise<ExtendedFakeDaemon> {
  const daemon = await startExtendedFakeDaemon()
  daemons.push(daemon)
  return daemon
}

interface Harness {
  service: RoomService
  store: RoomStore
  transport: MemoryTransport
  daemon: ExtendedFakeDaemon
}

async function buildHarness(): Promise<Harness> {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })
  const transport = new MemoryTransport()
  const service = new RoomService({ store, client, booter, transport })
  services.push(service)
  return { service, store, transport, daemon }
}

async function buildHarnessWithTransport<T extends Transport>(
  transport: T,
): Promise<{ service: RoomService; store: RoomStore; transport: T; daemon: ExtendedFakeDaemon }> {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })
  const service = new RoomService({ store, client, booter, transport })
  services.push(service)
  return { service, store, transport, daemon }
}

function alice(text: string): { address: Address; displayName: string; tier: Tier; text: string } {
  return {
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+15550001111" },
    displayName: "Alice",
    tier: "messenger",
    text,
  }
}

function bob(text: string): { address: Address; displayName: string; tier: Tier; text: string } {
  return {
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+15559998888" },
    displayName: "Bob",
    tier: "messenger",
    text,
  }
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** A plain `Transport` with no `sendMedia` at all — for asserting that the
 *  QR send is skipped, not just silently swallowed, when unsupported. */
class PlainTransport implements Transport {
  readonly sends: RecordedSend[] = []

  async send(member: Member, message: OutboundMessage): Promise<void> {
    this.sends.push({ member, message })
  }
}

test("new boots a session via the booter and replies to the sender with the code and artifact url", async () => {
  const { service, transport } = await buildHarness()

  const outcome = await service.handleInbound(alice("new"))
  assert.equal(outcome.kind, "created")
  if (outcome.kind !== "created") return
  assert.match(outcome.room.code, /^RDV-[A-Z0-9]{4}$/)
  assert.equal(outcome.room.sessionId, "sess_fake")
  assert.equal(outcome.room.members.length, 1)

  assert.equal(transport.sends.length, 1)
  assert.equal(transport.sends[0]?.member.displayName, "Alice")
  assert.ok(transport.sends[0]?.message.text.includes(outcome.room.code))
})

test("new includes the web join link in the reply and sends a QR when the transport supports media", async () => {
  const { service, transport } = await buildHarness()

  const outcome = await service.handleInbound(alice("new"))
  assert.equal(outcome.kind, "created")
  if (outcome.kind !== "created") return

  const replyText = transport.sends[0]?.message.text ?? ""
  assert.ok(replyText.includes(`/r/${outcome.room.code}`), "reply should include the web join link")

  assert.equal(transport.mediaSends.length, 1)
  assert.equal(transport.mediaSends[0]?.member.displayName, "Alice")
  assert.ok(transport.mediaSends[0]?.caption.includes(outcome.room.code))
  assert.ok((transport.mediaSends[0]?.png.length ?? 0) > 0, "should send actual PNG bytes")
})

test("new never calls sendMedia when the transport does not support it", async () => {
  const plain = new PlainTransport()
  const { service } = await buildHarnessWithTransport(plain)

  const outcome = await service.handleInbound(alice("new"))
  assert.equal(outcome.kind, "created")
  assert.equal(plain.sends.length, 1)
  // PlainTransport has no sendMedia at all — if RoomService ever called it
  // unconditionally this test would throw a TypeError instead of just failing.
})

test("join adds a second member to an existing room and replies with a welcome that lists the roster", async () => {
  const { service, transport } = await buildHarness()

  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return

  const joined = await service.handleInbound(bob(`join ${created.room.code}`))
  assert.equal(joined.kind, "joined")
  if (joined.kind !== "joined") return
  assert.equal(joined.room.code, created.room.code)
  assert.equal(joined.room.members.length, 2)
  assert.equal(joined.member.displayName, "Bob")

  assert.equal(transport.sends.length, 2)
  assert.equal(transport.sends[1]?.member.displayName, "Bob")
  const joinReplyText = transport.sends[1]?.message.text ?? ""
  assert.ok(joinReplyText.includes("Alice"), "join reply should list the roster, including who was already there")
  assert.ok(joinReplyText.includes("Bob"))
})

test("join on an unknown code replies with guidance and returns a typed error", async () => {
  const { service, transport } = await buildHarness()

  const outcome = await service.handleInbound(alice("join RDV-ZZZZ"))
  assert.deepEqual(outcome, { kind: "unknown-code" })
  assert.equal(transport.sends.length, 1)
  assert.match(transport.sends[0]?.message.text ?? "", /isn't known/i)
})

test("resume on an unknown code replies with guidance and returns a typed error", async () => {
  const { service, transport } = await buildHarness()

  const outcome = await service.handleInbound(alice("resume RDV-ZZZZ"))
  assert.deepEqual(outcome, { kind: "unknown-code" })
  assert.equal(transport.sends.length, 1)
  assert.match(transport.sends[0]?.message.text ?? "", /isn't known/i)
})

test("a message from an unknown sender gets guidance, not delivered to any session", async () => {
  const { service, transport, daemon } = await buildHarness()

  const outcome = await service.handleInbound(alice("hello, anyone there?"))
  assert.deepEqual(outcome, { kind: "unknown-sender" })
  assert.equal(transport.sends.length, 1)
  assert.match(transport.sends[0]?.message.text ?? "", /new|join/i)
  assert.equal(daemon.requestsReceived.some((r) => r.path.includes("/prompt")), false)
})

test("resume revives a room whose session is still alive without booting a new one", async () => {
  const { service, daemon } = await buildHarness()

  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  const spawnCallsBefore = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent").length

  const resumed = await service.handleInbound(alice(`resume ${created.room.code}`))
  assert.equal(resumed.kind, "resumed")
  if (resumed.kind !== "resumed") return
  assert.equal(resumed.room.sessionId, created.room.sessionId)

  const spawnCallsAfter = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent").length
  assert.equal(spawnCallsAfter, spawnCallsBefore, "resume should not boot a fresh session when the old one is alive")
})

test("a plain message from a known member fans in with queue:true and the [Name · tier] prefix", async () => {
  const { service, daemon } = await buildHarness()

  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return

  const outcome = await service.handleInbound(alice("what is the plan?"))
  assert.equal(outcome.kind, "message")

  const promptRequests = daemon.requestsReceived.filter((r) => r.path === `/sessions/${created.room.sessionId}/prompt`)
  assert.equal(promptRequests.length, 1)
  const body = promptRequests[0]?.body
  assert.ok(isRecord(body))
  if (!isRecord(body)) return
  assert.equal(body.queue, true)
  assert.equal(body.prompt, "[Alice · messenger] what is the plan?")

  await service.stop()
})

test("start() after reopening the store resumes fan-out from the persisted cursor, with no re-delivery", async () => {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })

  const store1 = await RoomStore.open(dir)
  const transport1 = new MemoryTransport()
  const service1 = new RoomService({ store: store1, client, booter, transport: transport1 })
  services.push(service1)

  const created = await service1.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  const sessionId = created.room.sessionId
  assert.ok(sessionId !== undefined)
  if (sessionId === undefined) return

  daemon.pushRecord(sessionId, { seq: 1, kind: "text-delta", text: "hello " })
  daemon.pushRecord(sessionId, { seq: 2, kind: "text-delta", text: "world" })
  daemon.pushRecord(sessionId, { seq: 3, kind: "turn-end", reason: "completed" })

  await waitFor(() => transport1.sends.some((s) => s.message.text === "hello world"))
  await waitFor(() => (store1.get(created.room.code)?.cursor ?? 0) === 3)
  const transport1CountAfterFirstTurn = transport1.sends.length
  await service1.stop()

  const store2 = await RoomStore.open(dir)
  const transport2 = new MemoryTransport()
  const service2 = new RoomService({ store: store2, client, booter, transport: transport2 })
  services.push(service2)
  service2.start()

  daemon.pushRecord(sessionId, { seq: 4, kind: "text-delta", text: "second turn" })
  daemon.pushRecord(sessionId, { seq: 5, kind: "turn-end", reason: "completed" })

  await waitFor(() => transport2.sends.length === 1)
  assert.equal(transport2.sends[0]?.message.text, "second turn")
  assert.equal(
    transport1.sends.length,
    transport1CountAfterFirstTurn,
    "the original transport must never see the second turn",
  )

  await service2.stop()
})
