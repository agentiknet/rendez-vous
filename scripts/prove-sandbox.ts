/**
 * Real-daemon proof of M4 (architecture.md §3 "Sandbox plus artifact",
 * §4.2 R8/R9). Encodes the exact sequence agreed after the first attempt's
 * findings (docs/UPSTREAM.md):
 *
 *   Step 0 (free — a reconnect, not a boot): try to salvage the paused box
 *     left over from the previous run. Move on either way.
 *   Step 1 (one e2b boot): phase-1 spawn (sandbox, a prompt that creates a
 *     tiny app dir via one exact shell command) — session left ALIVE. While
 *     it's still running and the box is `booted` (never paused), phase-2
 *     spawns `reuse: <sandboxId>` + `appServe` against that same live box.
 *     Proves `appServe` reuse works without ever pausing. Fetches the
 *     artifact once and prints its first bytes, then kills phase-1's
 *     session (no longer needed) and re-probes to confirm the box and
 *     artifact both survive that.
 *   Step 2 (free — reconnects only): kill phase-2's session (pauses the
 *     box), wait 20s, then `resumeRoomSession` — which now retries a
 *     transient `sandbox_reconnect_failed` internally (default 4 attempts,
 *     10s apart) before falling back to a full re-serve if the artifact is
 *     still dead after reconnecting.
 *   Step 3: leave the final box PAUSED (not destroyed) and report its
 *     sandboxId as the demo's pre-warm candidate.
 *
 * Budget: at most 3 fresh e2b boots (step 1, retried on failure by booting
 * an entirely new box each time). Reconnects to an already-booted box
 * (step 0, step 1's phase-2 reuse-with-retry, step 2) are free and are not
 * counted against that budget.
 *
 * Run: `RDV_DAEMON_TOKEN=$(...) node scripts/prove-sandbox.ts`
 */

import { DaemonClient } from "../src/daemon/client.ts"
import { isRecordKind } from "../src/daemon/records.ts"
import { env } from "../src/env.ts"
import { probeArtifact } from "../src/sandbox/artifact.ts"
import { bootRoomSession, resumeRoomSession, type RoomSessionResult } from "../src/sandbox/boot.ts"

const APP_DIR = "/home/user/apps/rdv-hello"
const PORT = 3210
const BOX_CWD = "/home/user"
const TURN_TIMEOUT_MS = 120_000
const MAX_BOOTS = 3
const PHASE2_REUSE_RETRY_ATTEMPTS = 3
const PHASE2_REUSE_RETRY_DELAY_MS = 10_000
const PAUSE_SETTLE_WAIT_MS = 20_000

// Left over, paused, from the previous run (docs/UPSTREAM.md) — a genuinely
// WORKING artifact (the UI-layout fix verified live). The URL is a pure
// function of sandboxId + port (architecture.md §3), so it's known without
// needing to ask the daemon.
const KNOWN_LEDGER_SANDBOX_ID = "iysytdsb9grusftw4u9bw"
const KNOWN_LEDGER_ARTIFACT_URL = `https://${PORT}-${KNOWN_LEDGER_SANDBOX_ID}.e2b.app`

