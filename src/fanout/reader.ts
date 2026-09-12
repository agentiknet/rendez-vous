import type { RoomStore } from "../rooms/store.ts"
import type { Ask, Member, Room } from "../rooms/types.ts"
import { publicArtifactUrl } from "../service/artifact-proxy.ts"
import { renderForTier } from "./render.ts"
import type { FanoutRecord, Transport } from "./types.ts"
import { askMarkerForOthers, askTextForTarget, resolveAskSegments, type ResolvedTurnSegment } from "./ask.ts"
import { renderWhisperForMember, resolveWhisperSegments, type ResolvedSegment } from "./whisper.ts"

const INITIAL_BACKOFF_MS = 250
const MAX_BACKOFF_MS = 5000

type Source = (sessionId: string, since: number, signal: AbortSignal) => AsyncIterable<FanoutRecord>
/** Checked once the source's read loop ends (error or clean close), before
 *  retrying against the same sessionId — lets a reader distinguish "the
 *  connection dropped, retry" from "the session is gone for good, stop"
 *  (Rehearsal Run 1, Finding 2c). Defaults to always-alive (retry forever)
 *  when the caller has no daemon-liveness check to offer. */
type IsAlive = (sessionId: string) => Promise<boolean>

interface ActiveReader {
  controller: AbortController
  done: Promise<void>
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/** One pre-resolved piece of a turn: either an ask (target already matched),
 *  or a broadcast slice whose whisper blocks are resolved once, up front, and
 *  then rendered per member. */
type TurnPiece =
  | { kind: "ask"; target: Member; text: string }
  | { kind: "text"; segments: ResolvedSegment[] }

function buildTurnPieces(segments: ResolvedTurnSegment[], members: Member[]): TurnPiece[] {
  const pieces: TurnPiece[] = []
  for (const segment of segments) {
    if (segment.kind === "ask") {
      pieces.push({ kind: "ask", target: segment.target, text: segment.text })
      continue
    }
    pieces.push({ kind: "text", segments: resolveWhisperSegments(segment.text, members) })
  }
  return pieces
}

/** The text one member should see for a turn: their own asks as a private
 *  "(the room is waiting on you)" line, everyone else's asks collapsed to the
 *  one-line open marker, and broadcast/whisper text rendered exactly as
 *  before (docs/MIDDLEMAN.md §3). */
function renderTurnForMember(pieces: TurnPiece[], member: Member): string {
  const parts: string[] = []
  for (const piece of pieces) {
    if (piece.kind === "ask") {
      parts.push(piece.target.id === member.id ? askTextForTarget(piece.text) : askMarkerForOthers(piece.target, piece.text))
      continue
    }
    parts.push(renderWhisperForMember(piece.segments, member))
  }
  return parts.join("\n")
}

export class RoomFanout {
  private readonly store: RoomStore
  private readonly transport: Transport
  private readonly source: Source
  private readonly isAlive: IsAlive
  private readonly readers: Map<string, ActiveReader> = new Map()
  /** Per-room, in-process only: reset on restart, so the first flush after boot is always treated as an artifact change (see start of `flush`). Keyed on the PUBLIC artifact URL (`publicArtifactUrl`), not the raw box URL — the public one never changes for a room, so a box replacement (architecture.md §9.3b) no longer trips this and re-sends. */
  private readonly lastArtifactUrl: Map<string, string | undefined> = new Map()

  constructor(opts: { store: RoomStore; transport: Transport; source: Source; isAlive?: IsAlive }) {
    this.store = opts.store
    this.transport = opts.transport
    this.source = opts.source
    this.isAlive = opts.isAlive ?? (async () => true)
  }

  start(code: string): void {
    if (this.readers.has(code)) return
    const room = this.store.get(code)
    if (room === undefined || room.sessionId === undefined) return

    const controller = new AbortController()
    const done = this.runLoop(code, controller.signal).catch(() => undefined)
    this.readers.set(code, { controller, done })
  }

