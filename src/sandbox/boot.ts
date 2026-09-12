/**
 * Sandbox boot and resume (M4, architecture.md §3 "Sandbox plus artifact",
 * §4.2 R8/R9; docs/ARTIFACT.md "Artifact strategy"). e2b only — R9: `box`
 * exposes no port, so no artifact URL is possible on that provider.
 *
 * `bootRoomSession` is a single spawn: `sandbox` + `appServe` together, with
 * the app directory seeded DETERMINISTICALLY via `sandbox.config
 * .setupCommands` (`src/sandbox/app-seed.ts`) rather than by an agent turn.
 * `setupCommands` run before the box's daemon starts and before
 * `app_install`/`appServe` ever runs (ground-truthed in `provider.ts`'s
 * `ensureDaemonHealthy`), on every boot AND every reconnect — so passing
 * `seedFromDir` makes every call in this module self-sufficient: no
 * "populate it first in a separate spawn" step, no LLM in the loop. See
 * docs/ARTIFACT.md for the full ranking against the alternatives, and
 * docs/UPSTREAM.md for the two-spawn approach this replaced.
 */

import type { DaemonClient, SandboxSpecInput, SpawnAgentInput, SpawnAgentResult } from "../daemon/client.ts"
import { isRecordKind } from "../daemon/records.ts"
import { buildAppSeedScript } from "./app-seed.ts"
import { probeArtifact } from "./artifact.ts"

const SANDBOX_PROVIDER = "e2b"
/**
 * Ground-truthed live (docs/UPSTREAM.md #7): the original 4×10s budget
 * (40s worst case) was NOT enough for a just-unpaused box's first turn to
 * stop erroring — a real `RDV_BOOTER=e2b node scripts/simulate-room.ts` run
 * exhausted all 4 attempts and only succeeded on a manual reconnect several
 * minutes later. Widened to give real settle time more room; still an
 * estimate, not a measured bound — the exact settle time this box class
 * needs after a pause is undocumented upstream and worth a dedicated timed
 * repro if this ever needs tightening back down.
 */
const DEFAULT_RESUME_ATTEMPTS = 6
const DEFAULT_RESUME_RETRY_DELAY_MS = 15_000
const DEFAULT_TURN_OUTCOME_TIMEOUT_MS = 30_000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Best-effort cleanup for a KNOWN, already-existing sandboxId (a `reuse`
 *  target) when the spawn that was supposed to reconnect to it fails. Never
 *  throws — a cost-protection best-effort must never mask the real spawn
 *  error it's reacting to. */
export type OrphanSandboxKiller = (sandboxId: string) => Promise<void>

const E2B_API_BASE = "https://api.e2b.dev"

/**
 * Last-resort cost protection (docs/UPSTREAM.md #3): a sandboxed reconnect
 * that fails during the box's MCP-transport connect step is NOT paused by
 * the daemon the way its sibling failure paths are — the box can be left
 * running with no daemon-side session tracking it. The daemon exposes no
 * HTTP route to act on a bare sandboxId with no live session (`POST
 * /sessions/:id/kill` needs a session id we don't have here), so this calls
 * e2b's own API directly. `E2B_API_KEY` is e2b's own credential, not one of
 * this service's `RDV_*` knobs (src/env.ts) — read once, here only, never
 * elsewhere, mirroring the "typed env module" discipline for a var that
 * belongs to a different (third-party) namespace than the rest of `env.ts`.
 */