// UI must live at `<appDir>/.agentproto/ui/` — `agentproto app serve` hardcodes
// that path and does NOT honour the APP.md frontmatter's `ui.path` field for
// locating it (only `app_install`/`loadAppHandle` do). Ground-truthed live:
// pointing `ui.path` at `ui/index.html` installs fine (app_install succeeds)
// but `app serve` then fails with "has no UI to serve (missing
// .agentproto/ui)" — see docs/UPSTREAM.md.
const CREATE_APP_SCRIPT = `set -e
mkdir -p ${APP_DIR}/.agentproto/ui
cat > ${APP_DIR}/.agentproto/APP.md <<'EOF'
---
schema: app/v1
id: rdv-hello
name: RDV Hello
version: 0.1.0
agents: []
workflows: []
ui:
  path: .agentproto/ui/index.html
  title: RDV Hello
---

RDV Hello -- minimal artifact for the Rendez-vous M4 sandbox proof.
EOF
cat > ${APP_DIR}/.agentproto/ui/index.html <<'EOF'
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isRetryableReconnectError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("sandbox_reconnect_failed")
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

/** Step 0 — free (a reconnect, not a boot). Never throws: any failure is
 *  logged and treated as "move on to step 1". */
async function step0Salvage(client: DaemonClient): Promise<void> {
  console.log("=== step 0 (free): try resuming the ledger box from the previous run ===")
  try {
    const result = await resumeRoomSession(client, {
      cwd: BOX_CWD,
      label: "rdv-step0-salvage",
      adapter: env.agentAdapter,
      model: env.agentModel,
      prompt: "Wait for further instructions.",
      appDir: APP_DIR,
      port: PORT,
      sandboxId: KNOWN_LEDGER_SANDBOX_ID,
      artifactUrl: KNOWN_LEDGER_ARTIFACT_URL,
    })
    console.log(
      `step 0: ledger box came back — sessionId=${result.sessionId} sandboxId=${result.sandboxId ?? "?"} ` +
        `artifactUrl=${result.artifactUrl ?? "?"}`,
    )
    await client.kill(result.sessionId)
    console.log("step 0: paused the salvaged box back down (not part of the main proof sequence)")
  } catch (err) {
    console.log(
      `step 0: ledger box not resumable — ${err instanceof Error ? err.message : String(err)} — moving on to a fresh boot`,
    )
  }
}

interface Step1Result extends RoomSessionResult {
  readonly sandboxId: string
  readonly artifactUrl: string
}

/** Step 1 — one e2b boot. Phase-1 session is left ALIVE; phase-2 reuses the
 *  still-booted (never paused) box. Throws on failure — the caller decides
 *  whether to retry with a fresh boot. */
async function step1FreshBootAndLiveReuse(client: DaemonClient): Promise<Step1Result> {
  console.log("=== step 1: fresh boot, then reuse+appServe on the LIVE (never paused) box ===")
  const setup = await client.spawnAgent({
    adapter: env.agentAdapter,
    model: env.agentModel,
    cwd: BOX_CWD,
    label: "rdv-step1-setup",
    prompt: CREATE_APP_PROMPT,
    sandbox: { provider: "e2b", config: {}, extraPorts: [PORT] },
  })
  console.log(`step 1: phase-1 spawned sessionId=${setup.id} sandboxId=${setup.sandboxId ?? "?"}`)
  if (setup.sandboxId === undefined) {
    throw new Error("step 1: phase-1 spawn returned no sandboxId")
  }
  await waitForTurnEnd(client, setup.id)
  console.log("step 1: phase-1 app dir created; session left ALIVE for the live-box reuse test")

  let served: Awaited<ReturnType<typeof bootRoomSession>> | undefined
  let lastErr: unknown
  for (let attempt = 1; attempt <= PHASE2_REUSE_RETRY_ATTEMPTS; attempt++) {
    console.log(`step 1: phase-2 reuse+appServe attempt ${attempt}/${PHASE2_REUSE_RETRY_ATTEMPTS} (free reconnect)...`)
    try {
      served = await bootRoomSession(client, {
        cwd: BOX_CWD,
        label: "rdv-step1-served",
        adapter: env.agentAdapter,
        model: env.agentModel,
        prompt: "The room's artifact is now live. Wait for further instructions.",
        appDir: APP_DIR,
        port: PORT,
        reuseSandboxId: setup.sandboxId,
      })
      break
    } catch (err) {
      lastErr = err
      console.log(`step 1: phase-2 attempt ${attempt} failed — ${err instanceof Error ? err.message : String(err)}`)
      if (attempt === PHASE2_REUSE_RETRY_ATTEMPTS || !isRetryableReconnectError(err)) break
      await sleep(PHASE2_REUSE_RETRY_DELAY_MS)
    }
  }
  if (served === undefined) {
    await client.kill(setup.id).catch(() => undefined)
    throw lastErr instanceof Error ? lastErr : new Error("step 1: phase-2 failed with no error captured")
  }
  if (served.sandboxId === undefined || served.artifactUrl === undefined) {
    await client.kill(setup.id).catch(() => undefined)
    throw new Error(`step 1: phase-2 returned no sandboxId/artifactUrl (${JSON.stringify(served)})`)
  }
  console.log(
    `step 1: phase-2 spawn returned — sessionId=${served.sessionId} sandboxId=${served.sandboxId} ` +
      `artifactUrl=${served.artifactUrl} artifactReady=${served.artifactReady ?? "?"}`,
  )

  const freshProbe = await probeArtifact(served.artifactUrl)
  console.log(`step 1: probe (fresh, live-box reuse) = ${freshProbe}`)

  const res = await fetch(served.artifactUrl, { signal: AbortSignal.timeout(10_000) })
  const text = await res.text()
  console.log(`step 1: fetched artifact — status=${res.status}, first 200 bytes: ${JSON.stringify(text.slice(0, 200))}`)

  if (served.artifactReady !== true || freshProbe !== "alive") {
    console.log("step 1: FAILED — the daemon reported a URL but the artifact never actually answered.")
    await client.kill(served.sessionId).catch(() => undefined)
    await client.kill(setup.id).catch(() => undefined)
    throw new Error(
      `step 1: artifact never came up (artifactReady=${served.artifactReady ?? "?"}, probe=${freshProbe}, ` +
        `fetch status=${res.status})`,
    )
  }

  console.log(`step 1: killing phase-1 session ${setup.id} (no longer needed)...`)
  await client.kill(setup.id)

  const afterPhase1Kill = await probeArtifact(served.artifactUrl)
  console.log(`step 1: probe after killing phase-1 session (box should still be booted) = ${afterPhase1Kill}`)
  if (afterPhase1Kill !== "alive") {
    await client.kill(served.sessionId).catch(() => undefined)
    throw new Error(`step 1: artifact died after killing phase-1's session (probe=${afterPhase1Kill})`)
  }

  return {
    sessionId: served.sessionId,
    sandboxId: served.sandboxId,
    artifactUrl: served.artifactUrl,
    artifactReady: true,
  }
}

