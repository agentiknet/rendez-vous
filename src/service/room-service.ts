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

function welcomeText(prefix: string, room: Room): string {
  const lines = [`${prefix}: ${room.code}`]
  if (room.artifactUrl !== undefined) {
    lines.push(room.artifactUrl)
  }
  return lines.join("\n")
}

function currentJoinLinks(code: string): JoinLinks {
  return joinLinks(code, { publicUrl: env.publicUrl, whatsappNumber: env.whatsappNumber, telegramBot: env.telegramBot })
}

function newRoomReplyText(room: Room, links: JoinLinks): string {
  const lines = [`Room created: ${room.code}`]
  if (room.artifactUrl !== undefined) {
    lines.push(room.artifactUrl)
  }
  lines.push(links.web)
  if (links.whatsapp !== undefined) lines.push(links.whatsapp)
  if (links.telegram !== undefined) lines.push(links.telegram)
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

  constructor(opts: { store: RoomStore; client: DaemonClient; booter: SessionBooter; transport: Transport }) {
    this.store = opts.store
    this.client = opts.client
    this.booter = opts.booter
    this.transport = opts.transport
    this.fanout = new RoomFanout({
      store: this.store,
      transport: this.transport,
      source: (sessionId, since, signal) => this.client.events(sessionId, since, signal),
    })
  }

  /** Start fan-out for every room in the store that already has a live session. */
  start(): void {
    for (const room of this.store.list()) {
      if (room.sessionId !== undefined) {
        this.fanout.start(room.code)
      }
    }
  }

  async stop(): Promise<void> {
    await this.fanout.stopAll()
  }

  getRoom(code: string): Room | undefined {
    return this.store.get(code)
  }

  roomCount(): number {
    return this.store.list().length
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

  /** A plain message from the room-web tier: no `new`/`join`/`resume`
   *  commands accepted here, the caller already knows the room. */
  async sendFromRoomWeb(code: string, displayName: string, text: string): Promise<RoomWebSendOutcome> {
    const room = this.store.get(code)
    if (room === undefined) {
      return { kind: "unknown-code" }
    }
    if (room.sessionId === undefined) {
      return { kind: "no-session" }
    }

    const member = await this.store.addMember(code, {
      displayName,
      tier: "room-web",
      address: { provider: "room-web", source: code, contactRef: slugify(displayName) },
    })
    const result = await fanIn(this.client, room.sessionId, member, text)
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
    const booted = await this.booter.resume(result.room)
    const room = await this.store.update(result.room.code, {
      sessionId: booted.sessionId,
      sandboxId: booted.sandboxId,
      artifactUrl: booted.artifactUrl,
    })
    this.fanout.start(room.code)
    await this.transport.send(result.member, { text: welcomeText("Resumed room", room), artifactUrl: room.artifactUrl })
    return { kind: "resumed", room, member: result.member }
  }

  private async handleMessage(input: InboundInput): Promise<InboundOutcome> {
    const found = this.store.findByAddress(input.address)
    if (found === undefined) {
      await this.replyGuidance(input, "Send `new` to start a room, or `join RDV-XXXX` to join one.")
      return { kind: "unknown-sender" }
    }

    const { room, member } = found
    if (room.sessionId === undefined) {
      await this.transport.send(member, {
        text: `This room has no live session yet — try \`resume ${room.code}\`.`,
        artifactUrl: room.artifactUrl,
      })
      return { kind: "message", room, member }
    }

    const result = await fanIn(this.client, room.sessionId, member, input.text)
    if (!result.ok) {
      await this.transport.send(member, {
        text: `Could not deliver your message: ${result.message}`,
        artifactUrl: room.artifactUrl,
      })
    }
    return { kind: "message", room, member }
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
