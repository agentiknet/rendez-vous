/**
 * A session killed out of band (a daemon-side `agent_kill`, a crash, a
 * daemon restart) never runs `RoomService.doPause` — the store is left
 * `state: "active"` pointing at a `sessionId` the daemon no longer runs.
 * The daemon still answers `GET /sessions/:id` with `200 {status:"killed"}`
 * (it only forgets the row on `DELETE`, `docs/DAEMON-NOTES.md` "Session
 * teardown"), so `isSessionAlive`'s old bare `res.ok` check read that as
 * alive and the room stranded on a 409 `session_not_alive` fan-in error.
 * This file exercises the fix end to end (through `RoomService`, against the
 * fake daemon's real kill route, never `doPause`) and unit-tests
 * `isSessionAlive` itself against every status in the daemon's vocabulary.
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { DaemonClient } from "../../src/daemon/client.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Address, Tier } from "../../src/rooms/types.ts"
import { LocalBooter } from "../../src/service/booter.ts"
import { isSessionAlive } from "../../src/service/daemon-extra.ts"
import { RoomService } from "../../src/service/room-service.ts"
import { MemoryTransport } from "../../src/service/transports.ts"
import { startExtendedFakeDaemon, type ExtendedFakeDaemon } from "./fake-daemon-extra.ts"

const dirs: string[] = []
const daemons: ExtendedFakeDaemon[] = []
const services: RoomService[] = []

after(async () => {
  await Promise.all(services.map((service) => service.stop()))
  await Promise.all(daemons.map((daemon) => daemon.close()))
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-oob-kill-"))
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
  daemonClient: DaemonClient
}

async function buildHarness(): Promise<Harness> {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const store = await RoomStore.open(dir)
  const daemonClient = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(daemonClient, { baseUrl: daemon.url, token: undefined })
  const transport = new MemoryTransport()
  const service = new RoomService({ store, client: daemonClient, booter, transport, daemon: { baseUrl: daemon.url, token: undefined } })
  services.push(service)
  return { service, store, transport, daemon, daemonClient }
}

function alice(text: string): { address: Address; displayName: string; tier: Tier; text: string } {
  return {
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+15550001111" },
    displayName: "Alice",
    tier: "messenger",
    text,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

test("a plain fan-in from a known member revives a room whose session was killed out of band (not via doPause)", async () => {
  const { service, store, transport, daemon, daemonClient } = await buildHarness()

  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  const code = created.room.code
  const originalSessionId = created.room.sessionId
  assert.ok(originalSessionId !== undefined)
  if (originalSessionId === undefined) return

  // Kill through the daemon's own kill route, exactly like `agent_kill` — not
  // `service.pauseRoom`, which would already mark the room paused itself.
  await daemonClient.kill(originalSessionId)
  assert.equal(store.get(code)?.state, "active", "an out-of-band kill leaves the store's own bookkeeping untouched")

  // The fake daemon always hands out the same fixed session id on every
  // spawn (test/daemon/fake-daemon.ts), so a booted-fresh session can't be
  // told apart from the dead one by id alone — the spawn count is the real
  // signal that a new boot happened rather than the dead session being reused.
  const spawnCallsBefore = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent").length
  const sendsBefore = transport.sends.length
  const outcome = await service.handleInbound(alice("are you there?"))
  assert.equal(outcome.kind, "message")

  const spawnCallsAfter = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent").length
  assert.ok(spawnCallsAfter > spawnCallsBefore, "revival must boot a fresh session, not reuse the dead id")

  const revived = store.get(code)
  assert.equal(revived?.state, "active")
  assert.ok(revived?.sessionId !== undefined)

  const resumingSend = transport.sends[sendsBefore]
  assert.ok(resumingSend?.message.text.includes("Resuming"), "the sender must be told the room is resuming")

  const promptRequests = daemon.requestsReceived.filter((r) => r.path === `/sessions/${revived?.sessionId}/prompt`)
  assert.equal(promptRequests.length, 1, "the triggering message must still fan in, on the new session")
  const body = promptRequests[0]?.body
  assert.ok(isRecord(body))
  if (!isRecord(body)) return
  assert.equal(body.queue, true, "queue:true is load-bearing (M2) — must survive the revive path too")
})

test("resume <code> on an active room whose session was killed out of band revives it the same way", async () => {
  const { service, store, daemon, daemonClient } = await buildHarness()

  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  const code = created.room.code
  const originalSessionId = created.room.sessionId
  assert.ok(originalSessionId !== undefined)
  if (originalSessionId === undefined) return

  await daemonClient.kill(originalSessionId)
  assert.equal(store.get(code)?.state, "active")

  const spawnCallsBefore = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent").length
  const outcome = await service.handleInbound(alice(`resume ${code}`))
  assert.equal(outcome.kind, "resumed")

  const spawnCallsAfter = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent").length
  assert.ok(spawnCallsAfter > spawnCallsBefore, "resume must boot a fresh session instead of trusting the dead one")

  const resumedRoom = store.get(code)
  assert.equal(resumedRoom?.state, "active")
  assert.ok(resumedRoom?.sessionId !== undefined)
})

test("isSessionAlive: alive only for running/starting; killed, exited, error, 404, and a connection error are all dead", async () => {
  const daemon = await freshDaemon()
  const opts = { baseUrl: daemon.url, token: undefined }

  daemon.setSessionStatus("sess-running", "running")
  assert.equal(await isSessionAlive(opts, "sess-running"), true)

  daemon.setSessionStatus("sess-starting", "starting")
  assert.equal(await isSessionAlive(opts, "sess-starting"), true)

  daemon.setSessionStatus("sess-killed", "killed")
  assert.equal(await isSessionAlive(opts, "sess-killed"), false)

  daemon.setSessionStatus("sess-exited", "exited")
  assert.equal(await isSessionAlive(opts, "sess-exited"), false)

  daemon.setSessionStatus("sess-error", "error")
  assert.equal(await isSessionAlive(opts, "sess-error"), false)

  daemon.forgetSession("sess-never-existed")
  assert.equal(await isSessionAlive(opts, "sess-never-existed"), false)

  // A connection error (nothing listening on this port) must read as dead,
  // not throw — callers boot fresh/revive rather than propagate.
  assert.equal(await isSessionAlive({ baseUrl: "http://127.0.0.1:1", token: undefined }, "sess-anything"), false)
})
