/**
 * Room-agent bridge — makes a LOCAL agentproto agent session a full MEMBER
 * of a Rendez-vous room, exactly like a human on Telegram or the laptop.
 *
 * A member is just "a thing that speaks and listens". This script is both:
 *
 *   room → desktop   it holds `GET {base}/rooms/:code/stream?since=N` (SSE,
 *                    `data: <TranscriptRecord>`) from a persisted cursor and
 *                    forwards turns into the desktop session with
 *                    `POST {daemon}/sessions/:id/prompt?wait=false`,
 *                    body `{prompt, queue: true, origin: "rdv:<name>"}`.
 *                    **`queue: true` is load-bearing** — without it a prompt
 *                    arriving mid-turn is rejected with `session "<id>" is
 *                    mid-turn` and SILENTLY LOST (docs/STATE.md, "The
 *                    silent-failure class"). Never omit it.
 *
 *   desktop → room   it holds the desktop session's own event stream,
 *                    accumulates `text-delta`, flushes on `turn-end` (the
 *                    exact shape of src/fanout/reader.ts), and posts the
 *                    turn back with `POST {base}/rooms/:code/send`.
 *
 *   loop guard       the posted turn comes back DOWN the room stream as a
 *                    `user-prompt` attributed `[<name> · room-web]`. Feeding
 *                    those back into the desktop session builds an infinite
 *                    mirror — they are skipped.
 *
 *   cursor           the last-seen room sequence persists under
 *                    `<dataDir>/room-agent/<code>.json` (atomic write, same
 *                    tmp+rename pattern as src/rooms/store.ts), so a restart
 *                    neither drops nor duplicates anything.
 *
 * The core (`RoomAgent`) knows nothing about HTTP: both transports are
 * injected, so test/scripts/room-agent.test.ts can fake both streams with
 * async generators and assert on plain data.
 */

import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { DaemonClient } from "../src/daemon/client.ts"
import { isRecordKind, parseTranscriptRecord, type TranscriptRecord } from "../src/daemon/records.ts"
import { sseData } from "../src/daemon/sse.ts"
import { env } from "../src/env.ts"

/** The prompt sent to the desktop session. `queue: true` is load-bearing —
 *  see the file header. The real transport sends it as
 *  `{prompt, queue, origin}` on `POST /sessions/:id/prompt?wait=false` with
 *  `authorization: Bearer <token>`. */
export interface DesktopPromptInput {
  readonly prompt: string
  readonly queue: boolean
  readonly origin: string
}

/** The two streams this bridge speaks, and the two writes it performs.
 *  Injectable so tests never touch a network, a daemon, or a room. */
export interface RoomAgentTransports {
  /** Room transcript, records with `seq > since`. */
  roomRecords(since: number, signal: AbortSignal): AsyncIterable<TranscriptRecord>
  /** Desktop session transcript, records with `seq > since`. */
  desktopRecords(since: number, signal: AbortSignal): AsyncIterable<TranscriptRecord>
  /** One turn from the room, into the desktop session. */
  promptDesktop(input: DesktopPromptInput): Promise<void>
  /** One turn from the desktop session, back into the room. */
  sendToRoom(text: string): Promise<void>
}

/** Last-seen room sequence, per room code. Injectable for tests. */
/** Last-seen sequence on BOTH streams, per room code. The room cursor is the
 *  load-bearing one (the brief's restart guarantee); the desktop cursor is
 *  persisted alongside it so a restart does not re-read the desktop
 *  session's old turns from zero and post them to the room a second time. */
export interface RoomAgentCursors {
  readonly room: number
  readonly desktop: number
}

export interface CursorStore {
  load(code: string): Promise<RoomAgentCursors>
  save(code: string, cursors: RoomAgentCursors): Promise<void>
}

/** Exact attribution prefix the room service stamps on messages this agent
 *  posts (`src/fanin/index.ts` prefixes `[<displayName> · <tier>] `, and
 *  `sendFromRoomWeb` always uses tier `room-web`). */
export function ownAttribution(name: string): string {
  return `[${name} · room-web]`
}

/** The loop guard: a room record that is this agent's own contribution
 *  coming back down the stream. Forwarding one re-feeds our own words into
 *  the desktop session, which posts them again — a mirror that burns tokens
 *  until someone notices. */
export function isOwnContribution(record: TranscriptRecord, name: string): boolean {
  return isRecordKind(record, "user-prompt") && record.text.startsWith(ownAttribution(name))
}

interface RoomAgentOptions {
  readonly code: string
  readonly name: string
  readonly transports: RoomAgentTransports
  readonly cursors: CursorStore
}

/**
 * The bridge's core. Two independent consume loops over the two injected
 * streams; all sequencing lives in `handleRoomRecord`/`handleDesktopRecord`.
 */
