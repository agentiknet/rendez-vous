import type { DaemonClient, HealthResult, PromptResult } from "../daemon/client.ts"
import type { TranscriptRecord } from "../daemon/records.ts"
import { AgentpushToolClient } from "../channels/agentpush/tools-client.ts"
import { env } from "../env.ts"
import { fanIn } from "../fanin/index.ts"
import { RoomFanout } from "../fanout/reader.ts"
import type { Transport } from "../fanout/types.ts"
import { joinLinks, qrPng, type JoinLinks } from "../links/index.ts"
import { ensureMembership, handleCommand, parseCommand } from "../rooms/commands.ts"
import type { RoomStore } from "../rooms/store.ts"
import type { Address, Member, Room, Tier } from "../rooms/types.ts"
import { publicArtifactUrl, publicMediaUrl } from "./artifact-proxy.ts"
import type { SessionBooter } from "./booter.ts"
import { isSandboxAlive, type BoxLivenessCheck } from "./box-liveness.ts"
import { isSessionAlive, type DaemonExtraOptions } from "./daemon-extra.ts"
import { DeliverableAwareTransport, DeliverableService, parseDeliverableCommand } from "./deliverable.ts"
import { MediaStore } from "./media-store.ts"
import { buildSessionRecap } from "./recap.ts"
import { hasSendMedia } from "./transports.ts"

/** What every member-facing surface shows instead of `room.artifactUrl`
 *  (architecture.md §9.3b): the raw e2b URL is a pure function of sandbox id
 *  and port, so it dies the moment the box is replaced. This is the stable,
 *  room-code-keyed URL that survives that — the raw URL never leaves the
 *  store. */
function memberFacingArtifactUrl(room: Room): string | undefined {
  if (room.artifactUrl === undefined || room.artifactReady === false) return undefined
  return publicArtifactUrl(room.code)
}

export interface InboundInput {
  address: Address
  displayName: string
  tier: Tier
  text: string
}

export type InboundOutcome =
  | { kind: "created"; room: Room; member: Member }
  | { kind: "joined"; room: Room; member: Member }
  | { kind: "moved"; room: Room; member: Member; from: string }
  | { kind: "resumed"; room: Room; member: Member }
  | { kind: "message"; room: Room; member: Member }
  | { kind: "left"; room: Room; member: Member }
  | { kind: "not-in-room" }
  | { kind: "unknown-code" }
  | { kind: "unknown-sender" }

export type RoomWebSendOutcome =
  | { kind: "sent"; member: Member; result: PromptResult }
  | { kind: "delivered"; member: Member; text: string }
  | { kind: "unknown-code" }
  | { kind: "no-session" }

const RESUMING_TEXT = "Resuming room, one moment…"

/** The one line of "how to use me" every member gets. It earns its place:
 *  `@me` is invisible otherwise, and a capability nobody knows about is not
 *  a capability. Kept to a single short line because most members read this
 *  on a phone. */
const AUDIENCE_HINT = "Everything you send goes to the whole room. Start with `@me` to get an answer only you can see."

function welcomeText(prefix: string, room: Room): string {
  const lines = [`${prefix}: ${room.code}`]
  const artifactUrl = memberFacingArtifactUrl(room)
  if (artifactUrl !== undefined) {
    lines.push(artifactUrl)
  }
  lines.push(AUDIENCE_HINT)
  return lines.join("\n")
}

function activeRoomStatusText(room: Room): string {
  const lines = [`Room ${room.code} is already active.`]
  const artifactUrl = memberFacingArtifactUrl(room)
  if (artifactUrl !== undefined) {
    lines.push(artifactUrl)
  }
  return lines.join("\n")
}

function currentJoinLinks(code: string): JoinLinks {
  return joinLinks(code, {
    publicUrl: env.publicUrl,
    whatsappNumber: env.whatsappNumber,
    telegramBot: env.telegramBot,
    smsNumber: env.smsNumber,
  })
}