async function killE2bSandboxDirect(sandboxId: string): Promise<void> {
  const apiKey = process.env.E2B_API_KEY
  if (apiKey === undefined || apiKey.trim().length === 0) {
    console.warn(
      `sandbox ${sandboxId}: spawn failed against a known reuse target and E2B_API_KEY is unset — ` +
        "cannot cost-protect it directly. Check `agentproto sandbox list` by hand.",
    )
    return
  }
  try {
    const res = await fetch(`${E2B_API_BASE}/sandboxes/${sandboxId}`, {
      method: "DELETE",
      headers: { "X-API-Key": apiKey },
    })
    if (!res.ok && res.status !== 404) {
      console.warn(`sandbox ${sandboxId}: e2b DELETE returned ${res.status} — may still be running.`)
    }
  } catch (err) {
    console.warn(
      `sandbox ${sandboxId}: best-effort e2b cleanup failed — ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** Run `fn`; on failure, best-effort kill `sandboxId` (a box we already knew
 *  about BEFORE this call, e.g. a `reuse` target) before rethrowing the
 *  original error unchanged. No-op passthrough when `sandboxId` is
 *  undefined — nothing to protect for a genuinely fresh boot. */
async function protectKnownSandboxOnFailure<T>(
  sandboxId: string | undefined,
  killOrphanSandbox: OrphanSandboxKiller,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (sandboxId !== undefined) await killOrphanSandbox(sandboxId)
    throw err
  }
}

/**
 * `sandbox_reconnect_failed` covers more than one failure inside
 * `createSandboxAgentSessionHost`: `provider.connect()`'s own
 * `ensureDaemonHealthy` (box's plain `/health`, ~3s probe — ground-truthed
 * in `provider.ts`), AND a separate MCP-transport connect attempt right
 * after (`connectDaemonAgentSessionHost`, `@agentproto/worktree`) that has
 * no readiness wait of its own. A box whose `/health` answers within 3s but
 * whose MCP layer isn't warmed up yet hits exactly this: `ensureDaemonHealthy`
 * returns, `provider.connect()` succeeds, and the MCP connect a moment later
 * fails — transient, ground-truthed against a real box (docs/UPSTREAM.md).
 * `DaemonClient.spawnAgent` throws on any non-2xx; this only retries when
 * the thrown message names this specific code, not any other spawn failure. */
function isRetryableReconnectError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("sandbox_reconnect_failed")
}

/**
 * A DIFFERENT shape of the same underlying race (docs/UPSTREAM.md #7),
 * ground-truthed live: the reconnect spawn itself can succeed (a real `201`,
 * the box's own `agent_start` returns a session) while the very first turn
 * riding along with it (the resume prompt) errors near-instantly — the
 * box's own agent-cli/network stack needing a beat after coming off pause,
 * even though the daemon's MCP connect already reported healthy. Reads the
 * session's own transcript for the first `turn-end` to find out; a timeout
 * (nothing arrives at all) counts as "error" too, since there is nothing to
 * trust either way. */
async function waitForFirstTurnOutcome(
  client: DaemonClient,
  sessionId: string,
  timeoutMs: number,
): Promise<"completed" | "error"> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    for await (const record of client.events(sessionId, 0, controller.signal)) {
      if (isRecordKind(record, "turn-end")) return record.reason === "completed" ? "completed" : "error"
    }
    return "error"
  } catch {
    return "error"
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Reconnect, then confirm the resume prompt's own first turn actually
 * completed — a successful spawn is not enough (see
 * `waitForFirstTurnOutcome`'s doc). Either failure mode (the spawn itself
 * rejected with a retryable `sandbox_reconnect_failed`, or the spawn
 * succeeded but the first turn errored) shares the same retry budget: drop
 * whatever session resulted and try again after `retryDelayMs`.
 */
async function spawnWithReconnectRetry(
  client: DaemonClient,
  input: SpawnAgentInput,
  attempts: number,
  retryDelayMs: number,
  turnTimeoutMs: number,
): Promise<SpawnAgentResult> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let spawned: SpawnAgentResult
    try {
      spawned = await client.spawnAgent(input)
    } catch (err) {
      if (attempt === attempts || !isRetryableReconnectError(err)) throw err
      await sleep(retryDelayMs)
      continue
    }

    const outcome = await waitForFirstTurnOutcome(client, spawned.id, turnTimeoutMs)
    if (outcome === "completed") return spawned

    await client.kill(spawned.id).catch(() => undefined)
    if (attempt === attempts) {
      throw new Error(
        `sandbox_reconnect_failed: reconnected to the sandbox but its first turn errored on all ` +
          `${attempts} attempt(s) (last session ${spawned.id})`,
      )
    }
    await sleep(retryDelayMs)
  }
  // Unreachable: the loop above always either returns or throws before
  // falling off the end (attempts >= 1 is the caller's responsibility).
  throw new Error("spawnWithReconnectRetry: attempts must be >= 1")
}

/** Build the `sandbox` spec, seeding `appDir` deterministically via
 *  `setupCommands` when `seedFromDir` is given. Included on every call this
 *  module makes (boot, live reuse, or a bare resume reconnect) — harmless
 *  when omitted, and idempotent (a plain overwrite) when present, per
 *  `setupCommands`'s own "runs on every boot/connect" contract. */
function buildSandboxSpec(opts: {
  readonly port: number
  readonly appDir: string
  readonly seedFromDir: string | undefined
  readonly reuse: string | undefined
  /** `sandbox.config.installAdapters` — harness slugs to pre-install in the
   *  box beyond the spawned `adapter` (which the daemon already auto-injects
   *  for a sandboxed spawn). See docs/CODEX-FLIP.md. */
  readonly installAdapters: readonly string[] | undefined
}): SandboxSpecInput {
  return {
    provider: SANDBOX_PROVIDER,
    config: {
      ...(opts.seedFromDir !== undefined ? { setupCommands: [buildAppSeedScript(opts.seedFromDir, opts.appDir)] } : {}),
      ...(opts.installAdapters !== undefined ? { installAdapters: [...opts.installAdapters] } : {}),
    },
    extraPorts: [opts.port],
    ...(opts.reuse !== undefined ? { reuse: opts.reuse } : {}),
  }
}

export interface RoomSessionResult {
  readonly sessionId: string
  readonly sandboxId: string | undefined
  readonly artifactUrl: string | undefined
  /** Whether the daemon's own readiness probe (`pollServeReady`,
   *  `sandbox-app-serve.ts`, up to 15s) confirmed the URL was answering
   *  before this call returned. `false` means the URL is the right address
   *  but the server hadn't answered in that window — ground-truthed against
   *  a real box (docs/UPSTREAM.md): a caller that only checks for a
   *  non-undefined `artifactUrl` can be fooled by a URL that never actually
   *  serves anything. Undefined when this result didn't come from a fresh
   *  `appServe` call (e.g. `resumeRoomSession`'s no-reserve-needed path —
   *  it already confirmed liveness itself via `probeArtifact`). */
  readonly artifactReady: boolean | undefined
}

export interface BootRoomSessionOpts {
  readonly cwd: string
  readonly label: string
  readonly adapter: string
  readonly model: string
  readonly prompt: string
  readonly appDir: string
  readonly port: number
  readonly reuseSandboxId?: string
  /** Local (this host's) absolute path to an agentproto app source dir
   *  (e.g. `apps/room-artifact`) to seed into `appDir` deterministically
   *  before `appServe` installs it. Omit only when `appDir` is already
   *  populated some other way. */
  readonly seedFromDir?: string
  /** `sandbox.config.installAdapters` passthrough — harness slugs to
   *  pre-install in the box beyond the spawned `adapter`. Omit for the
   *  common single-adapter case; the daemon already auto-injects the spawned
   *  adapter's own package for a sandboxed spawn. */
  readonly installAdapters?: readonly string[]
  /** Injectable for tests; defaults to the real e2b API call. See
   *  `killE2bSandboxDirect`'s doc. */
  readonly killOrphanSandbox?: OrphanSandboxKiller
}

export async function bootRoomSession(client: DaemonClient, opts: BootRoomSessionOpts): Promise<RoomSessionResult> {
  const spawned = await protectKnownSandboxOnFailure(
    opts.reuseSandboxId,
    opts.killOrphanSandbox ?? killE2bSandboxDirect,
    () =>
      client.spawnAgent({
        adapter: opts.adapter,
        model: opts.model,
        cwd: opts.cwd,
        label: opts.label,
        prompt: opts.prompt,
        sandbox: buildSandboxSpec({
          port: opts.port,
          appDir: opts.appDir,
          seedFromDir: opts.seedFromDir,
          reuse: opts.reuseSandboxId,
          installAdapters: opts.installAdapters,
        }),
        appServe: { dir: opts.appDir, port: opts.port },
      }),
  )
  return {
    sessionId: spawned.id,
    sandboxId: spawned.sandboxId,
    artifactUrl: spawned.appServe?.url,
    artifactReady: spawned.appServe?.ready,
  }
}

export interface ResumeRoomSessionOpts {
  readonly cwd: string
  readonly label: string
  readonly adapter: string
  readonly model: string
  readonly prompt: string
  readonly appDir: string
  readonly port: number
  readonly sandboxId: string
  /** The artifact URL recorded at the last boot — stable across a pause
   *  (architecture.md §3: "the URL is a pure function of sandbox id and
   *  port"), so resume probes this exact string rather than re-deriving it. */
  readonly artifactUrl: string
  /** Reconnect attempts before giving up — on a persistently retryable
   *  `sandbox_reconnect_failed`, or on a reconnect whose first turn keeps
   *  erroring (see `waitForFirstTurnOutcome`'s doc). Default 6. */
  readonly attempts?: number
  /** Delay between reconnect attempts. Default 15s — long enough for the
   *  box's MCP layer to catch up to its already-healthy `/health` endpoint
   *  (see `isRetryableReconnectError`'s doc comment), or for its agent-cli/
   *  network stack to settle after coming off pause (see
   *  `DEFAULT_RESUME_RETRY_DELAY_MS`'s doc). */
  readonly retryDelayMs?: number
  /** How long to wait for the reconnected session's first (resume-prompt)
   *  turn to end before treating it as failed. Default 30s. See
   *  `waitForFirstTurnOutcome`'s doc — a successful spawn is not enough. */
  readonly turnTimeoutMs?: number
  /** Same as `BootRoomSessionOpts.seedFromDir` — included on the bare
   *  reconnect too (harmless: `setupCommands` re-runs idempotently on every
   *  connect) and forwarded to the re-serve fallback below. */
  readonly seedFromDir?: string
  /** Same as `BootRoomSessionOpts.installAdapters` — included on the bare
   *  reconnect too and forwarded to the re-serve fallback below. */
  readonly installAdapters?: readonly string[]
  /** Injectable for tests; defaults to the real e2b API call. Also forwarded
   *  to the re-serve fallback's `bootRoomSession` call below. */
  readonly killOrphanSandbox?: OrphanSandboxKiller
}

/**
 * R8: reconnecting to a paused box (`SandboxProvider.connect`) does NOT
 * relaunch `agentproto app serve` — nothing but a fresh `appServe` bootstrap
 * does that. So: reconnect first (cheap — no install, no relaunch), probe
 * the known artifact URL, and only pay for a full re-install + relaunch when
 * that probe comes back dead.
 */
export async function resumeRoomSession(client: DaemonClient, opts: ResumeRoomSessionOpts): Promise<RoomSessionResult> {
  const killOrphanSandbox = opts.killOrphanSandbox ?? killE2bSandboxDirect
  const reconnected = await protectKnownSandboxOnFailure(opts.sandboxId, killOrphanSandbox, () =>
    spawnWithReconnectRetry(
      client,
      {
        adapter: opts.adapter,
        model: opts.model,
        cwd: opts.cwd,
        label: opts.label,
        prompt: opts.prompt,
        sandbox: buildSandboxSpec({
          port: opts.port,
          appDir: opts.appDir,
          seedFromDir: opts.seedFromDir,
          reuse: opts.sandboxId,
          installAdapters: opts.installAdapters,
        }),
      },
      opts.attempts ?? DEFAULT_RESUME_ATTEMPTS,
      opts.retryDelayMs ?? DEFAULT_RESUME_RETRY_DELAY_MS,
      opts.turnTimeoutMs ?? DEFAULT_TURN_OUTCOME_TIMEOUT_MS,
    ),
  )

  const status = await probeArtifact(opts.artifactUrl)
  if (status === "alive") {
    return {
      sessionId: reconnected.id,
      sandboxId: reconnected.sandboxId,
      artifactUrl: opts.artifactUrl,
      artifactReady: true,
    }
  }

  await client.kill(reconnected.id)
  return bootRoomSession(client, {
    cwd: opts.cwd,
    label: opts.label,
    adapter: opts.adapter,
    model: opts.model,
    prompt: opts.prompt,
    appDir: opts.appDir,
    port: opts.port,
    reuseSandboxId: opts.sandboxId,
    killOrphanSandbox,
    ...(opts.seedFromDir !== undefined ? { seedFromDir: opts.seedFromDir } : {}),
    ...(opts.installAdapters !== undefined ? { installAdapters: opts.installAdapters } : {}),
  })
}
