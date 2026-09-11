/**
 * Sandbox boot and resume (M4, architecture.md §3 "Sandbox plus artifact",
 * §4.2 R8/R9). e2b only — R9: `box` exposes no port, so no artifact URL is
 * possible on that provider.
 *
 * `bootRoomSession` is a single spawn: `sandbox` + `appServe` together. This
 * only succeeds when `appDir` ALREADY EXISTS inside the sandbox filesystem
 * — `appServe`'s `app_install` step runs before the agent's own prompt ever
 * gets a turn (ground-truthed in session-spawn.ts: `startSandboxAppServe`
 * runs immediately after the box boots, and the initial prompt is only
 * delivered once that whole spawn call returns). A fresh box has nothing at
 * `appDir` yet, so callers booting for the first time must populate it in a
 * separate, `appServe`-less spawn first (see scripts/prove-sandbox.ts) and
 * pass that spawn's `sandboxId` back in as `reuseSandboxId` here. See
 * docs/UPSTREAM.md for the full writeup.
 */

import type { DaemonClient, SpawnAgentInput, SpawnAgentResult } from "../daemon/client.ts"
import { probeArtifact } from "./artifact.ts"

const SANDBOX_PROVIDER = "e2b"
const DEFAULT_RESUME_ATTEMPTS = 4
const DEFAULT_RESUME_RETRY_DELAY_MS = 10_000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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
}

export async function bootRoomSession(client: DaemonClient, opts: BootRoomSessionOpts): Promise<RoomSessionResult> {
  const spawned = await client.spawnAgent({
    adapter: opts.adapter,
    model: opts.model,
    cwd: opts.cwd,
    label: opts.label,
    prompt: opts.prompt,
    sandbox: {
      provider: SANDBOX_PROVIDER,
      config: {},
      extraPorts: [opts.port],
      ...(opts.reuseSandboxId !== undefined ? { reuse: opts.reuseSandboxId } : {}),
    },
    appServe: { dir: opts.appDir, port: opts.port },
  })
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
}

/**
 * R8: reconnecting to a paused box (`SandboxProvider.connect`) does NOT
 * relaunch `agentproto app serve` — nothing but a fresh `appServe` bootstrap
 * does that. So: reconnect first (cheap — no install, no relaunch), probe
 * the known artifact URL, and only pay for a full re-install + relaunch when
 * that probe comes back dead.
 */
export async function resumeRoomSession(client: DaemonClient, opts: ResumeRoomSessionOpts): Promise<RoomSessionResult> {
  const reconnected = await spawnWithReconnectRetry(
    client,
    {
      adapter: opts.adapter,
      model: opts.model,
      cwd: opts.cwd,
      label: opts.label,
      prompt: opts.prompt,
      sandbox: {
        provider: SANDBOX_PROVIDER,
        config: {},
        extraPorts: [opts.port],
        reuse: opts.sandboxId,
      },
    },
    opts.attempts ?? DEFAULT_RESUME_ATTEMPTS,
    opts.retryDelayMs ?? DEFAULT_RESUME_RETRY_DELAY_MS,
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
  })
}
