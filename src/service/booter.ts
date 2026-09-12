import { fileURLToPath } from "node:url"
import type { DaemonClient } from "../daemon/client.ts"
import { env } from "../env.ts"
import type { RoomStore } from "../rooms/store.ts"
import type { Room } from "../rooms/types.ts"
import { bootRoomSession, resumeRoomSession } from "../sandbox/boot.ts"
import { isSessionAlive, type DaemonExtraOptions } from "./daemon-extra.ts"

/** Local (this host's) path to the artifact app source the sandbox executor
 *  maintains, seeded into the box on every boot/resume (src/sandbox/boot.ts's
 *  `seedFromDir`). Computed from this file's own location so it doesn't
 *  depend on process.cwd(). */
const ARTIFACT_SEED_DIR = fileURLToPath(new URL("../../apps/room-artifact", import.meta.url))

/**
 * `cwd` for a sandboxed spawn is forwarded verbatim into the BOX's own
 * `agent_start` (`session-spawn.ts`'s `bootSandboxAgentSession` passes it
 * straight to `host.start({ cwd, ... })`) — it must be a directory that
 * exists INSIDE the e2b box, never a path on this host. `process.cwd()`
 * (this host's repo checkout) does not exist in the box: the box's own
 * agent-cli spawn fails with ENOENT ("cwd '<path>' does not exist"), which
 * surfaces as `agent_start: the sandbox's own agent_start failed ... —
 * agent-cli 'claude-code': failed to spawn ...`. `scripts/prove-sandbox.ts`
 * gets this right with its own `BOX_CWD = "/home/user"` — match it here.
 */
const BOX_CWD = "/home/user"

export interface BootedSession {
  sessionId: string
  sandboxId: string | undefined
  artifactUrl: string | undefined
  /** See `RoomSessionResult.artifactReady` (src/sandbox/boot.ts). Always
   *  `undefined` for a booter with no artifact concept (`LocalBooter`). */
  artifactReady: boolean | undefined
}

export interface SessionBooter {
  boot(room: Room, opts: { label: string }): Promise<BootedSession>
  resume(room: Room): Promise<BootedSession>
}

/** `opts.appDir` is the e2b-only artifact case: naming the exact served-page
 *  path up front is what Rehearsal Run 1's Finding 1 needed a human for —
 *  without it, the agent reported "no index.html file exists anywhere" and
 *  asked whether to create one, instead of finding the real path at
 *  `<appDir>/.agentproto/ui/index.html` (`src/sandbox/app-seed.ts`). Omit
 *  `opts` for a booter with no artifact concept (`LocalBooter`) — there is
 *  nothing true to say about a page that doesn't exist. */
export function openingPrompt(room: Room, opts?: { appDir: string }): string {
  const lines = [
    `You are the shared agent for Rendez-vous room ${room.code}.`,
    "Several humans drive this one session together, each from their own device — a phone, email, or a laptop.",
    'Every message you receive is prefixed with its sender, like "[Alice · messenger] ...", so you always know who is speaking.',
    "People in the room may disagree or ask for different things. When that happens, pick a reasonable path forward and say in one short sentence what you chose and why, so everyone stays in sync — do not stall waiting for consensus.",
    'If part of your reply is meant for just one person — reconciling their request with someone else\'s, or answering something only they asked — wrap that part between "[[whisper to <their display name>]]" and "[[/whisper]]", each on its own line. Everyone else in the room will see that you whispered to that person, but not what you said, so use it for the "for your ears only" part of a reply, not for splitting an answer everyone needs. Text outside those markers reaches everyone as usual.',
    "Keep replies short: some members are reading you on a phone screen.",
  ]
  if (opts !== undefined) {
    lines.push(
      `The page members see at the artifact URL is served from ${opts.appDir}/.agentproto/ui/index.html — edit that file to change what they see, and the change is live immediately.`,
    )
  }
  lines.push(`Reply to this message with exactly one short line and nothing else: "Room ${room.code} is open. Say what you want built."`)
  return lines.join(" ")
}

function resumePrompt(room: Room): string {
  return [
    `You are the shared agent for Rendez-vous room ${room.code}, resuming after a pause.`,
    "Several humans drive this one session together, each from their own device — a phone, email, or a laptop.",
    'Every message you receive is prefixed with its sender, like "[Alice · messenger] ...", so you always know who is speaking.',
    "Keep replies short: some members are reading you on a phone screen.",
    `Reply to this message with exactly one short line and nothing else: "Room ${room.code} resumed. Where were we?"`,
  ].join(" ")
}