export class RoomAgent {
  private readonly code: string
  private readonly name: string
  private readonly transports: RoomAgentTransports
  private readonly cursors: CursorStore
  private readonly origin: string
  /** Assistant turn being accumulated from the room stream, flushed on
   *  `turn-end` (same shape as src/fanout/reader.ts's consume loop). */
  private roomBuffer = ""
  /** Assistant turn being accumulated from the desktop session stream. */
  private desktopBuffer = ""
  /** Serialized cursor writes: a crash between handling a record and
   *  persisting its seq re-reads that record on restart (at-least-once),
   *  never drops it — but two saves must never interleave their tmp files. */
  private cursorWriteChain: Promise<void> = Promise.resolve()
  /** Per-stream latest seq, seeded from the store at the start of each pass
   *  and merged into every save — the two consume loops advance
   *  independently and must never overwrite each other's position. */
  private lastRoomSeq = 0
  private lastDesktopSeq = 0

  constructor(opts: RoomAgentOptions) {
    this.code = opts.code
    this.name = opts.name
    this.transports = opts.transports
    this.cursors = opts.cursors
    this.origin = `rdv:${opts.name}`
  }

  /** One pass over both streams. Resolves when the ROOM stream ends (clean
   *  close or the signal fires); the desktop stream is consumed alongside it
   *  until then. Reconnection is the caller's job — `runAgent` wraps this. */
  async runPass(signal: AbortSignal): Promise<void> {
    const since = await this.cursors.load(this.code)
    this.lastRoomSeq = since.room
    this.lastDesktopSeq = since.desktop
    await Promise.all([this.consumeRoom(since.room, signal), this.consumeDesktop(since.desktop, signal)])
    await this.cursorWriteChain
  }

  private async consumeRoom(since: number, signal: AbortSignal): Promise<void> {
    for await (const record of this.transports.roomRecords(since, signal)) {
      if (signal.aborted) return
      await this.handleRoomRecord(record)
    }
  }

  private async consumeDesktop(since: number, signal: AbortSignal): Promise<void> {
    for await (const record of this.transports.desktopRecords(since, signal)) {
      if (signal.aborted) return
      await this.handleDesktopRecord(record)
    }
  }

  private persistCursor(cursors: RoomAgentCursors): Promise<void> {
    const next = this.cursorWriteChain.then(() => this.cursors.save(this.code, cursors))
    this.cursorWriteChain = next.catch(() => undefined)
    return next
  }

  private async handleRoomRecord(record: TranscriptRecord): Promise<void> {
    if (isRecordKind(record, "user-prompt")) {
      // Loop guard: our own sends come back attributed `[<name> · room-web]`.
      // Everything else — a human on any tier, or another member agent — is
      // a message this desktop session should see.
      if (!isOwnContribution(record, this.name)) {
        await this.transports.promptDesktop({ prompt: record.text, queue: true, origin: this.origin })
      }
    } else if (isRecordKind(record, "text-delta")) {
      this.roomBuffer += record.text
    } else if (isRecordKind(record, "turn-end")) {
      const text = this.roomBuffer
      this.roomBuffer = ""
      if (text.length > 0) {
        await this.transports.promptDesktop({ prompt: text, queue: true, origin: this.origin })
      }
    }
    // Any other kind still advances the cursor: skipping it must not lose
    // our place.
    this.lastRoomSeq = record.seq
    await this.persistCursor({ room: this.lastRoomSeq, desktop: this.lastDesktopSeq })
  }

  private async handleDesktopRecord(record: TranscriptRecord): Promise<void> {
    this.lastDesktopSeq = record.seq
    if (isRecordKind(record, "text-delta")) {
      this.desktopBuffer += record.text
      return
    }
    if (isRecordKind(record, "turn-end")) {
      const text = this.desktopBuffer
      this.desktopBuffer = ""
      if (text.length > 0) {
        await this.transports.sendToRoom(text)
      }
    }
    await this.persistCursor({ room: this.lastRoomSeq, desktop: this.lastDesktopSeq })
  }
}

/** Reconnect wrapper: hold the room stream forever, backing off when it
 *  drops, always resuming from the persisted cursor. */
export async function runAgent(opts: RoomAgentOptions, signal: AbortSignal): Promise<void> {
  const agent = new RoomAgent(opts)
  let backoffMs = 250
  while (!signal.aborted) {
    let failed = false
    try {
      await agent.runPass(signal)
    } catch (error: unknown) {
      failed = true
      const message = error instanceof Error ? error.message : String(error)
      console.error(`room-agent ${opts.code}: stream failed: ${message}`)
    }
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, backoffMs)
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
    backoffMs = failed ? Math.min(backoffMs * 2, 5000) : 250
  }
}

function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

interface CursorFile {
  readonly roomSeq?: number
  readonly desktopSeq?: number
  /** Pre-two-cursor files carried only the room sequence. */
  readonly lastSeq?: number
}

