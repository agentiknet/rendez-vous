import type { DaemonClient, HealthResult } from "../daemon/client.ts"
import { fanIn } from "../fanin/index.ts"
import { RoomFanout } from "../fanout/reader.ts"
import type { Transport } from "../fanout/types.ts"
import { handleCommand, parseCommand } from "../rooms/commands.ts"
import type { RoomStore } from "../rooms/store.ts"
import type { Address, Member, Room, Tier } from "../rooms/types.ts"
import type { SessionBooter } from "./booter.ts"

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

function welcomeText(prefix: string, room: Room): string {
  const lines = [`${prefix}: ${room.code}`]
  if (room.artifactUrl !== undefined) {
    lines.push(room.artifactUrl)
  }
  return lines.join("\n")
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
    await this.transport.send(result.member, { text: welcomeText("Room created", room), artifactUrl: room.artifactUrl })
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
      text: welcomeText("Joined room", result.room),
      artifactUrl: result.room.artifactUrl,
    })
    return { kind: "joined", room: result.room, member: result.member }
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