function newRoomReplyText(room: Room, links: JoinLinks): string {
  const lines = [`Room created: ${room.code}`]
  const artifactUrl = memberFacingArtifactUrl(room)
  if (artifactUrl !== undefined) {
    lines.push(artifactUrl)
  }
  lines.push(links.web)
  if (links.whatsapp !== undefined) lines.push(links.whatsapp)
  if (links.telegram !== undefined) lines.push(links.telegram)
  if (links.sms !== undefined) lines.push(links.sms)
  return lines.join("\n")
}

function joinRoomReplyText(room: Room): string {
  const lines = [`Joined room: ${room.code}`]
  const roster = room.members.map((member) => member.displayName).join(", ")
  if (roster.length > 0) {
    lines.push(`With: ${roster}`)
  }
  const artifactUrl = memberFacingArtifactUrl(room)
  if (artifactUrl !== undefined) {
    lines.push(artifactUrl)
  }
  return lines.join("\n")
}

/** Stable, deterministic contact ref for a room-web guest: the same
 *  displayName always resolves to the same member, wherever they're
 *  currently registered — there is no browser/session id to key on
 *  instead, so a name typed into a different room's page is treated as
 *  that guest moving rooms, same rule `join` applies to a phone number or
 *  email address. */
function slugify(displayName: string): string {
  const slug = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.length > 0 ? slug : "guest"
}

export class RoomService {
  private readonly store: RoomStore
  private readonly client: DaemonClient
  private readonly booter: SessionBooter
  private readonly transport: Transport
  private readonly daemon: DaemonExtraOptions
  private readonly mediaStore: MediaStore
  private readonly deliverable: DeliverableService
  private readonly fanout: RoomFanout
  private readonly idlePauseMs: number
  private readonly idleSweepMs: number
  private readonly boxProbeMs: number
  /** Cursor last observed per room, sweep to sweep — a jump means the room's
   *  own fan-out flushed something new since the last tick, which counts as
   *  activity just as much as an inbound message (R10). Cheaper and more
   *  robust than threading a callback through `RoomFanout` (outside this
   *  file's ownership): the cursor it already persists on every flush is
   *  itself the signal, sampled at sweep granularity. */
  private readonly lastSeenCursor = new Map<string, number>()
  /** Last time (`Date.now()`) each room's box was probed for liveness via the
   *  e2b API (docs/UPSTREAM.md #10) — in-process only, reset on restart, so a
   *  fresh process simply probes every active room again on its first sweep
   *  rather than waiting out the interval a second time. */
  private readonly lastBoxProbeAt = new Map<string, number>()
  private readonly checkBoxLiveness: BoxLivenessCheck
  /** Per-room-code serialization for `doResume` (see `withRoomLock`'s doc) —
   *  in-process only, and empty entries are never cleaned up eagerly; each
   *  slot holds only the tail of that room's own chain, so this stays one
   *  entry per room ever resumed, not per call. */
  private readonly roomLocks = new Map<string, Promise<unknown>>()
  private idleSweepTimer: ReturnType<typeof setInterval> | undefined

