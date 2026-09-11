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
import { buildAppSeedScript } from "./app-seed.ts"
import { probeArtifact } from "./artifact.ts"

const SANDBOX_PROVIDER = "e2b"
const DEFAULT_RESUME_ATTEMPTS = 4
const DEFAULT_RESUME_RETRY_DELAY_MS = 10_000

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

async function spawnWithReconnectRetry(
  client: DaemonClient,
  input: SpawnAgentInput,
  attempts: number,
  retryDelayMs: number,
): Promise<SpawnAgentResult> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await client.spawnAgent(input)
    } catch (err) {
      if (attempt === attempts || !isRetryableReconnectError(err)) throw err
      await sleep(retryDelayMs)
    }
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
}): SandboxSpecInput {
  return {
    provider: SANDBOX_PROVIDER,
    config: opts.seedFromDir !== undefined ? { setupCommands: [buildAppSeedScript(opts.seedFromDir, opts.appDir)] } : {},
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
  /** Reconnect attempts before giving up on a persistently retryable
   *  `sandbox_reconnect_failed`. Default 4. */
  readonly attempts?: number
  /** Delay between reconnect attempts. Default 10s — long enough for the
   *  box's MCP layer to catch up to its already-healthy `/health` endpoint
   *  (see `isRetryableReconnectError`'s doc comment). */
  readonly retryDelayMs?: number
  /** Same as `BootRoomSessionOpts.seedFromDir` — included on the bare
   *  reconnect too (harmless: `setupCommands` re-runs idempotently on every
   *  connect) and forwarded to the re-serve fallback below. */
  readonly seedFromDir?: string
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
        }),
      },
      opts.attempts ?? DEFAULT_RESUME_ATTEMPTS,
      opts.retryDelayMs ?? DEFAULT_RESUME_RETRY_DELAY_MS,
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
  })
}
