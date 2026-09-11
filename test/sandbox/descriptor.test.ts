/**
 * `DaemonClient.spawnAgent`'s descriptor guards, exercised against a REAL
 * descriptor captured from a live daemon (`GET /sessions/sess_251a34c1`
 * after a real e2b boot in scripts/prove-sandbox.ts — see the M4 report for
 * the full run). No tokens in it: the only credential-shaped field the
 * daemon returns is `auth.fingerprint`, and the daemon itself already masks
 * that to `"subscription · sk-ant-oat…UwAA"` before it ever reaches a
 * client. Trimmed of the (huge, irrelevant) `availableCommands` array; every
 * other field is verbatim.
 *
 * This descriptor came from a sandbox spawn WITHOUT `appServe` (the
 * file-creation phase, see docs — the two appServe attempts in that run
 * both hit real e2b infrastructure failures before producing a served
 * descriptor), so it proves the `sandboxId` guard against real data;
 * `appServe`'s guard is proven against the exact `SessionAppServeInfo`
 * shape (`sandbox-app-serve.ts`) via the fake daemon in
 * test/sandbox/boot.test.ts and test/daemon/client.test.ts.
 */

import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { test } from "node:test"
import { DaemonClient } from "../../src/daemon/client.ts"
import { listeningPort } from "./support.ts"

const REAL_KILLED_SANDBOX_DESCRIPTOR = {
  id: "sess_251a34c1",
  kind: "agent-cli",
  workspaceSlug: "default",
  command: "sandbox:e2b → claude-code",
  pid: null,
  status: "killed",
  startedAt: "2026-09-11T21:44:39.192Z",
  cwd: "/home/user",
  adapterSlug: "claude-code",
  resumable: true,
  nativeTerminalResume: true,
  harness: "claude-code",
  routeSelection: "free",
  adapterProvider: "anthropic",
  adapterSessionId: "sess_61ec57ae",
  label: "rdv-prove-sandbox-setup",
  title: "rdv-prove-sandbox-setup",
  renamedByUser: false,
  depth: 0,
  model: "claude-sonnet-5",
  auth: {
    mode: "subscription",
    fingerprint: "subscription · sk-ant-oat…UwAA",
    provider: "anthropic",
    credentialSource: "explicit-config",
    setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
  },
  accessProfile: {
    profileRef: "claude-subs-agentik",
    label: "Claude Subs Agentik",
    endpoint: "anthropic",
    method: "oauth-bearer",
  },
  remote: true,
  sandboxId: "ibnw6yj9w3ejc99bb49of",
  sandboxTeardown: "pause",
  sandboxPorts: { "3210": "https://3210-ibnw6yj9w3ejc99bb49of.e2b.app" },
  toolCallsThisTurn: 1,
  currentPhase: "killed",
  watchers: 0,
  watcherDetails: [],
  childrenBusy: 0,
  queuedPrompts: 0,
  lastOutputAt: "2026-09-11T21:44:50.223Z",
  busy: false,
  awaitingInput: false,
  agentsMdMode: "absent",
  contextSize: 1000000,
  contextUsed: 37123,
  costUsd: 0.2460036,
  turnsCompleted: 1,
  usageSource: "adapter",
  lastTurnReason: "completed",
  activitySummary: { text: "done", state: "au travail", at: "2026-09-11T21:44:50.224Z" },
  killedMidTurn: false,
  endedAt: "2026-09-11T21:44:50.277Z",
}

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const port = listeningPort(server)
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
  }
}

test("spawnAgent parses sandboxId out of a real captured descriptor", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(201, { "content-type": "application/json" })
      res.end(JSON.stringify(REAL_KILLED_SANDBOX_DESCRIPTOR))
    },
    async baseUrl => {
      const client = new DaemonClient({ baseUrl, token: undefined })
      const spawned = await client.spawnAgent({
        adapter: "claude-code",
        model: "claude-sonnet-5",
        cwd: "/home/user",
        label: "rdv-prove-sandbox-setup",
        sandbox: { provider: "e2b", config: {}, extraPorts: [3210] },
      })
      assert.equal(spawned.id, "sess_251a34c1")
      assert.equal(spawned.status, "killed")
      assert.equal(spawned.sandboxId, "ibnw6yj9w3ejc99bb49of")
      // This particular real descriptor came from a spawn with no
      // `appServe` — the field is absent on the wire, so the client must
      // report it as undefined rather than fabricate a value.
      assert.equal(spawned.appServe, undefined)
    },
  )
})

test("the real descriptor's sandboxPorts URL format matches what probeArtifact expects", () => {
  const url = REAL_KILLED_SANDBOX_DESCRIPTOR.sandboxPorts["3210"]
  assert.match(url, /^https:\/\/3210-ibnw6yj9w3ejc99bb49of\.e2b\.app$/)
})
