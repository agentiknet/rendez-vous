import { fileURLToPath } from "node:url"
import type { DaemonClient } from "../daemon/client.ts"
import { env } from "../env.ts"
import type { RoomStore } from "../rooms/store.ts"
import type { Room } from "../rooms/types.ts"
import { bootRoomSession, isSandboxNotFoundError, resumeRoomSession, type OrphanSandboxKiller } from "../sandbox/boot.ts"
import { isSandboxAlive, type BoxLivenessCheck } from "./box-liveness.ts"
import { canvakitMcpServer } from "./mcp-canvakit.ts"
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
  /** `true` only when this result came from `E2bBooter.resume` finding the
   *  room's prior box confirmed GONE via `isSandboxAlive` (docs/UPSTREAM.md
   *  #10) and booting a fresh one with no reuse — distinct from R8's
   *  same-or-reused-box re-serve, so `RoomService` can send the more precise
   *  "the previous box expired" notice instead of the generic one. Always
   *  `undefined` otherwise. */
  boxWasGone?: boolean
}

export interface ResumeOptions {
  /** Replay of the prior session's transcript (src/service/recap.ts), when
   *  one could be read. Absent means the history is genuinely unavailable
   *  and the resumed agent must say so rather than guess. */
  readonly recap?: string
}

export interface SessionBooter {
  boot(room: Room, opts: { label: string }): Promise<BootedSession>
  resume(room: Room, opts?: ResumeOptions): Promise<BootedSession>
}

/** The capability half of both prompts — how attribution arrives, how to
 *  whisper, how the artifact gets rendered and served.
 *
 *  `opts.appDir` is the e2b-only artifact case: the artifact lines (the
 *  render_artifact tool, `[[attach]]`) only make sense when the room has a
 *  served artifact app and an MCP mount. Omit `opts` for a booter with no
 *  artifact concept (`LocalBooter`) — there is nothing true to say about a
 *  page that doesn't exist.
 *
 *  Shared between boot and resume because a RESUMED agent needs every one of
 *  these just as much as a fresh one. The resume prompt used to inline its
 *  own shorter copy and silently lacked both the whisper protocol and the
 *  `appDir` line, so after any pause the room stopped being able to whisper
 *  and the agent no longer knew which file backed the artifact — with no
 *  error anywhere (the `docs/UPSTREAM.md` pattern, found live 2026-09-12). */
