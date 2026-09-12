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
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { startExtendedFakeDaemon, type ExtendedFakeDaemon } from "./fake-daemon-extra.ts"

function listeningPort(server: Server): number {
  const address = server.address()
  if (typeof address !== "object" || address === null) {
    throw new Error("server is not listening on a TCP port")
  }
  return address.port
}

/** A live artifact server for the box-liveness resume tests below: they
 *  exercise `E2bBooter.resume`'s real, non-gone fall-through into
 *  `resumeRoomSession`, which probes the artifact URL over the network
 *  (`src/sandbox/boot.ts`) — an `https://*.example` placeholder would hang on
 *  real DNS resolution instead of failing fast. */
async function startArtifactServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200)
    res.end("ok")
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return {
    url: `http://127.0.0.1:${listeningPort(server)}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  }
}

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

  // `cwd` is forwarded verbatim into the BOX's own `agent_start` (never
  // resolved against this host's filesystem) — it must be a path that
  // exists INSIDE the e2b image, never this process's own `process.cwd()`
  // (the host repo checkout), which does not exist in the box and makes the
  // box's own agent-cli spawn fail with ENOENT.
  assert.equal(body.cwd, "/home/user")
  assert.notEqual(body.cwd, process.cwd())

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

// ---------------------------------------------------------------------------
// Box liveness (docs/UPSTREAM.md #10): session liveness and box liveness are
// independent facts — `E2bBooter.resume` must not hand a confirmed-GONE
// sandboxId to `sandbox.reuse` at all, since a reconnect attempt against a
// box that no longer exists is not the transient `sandbox_reconnect_failed`
// case `resumeRoomSession`'s own retry budget is built for. `checkBoxLiveness`
// is injected here instead of reaching the real e2b API.
// ---------------------------------------------------------------------------

async function roomWithBox(store: Awaited<ReturnType<typeof RoomStore.open>>, sandboxId: string, artifactUrl: string) {
  const room = await store.create()
  return store.update(room.code, { sandboxId, artifactUrl })
}

test("E2bBooter.resume boots a fresh box with no reuse when the prior box is confirmed gone, and flags boxWasGone", async () => {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new E2bBooter(client, { baseUrl: daemon.url, token: undefined }, store, async () => "gone")

  // No live artifact server needed here: a confirmed-"gone" box short-circuits
  // straight to a fresh boot and never calls `resumeRoomSession`'s probe.
  const room = await roomWithBox(store, "old-box", "http://127.0.0.1:1")
  const result = await booter.resume(room)

  assert.equal(result.boxWasGone, true)
  assert.equal(result.sandboxId, "sandbox_fake")
  assert.notEqual(result.sandboxId, "old-box")

  const spawnRequests = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent")
  assert.equal(spawnRequests.length, 1)
  const body = spawnRequests[0]?.body
  assert.ok(isRecord(body) && isRecord(body.sandbox))
  if (!isRecord(body) || !isRecord(body.sandbox)) return
  assert.equal("reuse" in body.sandbox, false, "a confirmed-gone sandboxId must never be handed to sandbox.reuse")
})

test("E2bBooter.resume reconnects normally when the box probes alive", async () => {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new E2bBooter(client, { baseUrl: daemon.url, token: undefined }, store, async () => "alive")
  const artifact = await startArtifactServer()

  try {
    const room = await roomWithBox(store, "live-box", artifact.url)
    // The reconnect spawn's own first-turn-outcome check (`waitForFirstTurnOutcome`,
    // src/sandbox/boot.ts) waits for a `turn-end` on the fixed fake-daemon
    // session id — pre-seed it so this test resolves immediately instead of
    // riding out the real 30s timeout.
    daemon.pushRecord("sess_fake", { seq: 1, kind: "turn-end", reason: "completed" })
    const result = await booter.resume(room)

    assert.equal(result.boxWasGone, undefined)
    const spawnRequests = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent")
    assert.equal(spawnRequests.length, 1)
    const body = spawnRequests[0]?.body
    assert.ok(isRecord(body) && isRecord(body.sandbox))
    if (!isRecord(body) || !isRecord(body.sandbox)) return
    assert.equal(body.sandbox.reuse, "live-box", "a live box should be reconnected to, not replaced")
  } finally {
    await artifact.close()
  }
})

test("E2bBooter.resume reconnects normally when the box probes paused, not gone", async () => {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new E2bBooter(client, { baseUrl: daemon.url, token: undefined }, store, async () => "paused")
  const artifact = await startArtifactServer()

  try {
    const room = await roomWithBox(store, "paused-box", artifact.url)
    daemon.pushRecord("sess_fake", { seq: 1, kind: "turn-end", reason: "completed" })
    const result = await booter.resume(room)

    assert.equal(result.boxWasGone, undefined)
    const spawnRequests = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent")
    assert.equal(spawnRequests.length, 1)
    const body = spawnRequests[0]?.body
    assert.ok(isRecord(body) && isRecord(body.sandbox))
    if (!isRecord(body) || !isRecord(body.sandbox)) return
    assert.equal(body.sandbox.reuse, "paused-box")
  } finally {
    await artifact.close()
  }
})

test("E2bBooter.resume does NOT treat an unknown box-liveness result as gone — it reconnects normally instead of booting fresh", async () => {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new E2bBooter(client, { baseUrl: daemon.url, token: undefined }, store, async () => "unknown")
  const artifact = await startArtifactServer()

  try {
    const room = await roomWithBox(store, "flaky-box", artifact.url)
    daemon.pushRecord("sess_fake", { seq: 1, kind: "turn-end", reason: "completed" })
    const result = await booter.resume(room)

    assert.equal(result.boxWasGone, undefined)
    const spawnRequests = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent")
    assert.equal(spawnRequests.length, 1)
    const body = spawnRequests[0]?.body
    assert.ok(isRecord(body) && isRecord(body.sandbox))
    if (!isRecord(body) || !isRecord(body.sandbox)) return
    assert.equal(body.sandbox.reuse, "flaky-box", "unknown must fall through to the ordinary reconnect path, never be treated as gone")
  } finally {
    await artifact.close()
  }
})
