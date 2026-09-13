import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { DaemonClient } from "../../src/daemon/client.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Address, Tier } from "../../src/rooms/types.ts"
import { LocalBooter } from "../../src/service/booter.ts"
import { RoomService } from "../../src/service/room-service.ts"
import { MemoryTransport } from "../../src/service/transports.ts"
import { startExtendedFakeDaemon, type ExtendedFakeDaemon } from "./fake-daemon-extra.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const dirs: string[] = []
const daemons: ExtendedFakeDaemon[] = []
const services: RoomService[] = []

after(async () => {
  await Promise.all(services.map((service) => service.stop()))
  await Promise.all(daemons.map((daemon) => daemon.close()))
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-idle-"))
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

async function buildHarness(idlePauseMinutes: number): Promise<Harness> {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })
  const transport = new MemoryTransport()
  const service = new RoomService({
    store,
    client,
    booter,
    transport,
    idlePauseMinutes,
    daemon: { baseUrl: daemon.url, token: undefined },
  })
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

test("sweepIdleRooms pauses only rooms past the threshold and stops their fan-out", async () => {
  // Two separate harnesses (separate fake daemons), not two rooms on one:
  // the fake daemon always returns the same fixed session id for every
  // spawn, so two rooms sharing one daemon would also share a fan-out
  // subscription and this test couldn't tell them apart.
  const old = await buildHarness(1)
  const fresh = await buildHarness(1)

  const createdOld = await old.service.handleInbound(alice("new"))
  assert.ok(createdOld.kind === "created")
  if (createdOld.kind !== "created") return
  const oldCode = createdOld.room.code
  const oldSessionId = createdOld.room.sessionId
  assert.ok(oldSessionId !== undefined)
  if (oldSessionId === undefined) return

  const createdFresh = await fresh.service.handleInbound(bob("new"))
  assert.ok(createdFresh.kind === "created")
  if (createdFresh.kind !== "created") return
  const freshCode = createdFresh.room.code

  // First sweep only establishes the cursor baseline for each room (a room
  // seen for the first time is never paused on that same tick) — see
  // RoomService.sweepIdleRooms's doc comment.
  await old.service.sweepIdleRooms()
  await fresh.service.sweepIdleRooms()

  await old.store.update(oldCode, { lastActivityAt: new Date(Date.now() - 5 * 60_000).toISOString() })
  await old.service.sweepIdleRooms()
  await fresh.service.sweepIdleRooms()

  const oldRoom = old.store.get(oldCode)
  const freshRoom = fresh.store.get(freshCode)
  assert.equal(oldRoom?.state, "paused")
  assert.equal(oldRoom?.sessionId, undefined)
  assert.equal(freshRoom?.state, "active")
  assert.notEqual(freshRoom?.sessionId, undefined)

  // The server-side subscriber cleanup happens on the request's own 'close'
  // event, which can land a tick after our local abort() resolves — poll
  // rather than assert synchronously.
  await waitFor(() => old.daemon.subscriberCount(oldSessionId) === 0)
})

test("a message to a paused room resumes it, and the message still fans in with queue:true", async () => {
  const { service, store, daemon, transport } = await buildHarness(20)

  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  const code = created.room.code

  await service.pauseRoom(code)
  const paused = store.get(code)
  assert.equal(paused?.state, "paused")
  assert.equal(paused?.sessionId, undefined)

  const sendsBefore = transport.sends.length
  const outcome = await service.handleInbound(alice("are you still there?"))
  assert.equal(outcome.kind, "message")

  const resumedRoom = store.get(code)
  assert.equal(resumedRoom?.state, "active")
  const newSessionId = resumedRoom?.sessionId
  assert.ok(newSessionId !== undefined)
  if (newSessionId === undefined) return

  const resumingMessage = transport.sends[sendsBefore]
  assert.ok(resumingMessage?.message.text.includes("Resuming"), "should tell the sender it is resuming first")

  const promptRequests = daemon.requestsReceived.filter((r) => r.path === `/sessions/${newSessionId}/prompt`)
  assert.equal(promptRequests.length, 1)
  const body = promptRequests[0]?.body
  assert.ok(isRecord(body))
  if (!isRecord(body)) return
  assert.equal(body.queue, true)
  // Attribution names the CHANNEL, not the tier: `messenger` covers both
  // Telegram and WhatsApp, so one human on both was indistinguishable.
  assert.equal(body.prompt, "[Alice · whatsapp] are you still there?")
})

test("resume <code> on an active room is a no-op that replies with room status", async () => {
  const { service, transport, daemon } = await buildHarness(20)

  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  const code = created.room.code

  const spawnCallsBefore = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent").length
  const sendsBefore = transport.sends.length

  const outcome = await service.handleInbound(alice(`resume ${code}`))
  assert.equal(outcome.kind, "resumed")
  if (outcome.kind !== "resumed") return
  assert.equal(outcome.room.state, "active")

  const reply = transport.sends[sendsBefore]
  assert.ok(reply?.message.text.includes(created.room.slug), "the room-status reply should name the room by its slug")

  const spawnCallsAfter = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent").length
  assert.equal(spawnCallsAfter, spawnCallsBefore, "resuming an already-active room must not boot anything")
})
