/**
 * BRIEF-37: a join is a fact about the room that must reach the agent at the
 * time it happens, marked as a new person or as another device of someone
 * already here — and a join into a paused room must not pay for a resume.
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { DaemonClient } from "../../src/daemon/client.ts"
import type { Room } from "../../src/rooms/types.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Address, Tier } from "../../src/rooms/types.ts"
import { LocalBooter, openingPrompt, resumePrompt } from "../../src/service/booter.ts"
import { MediaStore } from "../../src/service/media-store.ts"
import { RoomService } from "../../src/service/room-service.ts"
import { MemoryTransport } from "../../src/service/transports.ts"
import { startExtendedFakeDaemon, type ExtendedFakeDaemon } from "./fake-daemon-extra.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const dirs: string[] = []
const daemons: ExtendedFakeDaemon[] = []
const services: RoomService[] = []

after(async () => {
  await Promise.all(services.map((service) => service.stop()))
  await Promise.all(daemons.map((daemon) => daemon.close()))
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

interface Harness {
  service: RoomService
  store: RoomStore
  transport: MemoryTransport
  daemon: ExtendedFakeDaemon
}

async function buildHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-brief37-"))
  dirs.push(dir)
  const mediaDir = await mkdtemp(join(tmpdir(), "rdv-brief37-media-"))
  dirs.push(mediaDir)
  const daemon = await startExtendedFakeDaemon()
  daemons.push(daemon)
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })
  const transport = new MemoryTransport()
  const service = new RoomService({
    store,
    client,
    booter,
    transport,
    daemon: { baseUrl: daemon.url, token: undefined },
    mediaStore: new MediaStore(mediaDir),
  })
  services.push(service)
  return { service, store, transport, daemon }
}

function inbound(displayName: string, contactRef: string, text: string): { address: Address; displayName: string; tier: Tier; text: string } {
  return {
    address: { provider: "whatsapp", source: "agentpush", contactRef },
    displayName,
    tier: "messenger",
    text,
  }
}

function fakeRoom(): Room {
  return {
    code: "RDV-7F3K",
    slug: "amber-cedar-harbor",
    sessionId: undefined,
    sandboxId: undefined,
    artifactUrl: undefined,
    artifactReady: undefined,
    members: [],
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    cursor: 0,
    lastActivityAt: "2026-09-11T00:00:00.000Z",
    state: "active",
  }
}

/** Every prompt body fanned into `sessionId`, in arrival order. */
function promptTexts(daemon: ExtendedFakeDaemon, sessionId: string): string[] {
  return daemon.requestsReceived
    .filter((request) => request.path === `/sessions/${sessionId}/prompt`)
    .map((request) => (isRecord(request.body) && typeof request.body.prompt === "string" ? request.body.prompt : ""))
}

