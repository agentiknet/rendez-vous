/**
 * `E2bBooter` reads `env.prewarmSandboxId`, and `env` is a frozen singleton
 * read once from `process.env` at module load — ESM hoists every *static*
 * import above this file's own code, so setting `process.env` here would run
 * too late for anything imported the normal way. Runtime values that
 * transitively touch `src/env.ts` are therefore imported dynamically, after
 * the env var below is set; pure types are still static (type-only imports
 * are erased, so they never trigger `env.ts` at runtime).
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { startExtendedFakeDaemon, type ExtendedFakeDaemon } from "./fake-daemon-extra.ts"

const PREWARM_ID = "prewarm-abc123"
process.env.RDV_PREWARM_SANDBOX_ID = PREWARM_ID

const { DaemonClient } = await import("../../src/daemon/client.ts")
const { RoomStore } = await import("../../src/rooms/store.ts")
const { E2bBooter } = await import("../../src/service/booter.ts")

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const dirs: string[] = []
const daemons: ExtendedFakeDaemon[] = []

after(async () => {
  await Promise.all(daemons.map((daemon) => daemon.close()))
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-e2b-booter-"))
  dirs.push(dir)
  return dir
}

async function freshDaemon(): Promise<ExtendedFakeDaemon> {
  const daemon = await startExtendedFakeDaemon()
  daemons.push(daemon)
  return daemon
}

test("E2bBooter.boot sends the sandbox spec, appServe and the pre-warm reuse id on the wire", async () => {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new E2bBooter(client, { baseUrl: daemon.url, token: undefined }, store)
  const room = await store.create()

  await booter.boot(room, { label: "rdv-test" })

  const spawnRequests = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent")
  assert.equal(spawnRequests.length, 1)
  const body = spawnRequests[0]?.body
  assert.ok(isRecord(body))
  if (!isRecord(body)) return

  assert.ok(isRecord(body.sandbox))
  if (!isRecord(body.sandbox)) return
  assert.equal(body.sandbox.provider, "e2b")
  assert.deepEqual(body.sandbox.extraPorts, [3210])
  assert.equal(body.sandbox.reuse, PREWARM_ID)

  assert.ok(isRecord(body.appServe))
  if (!isRecord(body.appServe)) return
  assert.equal(body.appServe.dir, "/home/user/apps/rdv-hello")
  assert.equal(body.appServe.port, 3210)
})

test("E2bBooter consumes the pre-warm sandbox id at most once across rooms", async () => {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new E2bBooter(client, { baseUrl: daemon.url, token: undefined }, store)

  const room1 = await store.create()
  await booter.boot(room1, { label: "rdv-room1" })
  const firstBody = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent")[0]?.body
  assert.ok(isRecord(firstBody) && isRecord(firstBody.sandbox))
  if (!isRecord(firstBody) || !isRecord(firstBody.sandbox)) return
  assert.equal(firstBody.sandbox.reuse, PREWARM_ID)

  // What actually "records consumption in the store": RoomService persists a
  // boot's returned sandboxId onto the room that used it (handleNew), which
  // is what makes the id unavailable to the next room below.
  await store.update(room1.code, { sandboxId: PREWARM_ID })

  const room2 = await store.create()
  await booter.boot(room2, { label: "rdv-room2" })
  const secondBody = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent")[1]?.body
  assert.ok(isRecord(secondBody) && isRecord(secondBody.sandbox))
  if (!isRecord(secondBody) || !isRecord(secondBody.sandbox)) return
  assert.equal(secondBody.sandbox.reuse, undefined, "the pre-warm box must not be handed to a second room")
})

test("E2bBooter.boot omits reuse entirely once the pre-warm id is already recorded on a room", async () => {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new E2bBooter(client, { baseUrl: daemon.url, token: undefined }, store)

  const takenRoom = await store.create()
  await store.update(takenRoom.code, { sandboxId: PREWARM_ID })

  const room = await store.create()
  await booter.boot(room, { label: "rdv-test" })
  const body = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent")[0]?.body
  assert.ok(isRecord(body) && isRecord(body.sandbox))
  if (!isRecord(body) || !isRecord(body.sandbox)) return
  assert.equal("reuse" in body.sandbox, false)
})