function capabilityLines(opts?: { appDir: string }): string[] {
  const lines = [
    "Several humans drive this one session together, each from their own device — a phone, email, or a laptop.",
    'Every message you receive is prefixed with its sender AND the channel they are on, like "[Alice · telegram] ..." or "[Alice · whatsapp] ...", so you always know who is speaking and where.',
    'THE SAME PERSON CAN BE IN THE ROOM TWICE, on two channels, under the same name — "[Jeremy · telegram]" and "[Jeremy · whatsapp]" are one human on two devices. Treat them as one person: do not greet them twice, do not ask them the same question on both, and do not describe them as two participants. Anything you broadcast already reaches every one of their surfaces. When you whisper to someone who appears on more than one channel, name the surface you mean — "[[whisper to Jeremy · whatsapp]]" — because a bare name picks whichever of their devices joined first.',
    "People in the room may disagree or ask for different things. When that happens, pick a reasonable path forward and say in one short sentence what you chose and why, so everyone stays in sync — do not stall waiting for consensus.",
    'When a single turn answers more than one person, ADDRESS THEM BY NAME so nobody has to guess which half is theirs: start each part with "<Name>:" on its own line, e.g. "Alain: keeping the hero red — you called it the brand colour." / "Claire: noted, I dropped the blue." Everyone still sees the whole thing; naming is for legibility, not privacy. When your answer is genuinely for the whole room, do not prefix it with anyone\'s name.',
    "If you need something from ONE person to keep going — a file, a decision, a missing number — ask that person directly by name rather than asking the room and waiting. Name the person, say exactly what you need, and meanwhile do whatever parts do not depend on the answer.",
    'When you need something from ONE member that the others do not have — a file, a photo, a decision only they can make, a fact only their machine knows — open an ask: put "[[ask <their display name>]]" on its own line, write below it exactly what you need and why, and close with "[[/ask]]" on its own line. Name them as they appear in the "[Name · tier]" prefix — one member, not the whole room. They receive the ask privately on their own channel and answer in their own time; everyone else just sees that you are waiting on them and for what. Meanwhile, keep working on whatever does not depend on the answer instead of blocking on it.',
    'If part of your reply is meant for just one person — reconciling their request with someone else\'s, or answering something only they asked — wrap that part between "[[whisper to <their display name>]]" and "[[/whisper]]", each on its own line. Everyone else in the room will see that you whispered to that person, but not what you said, so use it for the "for your ears only" part of a reply, not for splitting an answer everyone needs. Text outside those markers reaches everyone as usual.',
    'A message whose prefix ends in "· private", like "[Alice · messenger · private] ...", is one the sender asked you to answer ONLY to them. Put your entire answer to it inside a "[[whisper to <their display name>]]" / "[[/whisper]]" block — no part of it outside. The room still sees that you replied privately, which is the honest amount to reveal. Everything else defaults to the whole room, and you should keep it that way unless asked.',
    'Voice notes and images reach you already converted to text, and you must read them as what the member said or sent. A line like "(voice note) Can you hear me? media:abc123" IS a successful transcription of their audio — answer the words, never claim you cannot hear or play audio. "(image) a screenshot of a login form  media:abc123" is likewise a real description of their picture. Only a line that explicitly says it FAILED — "(voice note, could not be fetched: …)" or "(…, transcription unavailable, …)" — means the media could not be read, and only then should you say so and ask them to type it. Never generalise a past failure into a standing limitation: judge each line on what it says.',
    "Keep replies short: some members are reading you on a phone screen.",
  ]
  if (opts !== undefined) {
    lines.push(
      `Members see the room's artifact page at the artifact URL. You have a render_artifact MCP tool: call it with the document data (a list of typed blocks — the tool's inputSchema shows the shape) and it renders the branded live page every member can open AND the deliverable PDF in one go. Calling render_artifact is how members see anything you produce; if it returns an error, the canvakit message is verbatim — read it, fix the data, call it again.`,
    )
    lines.push(
      `To SEND someone a file — a PDF, an image, a chart, an audio clip — write it into ${opts.appDir}/.agentproto/ui/ and then put "[[attach <filename> <optional one-line caption>]]" on its own line in your reply. Everyone in the room receives it as a real attachment, not a link. The filename must have no spaces and no directory traversal. Use this whenever someone asks you for a document or a picture: do not paste a long URL and do not claim you cannot send files.`,
    )
    lines.push(
      'To reply with a VOICE NOTE, put "[[say <the sentence to speak>]]" on its own line. It is spoken aloud and delivered as playable audio; the same words also reach anyone who cannot play it, so never repeat the sentence outside the marker. Keep a spoken line to one or two sentences — it is listened to, not skimmed. Use it when someone sends YOU a voice note, or asks you to speak.',
    )
  }
  return lines
}

export function openingPrompt(room: Room, opts?: { appDir: string }): string {
  const lines = [`You are the shared agent for Rendez-vous room ${room.code}.`, ...capabilityLines(opts)]
  lines.push(`Reply to this message with exactly one short line and nothing else: "Room ${room.code} is open. Say what you want built."`)
  return lines.join(" ")
}

/** A resume boots a FRESH agent session: the agent's own working context
 *  never survives a pause. Two prompts, and the difference is whether the
 *  room's transcript could be replayed (`src/service/recap.ts`).
 *
 *  - `recap` present → the transcript is quoted verbatim and the agent is
 *    told to pick up from it. This is the path that makes a resume feel
 *    continuous to the people in the room.
 *  - `recap` absent → the history is genuinely unrecoverable, and the agent
 *    is told to SAY SO. Never to improvise.
 *
 *  That second branch exists because of what shipped before it: the prompt
 *  ended with `"Room <code> resumed. Where were we?"`, which made a
 *  context-free agent perform remembering. Members got a warm greeting, then
 *  watched it contradict itself two turns later when asked what had been
 *  said. Nothing errored — the room was `active`, replies flowed, the demo
 *  looked fine. Found live on a real phone, 2026-09-12. A resume may lose
 *  the history; it may never pretend it hasn't. */