function isCursorFile(value: unknown): value is CursorFile {
  return typeof value === "object" && value !== null
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

/** `<dataDir>/room-agent/<code>.json` — atomic write, same tmp+rename
 *  pattern as `RoomStore.persist`. A missing or malformed file reads as
 *  cursor 0 on both streams: replaying from the start is the safe direction
 *  (a duplicate line is recoverable, a dropped one is not). */
export class FileCursorStore {
  private readonly dir: string
  private readonly cache: Map<string, RoomAgentCursors> = new Map()

  constructor(dataDir: string) {
    this.dir = join(dataDir, "room-agent")
  }

  private filePath(code: string): string {
    return join(this.dir, `${code}.json`)
  }

  async load(code: string): Promise<RoomAgentCursors> {
    const cached = this.cache.get(code)
    if (cached !== undefined) return cached
    let raw: string
    try {
      raw = await readFile(this.filePath(code), "utf8")
    } catch (error) {
      if (isNodeErrnoException(error) && error.code === "ENOENT") {
        const zero: RoomAgentCursors = { room: 0, desktop: 0 }
        this.cache.set(code, zero)
        return zero
      }
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    const cursors: RoomAgentCursors = isCursorFile(parsed)
      ? { room: numberOr(parsed.roomSeq ?? parsed.lastSeq, 0), desktop: numberOr(parsed.desktopSeq, 0) }
      : { room: 0, desktop: 0 }
    this.cache.set(code, cursors)
    return cursors
  }

  async save(code: string, cursors: RoomAgentCursors): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const filePath = this.filePath(code)
    const tempPath = `${filePath}.${randomUUID()}.tmp`
    await writeFile(
      tempPath,
      JSON.stringify({ roomCode: code, roomSeq: cursors.room, desktopSeq: cursors.desktop }),
      "utf8",
    )
    await rename(tempPath, filePath)
    this.cache.set(code, cursors)
  }
}

// --- HTTP transports (the real wiring) -------------------------------------

/** Both streams over native fetch + the shared SSE parser, both writes over
 *  plain HTTP. The desktop prompt goes through the repo's own
 *  `DaemonClient.prompt` (`?wait=false`, `queue: true`, bearer auth). */
export class HttpRoomAgentTransports implements RoomAgentTransports {
  private readonly roomBase: string
  private readonly code: string
  private readonly name: string
  private readonly daemon: DaemonClient
  private readonly sessionId: string

  constructor(roomBase: string, code: string, name: string, daemon: DaemonClient, sessionId: string) {
    this.roomBase = roomBase.endsWith("/") ? roomBase.slice(0, -1) : roomBase
    this.code = code
    this.name = name
    this.daemon = daemon
    this.sessionId = sessionId
  }

  async *roomRecords(since: number, signal: AbortSignal): AsyncIterable<TranscriptRecord> {
    const res = await fetch(`${this.roomBase}/rooms/${encodeURIComponent(this.code)}/stream?since=${since}`, {
      headers: { accept: "text/event-stream" },
      signal,
    })
    if (!res.ok || res.body === null) {
      throw new Error(`room stream failed: ${res.status}`)
    }
    for await (const data of sseData(res.body)) {
      const record = parseTranscriptRecord(data)
      if (record !== undefined) yield record
    }
  }

  async *desktopRecords(since: number, signal: AbortSignal): AsyncIterable<TranscriptRecord> {
    for await (const record of this.daemon.events(this.sessionId, since, signal)) {
      yield record
    }
  }

  async promptDesktop(input: DesktopPromptInput): Promise<void> {
    const result = await this.daemon.prompt(this.sessionId, {
      prompt: input.prompt,
      queue: input.queue,
      origin: input.origin,
    })
    if (!result.ok) {
      throw new Error(`prompt rejected: ${result.reason}: ${result.message}`)
    }
  }

  async sendToRoom(text: string): Promise<void> {
    const res = await fetch(`${this.roomBase}/rooms/${encodeURIComponent(this.code)}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: this.name, text }),
    })
    if (!res.ok) {
      throw new Error(`room send failed: ${res.status}`)
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs({
    args: process.argv.slice(2),
    options: {
      room: { type: "string" },
      name: { type: "string", default: "Atlas" },
      session: { type: "string" },
      base: { type: "string" },
    },
  })
  const room = args.values.room
  const sessionId = args.values.session
  if (room === undefined || sessionId === undefined) {
    console.error("usage: node scripts/room-agent.ts --room RDV-XXXX --name Atlas --session sess_xxxxx [--base URL]")
    process.exitCode = 1
    return
  }
  const base = args.values.base ?? env.publicUrl
  const daemon = new DaemonClient({ baseUrl: env.daemonUrl, token: env.daemonToken })
  const transports = new HttpRoomAgentTransports(base, room, args.values.name, daemon, sessionId)
  const cursors = new FileCursorStore(env.dataDir)

  console.error(`room-agent: joining ${room} as ${args.values.name} (session ${sessionId})`)
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  await runAgent({ code: room, name: args.values.name, transports, cursors }, controller.signal)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
}