/** Step 2 — free (reconnects only): pause, wait, resume with retries. */
async function step2PauseWaitResume(client: DaemonClient, prior: Step1Result): Promise<RoomSessionResult> {
  console.log("=== step 2: pause, wait 20s, resume with retries ===")
  console.log(`step 2: killing session ${prior.sessionId} (pauses the box)...`)
  await client.kill(prior.sessionId)

  const beforeResume = await probeArtifact(prior.artifactUrl)
  console.log(`step 2: probe before resume (box paused) = ${beforeResume}`)

  console.log(`step 2: waiting ${PAUSE_SETTLE_WAIT_MS}ms before resuming...`)
  await sleep(PAUSE_SETTLE_WAIT_MS)

  console.log("step 2: resuming (resumeRoomSession's built-in retry: 4 attempts, 10s apart)...")
  const resumed = await resumeRoomSession(client, {
    cwd: BOX_CWD,
    label: "rdv-step2-resume",
    adapter: env.agentAdapter,
    model: env.agentModel,
    prompt: "The room has resumed. Wait for further instructions.",
    appDir: APP_DIR,
    port: PORT,
    sandboxId: prior.sandboxId,
    artifactUrl: prior.artifactUrl,
  })
  console.log(
    `step 2: resumed — sessionId=${resumed.sessionId} sandboxId=${resumed.sandboxId ?? "?"} artifactUrl=${resumed.artifactUrl ?? "?"}`,
  )

  const afterResume = await probeArtifact(resumed.artifactUrl ?? prior.artifactUrl)
  console.log(`step 2: probe after resume (possibly re-served) = ${afterResume}`)

  return resumed
}

async function main(): Promise<void> {
  const client = new DaemonClient({ baseUrl: env.daemonUrl, token: env.daemonToken })

  await step0Salvage(client)

  let step1: Step1Result | undefined
  let bootsUsed = 0
  while (step1 === undefined && bootsUsed < MAX_BOOTS) {
    bootsUsed += 1
    try {
      step1 = await step1FreshBootAndLiveReuse(client)
    } catch (err) {
      console.error(`step 1, boot ${bootsUsed}/${MAX_BOOTS} failed: ${err instanceof Error ? err.message : String(err)}`)
      if (bootsUsed >= MAX_BOOTS) {
        console.error("FAIL: exhausted the e2b boot budget without a working artifact URL.")
        process.exitCode = 1
        return
      }
      console.log("retrying step 1 with a fresh boot...")
    }
  }
  if (step1 === undefined) return // unreachable, satisfies the type checker
  console.log(`boots used: ${bootsUsed}/${MAX_BOOTS}`)

  const step2 = await step2PauseWaitResume(client, step1)

  console.log(`killing the final session ${step2.sessionId} (leaves the box paused, not destroyed)...`)
  await client.kill(step2.sessionId)

  console.log(`PASS: sandbox ${step1.sandboxId} left paused for pre-warm.`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