export function resumePrompt(room: Room, opts?: { appDir?: string; recap?: string }): string {
  // `appDir` and `recap` are independent: LocalBooter has a recap but no
  // artifact page, e2b has both. Passing an empty appDir must not emit an
  // artifact line pointing at "/.agentproto/ui/index.html".
  const appDir = opts?.appDir
  const appDirOpts = appDir !== undefined && appDir !== "" ? { appDir } : undefined
  const recap = opts?.recap
  const lines = [`You are the shared agent for Rendez-vous room ${room.code}, restarting on a fresh session after a pause.`]

  if (recap === undefined) {
    lines.push(
      "You do NOT have the earlier conversation: the previous session's transcript could not be recovered. Never pretend otherwise, never guess at what was already agreed, and if someone asks what was said before, say plainly that you no longer have it and ask them to re-state what matters.",
    )
  } else {
    lines.push(
      "Your own working context did not survive the pause, but the room's transcript did, and it is reproduced below. Treat it as what was actually said — it is a replay, not a summary you wrote. Member messages keep their original [Name · tier] prefix. Do not re-greet, do not re-introduce yourself, and do not ask people to repeat what is already in it.",
    )
  }

  lines.push(...capabilityLines(appDirOpts))

  if (recap === undefined) {
    lines.push(
      `Reply to this message with exactly one short line and nothing else: "Room ${room.code} is back, on a fresh session — I've lost the earlier thread. Catch me up in a line?"`,
    )
    return lines.join(" ")
  }

  // The recap goes LAST and on its own lines: it is quoted material, and
  // folding multi-line transcript into the single space-joined instruction
  // paragraph would blur the line between what the room said and what we
  // are telling the agent to do.
  return [
    lines.join(" "),
    "",
    "--- room transcript so far ---",
    recap,
    "--- end of transcript ---",
    "",
    `Reply to this message with exactly one short line and nothing else, picking up where the transcript leaves off: "Room ${room.code} is back — I still have us at: <one clause naming the last thing in the transcript>."`,
  ].join("\n")
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

  async resume(room: Room, opts?: ResumeOptions): Promise<BootedSession> {
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
    // The session is dead, so this spawn IS the resume — use the resume
    // prompt (with the recap when we have one), not the blank-slate opening
    // one, or the local booter silently loses the history the e2b path keeps.
    const spawned = await this.client.spawnAgent({
      adapter: env.agentAdapter,
      model: env.agentModel,
      cwd: process.cwd(),
      label: `rdv-${room.code}`,
      prompt: resumePrompt(room, opts?.recap !== undefined ? { recap: opts.recap } : undefined),
    })
    return { sessionId: spawned.id, sandboxId: undefined, artifactUrl: undefined, artifactReady: undefined }
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
  private readonly checkBoxLiveness: BoxLivenessCheck
  /** Forwarded to `bootRoomSession`/`resumeRoomSession` (src/sandbox/boot.ts),
   *  which default to the real e2b DELETE call; injected by tests so a
   *  simulated failed reconnect never reaches e2b. */
  private readonly killOrphanSandbox: OrphanSandboxKiller | undefined

  constructor(
    client: DaemonClient,
    _daemon: DaemonExtraOptions,
    store: RoomStore,
    checkBoxLiveness?: BoxLivenessCheck,
    killOrphanSandbox?: OrphanSandboxKiller,
  ) {
    this.client = client
    this.store = store
    this.checkBoxLiveness = checkBoxLiveness ?? ((sandboxId) => isSandboxAlive(sandboxId))
    this.killOrphanSandbox = killOrphanSandbox
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

  /** `recap`, when present, means this boot is really a RESUME that had to
   *  cold-start (box gone, or a reconnect that failed under us). Those are
   *  exactly the cases where replaying the transcript matters most, so they
   *  must not fall back to the blank-slate `openingPrompt`. */
  private async bootWithReuse(
    room: Room,
    label: string,
    reuseSandboxId: string | undefined,
    recap?: string,
  ): Promise<BootedSession> {
    const result = await bootRoomSession(this.client, {
      cwd: BOX_CWD,
      label,
      adapter: env.agentAdapter,
      model: env.agentModel,
      prompt:
        recap === undefined
          ? openingPrompt(room, { appDir: env.artifactAppDir })
          : resumePrompt(room, { appDir: env.artifactAppDir, recap }),
      appDir: env.artifactAppDir,
      port: env.artifactPort,
      seedFromDir: ARTIFACT_SEED_DIR,
      // The render tool, mounted on the agent session for THIS room — the
      // mount carries the room's own bearer token, and only the e2b booter
      // builds one (LocalBooter gets nothing).
      mcpServers: [canvakitMcpServer(room.code)],
      ...(reuseSandboxId !== undefined ? { reuseSandboxId } : {}),
      ...(this.killOrphanSandbox !== undefined ? { killOrphanSandbox: this.killOrphanSandbox } : {}),
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

  async resume(room: Room, opts?: ResumeOptions): Promise<BootedSession> {
    const recap = opts?.recap
    if (room.sandboxId === undefined || room.artifactUrl === undefined) {
      // No box on record, or one that never finished serving anything —
      // nothing for resumeRoomSession's probe to check, so boot fresh,
      // reusing the box if we at least have its id.
      return this.bootWithReuse(room, `rdv-${room.code}`, room.sandboxId, recap)
    }

    // Session liveness and box liveness are independent facts
    // (docs/UPSTREAM.md #10): a box confirmed GONE is not worth a reconnect
    // attempt at all — `resumeRoomSession`'s reconnect only retries a
    // TRANSIENT `sandbox_reconnect_failed`, not "the box no longer exists".
    // Boot fresh with reuse dropped entirely ("reuse nothing", per the
    // brief) rather than handing a known-dead sandboxId to `sandbox.reuse`.
    // `"unknown"` (a network error probing e2b) is deliberately NOT treated
    // as gone — fall through to the ordinary reconnect path, which has its
    // own retry budget for exactly that uncertainty.
    const liveness = await this.checkBoxLiveness(room.sandboxId)
    if (liveness === "gone") {
      const booted = await this.bootWithReuse(room, `rdv-${room.code}`, undefined, recap)
      return { ...booted, boxWasGone: true }
    }

    let result
    try {
      result = await resumeRoomSession(this.client, {
        cwd: BOX_CWD,
        label: `rdv-${room.code}`,
        adapter: env.agentAdapter,
        model: env.agentModel,
        prompt: resumePrompt(room, { appDir: env.artifactAppDir, ...(recap !== undefined ? { recap } : {}) }),
        appDir: env.artifactAppDir,
        port: env.artifactPort,
        sandboxId: room.sandboxId,
        artifactUrl: room.artifactUrl,
        seedFromDir: ARTIFACT_SEED_DIR,
        mcpServers: [canvakitMcpServer(room.code)],
        ...(this.killOrphanSandbox !== undefined ? { killOrphanSandbox: this.killOrphanSandbox } : {}),
      })
    } catch (err) {
      // The probe above is a snapshot, not a lock (docs/UPSTREAM.md #10
      // addendum, seen live): a box that probed "paused" can be genuinely
      // gone by the time the reconnect lands seconds later, and the daemon
      // reports that with the SAME `sandbox_reconnect_failed` code as the
      // transient race — only the text differs (`isSandboxNotFoundError`).
      // Treat it exactly like a probe that said gone, and boot fresh HERE,
      // inside the caller's per-room revive lock, instead of surfacing a
      // generic failure that the caller's own retry would answer with a
      // second, unserialized boot (the live double boot).
      if (!isSandboxNotFoundError(err)) throw err
      const booted = await this.bootWithReuse(room, `rdv-${room.code}`, undefined, recap)
      return { ...booted, boxWasGone: true }
    }
    return {
      sessionId: result.sessionId,
      sandboxId: result.sandboxId,
      artifactUrl: result.artifactUrl,
      artifactReady: result.artifactReady,
    }
  }
}