  async stop(code: string): Promise<void> {
    const active = this.readers.get(code)
    if (active === undefined) return
    this.readers.delete(code)
    active.controller.abort()
    await active.done
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.readers.keys()).map((code) => this.stop(code)))
  }

  private async runLoop(code: string, signal: AbortSignal): Promise<void> {
    let backoff = INITIAL_BACKOFF_MS
    while (!signal.aborted) {
      const room = this.store.get(code)
      if (room === undefined || room.sessionId === undefined) return
      const sessionId = room.sessionId

      let failed = false
      try {
        await this.consume(code, sessionId, signal)
      } catch {
        failed = true
      }
      if (signal.aborted) return

      // The source ended — either it errored, or the connection simply
      // closed. Either way, a session that no longer exists must not be
      // retried forever: stop this reader and let the next fan-in drive the
      // room through the ordinary pause/resume path (RoomService), which
      // starts a fresh reader once it has.
      if (!(await this.isAlive(sessionId))) {
        this.readers.delete(code)
        return
      }

      await delay(backoff, signal)
      backoff = failed ? Math.min(backoff * 2, MAX_BACKOFF_MS) : INITIAL_BACKOFF_MS
    }
  }

  private async consume(code: string, sessionId: string, signal: AbortSignal): Promise<void> {
    const room = this.store.get(code)
    if (room === undefined) return
    let buffer = ""

    for await (const record of this.source(sessionId, room.cursor, signal)) {
      if (signal.aborted) return
      if (record.kind === "text-delta") {
        buffer += record.text ?? ""
        continue
      }
      if (record.kind === "turn-end") {
        if (buffer.length > 0) {
          await this.flush(code, buffer, record.seq)
        }
        buffer = ""
      }
    }
  }

  /** Records every newly-opened ask on the room (docs/MIDDLEMAN.md §3): ids
   *  `a1, a2, …` per room, `toMemberId` the member id (names collide), status
   *  `open`. Happens once, on open — later turns neither re-record these nor
   *  re-emit their marker. Unmatched-name asks never reach here (they fell
   *  back to broadcast in `resolveAskSegments`), so no phantom wait is ever
   *  recorded on nobody. */
  private async recordAsks(code: string, room: Room, segments: ResolvedTurnSegment[]): Promise<void> {
    const existing = room.asks ?? []
    const created: Ask[] = []
    for (const segment of segments) {
      if (segment.kind !== "ask") continue
      created.push({
        id: `a${existing.length + created.length + 1}`,
        toMemberId: segment.target.id,
        what: segment.text,
        askedAt: new Date().toISOString(),
        status: "open",
        answeredBy: undefined,
        answeredAt: undefined,
        mediaId: undefined,
      })
    }
    if (created.length === 0) return
    await this.store.update(code, { asks: [...existing, ...created] })
  }

  private async flush(code: string, text: string, seq: number): Promise<void> {
    const room = this.store.get(code)
    if (room === undefined) return

    // The raw `room.artifactUrl` is the box's own ephemeral URL — never sent
    // to a member (architecture.md §9.3b). Everyone gets the room-code-keyed
    // proxy URL instead, which is why box replacement (a new raw URL behind
    // the same code) does not register as a change here: `RoomService`
    // already sends its own one-time "restored on a new box" notice for that.
    // `artifactReady === false` means the box was last confirmed dead (the
    // idle sweep's probe) — the URL is a dead link until something revives
    // the box and re-marks it ready, so no artifact line goes out at all.
    const artifactUrl =
      room.artifactUrl !== undefined && room.artifactReady !== false ? publicArtifactUrl(code) : undefined
    const hasSeenArtifact = this.lastArtifactUrl.has(code)
    const previousArtifactUrl = this.lastArtifactUrl.get(code)
    const artifactChanged = hasSeenArtifact ? previousArtifactUrl !== artifactUrl : artifactUrl !== undefined
    this.lastArtifactUrl.set(code, artifactUrl)

    // A whisper and an ask are both conventions in the agent's own text, not
    // separate record kinds (the box has no tool access to target a member
    // directly — see architecture.md §9.3). Ask blocks are extracted first
    // (and recorded on the room below), whisper blocks are resolved on the
    // broadcast remainder; then each member sees their own view of the same
    // turn: broadcast text verbatim, their own whisper/ask in full, everyone
    // else's collapsed to a visible marker (docs/MIDDLEMAN.md §3).
    const turnSegments = resolveAskSegments(text, room.members)
    await this.recordAsks(code, room, turnSegments)
    const pieces = buildTurnPieces(turnSegments, room.members)

    await Promise.allSettled(
      room.members.map(async (member) => {
        const memberText = renderTurnForMember(pieces, member)
        const message = renderForTier(member.tier, memberText, artifactUrl, artifactChanged)
        if (message === undefined) return
        await this.transport.send(member, message)
      }),
    )

    // Cursor is persisted only after the flush attempt: a crash between send and
    // persist re-sends this turn on the next boot (at-least-once), never drops it.
    await this.store.update(code, { cursor: seq })
  }
}
