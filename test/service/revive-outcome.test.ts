/**
 * BRIEF-25: a revive that says "Resuming room, one moment…" and then never
 * speaks again. The measured defect (RDV-HTUS, 2026-09-14): the room was
 * paused, its e2b box had been reaped, a member sent a message, the room
 * minted `Resuming room, one moment…`, and then nothing ever happened —
 * no session, no stored-shape change, no log line, and the HTTP request
 * never returned.
 *
 * The whole-revive bound does not exist on `main`: `RoomService.performResume`
 * awaits `booter.resume` with no ceiling and only catches
 * `SpawnAgentUnauthorizedError`, so a resume leg that never settles hangs the
 * revive (and the room's per-code lock behind it) forever. These tests script
 * the `SessionBooter` seam so nothing here reaches the real e2b API.
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { DaemonClient } from "../../src/daemon/client.ts"
import { ensureMembership } from "../../src/rooms/commands.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Address, Room, Tier } from "../../src/rooms/types.ts"
import type { BootedSession, ResumeOptions, SessionBooter } from "../../src/service/booter.ts"
import { BoxLivenessUnknownError } from "../../src/service/box-liveness.ts"
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
  const dir = await mkdtemp(join(tmpdir(), "rdv-revive-outcome-"))
  dirs.push(dir)
  return dir
}

function web(text: string): { address: Address; displayName: string; tier: Tier; text: string } {
  return {
    address: { provider: "room-web", source: "room-web", contactRef: "ecran" },
    displayName: "Ecran",
    tier: "room-web",
    text,
  }
}

interface Harness {
  service: RoomService
  store: RoomStore
  daemon: ExtendedFakeDaemon
}

async function buildHarness(booter: SessionBooter, reviveTimeoutMs?: number): Promise<Harness> {
  const dir = await freshDir()
  const daemon = await startExtendedFakeDaemon()
  daemons.push(daemon)
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const transport = new MemoryTransport()
  const service = new RoomService({
    store,
    client,
    booter,
    transport,
    daemon: { baseUrl: daemon.url, token: undefined },
    mediaStore: new MediaStore(await freshDir()),
    ...(reviveTimeoutMs !== undefined ? { reviveTimeoutMs } : {}),
  })
  services.push(service)
  return { service, store, daemon }
}

/** A resume leg that never settles — the shape of tonight's measurement. */
class NeverSettlesBooter implements SessionBooter {
  async boot(): Promise<BootedSession> {
    return { sessionId: "sess-old", sandboxId: "box-1", artifactUrl: undefined, artifactReady: true }
  }

  resume(_room: Room, _opts?: ResumeOptions): Promise<BootedSession> {
    return new Promise<BootedSession>(() => {})
  }
}

interface ScriptedBooterConfig {
  readonly boot?: BootedSession
  readonly resume?: BootedSession
  /** When set, `resume` refuses with this error instead of returning. */
  readonly resumeThrows?: Error
}

/** A booter whose two legs are scripted, plus call counts, so the tests assert
 *  which leg ran, not merely that something happened. */
class ScriptedBooter implements SessionBooter {
  bootCalls = 0
  resumeCalls = 0
  private readonly config: ScriptedBooterConfig

  constructor(config: ScriptedBooterConfig) {
    this.config = config
  }

  async boot(): Promise<BootedSession> {
    this.bootCalls += 1
    return this.config.boot ?? { sessionId: "sess-old", sandboxId: "box-1", artifactUrl: undefined, artifactReady: true }
  }

  async resume(_room: Room, _opts?: ResumeOptions): Promise<BootedSession> {
    this.resumeCalls += 1
    if (this.config.resumeThrows !== undefined) throw this.config.resumeThrows
    return (
      this.config.resume ?? { sessionId: "sess-new", sandboxId: "box-1", artifactUrl: undefined, artifactReady: true }
    )
  }
}

/** A paused room with a room-web (pull) member and no prior session id to
 *  recap — so the only variable is the scripted `resume` leg. */
async function pausedRoomWithWebMember(booter: SessionBooter): Promise<{ harness: Harness; code: string }> {
  const harness = await buildHarness(booter, 40)
  const room = await harness.store.create()
  await ensureMembership(harness.store, room.code, {
    displayName: "Ecran",
    tier: "room-web",
    address: { provider: "room-web", source: "room-web", contactRef: "ecran" },
    claim: "claim-ecran",
  })
  await harness.store.update(room.code, { state: "paused", sandboxId: "box-1", artifactReady: false })
  return { harness, code: room.code }
}

