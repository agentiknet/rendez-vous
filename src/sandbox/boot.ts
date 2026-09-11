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

import type { DaemonClient } from "../daemon/client.ts"
import { probeArtifact } from "./artifact.ts"

const SANDBOX_PROVIDER = "e2b"

export interface RoomSessionResult {
  readonly sessionId: string
  readonly sandboxId: string | undefined
  readonly artifactUrl: string | undefined
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
}

/**
 * R8: reconnecting to a paused box (`SandboxProvider.connect`) does NOT
 * relaunch `agentproto app serve` — nothing but a fresh `appServe` bootstrap
 * does that. So: reconnect first (cheap — no install, no relaunch), probe
 * the known artifact URL, and only pay for a full re-install + relaunch when
 * that probe comes back dead.
 */
export async function resumeRoomSession(client: DaemonClient, opts: ResumeRoomSessionOpts): Promise<RoomSessionResult> {
  const reconnected = await client.spawnAgent({
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
  })

  const status = await probeArtifact(opts.artifactUrl)
  if (status === "alive") {
    return {
      sessionId: reconnected.id,
      sandboxId: reconnected.sandboxId,
      artifactUrl: opts.artifactUrl,
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