  constructor(opts: {
    store: RoomStore
    client: DaemonClient
    booter: SessionBooter
    transport: Transport
    idlePauseMinutes?: number
    idleSweepSeconds?: number
    boxProbeMinutes?: number
    /** Injectable for tests — see `BoxLivenessCheck`'s doc. Defaults to the
     *  real e2b API call. */
    checkBoxLiveness?: BoxLivenessCheck
    /** Defaults to the same daemon connection the rest of the process uses
     *  (`env.daemonUrl`/`env.daemonToken`) — override in tests to point at a
     *  fake daemon instead. Needed for the out-of-band-kill liveness check
     *  (`reviveIfSessionDied`) and the fan-out reader's own dead-session
     *  detection, neither of which can be derived from `DaemonClient` (it
     *  keeps its base URL/token private). */
    daemon?: DaemonExtraOptions
    /** Overrides the default `MediaStore`/`DeliverableService` pair for
     *  tests — inject `mediaStore` alone to point rendered PDFs at a temp
     *  dir while keeping the real render/send pipeline, or `deliverable`
     *  alone for a fully scripted delivery flow. When `deliverable` is
     *  given without `mediaStore`, the media HTTP route
     *  (`RoomService.readMedia`) reads through whichever `MediaStore` the
     *  caller built that `DeliverableService` with, not this one — pass
     *  both together in that case. */
    mediaStore?: MediaStore
    deliverable?: DeliverableService
  }) {
    this.store = opts.store
    this.client = opts.client
    this.booter = opts.booter
    this.transport = opts.transport
    this.daemon = opts.daemon ?? { baseUrl: env.daemonUrl, token: env.daemonToken }
    this.idlePauseMs = (opts.idlePauseMinutes ?? env.idlePauseMinutes) * 60_000
    this.idleSweepMs = (opts.idleSweepSeconds ?? env.idleSweepSeconds) * 1000
    this.boxProbeMs = (opts.boxProbeMinutes ?? env.boxProbeMinutes) * 60_000
    this.checkBoxLiveness = opts.checkBoxLiveness ?? ((sandboxId) => isSandboxAlive(sandboxId))
    this.mediaStore = opts.mediaStore ?? new MediaStore()
    this.deliverable =
      opts.deliverable ??
      new DeliverableService({
        mediaStore: this.mediaStore,
        client: this.client,
        // Persist pending deliveries on the room record so they survive a
        // restart (docs/DELIVERABLE.md) — the minimal wiring hook.
        store: this.store,
        agentpush:
          env.agentpushUrl !== undefined ? new AgentpushToolClient({ baseUrl: env.agentpushUrl, apiKey: env.agentpushKey }) : undefined,
      })
    this.fanout = new RoomFanout({
      store: this.store,
      transport: new DeliverableAwareTransport(this.transport, this.deliverable, this.store),
      source: (sessionId, since, signal) => this.client.events(sessionId, since, signal),
      isAlive: (sessionId) => isSessionAlive(this.daemon, sessionId),
    })
  }

