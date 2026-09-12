import type { RoomStore } from "../rooms/store.ts"
import { deliveryModeOf, type Ask, type Member, type Room } from "../rooms/types.ts"
import type { TtsProvider } from "../media/openai.ts"
import { env } from "../env.ts"
import { publicArtifactUrl, publicMediaUrl } from "../service/artifact-proxy.ts"
import type { MediaRecord, SaveMediaInput } from "../service/media-store.ts"
import {
  attachmentFallbackText,
  hasSendAttachment,
  type OutboundAttachment,
} from "../service/transports.ts"
import { attachmentUrl, parseAttachments, parseSpeech, type ParsedAttachment } from "./attach.ts"

/** Structural subset of `MediaStore` the speech path needs — injectable so
 *  tests never touch a real directory. */
export interface SpeechMediaStore {
  save(roomCode: string, data: Buffer, opts: SaveMediaInput): Promise<MediaRecord>
}
import { renderForTier } from "./render.ts"
import type { FanoutRecord, Transport } from "./types.ts"
import { askMarkerForOthers, askTextForTarget, resolveAskSegments, type ResolvedTurnSegment } from "./ask.ts"
import { renderWhisperForMember, resolveWhisperSegments, type ResolvedSegment } from "./whisper.ts"

const INITIAL_BACKOFF_MS = 250
const MAX_BACKOFF_MS = 5000

/** The attachment URL is behind our own tunnel on a box we control — if it
 *  has not answered in two seconds, it is not going to answer. */
const PROBE_TIMEOUT_MS = 2000

/** Whether a URL actually serves something right now. Injected so tests
 *  never touch the network; the default probes over HTTP (see
 *  `probeArtifactUrl`). A probe that throws — timeout, DNS, anything — is a
 *  failure: an attachment is only ever delivered on a confirmed 2xx. */
export type ArtifactProbe = (url: string) => Promise<boolean>

/** Default probe: `HEAD` with a short timeout, falling back to a ranged `GET`
 *  when the upstream rejects `HEAD` (405) or the `HEAD` itself fails at the
 *  transport level. Only a 2xx answer counts as "served". */
