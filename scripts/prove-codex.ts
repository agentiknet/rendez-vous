/**
 * Prove or disprove architecture.md §9.3(A)'s claim that swapping the room's
 * "brain" is one parameter: `adapter: "codex"` (plus, the doc says,
 * `sandbox.config.installAdapters: ["codex"]`). Single-spawn path copied
 * from `scripts/prove-sandbox.ts`'s step 1, with the adapter/model changed
 * FIRST and nothing else — escalating only if that fails, via free `reuse`
 * reconnects on the SAME box, never a second fresh boot. See
 * docs/CODEX-FLIP.md for the write-up this run produced.
 *
 * Budget: exactly ONE fresh e2b boot for this whole script (variant A's
 * spawn). Variants B and C, if reached, reconnect to that same box.
 *
 * Run: `RDV_DAEMON_TOKEN=$(...) node scripts/prove-codex.ts`
 */

import { fileURLToPath } from "node:url"
import { DaemonClient, type SandboxSpecInput } from "../src/daemon/client.ts"
import { isRecordKind } from "../src/daemon/records.ts"
import { env } from "../src/env.ts"
import { bootRoomSession, type RoomSessionResult } from "../src/sandbox/boot.ts"

const APP_DIR = "/home/user/apps/rdv-hello"
const PORT = 3210
const BOX_CWD = "/home/user"
const APP_SOURCE_DIR = fileURLToPath(new URL("../apps/room-artifact", import.meta.url))
const CODEX_MODEL = "gpt-5.2-codex"
const PONG_PROMPT = "Reply with exactly the single word: pong"
const TITLE_PROMPT = "Change the served page title to Codex was here"
const TURN_TIMEOUT_MS = 120_000

/**
 * `SandboxSpecInput` (src/daemon/client.ts) models only the fields every
 * OTHER caller in this repo needs (`provider`, `config`, `reuse`,
 * `extraPorts`). Variant C needs `env.passthrough` too — the daemon's own
 * `sandboxFrontmatterSchema` (agentproto/ts packages/sandbox/src/schema.ts)
 * carries it as a top-level sibling of `config`. Extending the shared type
 * for one throwaway proof script would widen what every other caller has to
 * consider, so it's modelled locally instead: a structural subtype is
 * assignable wherever `SandboxSpecInput` is expected, with no cast.
 */
interface SandboxSpecWithEnvPassthrough extends SandboxSpecInput {
  readonly env?: { readonly passthrough: readonly string[] }
}

interface TurnOutcome {
  readonly reason: string
  readonly text: string
  readonly lastSeq: number
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Read `sessionId`'s transcript from `since`, accumulating `text-delta`
 *  text, until the first `turn-end` (or `timeoutMs` elapses). */
async function readUntilTurnEnd(
  client: DaemonClient,
  sessionId: string,
  since: number,
  timeoutMs: number,
): Promise<TurnOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let lastSeq = since
  let text = ""
  let reason: string | undefined
  try {
    for await (const record of client.events(sessionId, since, controller.signal)) {
      lastSeq = record.seq
      if (isRecordKind(record, "text-delta")) text += record.text
      if (isRecordKind(record, "turn-end")) {
        reason = record.reason
        break
      }
    }
  } finally {
    clearTimeout(timer)
  }
  if (reason === undefined) {
    throw new Error(`timed out after ${timeoutMs}ms waiting for turn-end on ${sessionId} (since=${since})`)
  }
  return { reason, text, lastSeq }
}

/** Send a follow-up prompt (`queue: true`, so it never races a still-busy
 *  session) and wait for its turn-end. */
async function sendAndWait(
  client: DaemonClient,
  sessionId: string,
  prompt: string,
  since: number,
  timeoutMs: number,
): Promise<TurnOutcome & { readonly latencyMs: number }> {
  const start = Date.now()
  const result = await client.prompt(sessionId, { prompt, queue: true, origin: "rdv:prove-codex" })
  if (!result.ok) throw new Error(`prompt rejected: ${result.reason} ${result.message}`)
  const outcome = await readUntilTurnEnd(client, sessionId, since, timeoutMs)
  return { ...outcome, latencyMs: Date.now() - start }
}

