/**
 * BRIEF-22: a `spawnAgent` 401 (the daemon rejected our bearer) must surface
 * as a room-visible `system` record, not only in the service log — the
 * member who wrote into the room and got nothing is the one who needs to
 * know an agent could not be spawned.
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { DaemonClient, SpawnAgentUnauthorizedError } from "../../src/daemon/client.ts"
import type { Address, Tier } from "../../src/rooms/types.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import { LocalBooter, type BootedSession, type ResumeOptions, type SessionBooter } from "../../src/service/booter.ts"
import { MediaStore } from "../../src/service/media-store.ts"
import { RoomService } from "../../src/service/room-service.ts"
import { MemoryTransport } from "../../src/service/transports.ts"
import { startExtendedFakeDaemon, type ExtendedFakeDaemon } from "./fake-daemon-extra.ts"
import type { Room } from "../../src/rooms/types.ts"

const dirs: string[] = []
const daemons: ExtendedFakeDaemon[] = []
const services: RoomService[] = []

after(async () => {
  await Promise.all(services.map((service) => service.stop()))
  await Promise.all(daemons.map((daemon) => daemon.close()))
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-spawn401-"))
  dirs.push(dir)
  return dir
}

/** Boots normally (through the real `LocalBooter`, against the fake daemon)
 *  but every RESUME is answered exactly the way the live daemon answered on
 *  the night this brief describes: the bearer this service sends is no
 *  longer the one the daemon expects. */
class ResumeUnauthorizedBooter implements SessionBooter {
  private readonly inner: SessionBooter

  constructor(inner: SessionBooter) {
    this.inner = inner
  }

  boot(room: Room, opts: { label: string }): Promise<BootedSession> {
    return this.inner.boot(room, opts)
  }

  async resume(_room: Room, _opts?: ResumeOptions): Promise<BootedSession> {
    throw new SpawnAgentUnauthorizedError('{"error":"sessions_unauthorized"}')
  }
}

function web(text: string): { address: Address; displayName: string; tier: Tier; text: string } {
  return {
    address: { provider: "room-web", source: "room-web", contactRef: "ecran" },
    displayName: "Ecran",
    tier: "room-web",
    text,
  }
}

test("a spawnAgent 401 on resume writes a system record telling the room it could not get an agent", async () => {
  const dir = await freshDir()
  const daemon = await startExtendedFakeDaemon()
  daemons.push(daemon)
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const realBooter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })
  const booter = new ResumeUnauthorizedBooter(realBooter)
  const transport = new MemoryTransport()
  const service = new RoomService({
    store,
    client,
    booter,
    transport,
    daemon: { baseUrl: daemon.url, token: undefined },
    mediaStore: new MediaStore(await freshDir()),
  })
  services.push(service)

  // A room-web (pull) member so the notice lands as a `deliveries` record
  // rather than a transport push — "a system record in the room", literally.
  const created = await service.handleInbound(web("new"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return
  const member = created.room.members[0]
  assert.ok(member !== undefined)

  await service.pauseRoom(created.room.code)
  const resumed = await service.handleInbound(web(`resume ${created.room.code}`))
  assert.equal(resumed.kind, "resumed")
  if (resumed.kind !== "resumed") return

  // The resume genuinely failed: no session was ever recovered.
  assert.equal(resumed.room.sessionId, undefined)

  const records = (store.get(created.room.code)?.deliveries ?? []).filter((record) => record.memberId === member.id)
  const notice = records.find((record) => record.text.includes("could not get an agent"))
  assert.ok(notice !== undefined, "a record naming the failure exists in the room")
  assert.equal(notice.kind, "system")
})