export async function probeArtifactUrl(url: string): Promise<boolean> {
  try {
    const head = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (head.ok) return true
    if (head.status !== 405) return false
  } catch {
    // Fall through to the ranged GET: some servers refuse HEAD outright, and
    // the GET is the authoritative answer either way.
  }
  try {
    const range = await fetch(url, { headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return range.ok
  } catch {
    return false
  }
}

/** Where the agent is told to put a file it wants members to receive — the
 *  directory the artifact app actually serves. */
export function servedDir(): string {
  return `${env.artifactAppDir}/.agentproto/ui`
}

/** What the AGENT sees when an attachment URL probed dead. Names the file,
 *  the URL that 404'd, and the one directory that works — everything it
 *  needs to fix this without guessing. */
function unservableCorrection(name: string, url: string): string {
  return `[system · artifact] The file "${name}" from your "[[attach ${name}]]" did NOT reach any member: nothing is served at ${url}. Members only receive files that exist in ${servedDir()} — write it there, then attach it again.`
}

/** What the MEMBER sees instead of a dead link: short, honest, no URL. */
function unservableNotice(name: string): string {
  return `Sorry — the room said it attached "${name}", but the file was not actually sent. Nothing to download yet; the room has been told to fix it.`
}

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
  /** Per-room, in-process only: `room.deliverySeq` as of the last flush of a
   *  `"tools"` room. A turn that ends with it unchanged means the agent
   *  called neither `say` nor `whisper` — nobody's phone received anything
   *  (PLAN risk R2). Logged, not fixed: the web transcript still shows the
   *  turn, so a human can see why.
   *
   *  It reads the COUNTER, never `deliveries.length`. The array is a work
   *  queue that keeps a short tail, not a log: `pruneDeliveries` drops
   *  `delivered` records past `MAX_RETAINED_DELIVERED`, so its length stops
   *  growing once a room is busy — and a length compared against the
   *  previous length then matches on every single turn, warning "no phone
   *  received anything" precisely when the agent IS addressing people. A
   *  detector that cries wolf permanently is worse than none, and this is
   *  the only handle we have on R2. `deliverySeq` never goes backwards. */
  private readonly lastDeliverySeq: Map<string, number> = new Map()

  /** Both undefined unless TTS is configured. `[[say …]]` needs somewhere to
   *  put the rendered audio (the media store, which the artifact-independent
   *  `/r/:code/media/:id` route serves) as well as something to render it. */
  private readonly tts: TtsProvider | undefined
  private readonly mediaStore: SpeechMediaStore | undefined

  private readonly probeUrl: ArtifactProbe
  /** Fan-in callback for "this attachment is not actually being served",
   *  wired by `RoomService` to the same `queue: true` prompt path a member
   *  message takes. The agent is the only party that can fix a missing
   *  artifact, so it is the only party that must be told. */
  private readonly reportUnservable: ((code: string, correction: string) => Promise<void>) | undefined

  constructor(opts: {
    store: RoomStore
    transport: Transport
    source: Source
    isAlive?: IsAlive
    tts?: TtsProvider
    mediaStore?: SpeechMediaStore
    probeUrl?: ArtifactProbe
    reportUnservable?: (code: string, correction: string) => Promise<void>
  }) {
    this.store = opts.store
    this.transport = opts.transport
    this.source = opts.source
    this.isAlive = opts.isAlive ?? (async () => true)
    this.tts = opts.tts
    this.mediaStore = opts.mediaStore
    this.probeUrl = opts.probeUrl ?? probeArtifactUrl
    this.reportUnservable = opts.reportUnservable
  }

  start(code: string): void {
    if (this.readers.has(code)) return
    const room = this.store.get(code)
    if (room === undefined || room.sessionId === undefined) return

    // Seed the R2 detector from where the room already is, so the first flush
    // after a restart compares against the counter's real value rather than
    // against 0 — otherwise a resumed room with prior deliveries looks active
    // on its first turn no matter what the agent did, and a genuinely silent
    // first turn goes unreported.
    this.lastDeliverySeq.set(code, room.deliverySeq ?? 0)

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

  /** One attachment to one member. Never throws: a provider rejecting a file
   *  must not take down the rest of the turn's delivery, and the failure is
   *  logged rather than swallowed. */
  /**
   * Render each `[[say …]]` into a real voice note, once per turn rather than
   * once per member: the audio is identical for everyone, and TTS is the
   * expensive part.
   *
   * Returns `[]` when TTS is not configured or a render fails — and in the
   * failure case the words are NOT lost, because `renderSpeech`'s caller has
   * already put them in the caption. A room where the voice note fails should
   * read the sentence, not fall silent.
   */
  private async renderSpeech(code: string, spoken: readonly string[]): Promise<OutboundAttachment[]> {
    if (spoken.length === 0) return []
    const tts = this.tts
    const mediaStore = this.mediaStore
    if (tts === undefined || mediaStore === undefined) {
      // Nothing to render with. The text is already back in the caption path
      // below, so members still get the words.
      return spoken.map((text) => ({
        url: "",
        filename: "",
        mimeType: "",
        kind: "audio" as const,
        caption: text,
      }))
    }

    const notes: OutboundAttachment[] = []
    for (const text of spoken) {
      try {
        const audio = await tts.speak(text)
        if (audio === undefined) {
          notes.push({ url: "", filename: "", mimeType: "", kind: "audio", caption: text })
          continue
        }
        const record = await mediaStore.save(code, Buffer.from(audio.bytes), {
          contentType: audio.mime,
          pages: 1,
        })
        notes.push({
          url: publicMediaUrl(code, record.id),
          filename: `voice.${audio.extension}`,
          mimeType: audio.mime,
          kind: "audio",
          caption: text,
        })
      } catch (error: unknown) {
        console.error(
          `tts failed for room ${code}: ${error instanceof Error ? error.message : String(error)}`,
        )
        notes.push({ url: "", filename: "", mimeType: "", kind: "audio", caption: text })
      }
    }
    return notes
  }

  /** Deliver an already-built attachment. A voice note whose render failed
   *  has no URL — it is sent as its caption, so the sentence still arrives. */
  private async deliverAttachment(member: Member, code: string, attachment: OutboundAttachment): Promise<void> {
    try {
      if (attachment.url.length === 0) {
        const text = attachment.caption
        if (text !== undefined && text.length > 0) {
          await this.transport.send(member, { text, artifactUrl: undefined })
        }
        return
      }
      if (hasSendAttachment(this.transport)) {
        await this.transport.sendAttachment(member, attachment)
        return
      }
      await this.transport.send(member, { text: attachmentFallbackText(attachment), artifactUrl: undefined })
    } catch (error: unknown) {
      console.error(
        `failed to deliver attachment to ${member.displayName} in ${code}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  /** One correction into the room's session per missing file, via the
   *  injected fan-in callback (RoomService's `queue: true` prompt path — the
   *  same path a member message takes, so it queues mid-turn instead of
   *  being lost). Never throws: a failed correction is logged, and the
   *  members' honest line has already gone out regardless. */
  private async reportUnservableArtifacts(
    code: string,
    unserved: ReadonlyArray<{ attachment: ParsedAttachment; url: string }>,
  ): Promise<void> {
    const report = this.reportUnservable
    if (report === undefined) return
    for (const { attachment, url } of unserved) {
      try {
        await report(code, unservableCorrection(attachment.name, url))
      } catch (error: unknown) {
        console.error(
          `failed to report unserved attachment ${attachment.name} in ${code}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
  }

  private async sendAttachment(member: Member, code: string, parsed: ParsedAttachment): Promise<void> {
    const attachment: OutboundAttachment = {
      url: attachmentUrl(publicArtifactUrl(code), parsed.name),
      filename: parsed.name,
      mimeType: parsed.mimeType,
      kind: parsed.kind,
      caption: parsed.caption,
    }
    try {
      if (hasSendAttachment(this.transport)) {
        await this.transport.sendAttachment(member, attachment)
        return
      }
      await this.transport.send(member, { text: attachmentFallbackText(attachment), artifactUrl: undefined })
    } catch (error: unknown) {
      console.error(
        `failed to send attachment ${parsed.name} to ${member.displayName} in ${code}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  private async flush(code: string, rawText: string, seq: number): Promise<void> {
    const room = this.store.get(code)
    if (room === undefined) return

    // `[[attach …]]` and `[[say …]]` come out FIRST, before whisper/ask
    // parsing, so a marker inside a whisper block is not silently swallowed
    // with it and never reaches a member as literal text. Attached files are
    // already served by the artifact proxy; spoken text is rendered below.
    const withoutAttachments = parseAttachments(rawText)
    const { text, spoken } = parseSpeech(withoutAttachments.text)
    const attachments = withoutAttachments.attachments
    const voiceNotes = await this.renderSpeech(code, spoken)

    // Nothing is claimed without proof: each attachment URL is probed once
    // per turn (not once per member) and only confirmed-alive files go out.
    // A 404 here is exactly how the MilanoTripItinerary bug happened — the
    // agent attached a name it never wrote into the served directory, and
    // every member got a dead link plus a confident "sent!" from the agent.
    const served: ParsedAttachment[] = []
    const unserved: Array<{ attachment: ParsedAttachment; url: string }> = []
    for (const attachment of attachments) {
      const url = attachmentUrl(publicArtifactUrl(code), attachment.name)
      let alive = false
      try {
        alive = await this.probeUrl(url)
      } catch {
        alive = false
      }
      if (alive) served.push(attachment)
      else unserved.push({ attachment, url })
    }
    if (unserved.length > 0) {
      await this.reportUnservableArtifacts(code, unserved)
    }

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

    // `protocol === "tools"` gates ONLY the agent's bare text: under the
    // tools protocol a person hears from the agent when, and only when, it
    // calls `say`/`whisper` — the turn's own text is thinking, projected on
    // the web page. Everything else below (attachments, voice notes, the
    // unservable notices, the cursor) runs identically for both protocols.
    const textGated = room.protocol === "tools"

    await Promise.allSettled(
      room.members.map(async (member) => {
        if (textGated) {
          // The artifact-change notice is not the agent's speech — it is the
          // room telling members its deliverable moved — so it survives the
          // gate as its own standalone message. This is the same line
          // `renderMessenger` appends to the text for `"markers"` rooms;
          // here the text itself is suppressed, so the line must not be.
          // It rides the push transports only (the former `tier !==
          // "room-web"` sniff, expressed through the delivery union instead):
          // a pull member IS the screen — it is watching the artifact live —
          // and has no push transport at all.
          if (artifactChanged && artifactUrl !== undefined && deliveryModeOf(member) === "push") {
            await this.transport.send(member, { text: artifactUrl, artifactUrl })
          }
        } else {
          const memberText = renderTurnForMember(pieces, member)
          const message = renderForTier(member.tier, memberText, artifactUrl, artifactChanged)
          if (message !== undefined) {
            await this.transport.send(member, message)
          }
        }
        // Attachments go to everyone, after the text, and are independent of
        // it: a turn that is nothing BUT an attachment still delivers the
        // file, even though `renderForTier` had no text to render.
        for (const attachment of served) {
          await this.sendAttachment(member, code, attachment)
        }
        // A file that probed dead is never replaced by a link or a fallback:
        // members get the honest one-liner instead, because the room said it
        // was sending a file and did not.
        for (const { attachment } of unserved) {
          await this.transport.send(member, { text: unservableNotice(attachment.name), artifactUrl: undefined })
        }
        for (const note of voiceNotes) {
          await this.deliverAttachment(member, code, note)
        }
      }),
    )

    // PLAN risk R2: for a `"tools"` room, delivery depends on the agent
    // actually calling `say`/`whisper`. The counter moved during the turn if
    // it did (the tool handlers write before turn-end, and this room was read
    // at the top of `flush`, after it). A turn that left it where it was sent
    // nothing to anyone's phone while the web page looks healthy; say so.
    if (textGated) {
      const seq = room.deliverySeq ?? 0
      if (seq === (this.lastDeliverySeq.get(code) ?? 0)) {
        console.warn(`room ${code}: turn ended with zero say/whisper tool calls — no phone received anything this turn`)
      }
      this.lastDeliverySeq.set(code, seq)
    }

    // Cursor is persisted only after the flush attempt: a crash between send and
    // persist re-sends this turn on the next boot (at-least-once), never drops it.
    await this.store.update(code, { cursor: seq })
  }
}
