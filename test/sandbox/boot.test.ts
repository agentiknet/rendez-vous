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

test("bootRoomSession forwards installAdapters into sandbox.config.installAdapters", async () => {
  const daemon = await startFakeDaemon({})
  try {
    const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
    await bootRoomSession(client, {
      cwd: "/home/user",
      label: "rdv-room",
      adapter: "codex",
      model: "gpt-5.2-codex",
      prompt: "hello room",
      appDir: "/home/user/apps/rdv-hello",
      port: 3210,
      installAdapters: ["codex"],
    })
    const req = daemon.requestsReceived.find(r => r.path === "/sessions/agent")
    assert.ok(req !== undefined)
    assert.ok(isRecord(req.body))
    assert.deepEqual(req.body.sandbox, {
      provider: "e2b",
      config: { installAdapters: ["codex"] },
      extraPorts: [3210],
    })
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

test("resumeRoomSession retries when the reconnect spawn succeeds but its first turn errors, and succeeds on the 2nd attempt", async () => {
  const artifact = createServer((_req, res) => {
    res.writeHead(200)
    res.end("ok")
  })
  await new Promise<void>((resolve, reject) => {
    artifact.once("error", reject)
    artifact.listen(0, "127.0.0.1", resolve)
  })
  const artifactUrl = `http://127.0.0.1:${listeningPort(artifact)}`

  const daemon = await startFakeDaemon({ failFirstTurnForSandbox: { sandboxId: "sandbox_prior", failCount: 1 } })
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
      turnTimeoutMs: 2_000,
    })
    assert.equal(result.artifactUrl, artifactUrl)

    // Two reconnect spawns (the first one's turn errored, the second one's
    // turn completed) plus a kill of the first, broken session before the
    // retry.
    const spawnCalls = daemon.requestsReceived.filter(r => r.path === "/sessions/agent")
    assert.equal(spawnCalls.length, 2)
    const killCalls = daemon.requestsReceived.filter(r => r.path.endsWith("/kill"))
    assert.equal(killCalls.length, 1)
  } finally {
    await daemon.close()
    await new Promise<void>((resolve, reject) => artifact.close(err => (err ? reject(err) : resolve())))
  }
})

test("resumeRoomSession gives up after exhausting attempts when every reconnect's first turn errors", async () => {
  const daemon = await startFakeDaemon({ failFirstTurnForSandbox: { sandboxId: "sandbox_prior", failCount: 10 } })
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
        attempts: 2,
        retryDelayMs: 1,
        turnTimeoutMs: 2_000,
      }),
      /first turn errored/,
    )
    const spawnCalls = daemon.requestsReceived.filter(r => r.path === "/sessions/agent")
    assert.equal(spawnCalls.length, 2)
  } finally {
    await daemon.close()
  }
})

test("resumeRoomSession cost-protects the known sandboxId once every reconnect's first turn has errored", async () => {
  const daemon = await startFakeDaemon({ failFirstTurnForSandbox: { sandboxId: "sandbox_prior", failCount: 10 } })
  const killed: string[] = []
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
        attempts: 2,
        retryDelayMs: 1,
        turnTimeoutMs: 2_000,
        killOrphanSandbox: async (sandboxId) => {
          killed.push(sandboxId)
        },
      }),
      /first turn errored/,
    )
    assert.deepEqual(killed, ["sandbox_prior"])
  } finally {
    await daemon.close()
  }
})

test("resumeRoomSession cost-protects the known sandboxId once reconnect attempts are exhausted", async () => {
  const daemon = await startFakeDaemon({ failReconnectsForSandbox: { sandboxId: "sandbox_prior", failCount: 10 } })
  const killed: string[] = []
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
        killOrphanSandbox: async (sandboxId) => {
          killed.push(sandboxId)
        },
      }),
      /sandbox_reconnect_failed/,
    )
    assert.deepEqual(killed, ["sandbox_prior"])
  } finally {
    await daemon.close()
  }
})

test("resumeRoomSession does NOT cost-protect while retries are still succeeding eventually", async () => {
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
  const killed: string[] = []
  try {
    const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
    await resumeRoomSession(client, {
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
      killOrphanSandbox: async (sandboxId) => {
        killed.push(sandboxId)
      },
    })
    assert.deepEqual(killed, [])
  } finally {
    await daemon.close()
    await new Promise<void>((resolve, reject) => artifact.close(err => (err ? reject(err) : resolve())))
  }
})

test("bootRoomSession cost-protects a known reuseSandboxId when the spawn fails outright", async () => {
  const deadPort = await closedPort()
  const killed: string[] = []
  const client = new DaemonClient({ baseUrl: `http://127.0.0.1:${deadPort}`, token: undefined })
  await assert.rejects(
    bootRoomSession(client, {
      cwd: "/home/user",
      label: "rdv-room",
      adapter: "claude-code",
      model: "claude-sonnet-5",
      prompt: "hello room",
      appDir: "/home/user/apps/rdv-hello",
      port: 3210,
      reuseSandboxId: "sandbox_prior",
      killOrphanSandbox: async (sandboxId) => {
        killed.push(sandboxId)
      },
    }),
  )
  assert.deepEqual(killed, ["sandbox_prior"])
})

test("bootRoomSession never calls the orphan killer for a genuinely fresh boot (no reuseSandboxId)", async () => {
  const deadPort = await closedPort()
  const killed: string[] = []
  const client = new DaemonClient({ baseUrl: `http://127.0.0.1:${deadPort}`, token: undefined })
  await assert.rejects(
    bootRoomSession(client, {
      cwd: "/home/user",
      label: "rdv-room",
      adapter: "claude-code",
      model: "claude-sonnet-5",
      prompt: "hello room",
      appDir: "/home/user/apps/rdv-hello",
      port: 3210,
      killOrphanSandbox: async (sandboxId) => {
        killed.push(sandboxId)
      },
    }),
  )
  assert.deepEqual(killed, [])
})
