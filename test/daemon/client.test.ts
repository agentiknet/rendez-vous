import assert from "node:assert/strict"
import { test } from "node:test"
import { DaemonClient } from "../../src/daemon/client.ts"
import { startFakeDaemon, type FakeDaemon } from "./fake-daemon.ts"

async function withFakeDaemon(
  opts: Parameters<typeof startFakeDaemon>[0],
  run: (daemon: FakeDaemon, client: DaemonClient) => Promise<void>,
): Promise<void> {
  const daemon = await startFakeDaemon(opts)
  try {
    const client = new DaemonClient({ baseUrl: daemon.url, token: opts?.requireAuth })
    await run(daemon, client)
  } finally {
    await daemon.close()
  }
}

test("health() reads status, version and build sha", async () => {
  await withFakeDaemon({}, async (_daemon, client) => {
    const health = await client.health()
    assert.deepEqual(health, { status: "ok", version: "9.9.9", buildSha: "deadbeef" })
  })
})

test("spawnAgent() returns id and status", async () => {
  await withFakeDaemon({}, async (_daemon, client) => {
    const spawned = await client.spawnAgent({
      adapter: "claude-code",
      model: "claude-sonnet-5",
      cwd: "/tmp",
      label: "test",
    })
    assert.deepEqual(spawned, { id: "sess_fake", status: "running" })
  })
})

test("prompt() dispatched immediately on an idle session returns queued:false", async () => {
  await withFakeDaemon({}, async (_daemon, client) => {
    const result = await client.prompt("sess_idle", { prompt: "hello", queue: true, origin: "user" })
    assert.deepEqual(result, { ok: true, queued: false })
  })
})

test("prompt() always calls the fire-and-forget route with queue on the wire", async () => {
  await withFakeDaemon({}, async (daemon, client) => {
    await client.prompt("sess_wire", { prompt: "hello", queue: true, origin: "rdv:alice" })
    const req = daemon.requestsReceived.find(r => r.path === "/sessions/sess_wire/prompt")
    assert.ok(req !== undefined)
    assert.deepEqual(req.body, { prompt: "hello", queue: true, origin: "rdv:alice" })
  })
})

test("two prompts sent while busy both land as queued, in order", async () => {
  await withFakeDaemon({}, async (_daemon, client) => {
    // First prompt dispatches immediately and makes the fake session busy.
    const first = await client.prompt("sess_busy", { prompt: "start", queue: true, origin: "user" })
    assert.deepEqual(first, { ok: true, queued: false })

    const second = await client.prompt("sess_busy", { prompt: "from alice", queue: true, origin: "rdv:alice" })
    assert.ok(second.ok)
    assert.ok(second.queued)
    assert.equal(second.queuePosition, 1)

    const third = await client.prompt("sess_busy", { prompt: "from bob", queue: true, origin: "rdv:bob" })
    assert.ok(third.ok)
    assert.ok(third.queued)
    assert.equal(third.queuePosition, 2)
  })
})

test("prompt() without queue:true while busy returns ok:false reason:mid-turn", async () => {
  await withFakeDaemon({}, async (_daemon, client) => {
    await client.prompt("sess_no_queue", { prompt: "start", queue: true, origin: "user" })
    const result = await client.prompt("sess_no_queue", { prompt: "not queued", queue: false, origin: "user" })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.reason, "mid-turn")
      assert.equal(result.status, 409)
      assert.match(result.message, /mid-turn/)
    }
  })
})

test("prompt() against an unknown session returns ok:false reason:not-found", async () => {
  await withFakeDaemon({}, async (_daemon, client) => {
    const result = await client.prompt("sess_missing", { prompt: "hi", queue: true, origin: "user" })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, "not-found")
  })
})

test("prompt() against a dead session returns ok:false reason:not-alive", async () => {
  await withFakeDaemon({}, async (_daemon, client) => {
    const result = await client.prompt("sess_dead", { prompt: "hi", queue: true, origin: "user" })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, "not-alive")
  })
})

test("prompt() without a valid bearer returns ok:false reason:unauthorized", async () => {
  const daemon = await startFakeDaemon({ requireAuth: "secret-token" })
  try {
    const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
    const result = await client.prompt("sess_any", { prompt: "hi", queue: true, origin: "user" })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, "unauthorized")
  } finally {
    await daemon.close()
  }
})

test("prompt() sends the bearer when a token is configured", async () => {
  const daemon = await startFakeDaemon({ requireAuth: "secret-token" })
  try {
    const client = new DaemonClient({ baseUrl: daemon.url, token: "secret-token" })
    const result = await client.prompt("sess_any", { prompt: "hi", queue: true, origin: "user" })
    assert.equal(result.ok, true)
  } finally {
    await daemon.close()
  }
})

test("kill() resolves on a 200 response", async () => {
  await withFakeDaemon({}, async (_daemon, client) => {
    await assert.doesNotReject(client.kill("sess_anything"))
  })
})
