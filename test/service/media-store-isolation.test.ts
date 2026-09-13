/**
 * BRIEF-17: MediaStore's own constructor default (`baseDir = env.mediaDir`)
 * meant any RoomService built without an explicit `mediaStore` silently wrote
 * a room's join QR into `.rdv/media` — the LIVE runtime directory a real
 * service reads from. `test/service/room-service.test.ts`'s `buildHarness`
 * did exactly that: one run added +31 real directories under `.rdv/media`,
 * measured directly against this file's pre-fix content (see the fix's
 * commit message for the exact numbers).
 *
 * This test locks in the honest shape of the fix: the room-creation path,
 * given its own injected `MediaStore`, lands the QR in that store and
 * NOWHERE ELSE — specifically, `env.mediaDir` (the real live directory) must
 * not gain a single new entry. Checking only "the injected store got the
 * file" would already pass without this fix (RoomService has always
 * supported an injected `mediaStore`); the second half — the live directory
 * staying untouched — is the half that actually matters and the half a
 * forgetful caller (like the old `buildHarness`) would fail.
 */
import assert from "node:assert/strict"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { DaemonClient } from "../../src/daemon/client.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Address, Tier } from "../../src/rooms/types.ts"
import { env } from "../../src/env.ts"
import { LocalBooter } from "../../src/service/booter.ts"
import { MediaStore } from "../../src/service/media-store.ts"
import { RoomService } from "../../src/service/room-service.ts"
import { MemoryTransport } from "../../src/service/transports.ts"
import { startExtendedFakeDaemon, type ExtendedFakeDaemon } from "./fake-daemon-extra.ts"

const dirs: string[] = []
const daemons: ExtendedFakeDaemon[] = []
const services: RoomService[] = []

after(async () => {
  await Promise.all(services.map((service) => service.stop()))
  await Promise.all(daemons.map((daemon) => daemon.close()))
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-media-isolation-"))
  dirs.push(dir)
  return dir
}

/** A read-only snapshot of the real live media directory — never written to,
 *  never deleted. `readdir` on a directory that does not exist yet (a fresh
 *  checkout with no `.rdv/media`) is treated as "no entries", since an
 *  absent live store is just as untouched as an empty one. */
async function liveMediaEntries(): Promise<string[]> {
  return readdir(env.mediaDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
}

function alice(text: string): { address: Address; displayName: string; tier: Tier; text: string } {
  return {
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+15550001111" },
    displayName: "Alice",
    tier: "messenger",
    text,
  }
}

test("the room-creation path writes its join QR into the injected MediaStore, and the real live env.mediaDir gains no entry", async () => {
  const before = await liveMediaEntries()

  const dir = await freshDir()
  const daemon = await startExtendedFakeDaemon()
  daemons.push(daemon)
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })
  const transport = new MemoryTransport()
  const mediaStore = new MediaStore(await freshDir())
  const service = new RoomService({
    store,
    client,
    booter,
    transport,
    daemon: { baseUrl: daemon.url, token: undefined },
    mediaStore,
  })
  services.push(service)

  const outcome = await service.handleInbound(alice("new"))
  assert.equal(outcome.kind, "created")
  if (outcome.kind !== "created") return

  // The QR actually landed — in the injected store, not just "somewhere".
  assert.equal(transport.mediaSends.length, 1)
  assert.ok((transport.mediaSends[0]?.png.length ?? 0) > 0)
  const publishedUrl = transport.mediaSends[0]?.publicUrl
  assert.ok(publishedUrl !== undefined, "the QR must have been published through the injected mediaStore")
  const mediaId = publishedUrl?.split("/media/")[1]
  assert.ok(mediaId !== undefined)
  if (mediaId === undefined) return
  const bytes = await mediaStore.read(outcome.room.code, mediaId)
  assert.ok(bytes !== undefined && bytes.length > 0, "the injected store must actually hold the bytes it was asked to save")

  // The real live directory must be exactly as it was before this room ever
  // existed — no directory for this room's code, and no new entry of any
  // shape at all.
  const after = await liveMediaEntries()
  assert.deepEqual(after, before, "creating a room with an injected MediaStore must not touch env.mediaDir")
  assert.ok(!after.includes(outcome.room.code), "the live store must never gain a directory for a test-minted room code")
})