/** No sandbox: the box-less fallback of R9. `sandboxId`/`artifactUrl` stay
 *  undefined until an M4 booter is plugged in in its place. */
export class LocalBooter implements SessionBooter {
  private readonly client: DaemonClient
  private readonly daemon: DaemonExtraOptions

  constructor(client: DaemonClient, daemon: DaemonExtraOptions) {
    this.client = client
    this.daemon = daemon
  }

  async boot(room: Room, opts: { label: string }): Promise<BootedSession> {
    const spawned = await this.client.spawnAgent({
      adapter: env.agentAdapter,
      model: env.agentModel,
      cwd: process.cwd(),
      label: opts.label,
      prompt: openingPrompt(room),
    })
    return { sessionId: spawned.id, sandboxId: undefined, artifactUrl: undefined, artifactReady: undefined }
  }

  async resume(room: Room): Promise<BootedSession> {
    if (room.sessionId !== undefined) {
      const alive = await isSessionAlive(this.daemon, room.sessionId)
      if (alive) {
        return {
          sessionId: room.sessionId,
          sandboxId: room.sandboxId,
          artifactUrl: room.artifactUrl,
          artifactReady: room.artifactReady,
        }
      }
    }
    return this.boot(room, { label: `rdv-${room.code}` })
  }
}

/** M4: e2b sandbox + served artifact (architecture.md §3, R8/R9, build brief
 *  M4). `bootRoomSession`/`resumeRoomSession` (src/sandbox/boot.ts) already
 *  handle the sandbox spec, app seeding, and R8's "probe then re-serve if
 *  dead" resume policy — this class is just the `SessionBooter` adapter over
 *  them, plus the pre-warm sandbox handoff (R10 cost control). */
export class E2bBooter implements SessionBooter {
  private readonly client: DaemonClient
  private readonly store: RoomStore

  constructor(client: DaemonClient, _daemon: DaemonExtraOptions, store: RoomStore) {
    this.client = client
    this.store = store
  }

  /** `RDV_PREWARM_SANDBOX_ID`, consumed at most once: available only while no
   *  room in the store has already recorded it as its own `sandboxId`. That
   *  recording happens naturally as part of a normal boot, so this needs no
   *  separate "consumed" flag and survives a restart for free. */
  private prewarmSandboxId(): string | undefined {
    const candidate = env.prewarmSandboxId
    if (candidate === undefined) return undefined
    const alreadyTaken = this.store.list().some((room) => room.sandboxId === candidate)
    return alreadyTaken ? undefined : candidate
  }

  private async bootWithReuse(room: Room, label: string, reuseSandboxId: string | undefined): Promise<BootedSession> {
    const result = await bootRoomSession(this.client, {
      cwd: BOX_CWD,
      label,
      adapter: env.agentAdapter,
      model: env.agentModel,
      prompt: openingPrompt(room, { appDir: env.artifactAppDir }),
      appDir: env.artifactAppDir,
      port: env.artifactPort,
      seedFromDir: ARTIFACT_SEED_DIR,
      ...(reuseSandboxId !== undefined ? { reuseSandboxId } : {}),
    })
    return {
      sessionId: result.sessionId,
      sandboxId: result.sandboxId,
      artifactUrl: result.artifactUrl,
      artifactReady: result.artifactReady,
    }
  }

  async boot(room: Room, opts: { label: string }): Promise<BootedSession> {
    return this.bootWithReuse(room, opts.label, this.prewarmSandboxId())
  }

  async resume(room: Room): Promise<BootedSession> {
    if (room.sandboxId === undefined || room.artifactUrl === undefined) {
      // No box on record, or one that never finished serving anything —
      // nothing for resumeRoomSession's probe to check, so boot fresh,
      // reusing the box if we at least have its id.
      return this.bootWithReuse(room, `rdv-${room.code}`, room.sandboxId)
    }
    const result = await resumeRoomSession(this.client, {
      cwd: BOX_CWD,
      label: `rdv-${room.code}`,
      adapter: env.agentAdapter,
      model: env.agentModel,
      prompt: resumePrompt(room),
      appDir: env.artifactAppDir,
      port: env.artifactPort,
      sandboxId: room.sandboxId,
      artifactUrl: room.artifactUrl,
      seedFromDir: ARTIFACT_SEED_DIR,
    })
    return {
      sessionId: result.sessionId,
      sandboxId: result.sandboxId,
      artifactUrl: result.artifactUrl,
      artifactReady: result.artifactReady,
    }
  }
}
