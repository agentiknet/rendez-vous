import type { DaemonClient, HealthResult, PromptResult } from "../daemon/client.ts"
import type { TranscriptRecord } from "../daemon/records.ts"
import { env } from "../env.ts"
import { fanIn } from "../fanin/index.ts"
import { RoomFanout } from "../fanout/reader.ts"
import type { Transport } from "../fanout/types.ts"
import { joinLinks, qrPng, type JoinLinks } from "../links/index.ts"
import { handleCommand, parseCommand } from "../rooms/commands.ts"
import type { RoomStore } from "../rooms/store.ts"
import type { Address, Member, Room, Tier } from "../rooms/types.ts"
import type { SessionBooter } from "./booter.ts"
import { hasSendMedia } from "./transports.ts"

export interface InboundInput {
  address: Address
  displayName: string
  tier: Tier
  text: string
}

export type InboundOutcome =
  | { kind: "created"; room: Room; member: Member }
  | { kind: "joined"; room: Room; member: Member }
  | { kind: "resumed"; room: Room; member: Member }
  | { kind: "message"; room: Room; member: Member }
  | { kind: "unknown-code" }
  | { kind: "unknown-sender" }

export type RoomWebSendOutcome =
  | { kind: "sent"; member: Member; result: PromptResult }
  | { kind: "unknown-code" }
  | { kind: "no-session" }

const RESUMING_TEXT = "Resuming room, one moment…"

function welcomeText(prefix: string, room: Room): string {
  const lines = [`${prefix}: ${room.code}`]
  if (room.artifactUrl !== undefined) {
    lines.push(room.artifactUrl)
  }
  return lines.join("\n")
}

