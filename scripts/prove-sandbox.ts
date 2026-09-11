/**
 * Real-daemon proof of M4 (architecture.md §3 "Sandbox plus artifact",
 * §4.2 R8/R9; docs/ARTIFACT.md "Artifact strategy"). The app is installed
 * as part of DETERMINISTIC box setup (`sandbox.config.setupCommands`,
 * `src/sandbox/app-seed.ts`) — no agent turn creates it. Every spawn in
 * this script is a single `POST /sessions/agent` call.
 *
 *   Step 0 (free — a reconnect, not a boot): try to salvage the paused,
 *     working box left over from the last run. Move on either way.
 *   Step 1 (one e2b boot): a single spawn — `sandbox` (seeded via
 *     `setupCommands`) + `appServe`, no reuse. Verify alive, fetch the
 *     first bytes. WITHOUT killing that session, spawn again with
 *     `reuse: <sandboxId>` + `appServe` to prove reuse works against a
 *     LIVE (never-paused) box. Then kill the first session and confirm the
 *     box and artifact both survive that.
 *   Step 2 (free — reconnects only): kill the session, wait 20s, then
 *     `resumeRoomSession` (retries a transient `sandbox_reconnect_failed`
 *     internally, default 4 attempts / 10s apart).
 *   Step 3: leave the final box PAUSED (not destroyed) and report its
 *     sandboxId as the demo's pre-warm candidate.
 *
 * Budget: at most 3 fresh e2b boots (step 1, retried on failure by booting
 * an entirely new box each time). Reconnects (step 0, step 1's live reuse,
 * step 2) are free and are not counted against that budget.
 *
 * Run: `RDV_DAEMON_TOKEN=$(...) node scripts/prove-sandbox.ts`
 */

import { fileURLToPath } from "node:url"
import { DaemonClient } from "../src/daemon/client.ts"
import { env } from "../src/env.ts"
import { probeArtifact } from "../src/sandbox/artifact.ts"
import { bootRoomSession, resumeRoomSession, type RoomSessionResult } from "../src/sandbox/boot.ts"

const APP_DIR = "/home/user/apps/rdv-hello"
const PORT = 3210
const BOX_CWD = "/home/user"
const MAX_BOOTS = 3
const PAUSE_SETTLE_WAIT_MS = 20_000
const APP_SOURCE_DIR = fileURLToPath(new URL("../apps/room-artifact", import.meta.url))

// Left over, paused, from the previous run (docs/UPSTREAM.md) — a genuinely
// WORKING artifact (the UI-layout fix verified live). The URL is a pure
// function of sandboxId + port (architecture.md §3), so it's known without
// needing to ask the daemon.
const KNOWN_LEDGER_SANDBOX_ID = "iysytdsb9grusftw4u9bw"
const KNOWN_LEDGER_ARTIFACT_URL = `https://${PORT}-${KNOWN_LEDGER_SANDBOX_ID}.e2b.app`