test("a revive whose resume leg never settles ends within the bound and tells the room it failed — never parked on 'one moment…'", async () => {
  const { harness, code } = await pausedRoomWithWebMember(new NeverSettlesBooter())
  const { service, store } = harness

  const started = Date.now()
  const outcome = await service.handleInbound(web("are you there?"))
  const elapsed = Date.now() - started

  assert.ok(elapsed < 2_000, `the revive must be bounded (took ${elapsed}ms)`)
  assert.equal(outcome.kind, "message")

  const saved = store.get(code)
  assert.equal(saved?.state, "paused")
  assert.equal(saved?.sessionId, undefined)

  const texts = (saved?.deliveries ?? []).map((record) => record.text)
  assert.ok(
    texts.some((text) => !text.includes("one moment") && !text.includes("Resuming")),
    "the failing revive must produce a terminal record",
  )
  const last = texts[texts.length - 1]
  assert.ok(last === undefined || !last.includes("one moment"), "the resume notice must never be the room's last word")
})

test("a confirmed-gone box boots a fresh one, sets the session, and tells the room the old box was gone", async () => {
  const booter = new ScriptedBooter({
    resume: {
      sessionId: "sess-new",
      sandboxId: "box-2",
      artifactUrl: "https://box-2.example",
      artifactReady: true,
      boxWasGone: true,
    },
  })
  const { harness, code } = await pausedRoomWithWebMember(booter)
  const { store } = harness

  const outcome = await harness.service.handleInbound(web("are you there?"))
  assert.equal(outcome.kind, "message")

  const saved = store.get(code)
  assert.equal(saved?.sessionId, "sess-new", "a fresh box's session must be recorded")
  assert.equal(saved?.sandboxId, "box-2", "the gone box must not be left as the room's box")
  assert.equal(saved?.state, "active")

  const texts = (saved?.deliveries ?? []).map((record) => record.text)
  assert.ok(
    texts.some((text) => text.includes("previous box expired")),
    "the room is told the old box was gone and a new one started",
  )
})

test("an alive box is resumed on itself, with no fresh box booted", async () => {
  const booter = new ScriptedBooter({
    resume: {
      sessionId: "sess-new",
      sandboxId: "box-1",
      artifactUrl: "https://box-1.example",
      artifactReady: true,
    },
  })
  const { harness, code } = await pausedRoomWithWebMember(booter)
  const { store } = harness

  const outcome = await harness.service.handleInbound(web("are you there?"))
  assert.equal(outcome.kind, "message")

  assert.equal(booter.resumeCalls, 1, "the alive box is resumed")
  assert.equal(booter.bootCalls, 0, "no fresh box is booted when the old one is alive")

  const saved = store.get(code)
  assert.equal(saved?.sessionId, "sess-new")
  assert.equal(saved?.sandboxId, "box-1", "the same, still-alive box must stay on record")

  const texts = (saved?.deliveries ?? []).map((record) => record.text)
  assert.ok(texts.some((text) => text.includes("Room resumed")), "the room is told it resumed")
  assert.ok(
    !texts.some((text) => text.includes("previous box expired")),
    "'booted fresh' must not fire when the box was alive",
  )
})

test("an unknown box-liveness probe refuses to boot, keeps the box on record, and says the room could not tell", async () => {
  const booter = new ScriptedBooter({ resumeThrows: new BoxLivenessUnknownError("box-1") })
  const { harness, code } = await pausedRoomWithWebMember(booter)
  const { store } = harness

  const outcome = await harness.service.handleInbound(web("are you there?"))
  assert.equal(outcome.kind, "message")

  assert.equal(booter.resumeCalls, 1)
  assert.equal(booter.bootCalls, 0, "unknown must never be treated as gone — no fresh box")

  const saved = store.get(code)
  assert.equal(saved?.state, "paused")
  assert.equal(saved?.sessionId, undefined)
  assert.equal(saved?.sandboxId, "box-1", "an unknown box may still be alive, so it must not be erased")
  assert.equal(saved?.artifactReady, false)

  const texts = (saved?.deliveries ?? []).map((record) => record.text)
  assert.ok(texts.some((text) => text.includes("could not tell")), "the room is told the box could not be reached")
})

test("a revive that throws ends with the failure record, and 'Resuming room, one moment…' is never its last word", async () => {
  const booter = new ScriptedBooter({ resumeThrows: new Error("spawn exploded") })
  const { harness, code } = await pausedRoomWithWebMember(booter)
  const { store } = harness

  const outcome = await harness.service.handleInbound(web("are you there?"))
  assert.equal(outcome.kind, "message")

  const saved = store.get(code)
  assert.equal(saved?.state, "paused")
  assert.equal(saved?.sessionId, undefined)

  const texts = (saved?.deliveries ?? []).map((record) => record.text)
  assert.ok(texts.some((text) => text.includes("could not be resumed")), "the failing revive must produce a terminal record")
  const last = texts[texts.length - 1]
  assert.ok(last !== undefined && !last.includes("one moment"), "the resume notice must never be the room's last word")
  assert.ok(last === undefined || !last.includes("Resuming"), "and not a second 'Resuming' either")
})