  /** Start fan-out for every active room with a live session, and the idle sweep. */
  start(): void {
    for (const room of this.store.list()) {
      if (room.sessionId !== undefined && room.state === "active") {
        this.fanout.start(room.code)
      }
    }
    this.idleSweepTimer = setInterval(() => {
      this.sweepIdleRooms().catch((error: unknown) => {
        console.error(`idle sweep failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, this.idleSweepMs)
    this.idleSweepTimer.unref()
  }

  async stop(): Promise<void> {
    if (this.idleSweepTimer !== undefined) {
      clearInterval(this.idleSweepTimer)
      this.idleSweepTimer = undefined
    }
    await this.fanout.stopAll()
  }

  getRoom(code: string): Room | undefined {
    return this.store.get(code)
  }

  roomCount(): number {
    return this.store.list().length
  }

  /** Whether some room already has a member at this provider+contactRef,
   *  regardless of which room's code that member joined under (a member's
   *  stored `address.source` is the room code it joined, so an exact-address
   *  lookup would miss them unless the caller already knows the code). Used
   *  by the tier-2 mail webhook (docs/AGENTPUSH.md §8.5) to decide whether a
   *  subject-line room code hint should be treated as an implicit `join`. */
  hasMemberAcrossRooms(provider: string, contactRef: string): boolean {
    for (const room of this.store.list()) {
      if (room.members.some((member) => member.address.provider === provider && member.address.contactRef === contactRef)) {
        return true
      }
    }
    return false
  }

  /** `GET /r/:code/media/:id` (docs/DELIVERABLE.md) — `undefined` for an
   *  unknown room or an unknown/missing media id, never throws. */
  async readMedia(code: string, id: string): Promise<Buffer | undefined> {
    const room = this.store.get(code)
    if (room === undefined) return undefined
    return this.mediaStore.read(room.code, id)
  }

  async daemonHealth(): Promise<HealthResult | "unreachable"> {
    try {
      return await this.client.health()
    } catch {
      return "unreachable"
    }
  }

  /** Raw transcript passthrough for the tier-3 web view's own SSE reader (R6:
   *  the browser talks only to us, never the daemon — this is the one seam
   *  that keeps the bearer inside the service). */
  events(sessionId: string, since: number, signal: AbortSignal): AsyncIterable<TranscriptRecord> {
    return this.client.events(sessionId, since, signal)
  }

  /** Pause a room right now, regardless of idle time — the idle sweep's own
   *  early exit, exposed so callers (the no-phone e2b proof) can force the
   *  same path without waiting out the real threshold. A no-op for a room
   *  that's already paused or doesn't exist. */
  async pauseRoom(code: string): Promise<void> {
    const room = this.store.get(code)
    if (room === undefined || room.state !== "active") return
    await this.doPause(room)
  }

  /** Checked every `idleSweepSeconds`; pauses any active room whose cursor
   *  hasn't moved and whose `lastActivityAt` is older than `idlePauseMinutes`
   *  (R10 — nothing upstream enforces this, so the room service must). Also
   *  probes each active room's own box for liveness (docs/UPSTREAM.md #10),
   *  independent of idle time — a box can vanish mid-conversation. */
  async sweepIdleRooms(): Promise<void> {
    const now = Date.now()
    for (const room0 of this.store.list()) {
      const room = room0.state === "active" ? await this.probeBoxLiveness(room0, now) : room0

      const previousCursor = this.lastSeenCursor.get(room.code)
      if (room.cursor !== previousCursor) {
        this.lastSeenCursor.set(room.code, room.cursor)
        if (previousCursor !== undefined) {
          await this.store.update(room.code, { lastActivityAt: new Date().toISOString() })
        }
        continue
      }

      if (room.state !== "active" || room.sessionId === undefined) continue
      const lastActivityMs = Date.parse(room.lastActivityAt)
      if (!Number.isFinite(lastActivityMs)) continue
      if (now - lastActivityMs >= this.idlePauseMs) {
        await this.doPause(room)
      }
    }
  }

  /** At most once per `boxProbeMinutes`, ask e2b directly whether this room's
   *  box still exists. A box confirmed GONE marks the room `artifactReady:
   *  false` and pauses it — the same shape as `doPause` — so the web page and
   *  fan-out stop claiming the artifact is live, and the next message (or an
   *  explicit `resume`) drives it through `reviveIfSessionDied`/`doResume`,
   *  which boot a fresh box (`E2bBooter.resume`'s own liveness gate). A room
   *  with no `sandboxId` (`LocalBooter`) or a probe result of `"alive"`,
   *  `"paused"`, or `"unknown"` returns the room unchanged — `"unknown"` (a
   *  network error reaching e2b) must never be treated as gone. */
  private async probeBoxLiveness(room: Room, now: number): Promise<Room> {
    if (room.sandboxId === undefined) return room
    const lastProbe = this.lastBoxProbeAt.get(room.code)
    if (lastProbe !== undefined && now - lastProbe < this.boxProbeMs) return room
    this.lastBoxProbeAt.set(room.code, now)

    const liveness = await this.checkBoxLiveness(room.sandboxId)
    if (liveness !== "gone") return room

    await this.doPause(room, { artifactReady: false })
    return this.store.get(room.code) ?? room
  }

  /** A plain message from the room-web tier: no `new`/`join`/`resume`
   *  commands accepted here, the caller already knows the room. */
  async sendFromRoomWeb(code: string, displayName: string, text: string): Promise<RoomWebSendOutcome> {
    let room = this.store.get(code)
    if (room === undefined) {
      return { kind: "unknown-code" }
    }
    room = await this.reviveIfSessionDied(room)
    if (room.sessionId === undefined && room.state !== "paused") {
      return { kind: "no-session" }
    }

    const { member } = await ensureMembership(this.store, room.code, {
      displayName,
      tier: "room-web",
      address: { provider: "room-web", source: "room-web", contactRef: slugify(displayName) },
    })

    const deliverableText = await this.resolveDeliverableText(room, member, text)
    if (deliverableText !== undefined) {
      await this.broadcast(room, deliverableText)
      return { kind: "delivered", member, text: deliverableText }
    }

    if (room.state === "paused") {
      await this.transport.send(member, { text: RESUMING_TEXT, artifactUrl: memberFacingArtifactUrl(room) })
      room = await this.doResume(room)
    }
    if (room.sessionId === undefined) {
      return { kind: "no-session" }
    }

    const result = await fanIn(this.client, room.sessionId, member, text)
    await this.touchActivity(room.code)
    return { kind: "sent", member, result }
  }

  async handleInbound(input: InboundInput): Promise<InboundOutcome> {
    const sender = { displayName: input.displayName, tier: input.tier, address: input.address }
    const command = parseCommand(input.text)

    if (command !== undefined) {
      switch (command.kind) {
        case "new":
          return this.handleNew(sender)
        case "join":
          return this.handleJoin(command.code, sender, input)
        case "resume":
          return this.handleResume(command.code, sender, input)
        case "leave":
          return this.handleLeave(sender, input)
      }
    }

    return this.handleMessage(input)
  }

  private async handleNew(sender: Omit<Member, "id" | "joinedAt">): Promise<InboundOutcome> {
    const result = await handleCommand(this.store, { kind: "new" }, sender)
    if (!result.ok) {
      // "new" never fails at the command layer; this branch only exists for exhaustiveness.
      return { kind: "unknown-code" }
    }
    const booted = await this.booter.boot(result.room, { label: `rdv-${result.room.code}` })
    const room = await this.store.update(result.room.code, {
      sessionId: booted.sessionId,
      sandboxId: booted.sandboxId,
      artifactUrl: booted.artifactUrl,
      artifactReady: booted.artifactReady,
      state: "active",
      lastActivityAt: new Date().toISOString(),
    })
    this.fanout.start(room.code)

    const links = currentJoinLinks(room.code)
    await this.transport.send(result.member, { text: newRoomReplyText(room, links), artifactUrl: memberFacingArtifactUrl(room) })
    await this.sendJoinQr(result.member, room, links)

    return { kind: "created", room, member: result.member }
  }

  private async handleJoin(
    code: string,
    sender: Omit<Member, "id" | "joinedAt">,
    input: InboundInput,
  ): Promise<InboundOutcome> {
    const result = await handleCommand(this.store, { kind: "join", code }, sender)
    if (!result.ok) {
      await this.replyGuidance(input, "That room code isn't known. Send `new` to start one.")
      return { kind: "unknown-code" }
    }
    this.fanout.start(result.room.code)
    await this.touchActivity(result.room.code)

    if (result.movedFrom !== undefined) {
      await this.transport.send(result.member, {
        text: `Moved from ${result.movedFrom} to ${result.room.code}.`,
        artifactUrl: memberFacingArtifactUrl(result.room),
      })
      return { kind: "moved", room: result.room, member: result.member, from: result.movedFrom }
    }

    await this.transport.send(result.member, {
      text: joinRoomReplyText(result.room),
      artifactUrl: memberFacingArtifactUrl(result.room),
    })
    return { kind: "joined", room: result.room, member: result.member }
  }

  private async handleLeave(sender: Omit<Member, "id" | "joinedAt">, input: InboundInput): Promise<InboundOutcome> {
    const result = await handleCommand(this.store, { kind: "leave" }, sender)
    if (!result.ok) {
      await this.replyGuidance(input, "You're not in a room. Send `new` or `join RDV-XXXX`.")
      return { kind: "not-in-room" }
    }
    await this.transport.send(result.member, {
      text: `You left ${result.room.code}. Send \`new\` or \`join RDV-XXXX\`.`,
      artifactUrl: undefined,
    })
    return { kind: "left", room: result.room, member: result.member }
  }

  /** Only when the transport can actually deliver an image (R6-adjacent: the
   *  QR just encodes the same public web join link, no daemon access needed). */
  private async sendJoinQr(member: Member, room: Room, links: JoinLinks): Promise<void> {
    const transport = this.transport
    if (!hasSendMedia(transport)) return
    const png = await qrPng(links.web)
    // Publish the bytes before sending. Telegram has no upload path of its
    // own and can only send media by public URL, so without this the QR
    // reaches a Telegram member as the caption alone — a "scan this" with
    // nothing to scan. Publishing is cheap and the URL is the same one the
    // deliverable flow already serves.
    const publicUrl = await this.publishPng(room, png)
    await transport.sendMedia(member, png, `Scan to join ${room.code}`, publicUrl)
  }

  /** Store a PNG against the room and return its public URL, or `undefined`
   *  if it could not be stored — a QR that fails to publish must still go
   *  out as a caption rather than throwing inside a join. */
  private async publishPng(room: Room, png: Uint8Array): Promise<string | undefined> {
    try {
      const record = await this.mediaStore.save(room.code, Buffer.from(png), {
        contentType: "image/png",
        pages: 1,
      })
      return publicMediaUrl(room.code, record.id)
    } catch {
      return undefined
    }
  }

  private async handleResume(
    code: string,
    sender: Omit<Member, "id" | "joinedAt">,
    input: InboundInput,
  ): Promise<InboundOutcome> {
    const result = await handleCommand(this.store, { kind: "resume", code }, sender)
    if (!result.ok) {
      await this.replyGuidance(input, "That room code isn't known. Send `new` to start one.")
      return { kind: "unknown-code" }
    }

    const room = await this.reviveIfSessionDied(result.room)
    if (room.state === "active") {
      await this.transport.send(result.member, {
        text: activeRoomStatusText(room),
        artifactUrl: memberFacingArtifactUrl(room),
      })
      return { kind: "resumed", room, member: result.member }
    }

    const resumed = await this.doResume(room)
    await this.transport.send(result.member, {
      text: welcomeText("Resumed room", resumed),
      artifactUrl: memberFacingArtifactUrl(resumed),
    })
    return { kind: "resumed", room: resumed, member: result.member }
  }

  private async handleMessage(input: InboundInput): Promise<InboundOutcome> {
    const found = this.store.findByAddress(input.address)
    if (found === undefined) {
      await this.replyGuidance(input, "Send `new` to start a room, or `join RDV-XXXX` to join one.")
      return { kind: "unknown-sender" }
    }

    let { room } = found
    const { member } = found

    const deliverableText = await this.resolveDeliverableText(room, member, input.text)
    if (deliverableText !== undefined) {
      await this.broadcast(room, deliverableText)
      return { kind: "message", room, member }
    }

    room = await this.reviveIfSessionDied(room)
    if (room.state === "paused") {
      await this.transport.send(member, { text: RESUMING_TEXT, artifactUrl: memberFacingArtifactUrl(room) })
      room = await this.doResume(room)
    }

    if (room.sessionId === undefined) {
      await this.transport.send(member, {
        text: `This room has no live session yet — try \`resume ${room.code}\`.`,
        artifactUrl: memberFacingArtifactUrl(room),
      })
      return { kind: "message", room, member }
    }

    const result = await fanIn(this.client, room.sessionId, member, input.text)
    await this.touchActivity(room.code)
    if (!result.ok) {
      await this.transport.send(member, {
        text: `Could not deliver your message: ${result.message}`,
        artifactUrl: memberFacingArtifactUrl(room),
      })
    }
    return { kind: "message", room, member }
  }

  /** `send pdf to <address>` / `confirm <token>` / `cancel <token>`
   *  (docs/DELIVERABLE.md) — any member, any tier. Returns `undefined` when
   *  `text` isn't one of these commands, so the caller falls through to the
   *  ordinary chat/fan-in path unchanged. Deliberately does not revive a
   *  paused session first: none of these three actions need the agent's
   *  session to be running (rendering only needs the stored `artifactUrl` to
   *  be reachable, and confirming/cancelling touches no session at all) —
   *  only the transcript audit note (`DeliverableService`'s own
   *  `postSystemNote`) is skipped when there is no live session to post it to. */
  private async resolveDeliverableText(room: Room, member: Member, text: string): Promise<string | undefined> {
    const command = parseDeliverableCommand(text)
    if (command === undefined) return undefined

    if (command.kind === "send") {
      const outcome = await this.deliverable.requestFromCommand(room, member, command.to)
      return outcome.ok ? outcome.previewText : `Could not start that delivery: ${outcome.error}`
    }

    if (command.kind === "confirm") {
      const outcome = await this.deliverable.confirm(room, member, command.token)
      if (outcome.kind === "sent") return outcome.resultText
      if (outcome.kind === "not-found") return `No pending delivery found for token ${command.token}.`
      return `Delivery ${command.token} expired 30 minutes after it was requested — ask again.`
    }

    const outcome = await this.deliverable.cancel(room, member, command.token)
    if (outcome.kind === "cancelled") return `Delivery ${command.token} cancelled — nothing sent.`
    if (outcome.kind === "not-found") return `No pending delivery found for token ${command.token}.`
    return `Delivery ${command.token} had already expired — nothing was sent.`
  }

  /** Every deliverable preview/confirmation/cancellation reaches every
   *  current member, not just whoever triggered it — the whole point of the
   *  preview gate is that anyone in the room can see and confirm it. */
  private async broadcast(room: Room, text: string): Promise<void> {
    const artifactUrl = memberFacingArtifactUrl(room)
    await Promise.allSettled(room.members.map((member) => this.transport.send(member, { text, artifactUrl })))
  }

  private async touchActivity(code: string): Promise<void> {
    await this.store.update(code, { lastActivityAt: new Date().toISOString() })
  }

  /** A session that dies out of band — a daemon kill, a crash, a daemon
   *  restart — never runs `doPause`, so the room is left `state: "active"`
   *  pointing at a dead `sessionId` with no self-healing path: auto-resume
   *  only fires from a `state: "paused"` room, and `resume <code>` on an
   *  "active" room used to just reply "already active" (Rehearsal Run 1,
   *  Finding 2). Called on every fan-in for an active room and on `resume
   *  <code>` alike, so both surfaces detect the same out-of-band death and
   *  fall through to the ordinary pause→resume path instead of stranding. */
  private async reviveIfSessionDied(room: Room): Promise<Room> {
    if (room.state !== "active" || room.sessionId === undefined) return room
    const alive = await isSessionAlive(this.daemon, room.sessionId)
    if (alive) return room
    await this.fanout.stop(room.code)
    return this.store.update(room.code, { sessionId: undefined, state: "paused" })
  }

  private async doPause(room: Room, extra: Partial<Pick<Room, "artifactReady">> = {}): Promise<void> {
    await this.fanout.stop(room.code)
    if (room.sessionId !== undefined) {
      await this.client.kill(room.sessionId).catch((error: unknown) => {
        console.error(`failed to kill session for room ${room.code}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    await this.store.update(room.code, { sessionId: undefined, state: "paused", ...extra })
  }

  /** Serializes `performResume` per room code (docs/UPSTREAM.md #10 territory
   *  — a second, independent race). Every caller of `doResume` gets here
   *  after independently deciding "this room needs resuming" from its OWN
   *  copy of the room — two concurrent triggers (two messages, or a message
   *  racing `resume <code>`) can both decide that at once, and each one
   *  reaching `booter.resume` boots a REAL e2b session/box. Ground-truthed
   *  live, 2026-09-12: room RDV-NG7F got `sess_13a08221` on box `i65mye...`,
   *  then 80s later `sess_1696a06c` on box `icc84u...` — the store kept only
   *  the second, orphaning the first's session AND its billed box. Chaining
   *  every call for the same code onto one promise means a second caller's
   *  body only starts once the first's entire resume (boot included) has
   *  already been written to the store — and that body re-reads the store
   *  itself rather than trusting the `room` it was handed before it queued,
   *  so it can see that and skip booting a second time. */
  private async withRoomLock<T>(code: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.roomLocks.get(code) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    this.roomLocks.set(
      code,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    return run
  }

  private async doResume(room: Room): Promise<Room> {
    return this.withRoomLock(room.code, async () => {
      // Re-check the store, not the `room` this call was handed before it
      // queued for the lock: a prior holder may have already resumed this
      // exact room while this call waited its turn, in which case there is
      // nothing left to do — booting again would be the exact race this
      // lock exists to close.
      const current = this.store.get(room.code) ?? room
      if (current.state !== "paused") return current
      return this.performResume(current)
    })
  }

  private async performResume(room: Room): Promise<Room> {
    // Read the OUTGOING session's transcript before `booter.resume` mints a
    // new one — `room.sessionId` is still the old id here, and this is the
    // last moment it exists anywhere (the `store.update` below overwrites
    // it). `buildSessionRecap` is bounded and never throws: a resume that
    // loses the history is a working resume, a resume that hangs is not.
    const recap =
      room.sessionId === undefined ? undefined : await buildSessionRecap(this.client, room.sessionId)
    const booted = await this.booter.resume(room, recap !== undefined ? { recap } : {})
    // A new sessionId restarts the daemon's own seq numbering near 1, while
    // `room.cursor` is still whatever seq the *previous* session last
    // flushed at — the fan-out reader would then open the new session's
    // stream at that stale `since` and nothing would ever cross it (Run 2,
    // Finding 3). Reset only when the session actually changed: a resume
    // that reconnects the same still-alive session must keep its cursor.
    const sessionChanged = booted.sessionId !== room.sessionId
    // A resume can cold-boot onto a fresh box when the old one's app-serve
    // came back dead (R8, architecture.md §9.3b) — the member-facing URL
    // (`memberFacingArtifactUrl`) never changes, so nobody needs a new link,
    // but they do deserve to know the artifact just came back on a different
    // box, in case they'd bookmarked or reasoned about the old one directly.
    const boxReplaced =
      room.sandboxId !== undefined && booted.sandboxId !== undefined && booted.sandboxId !== room.sandboxId
    const updated = await this.store.update(room.code, {
      sessionId: booted.sessionId,
      sandboxId: booted.sandboxId,
      artifactUrl: booted.artifactUrl,
      artifactReady: booted.artifactReady,
      state: "active",
      lastActivityAt: new Date().toISOString(),
      ...(sessionChanged ? { cursor: 0 } : {}),
    })
    this.fanout.start(updated.code)
    if (boxReplaced) {
      await this.notifyBoxReplaced(updated, booted.boxWasGone === true)
    }
    return updated
  }

  /** The single explicit notice architecture.md §9.3b asks for: broadcast to
   *  every current member, not just whoever triggered the resume — anyone
   *  already in the room may have the artifact open or bookmarked. A box
   *  confirmed GONE (docs/UPSTREAM.md #10, `E2bBooter.resume`'s own liveness
   *  gate) gets the more precise wording; every other box replacement (R8's
   *  same-or-reused-box re-serve) keeps the original generic notice. */
  private async notifyBoxReplaced(room: Room, boxWasGone: boolean): Promise<void> {
    const artifactUrl = memberFacingArtifactUrl(room)
    const text = boxWasGone
      ? "The previous box expired; artifact restored on a new box."
      : "Artifact restored on a new box, same link."
    await Promise.allSettled(room.members.map((member) => this.transport.send(member, { text, artifactUrl })))
  }

  private async replyGuidance(input: InboundInput, text: string): Promise<void> {
    const placeholder: Member = {
      id: `pending:${input.address.provider}:${input.address.contactRef}`,
      displayName: input.displayName,
      tier: input.tier,
      address: input.address,
      joinedAt: new Date().toISOString(),
    }
    await this.transport.send(placeholder, { text, artifactUrl: undefined })
  }
}
