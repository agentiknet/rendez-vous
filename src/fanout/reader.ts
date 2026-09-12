import type { RoomStore } from "../rooms/store.ts"
import { renderForTier } from "./render.ts"
import type { FanoutRecord, Transport } from "./types.ts"

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

export class RoomFanout {
  private readonly store: RoomStore
  private readonly transport: Transport
  private readonly source: Source
  private readonly isAlive: IsAlive
  private readonly readers: Map<string, ActiveReader> = new Map()
  /** Per-room, in-process only: reset on restart, so the first flush after boot is always treated as an artifact change (see start of `flush`). */
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

  private async flush(code: string, text: string, seq: number): Promise<void> {
    const room = this.store.get(code)
    if (room === undefined) return

    const hasSeenArtifact = this.lastArtifactUrl.has(code)
    const previousArtifactUrl = this.lastArtifactUrl.get(code)
    const artifactChanged = hasSeenArtifact ? previousArtifactUrl !== room.artifactUrl : room.artifactUrl !== undefined
    this.lastArtifactUrl.set(code, room.artifactUrl)

    await Promise.allSettled(
      room.members.map(async (member) => {
        const message = renderForTier(member.tier, text, room.artifactUrl, artifactChanged)
        if (message === undefined) return
        await this.transport.send(member, message)
      }),
    )

    // Cursor is persisted only after the flush attempt: a crash between send and
    // persist re-sends this turn on the next boot (at-least-once), never drops it.
    await this.store.update(code, { cursor: seq })
  }
}