interface Step1Result extends RoomSessionResult {
  readonly sandboxId: string
  readonly artifactUrl: string
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
      seedFromDir: APP_SOURCE_DIR,
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

async function fetchFirstBytes(url: string): Promise<{ status: number; first200: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  const text = await res.text()
  return { status: res.status, first200: text.slice(0, 200) }
}

/** Step 1 — one e2b boot, entirely deterministic (no agent turn creates
 *  the app). Also proves reuse+appServe against a box that's still LIVE
 *  (never paused). Throws on failure — the caller decides whether to retry
 *  with a fresh boot. */
async function step1BootAndLiveReuse(client: DaemonClient): Promise<Step1Result> {
  console.log("=== step 1: single deterministic spawn (sandbox+setupCommands+appServe), then reuse on the LIVE box ===")
  const first = await bootRoomSession(client, {
    cwd: BOX_CWD,
    label: "rdv-step1-first",
    adapter: env.agentAdapter,
    model: env.agentModel,
    prompt: "The room's artifact is now live. Wait for further instructions.",
    appDir: APP_DIR,
    port: PORT,
    seedFromDir: APP_SOURCE_DIR,
  })
  console.log(
    `step 1: first spawn — sessionId=${first.sessionId} sandboxId=${first.sandboxId ?? "?"} ` +
      `artifactUrl=${first.artifactUrl ?? "?"} artifactReady=${first.artifactReady ?? "?"}`,
  )
  if (first.sandboxId === undefined || first.artifactUrl === undefined) {
    throw new Error(`step 1: first spawn returned no sandboxId/artifactUrl (${JSON.stringify(first)})`)
  }

  const firstProbe = await probeArtifact(first.artifactUrl)
  const { status, first200 } = await fetchFirstBytes(first.artifactUrl)
  console.log(`step 1: probe (fresh boot) = ${firstProbe}; fetch status=${status}, first 200 bytes: ${JSON.stringify(first200)}`)
  if (first.artifactReady !== true || firstProbe !== "alive") {
    await client.kill(first.sessionId).catch(() => undefined)
    throw new Error(`step 1: artifact never came up (artifactReady=${first.artifactReady ?? "?"}, probe=${firstProbe})`)
  }

  console.log("step 1: reusing on the LIVE (never-paused) box, first session left alive...")
  const second = await bootRoomSession(client, {
    cwd: BOX_CWD,
    label: "rdv-step1-live-reuse",
    adapter: env.agentAdapter,
    model: env.agentModel,
    prompt: "The room's artifact is still live. Wait for further instructions.",
    appDir: APP_DIR,
    port: PORT,
    reuseSandboxId: first.sandboxId,
    seedFromDir: APP_SOURCE_DIR,
  })
  console.log(
    `step 1: live-reuse spawn — sessionId=${second.sessionId} sandboxId=${second.sandboxId ?? "?"} ` +
      `artifactUrl=${second.artifactUrl ?? "?"} artifactReady=${second.artifactReady ?? "?"}`,
  )
  if (second.sandboxId === undefined || second.artifactUrl === undefined || second.artifactReady !== true) {
    await client.kill(second.sessionId).catch(() => undefined)
    await client.kill(first.sessionId).catch(() => undefined)
    throw new Error(`step 1: reuse-on-live-box spawn did not come up (${JSON.stringify(second)})`)
  }

  console.log(`step 1: killing the first session ${first.sessionId} (no longer needed)...`)
  await client.kill(first.sessionId)

  const afterFirstKill = await probeArtifact(second.artifactUrl)
  console.log(`step 1: probe after killing the first session (box should still be booted) = ${afterFirstKill}`)
  if (afterFirstKill !== "alive") {
    await client.kill(second.sessionId).catch(() => undefined)
    throw new Error(`step 1: artifact died after killing the first session (probe=${afterFirstKill})`)
  }

  return {
    sessionId: second.sessionId,
    sandboxId: second.sandboxId,
    artifactUrl: second.artifactUrl,
    artifactReady: true,
  }
}

/** Step 2 — free (reconnects only): pause, wait 20s, resume with retries. */
async function step2PauseWaitResume(client: DaemonClient, prior: Step1Result): Promise<RoomSessionResult> {
  console.log("=== step 2: pause, wait 20s, resume with retries ===")
  console.log(`step 2: killing session ${prior.sessionId} (pauses the box)...`)
  await client.kill(prior.sessionId)

  const beforeResume = await probeArtifact(prior.artifactUrl)
  console.log(`step 2: probe before resume (box paused) = ${beforeResume}`)

  console.log(`step 2: waiting ${PAUSE_SETTLE_WAIT_MS}ms before resuming...`)
  await new Promise(resolve => setTimeout(resolve, PAUSE_SETTLE_WAIT_MS))

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
    seedFromDir: APP_SOURCE_DIR,
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
      step1 = await step1BootAndLiveReuse(client)
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
