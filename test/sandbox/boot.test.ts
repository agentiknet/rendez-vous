import assert from "node:assert/strict"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { DaemonClient } from "../../src/daemon/client.ts"
import { bootRoomSession, resumeRoomSession } from "../../src/sandbox/boot.ts"
import { startFakeDaemon } from "../daemon/fake-daemon.ts"
import { listeningPort } from "./support.ts"

const ROOM_ARTIFACT_APP_DIR = fileURLToPath(new URL("../../apps/room-artifact", import.meta.url))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const port = listeningPort(server)
  await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
  return port
}

test("bootRoomSession sends sandbox + appServe and returns the parsed result", async () => {
  const daemon = await startFakeDaemon({})
  try {
    const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
    const result = await bootRoomSession(client, {
      cwd: "/home/user",
      label: "rdv-room",
      adapter: "claude-code",
      model: "claude-sonnet-5",
      prompt: "hello room",
      appDir: "/home/user/apps/rdv-hello",
      port: 3210,
    })
    assert.equal(result.sandboxId, "sandbox_fake")
    assert.equal(result.artifactUrl, "https://fake-artifact.example")

    const req = daemon.requestsReceived.find(r => r.path === "/sessions/agent")
    assert.ok(req !== undefined)
    assert.ok(isRecord(req.body))
    assert.deepEqual(req.body.sandbox, { provider: "e2b", config: {}, extraPorts: [3210] })
    assert.deepEqual(req.body.appServe, { dir: "/home/user/apps/rdv-hello", port: 3210 })
  } finally {
    await daemon.close()
  }
})

test("bootRoomSession forwards reuseSandboxId as sandbox.reuse", async () => {
  const daemon = await startFakeDaemon({})
  try {
    const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
    await bootRoomSession(client, {
      cwd: "/home/user",
      label: "rdv-room",
      adapter: "claude-code",
      model: "claude-sonnet-5",
      prompt: "hello room",
      appDir: "/home/user/apps/rdv-hello",
      port: 3210,
      reuseSandboxId: "sandbox_prior",
    })
    const req = daemon.requestsReceived.find(r => r.path === "/sessions/agent")
    assert.ok(req !== undefined)
    assert.ok(isRecord(req.body))
    assert.deepEqual(req.body.sandbox, {
      provider: "e2b",
      config: {},
      extraPorts: [3210],
      reuse: "sandbox_prior",
    })
  } finally {
    await daemon.close()
  }
})

test("bootRoomSession with seedFromDir sends a single deterministic setupCommands entry, no agent turn", async () => {
  const daemon = await startFakeDaemon({})
  try {
    const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
    await bootRoomSession(client, {
      cwd: "/home/user",
      label: "rdv-room",
      adapter: "claude-code",
      model: "claude-sonnet-5",
      prompt: "hello room",
      appDir: "/home/user/apps/rdv-hello",
      port: 3210,
      seedFromDir: ROOM_ARTIFACT_APP_DIR,
    })
    const req = daemon.requestsReceived.find(r => r.path === "/sessions/agent")
    assert.ok(req !== undefined)
    assert.ok(isRecord(req.body))
    assert.ok(isRecord(req.body.sandbox))
    assert.ok(isRecord(req.body.sandbox.config))
    const setupCommands = req.body.sandbox.config.setupCommands
    assert.ok(Array.isArray(setupCommands))
    assert.equal(setupCommands.length, 1)
    assert.ok(typeof setupCommands[0] === "string" && setupCommands[0].includes("rdv-room-artifact"))
  } finally {
    await daemon.close()
  }
})

test("resumeRoomSession returns without re-serving when the artifact probes alive", async () => {
  const artifact = createServer((_req, res) => {
    res.writeHead(200)
    res.end("ok")
  })
  await new Promise<void>((resolve, reject) => {
    artifact.once("error", reject)
    artifact.listen(0, "127.0.0.1", resolve)
  })
  const artifactUrl = `http://127.0.0.1:${listeningPort(artifact)}`

  const daemon = await startFakeDaemon({})
  try {
    const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
    const result = await resumeRoomSession(client, {
      cwd: "/home/user",
      label: "rdv-room",
      adapter: "claude-code",
      model: "claude-sonnet-5",
      prompt: "hello again",
      appDir: "/home/user/apps/rdv-hello",
      port: 3210,
      sandboxId: "sandbox_prior",
      artifactUrl,
    })
    assert.equal(result.artifactUrl, artifactUrl)

    const spawnCalls = daemon.requestsReceived.filter(r => r.path === "/sessions/agent")
    assert.equal(spawnCalls.length, 1)
    const killCalls = daemon.requestsReceived.filter(r => r.path.endsWith("/kill"))
    assert.equal(killCalls.length, 0)
  } finally {
    await daemon.close()
    await new Promise<void>((resolve, reject) => artifact.close(err => (err ? reject(err) : resolve())))
  }
})

