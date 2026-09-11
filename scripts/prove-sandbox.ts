/**
 * Real-daemon proof of M4 (architecture.md §3 "Sandbox plus artifact",
 * §4.2 R8/R9): boot an e2b sandbox, serve a tiny app from inside it, probe
 * the resulting artifact URL, pause the box, resume it, and prove the URL
 * comes back alive either way (see docs/UPSTREAM.md for the R8 gap this
 * resume step exercises).
 *
 * `appServe`'s `app_install` step runs BEFORE any prompt is delivered to
 * the sandboxed agent (ground-truthed in session-spawn.ts), so a fresh box
 * has nothing at the app dir yet on the very first call. This script does
 * two spawns against the SAME box to get around that:
 *
 *   1. `client.spawnAgent` with `sandbox` and NO `appServe` — the prompt
 *      runs one exact, verbatim shell command (a heredoc) to create the
 *      smallest possible agentproto app: a UI-only APP.md
 *      (`agents: []`, `workflows: []`, a `ui` block) plus its HTML.
 *   2. `bootRoomSession` with `reuseSandboxId` set and `appServe` pointed
 *      at that now-populated dir — this is the one call that actually
 *      installs + launches + returns the artifact URL.
 *
 * Only step 1 is a genuine e2b cold boot; step 2 (and the later resume) are
 * `SandboxProvider.connect()` reconnects to the same box. Budget: at most
 * one retry of the WHOLE two-step boot if it fails (so at most two cold
 * boots total).
 *
 * Run: `RDV_DAEMON_TOKEN=$(...) node scripts/prove-sandbox.ts`
 */

import { DaemonClient } from "../src/daemon/client.ts"
import { isRecordKind } from "../src/daemon/records.ts"
import { env } from "../src/env.ts"
import { probeArtifact } from "../src/sandbox/artifact.ts"
import { bootRoomSession, resumeRoomSession } from "../src/sandbox/boot.ts"

const APP_DIR = "/home/user/apps/rdv-hello"
const PORT = 3210
const BOX_CWD = "/home/user"
const TURN_TIMEOUT_MS = 120_000

const CREATE_APP_SCRIPT = `set -e
mkdir -p ${APP_DIR}/.agentproto ${APP_DIR}/ui
cat > ${APP_DIR}/.agentproto/APP.md <<'EOF'
---
schema: app/v1
id: rdv-hello
name: RDV Hello
version: 0.1.0
agents: []
workflows: []
ui:
  path: ui/index.html
  title: RDV Hello
---

RDV Hello -- minimal artifact for the Rendez-vous M4 sandbox proof.
EOF
cat > ${APP_DIR}/ui/index.html <<'EOF'
<!doctype html>
<html>
  <body>
    <h1>Rendez-vous room artifact</h1>
    <p>Booted by scripts/prove-sandbox.ts</p>
  </body>
</html>
EOF
echo done`

const CREATE_APP_PROMPT =
  "Run exactly the following command verbatim, using whichever tool you have for running shell " +
  "commands. Do not modify it, do not explain it, do not run anything else. Once it finishes, " +
  `reply with only the word done.\n\n${CREATE_APP_SCRIPT}`

interface BootOutcome {
  readonly sessionId: string
  readonly sandboxId: string
  readonly artifactUrl: string
}

async function waitForTurnEnd(client: DaemonClient, sessionId: string): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS)
  try {
    for await (const record of client.events(sessionId, 0, controller.signal)) {
      if (isRecordKind(record, "turn-end")) return
    }
    throw new Error(`event stream for ${sessionId} ended without a turn-end`)
  } finally {
    clearTimeout(timeout)
  }
}

async function attemptBoot(client: DaemonClient): Promise<BootOutcome> {
  console.log("phase 1: booting a fresh e2b box and creating the app dir...")
  const setup = await client.spawnAgent({
    adapter: env.agentAdapter,
    model: env.agentModel,
    cwd: BOX_CWD,
    label: "rdv-prove-sandbox-setup",
    prompt: CREATE_APP_PROMPT,
    sandbox: { provider: "e2b", config: {}, extraPorts: [PORT] },
  })
  console.log(`phase 1: spawned setup session ${setup.id}, sandboxId=${setup.sandboxId ?? "?"}`)
  if (setup.sandboxId === undefined) {
    throw new Error("phase 1: spawn response carried no sandboxId")
  }
  await waitForTurnEnd(client, setup.id)
  console.log("phase 1: app dir created; killing the setup session (pauses the box)")
  await client.kill(setup.id)

  console.log("phase 2: reconnecting with appServe...")
  const served = await bootRoomSession(client, {
    cwd: BOX_CWD,
    label: "rdv-prove-sandbox",
    adapter: env.agentAdapter,
    model: env.agentModel,
    prompt: "The room's artifact is now live. Wait for further instructions.",
    appDir: APP_DIR,
    port: PORT,
    reuseSandboxId: setup.sandboxId,
  })
  if (served.sandboxId === undefined || served.artifactUrl === undefined) {
    throw new Error(`phase 2: appServe spawn returned no sandboxId/artifactUrl (${JSON.stringify(served)})`)
  }
  return { sessionId: served.sessionId, sandboxId: served.sandboxId, artifactUrl: served.artifactUrl }
}

async function main(): Promise<void> {
  const client = new DaemonClient({ baseUrl: env.daemonUrl, token: env.daemonToken })

  let boot: BootOutcome
  try {
    boot = await attemptBoot(client)
  } catch (err) {
    console.error(`first boot attempt failed: ${err instanceof Error ? err.message : String(err)}`)
    console.log("retrying once (budget: at most two e2b boots total)...")
    boot = await attemptBoot(client)
  }

  console.log(`sessionId: ${boot.sessionId}`)
  console.log(`sandboxId: ${boot.sandboxId}`)
  console.log(`artifactUrl: ${boot.artifactUrl}`)

  const freshProbe = await probeArtifact(boot.artifactUrl)
  console.log(`probe (fresh boot): ${freshProbe}`)

  console.log(`killing session ${boot.sessionId} (pauses the box)...`)
  await client.kill(boot.sessionId)

  const beforeResume = await probeArtifact(boot.artifactUrl)
  console.log(`probe (before resume, box paused): ${beforeResume}`)

  console.log("resuming...")
  const resumed = await resumeRoomSession(client, {
    cwd: BOX_CWD,
    label: "rdv-prove-sandbox-resume",
    adapter: env.agentAdapter,
    model: env.agentModel,
    prompt: "The room has resumed. Wait for further instructions.",
    appDir: APP_DIR,
    port: PORT,
    sandboxId: boot.sandboxId,
    artifactUrl: boot.artifactUrl,
  })
  console.log(
    `resumed: sessionId=${resumed.sessionId} sandboxId=${resumed.sandboxId ?? "?"} artifactUrl=${resumed.artifactUrl ?? "?"}`,
  )

  const afterResume = await probeArtifact(resumed.artifactUrl ?? boot.artifactUrl)
  console.log(`probe (after resume): ${afterResume}`)

  console.log(`killing the resumed session ${resumed.sessionId} (leaves the box paused, not destroyed)...`)
  await client.kill(resumed.sessionId)

  if (freshProbe === "alive" && afterResume === "alive") {
    console.log(`PASS: sandbox ${boot.sandboxId} left paused for pre-warm.`)
  } else {
    console.log(`FAIL: expected alive/alive, got fresh=${freshProbe} afterResume=${afterResume}.`)
    process.exitCode = 1
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
