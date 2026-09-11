import type { DaemonClient } from "../daemon/client.ts"
import { env } from "../env.ts"
import type { Room } from "../rooms/types.ts"
import { isSessionAlive, type DaemonExtraOptions } from "./daemon-extra.ts"

export interface BootedSession {
  sessionId: string
  sandboxId: string | undefined
  artifactUrl: string | undefined
}

export interface SessionBooter {
  boot(room: Room, opts: { label: string }): Promise<BootedSession>
  resume(room: Room): Promise<BootedSession>
}

function openingPrompt(room: Room): string {
  return [
    `You are the shared agent for Rendez-vous room ${room.code}.`,
    "Several humans drive this one session together, each from their own device — a phone, email, or a laptop.",
    'Every message you receive is prefixed with its sender, like "[Alice · messenger] ...", so you always know who is speaking.',
    "People in the room may disagree or ask for different things. When that happens, pick a reasonable path forward and say in one short sentence what you chose and why, so everyone stays in sync — do not stall waiting for consensus.",
    "Keep replies short: some members are reading you on a phone screen.",
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
    return { sessionId: spawned.id, sandboxId: undefined, artifactUrl: undefined }
  }

  async resume(room: Room): Promise<BootedSession> {
    if (room.sessionId !== undefined) {
      const alive = await isSessionAlive(this.daemon, room.sessionId)
      if (alive) {
        return { sessionId: room.sessionId, sandboxId: room.sandboxId, artifactUrl: room.artifactUrl }
      }
    }
    return this.boot(room, { label: `rdv-${room.code}` })
  }
}