test("a join by a new display name fans exactly one unattributed join line into the session at join time", async () => {
  const h = await buildHarness()
  const created = await h.service.handleInbound(inbound("Alice", "+15550001111", "new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  const sessionId = created.room.sessionId
  assert.ok(sessionId !== undefined)
  const promptsBefore = promptTexts(h.daemon, sessionId).length

  const joined = await h.service.handleInbound(inbound("Bob", "+15550002222", `join ${created.room.code}`))
  assert.equal(joined.kind, "joined")
  if (joined.kind !== "joined") return

  const prompts = promptTexts(h.daemon, sessionId)
  assert.equal(prompts.length, promptsBefore + 1, "exactly one join line, at join time — no later inbound needed")
  const line = prompts[prompts.length - 1] ?? ""
  assert.ok(line.includes("Bob"), "the join line names who arrived")
  assert.match(line, /new person/, "the line marks the join as a NEW person")
  assert.ok(!line.startsWith("["), "the room speaks — the line must not wear a member's [Name · surface] attribution")

  const bobSend = h.transport.sends.find((send) => send.member.displayName === "Bob")
  assert.ok(bobSend !== undefined, "the joiner still receives their own reply on their own channel")
  assert.ok((bobSend?.message.text ?? "").includes(created.room.slug), "the joiner's reply is the ordinary join welcome")
})

test("a join whose displayName is already in the room fans a line that marks it the same human, not a new person", async () => {
  const h = await buildHarness()
  const created = await h.service.handleInbound(inbound("Alice", "+15550001111", "new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  const sessionId = created.room.sessionId
  assert.ok(sessionId !== undefined)
  const promptsBefore = promptTexts(h.daemon, sessionId).length

  // Same human, second device: same displayName, different address.
  const second = await h.service.handleInbound(inbound("Alice", "+15550001999", `join ${created.room.code}`))
  assert.equal(second.kind, "joined")
  if (second.kind !== "joined") return

  const prompts = promptTexts(h.daemon, sessionId)
  assert.equal(prompts.length, promptsBefore + 1, "one line for the second-device join")
  const line = prompts[prompts.length - 1] ?? ""
  assert.match(line, /same human/, "the line says it is the same human already in the room")
  assert.match(line, /another device/, "the line explains the second device")
  assert.ok(!/new person/.test(line), "a second device of someone already here must never read as a new person")
})

test("a join into a paused room does not resume it", async () => {
  const h = await buildHarness()
  const created = await h.service.handleInbound(inbound("Alice", "+15550001111", "new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  await h.service.pauseRoom(created.room.code)
  assert.equal(h.store.get(created.room.code)?.state, "paused")
  const sessionId = created.room.sessionId
  assert.ok(sessionId !== undefined)
  const promptsBefore = promptTexts(h.daemon, sessionId).length

  const joined = await h.service.handleInbound(inbound("Bob", "+15550002222", `join ${created.room.code}`))
  assert.equal(joined.kind, "joined")
  if (joined.kind !== "joined") return

  const after = h.store.get(created.room.code)
  assert.equal(after?.state, "paused", "a join must not wake a paused room")
  assert.equal(after?.sessionId, undefined, "a join must not boot a session for a paused room")
  assert.equal(promptTexts(h.daemon, sessionId).length, promptsBefore, "no prompt can ride into a room that is not running")
})

test("joining twice from the same address fans no second join line", async () => {
  const h = await buildHarness()
  const created = await h.service.handleInbound(inbound("Alice", "+15550001111", "new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  const sessionId = created.room.sessionId
  assert.ok(sessionId !== undefined)

  const first = await h.service.handleInbound(inbound("Bob", "+15550002222", `join ${created.room.code}`))
  assert.equal(first.kind, "joined")
  const promptsAfterFirst = promptTexts(h.daemon, sessionId).length

  const again = await h.service.handleInbound(inbound("Bob", "+15550002222", `join ${created.room.code}`))
  assert.equal(again.kind, "joined")
  assert.equal(promptTexts(h.daemon, sessionId).length, promptsAfterFirst, "a rejoin from the same address produces no second line")
})

test("a member moving in from another room fans the same join line — the move arm is a join too", async () => {
  const h = await buildHarness()
  const createdA = await h.service.handleInbound(inbound("Alice", "+15550001111", "new"))
  assert.ok(createdA.kind === "created")
  if (createdA.kind !== "created") return
  const createdB = await h.service.handleInbound(inbound("Bob", "+15550002222", "new"))
  assert.ok(createdB.kind === "created")
  if (createdB.kind !== "created") return
  const sessionId = createdB.room.sessionId
  assert.ok(sessionId !== undefined)
  const promptsBefore = promptTexts(h.daemon, sessionId).length

  // Bob, already in room B, joins room A — the `movedFrom` arm.
  const moved = await h.service.handleInbound(inbound("Bob", "+15550002222", `join ${createdA.room.code}`))
  assert.equal(moved.kind, "moved")
  if (moved.kind !== "moved") return

  const prompts = promptTexts(h.daemon, sessionId)
  assert.equal(prompts.length, promptsBefore + 1, "the move arm must fan the join line too — arriving is arriving")
  const line = prompts[prompts.length - 1] ?? ""
  assert.ok(line.includes("Bob"), "the move line names who arrived")
  assert.match(line, /new person/, "Bob is genuinely new to room A — the line says a new person")
})

test("the capability block still states the same-human rule exactly once, on boot and on resume", () => {
  for (const prompt of [openingPrompt(fakeRoom()), resumePrompt(fakeRoom(), {})]) {
    const count = prompt.split("THE SAME PERSON CAN BE IN THE ROOM TWICE").length - 1
    assert.equal(count, 1, "the same-human rule appears exactly once in the capability block")
  }
})