test("resumeRoomSession kills the reconnect and re-serves when the artifact probes dead", async () => {
  const deadPort = await closedPort()
  const daemon = await startFakeDaemon({})
  try {
    const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
    const result = await resumeRoomSession(client, {
      cwd: "/home/user",
      label: "rdv-room",
      adapter: "claude-code",
      model: "claude-sonnet-5",
      prompt: "hello again",
      appDir: "/home/user/apps/rdv-hello",
      port: 3210,
      sandboxId: "sandbox_prior",
      artifactUrl: `http://127.0.0.1:${deadPort}`,
    })
    assert.equal(result.artifactUrl, "https://fake-artifact.example")

    const spawnCalls = daemon.requestsReceived.filter(r => r.path === "/sessions/agent")
    assert.equal(spawnCalls.length, 2)
    const firstBody = spawnCalls[0]?.body
    const secondBody = spawnCalls[1]?.body
    assert.ok(isRecord(firstBody))
    assert.equal(firstBody.appServe, undefined)
    assert.ok(isRecord(secondBody))
    assert.notEqual(secondBody.appServe, undefined)

    const killCalls = daemon.requestsReceived.filter(r => r.path.endsWith("/kill"))
    assert.equal(killCalls.length, 1)
  } finally {
    await daemon.close()
  }
})

test("resumeRoomSession retries a transient sandbox_reconnect_failed and succeeds on the 3rd attempt", async () => {
  const artifact = createServer((_req, res) => {
    res.writeHead(200)
    res.end("ok")
  })
  await new Promise<void>((resolve, reject) => {
    artifact.once("error", reject)
    artifact.listen(0, "127.0.0.1", resolve)
  })
  const artifactUrl = `http://127.0.0.1:${listeningPort(artifact)}`

  const daemon = await startFakeDaemon({ failReconnectsForSandbox: { sandboxId: "sandbox_prior", failCount: 2 } })
  try {
    const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
    const result = await resumeRoomSession(client, {
      cwd: "/home/user",
      label: "rdv-room",
      adapter: "claude-code",
      model: "claude-sonnet-5",
      prompt: "hello again",
      appDir: "/home/user/apps/rdv-hello",
      port: 3210,
      sandboxId: "sandbox_prior",
      artifactUrl,
      attempts: 4,
      retryDelayMs: 1,
    })
    assert.equal(result.artifactUrl, artifactUrl)

    const spawnCalls = daemon.requestsReceived.filter(r => r.path === "/sessions/agent")
    assert.equal(spawnCalls.length, 3)
  } finally {
    await daemon.close()
    await new Promise<void>((resolve, reject) => artifact.close(err => (err ? reject(err) : resolve())))
  }
})

test("resumeRoomSession gives up after exhausting its reconnect attempts", async () => {
  const daemon = await startFakeDaemon({ failReconnectsForSandbox: { sandboxId: "sandbox_prior", failCount: 10 } })
  try {
    const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
    await assert.rejects(
      resumeRoomSession(client, {
        cwd: "/home/user",
        label: "rdv-room",
        adapter: "claude-code",
        model: "claude-sonnet-5",
        prompt: "hello again",
        appDir: "/home/user/apps/rdv-hello",
        port: 3210,
        sandboxId: "sandbox_prior",
        artifactUrl: "http://127.0.0.1:1",
        attempts: 3,
        retryDelayMs: 1,
      }),
      /sandbox_reconnect_failed/,
    )
    const spawnCalls = daemon.requestsReceived.filter(r => r.path === "/sessions/agent")
    assert.equal(spawnCalls.length, 3)
  } finally {
    await daemon.close()
  }
})