interface VariantResult {
  readonly label: string
  readonly sessionId: string
  readonly ok: boolean
  readonly turn: TurnOutcome
  readonly latencyMs: number
}

async function main(): Promise<void> {
  const client = new DaemonClient({ baseUrl: env.daemonUrl, token: env.daemonToken })
  const liveSessionIds: string[] = []
  let sandboxId: string | undefined
  let artifactUrl: string | undefined
  const variantResults: VariantResult[] = []
  let workingVariant: VariantResult | undefined

  try {
    // ---- Variant A: the one-parameter claim, exactly as stated ----
    console.log('=== variant A: adapter: "codex", nothing else changed ===')
    const bootStart = Date.now()
    const bootA: RoomSessionResult = await bootRoomSession(client, {
      cwd: BOX_CWD,
      label: "rdv-prove-codex-a",
      adapter: "codex",
      model: CODEX_MODEL,
      prompt: PONG_PROMPT,
      appDir: APP_DIR,
      port: PORT,
      seedFromDir: APP_SOURCE_DIR,
    })
    console.log(
      `variant A: spawned sessionId=${bootA.sessionId} sandboxId=${bootA.sandboxId ?? "?"} ` +
        `artifactUrl=${bootA.artifactUrl ?? "?"} artifactReady=${bootA.artifactReady ?? "?"}`,
    )
    liveSessionIds.push(bootA.sessionId)
    sandboxId = bootA.sandboxId
    artifactUrl = bootA.artifactUrl

    const pongA = await readUntilTurnEnd(client, bootA.sessionId, 0, TURN_TIMEOUT_MS)
    const latencyA = Date.now() - bootStart
    console.log(`variant A: first turn reason=${pongA.reason} reply=${JSON.stringify(pongA.text.trim())} latencyMs=${latencyA}`)
    const resultA: VariantResult = { label: 'A: adapter: "codex" alone', sessionId: bootA.sessionId, ok: pongA.reason === "completed", turn: pongA, latencyMs: latencyA }
    variantResults.push(resultA)

    if (resultA.ok) {
      workingVariant = resultA
    } else if (sandboxId === undefined) {
      console.log("variant A failed and returned no sandboxId — nothing to reuse, stopping within the 1-boot budget.")
    } else {
      // ---- Variant B: + sandbox.config.installAdapters (free reconnect) ----
      console.log('=== variant B: + sandbox.config.installAdapters: ["codex"] (free reconnect, same box) ===')
      const bootB = await bootRoomSession(client, {
        cwd: BOX_CWD,
        label: "rdv-prove-codex-b",
        adapter: "codex",
        model: CODEX_MODEL,
        prompt: PONG_PROMPT,
        appDir: APP_DIR,
        port: PORT,
        reuseSandboxId: sandboxId,
        seedFromDir: APP_SOURCE_DIR,
        installAdapters: ["codex"],
      })
      console.log(`variant B: spawned sessionId=${bootB.sessionId} sandboxId=${bootB.sandboxId ?? "?"}`)
      liveSessionIds.push(bootB.sessionId)
      await client.kill(bootA.sessionId)
      liveSessionIds.splice(liveSessionIds.indexOf(bootA.sessionId), 1)
      artifactUrl = bootB.artifactUrl ?? artifactUrl

      const startB = Date.now()
      const pongB = await readUntilTurnEnd(client, bootB.sessionId, 0, TURN_TIMEOUT_MS)
      const latencyB = Date.now() - startB
      console.log(`variant B: first turn reason=${pongB.reason} reply=${JSON.stringify(pongB.text.trim())} latencyMs=${latencyB}`)
      const resultB: VariantResult = {
        label: 'B: adapter: "codex" + installAdapters: ["codex"]',
        sessionId: bootB.sessionId,
        ok: pongB.reason === "completed",
        turn: pongB,
        latencyMs: latencyB,
      }
      variantResults.push(resultB)

      if (resultB.ok) {
        workingVariant = resultB
      } else {
        // ---- Variant C: + env.passthrough OPENAI_API_KEY (free reconnect) ----
        console.log('=== variant C: + env.passthrough: ["OPENAI_API_KEY"] (free reconnect, same box) ===')
        const specC: SandboxSpecWithEnvPassthrough = {
          provider: "e2b",
          config: { installAdapters: ["codex"] },
          extraPorts: [PORT],
          reuse: sandboxId,
          env: { passthrough: ["OPENAI_API_KEY"] },
        }
        const spawnedC = await client.spawnAgent({
          adapter: "codex",
          model: CODEX_MODEL,
          cwd: BOX_CWD,
          label: "rdv-prove-codex-c",
          prompt: PONG_PROMPT,
          sandbox: specC,
        })
        console.log(`variant C: spawned sessionId=${spawnedC.id} sandboxId=${spawnedC.sandboxId ?? "?"}`)
        liveSessionIds.push(spawnedC.id)
        await client.kill(bootB.sessionId)
        liveSessionIds.splice(liveSessionIds.indexOf(bootB.sessionId), 1)

        const startC = Date.now()
        const pongC = await readUntilTurnEnd(client, spawnedC.id, 0, TURN_TIMEOUT_MS)
        const latencyC = Date.now() - startC
        console.log(`variant C: first turn reason=${pongC.reason} reply=${JSON.stringify(pongC.text.trim())} latencyMs=${latencyC}`)
        const resultC: VariantResult = {
          label: 'C: adapter: "codex" + installAdapters + env.passthrough["OPENAI_API_KEY"] (--with-api-key path)',
          sessionId: spawnedC.id,
          ok: pongC.reason === "completed",
          turn: pongC,
          latencyMs: latencyC,
        }
        variantResults.push(resultC)
        if (resultC.ok) workingVariant = resultC
      }
    }

    console.log("")
    console.log("=== summary ===")
    for (const r of variantResults) {
      console.log(`${r.ok ? "PASS" : "FAIL"} ${r.label} — reason=${r.turn.reason} latencyMs=${r.latencyMs} reply=${JSON.stringify(r.turn.text.trim())}`)
    }

    if (workingVariant === undefined) {
      console.log("VERDICT: no variant produced a completed first turn. See docs/CODEX-FLIP.md for the write-up.")
      process.exitCode = 1
      return
    }

    console.log("")
    console.log(`=== working variant confirmed (${workingVariant.label}) — sending the title-change prompt ===`)
    const titleResult = await sendAndWait(client, workingVariant.sessionId, TITLE_PROMPT, workingVariant.turn.lastSeq, TURN_TIMEOUT_MS)
    console.log(`title change: reason=${titleResult.reason} latencyMs=${titleResult.latencyMs}`)

    if (titleResult.reason === "completed" && artifactUrl !== undefined) {
      const res = await fetch(artifactUrl, { signal: AbortSignal.timeout(10_000) })
      const html = await res.text()
      const titleLanded = html.includes("Codex was here")
      console.log(`artifact fetch: status=${res.status} url=${artifactUrl} title landed=${titleLanded}`)
    } else {
      console.log(`skipping artifact confirmation — turn reason=${titleResult.reason}, artifactUrl=${artifactUrl ?? "?"}`)
    }

    console.log("")
    console.log(`PASS: sandbox ${sandboxId ?? "?"} will be left paused for pre-warm.`)
  } finally {
    for (const id of liveSessionIds) {
      await client.kill(id).catch(err => console.warn(`cleanup: failed to kill session ${id}: ${errorMessage(err)}`))
    }
    console.log(`cleanup: killed ${liveSessionIds.length} live session(s) — sandbox ${sandboxId ?? "?"} should now be paused.`)
  }
}

main().catch((err: unknown) => {
  console.error(errorMessage(err))
  process.exitCode = 1
})