function activeRoomStatusText(room: Room): string {
  const lines = [`Room ${room.code} is already active.`]
  if (room.artifactUrl !== undefined) {
    lines.push(room.artifactUrl)
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
  if (room.artifactUrl !== undefined) {
    lines.push(room.artifactUrl)
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
  if (room.artifactUrl !== undefined) {
    lines.push(room.artifactUrl)
  }
  return lines.join("\n")
}

/** Stable, deterministic contact ref for a room-web guest: the same
 *  displayName in the same room always resolves to the same member, which
 *  is what makes `store.addMember`'s idempotency actually kick in here —
 *  there is no browser/session id to key on instead. */
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
  private readonly fanout: RoomFanout
  private readonly idlePauseMs: number
  private readonly idleSweepMs: number
  /** Cursor last observed per room, sweep to sweep — a jump means the room's
   *  own fan-out flushed something new since the last tick, which counts as
   *  activity just as much as an inbound message (R10). Cheaper and more
   *  robust than threading a callback through `RoomFanout` (outside this
   *  file's ownership): the cursor it already persists on every flush is
   *  itself the signal, sampled at sweep granularity. */
  private readonly lastSeenCursor = new Map<string, number>()
  private idleSweepTimer: ReturnType<typeof setInterval> | undefined

  constructor(opts: {
    store: RoomStore
    client: DaemonClient
    booter: SessionBooter
    transport: Transport
    idlePauseMinutes?: number
    idleSweepSeconds?: number
  }) {
    this.store = opts.store
    this.client = opts.client
    this.booter = opts.booter
    this.transport = opts.transport
    this.idlePauseMs = (opts.idlePauseMinutes ?? env.idlePauseMinutes) * 60_000
    this.idleSweepMs = (opts.idleSweepSeconds ?? env.idleSweepSeconds) * 1000
    this.fanout = new RoomFanout({
      store: this.store,
      transport: this.transport,
      source: (sessionId, since, signal) => this.client.events(sessionId, since, signal),
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
   *  (R10 — nothing upstream enforces this, so the room service must). */
  async sweepIdleRooms(): Promise<void> {
    const now = Date.now()
    for (const room of this.store.list()) {
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

  /** A plain message from the room-web tier: no `new`/`join`/`resume`
   *  commands accepted here, the caller already knows the room. */
  async sendFromRoomWeb(code: string, displayName: string, text: string): Promise<RoomWebSendOutcome> {
    let room = this.store.get(code)
    if (room === undefined) {
      return { kind: "unknown-code" }
    }
    if (room.sessionId === undefined && room.state !== "paused") {
      return { kind: "no-session" }
    }

    const member = await this.store.addMember(code, {
      displayName,
      tier: "room-web",
      address: { provider: "room-web", source: code, contactRef: slugify(displayName) },
    })

    if (room.state === "paused") {
      await this.transport.send(member, { text: RESUMING_TEXT, artifactUrl: room.artifactUrl })
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
    await this.transport.send(result.member, { text: newRoomReplyText(room, links), artifactUrl: room.artifactUrl })
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
    await this.transport.send(result.member, {
      text: joinRoomReplyText(result.room),
      artifactUrl: result.room.artifactUrl,
    })
    return { kind: "joined", room: result.room, member: result.member }
  }

  /** Only when the transport can actually deliver an image (R6-adjacent: the
   *  QR just encodes the same public web join link, no daemon access needed). */
  private async sendJoinQr(member: Member, room: Room, links: JoinLinks): Promise<void> {
    const transport = this.transport
    if (!hasSendMedia(transport)) return
    const png = await qrPng(links.web)
    await transport.sendMedia(member, png, `Scan to join ${room.code}`)
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

    if (result.room.state === "active") {
      await this.transport.send(result.member, {
        text: activeRoomStatusText(result.room),
        artifactUrl: result.room.artifactUrl,
      })
      return { kind: "resumed", room: result.room, member: result.member }
    }

    const room = await this.doResume(result.room)
    await this.transport.send(result.member, { text: welcomeText("Resumed room", room), artifactUrl: room.artifactUrl })
    return { kind: "resumed", room, member: result.member }
  }

  private async handleMessage(input: InboundInput): Promise<InboundOutcome> {
    const found = this.store.findByAddress(input.address)
    if (found === undefined) {
      await this.replyGuidance(input, "Send `new` to start a room, or `join RDV-XXXX` to join one.")
      return { kind: "unknown-sender" }
    }

    let { room } = found
    const { member } = found

    if (room.state === "paused") {
      await this.transport.send(member, { text: RESUMING_TEXT, artifactUrl: room.artifactUrl })
      room = await this.doResume(room)
    }

    if (room.sessionId === undefined) {
      await this.transport.send(member, {
        text: `This room has no live session yet — try \`resume ${room.code}\`.`,
        artifactUrl: room.artifactUrl,
      })
      return { kind: "message", room, member }
    }

    const result = await fanIn(this.client, room.sessionId, member, input.text)
    await this.touchActivity(room.code)
    if (!result.ok) {
      await this.transport.send(member, {
        text: `Could not deliver your message: ${result.message}`,
        artifactUrl: room.artifactUrl,
      })
    }
    return { kind: "message", room, member }
  }

  private async touchActivity(code: string): Promise<void> {
    await this.store.update(code, { lastActivityAt: new Date().toISOString() })
  }

  private async doPause(room: Room): Promise<void> {
    await this.fanout.stop(room.code)
    if (room.sessionId !== undefined) {
      await this.client.kill(room.sessionId).catch((error: unknown) => {
        console.error(`failed to kill session for room ${room.code}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    await this.store.update(room.code, { sessionId: undefined, state: "paused" })
  }

  private async doResume(room: Room): Promise<Room> {
    const booted = await this.booter.resume(room)
    const updated = await this.store.update(room.code, {
      sessionId: booted.sessionId,
      sandboxId: booted.sandboxId,
      artifactUrl: booted.artifactUrl,
      artifactReady: booted.artifactReady,
      state: "active",
      lastActivityAt: new Date().toISOString(),
    })
    this.fanout.start(updated.code)
    return updated
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
