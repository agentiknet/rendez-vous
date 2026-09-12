import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Address, Member, PendingDelivery } from "../../src/rooms/types.ts"

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "rdv-store-"))
}

const dirs: string[] = []
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

function trackDir(dir: string): string {
  dirs.push(dir)
  return dir
}

function aliceInput(): Omit<Member, "id" | "joinedAt"> {
  return {
    displayName: "Alice",
    tier: "messenger",
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+15551234567" },
  }
}

test("create mints a room with default fields", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  assert.match(room.code, /^RDV-[A-Z0-9]{4}$/)
  assert.equal(room.sessionId, undefined)
  assert.equal(room.sandboxId, undefined)
  assert.equal(room.artifactUrl, undefined)
  assert.deepEqual(room.members, [])
  assert.equal(room.cursor, 0)
  assert.equal(room.createdAt, room.updatedAt)
  assert.equal(room.artifactReady, undefined)
  assert.equal(room.state, "active")
  assert.equal(room.lastActivityAt, room.createdAt)
})

test("get and list reflect created rooms, code lookup is normalization-tolerant", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()

  assert.deepEqual(store.get(room.code), room)
  assert.deepEqual(store.get(room.code.toLowerCase().replace("rdv-", "")), room)
  assert.equal(store.get("nope"), undefined)

  const other = await store.create()
  const codes = store.list().map((r) => r.code)
  assert.deepEqual(new Set(codes), new Set([room.code, other.code]))
})

test("create mints codes that never collide even under a tiny alphabet pressure test", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const rooms = await Promise.all(Array.from({ length: 25 }, () => store.create()))
  const codes = new Set(rooms.map((r) => r.code))
  assert.equal(codes.size, rooms.length)
})

test("addMember is idempotent on the address triple and updates displayName", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()

  const first = await store.addMember(room.code, aliceInput())
  const second = await store.addMember(room.code, { ...aliceInput(), displayName: "Alice B." })

  assert.equal(first.id, second.id)
  assert.equal(second.displayName, "Alice B.")
  const stored = store.get(room.code)
  assert.equal(stored?.members.length, 1)
  assert.equal(stored?.members[0]?.displayName, "Alice B.")
})

test("addMember adds distinct members for distinct addresses", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()

  await store.addMember(room.code, aliceInput())
  await store.addMember(room.code, {
    displayName: "Bob",
    tier: "email",
    address: { provider: "agentpush", source: "mail", contactRef: "bob@example.com" },
  })

  const stored = store.get(room.code)
  assert.equal(stored?.members.length, 2)
})

test("addMember throws on unknown room code", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  await assert.rejects(() => store.addMember("RDV-ZZZZ", aliceInput()))
})

test("removeMember removes a known member and persists the change", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  const alice = await store.addMember(room.code, aliceInput())

  const removed = await store.removeMember(room.code, alice.id)
  assert.equal(removed?.id, alice.id)
  assert.equal(store.get(room.code)?.members.length, 0)

  const reopened = await RoomStore.open(dir)
  assert.equal(reopened.get(room.code)?.members.length, 0)
})

test("removeMember is idempotent: removing an absent member id is a no-op, not a throw", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  const alice = await store.addMember(room.code, aliceInput())

  const first = await store.removeMember(room.code, alice.id)
  assert.equal(first?.id, alice.id)
  const second = await store.removeMember(room.code, alice.id)
  assert.equal(second, undefined)
  assert.equal(store.get(room.code)?.members.length, 0)
})

test("removeMember throws on unknown room code", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  await assert.rejects(() => store.removeMember("RDV-ZZZZ", "some-id"))
})

test("update patches only the given fields and bumps updatedAt", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()

  const updated = await store.update(room.code, { sessionId: "sess-1", cursor: 3 })
  assert.equal(updated.sessionId, "sess-1")
  assert.equal(updated.cursor, 3)
  assert.equal(updated.sandboxId, undefined)
  assert.equal(updated.artifactUrl, undefined)
  assert.ok(updated.updatedAt >= room.updatedAt)

  const clearedSession = await store.update(room.code, { sessionId: undefined })
  assert.equal(clearedSession.sessionId, undefined)
  assert.equal(clearedSession.cursor, 3)
})

test("update throws on unknown room code", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  await assert.rejects(() => store.update("RDV-ZZZZ", { cursor: 1 }))
})

test("findByAddress locates the room and member for a known address", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  const member = await store.addMember(room.code, aliceInput())

  const found = store.findByAddress(aliceInput().address)
  assert.equal(found?.room.code, room.code)
  assert.equal(found?.member.id, member.id)
})

test("findByAddress returns undefined for an unknown address", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  await store.create()

  const unknown: Address = { provider: "whatsapp", source: "agentpush", contactRef: "+10000000000" }
  assert.equal(store.findByAddress(unknown), undefined)
})

test("store survives a restart: reopening the same dir sees prior writes", async () => {
  const dir = trackDir(await freshDir())
  const store1 = await RoomStore.open(dir)
  const room = await store1.create()
  await store1.addMember(room.code, aliceInput())
  await store1.update(room.code, {
    sessionId: "sess-42",
    sandboxId: "box-1",
    artifactUrl: "https://x.test",
    artifactReady: true,
    cursor: 5,
    state: "paused",
    lastActivityAt: "2026-09-12T00:00:00.000Z",
  })

  const store2 = await RoomStore.open(dir)
  const reloaded = store2.get(room.code)
  assert.ok(reloaded)
  assert.equal(reloaded?.sessionId, "sess-42")
  assert.equal(reloaded?.sandboxId, "box-1")
  assert.equal(reloaded?.artifactUrl, "https://x.test")
  assert.equal(reloaded?.artifactReady, true)
  assert.equal(reloaded?.cursor, 5)
  assert.equal(reloaded?.state, "paused")
  assert.equal(reloaded?.lastActivityAt, "2026-09-12T00:00:00.000Z")
  assert.equal(reloaded?.members.length, 1)
  assert.equal(reloaded?.members[0]?.displayName, "Alice")
})

test("store survives a restart when sandboxId and artifactUrl are still unset", async () => {
  const dir = trackDir(await freshDir())
  const store1 = await RoomStore.open(dir)
  const room = await store1.create()
  await store1.update(room.code, { sessionId: "sess-1" })

  const store2 = await RoomStore.open(dir)
  const reloaded = store2.get(room.code)
  assert.ok(reloaded)
  assert.equal(reloaded?.sessionId, "sess-1")
  assert.equal(reloaded?.sandboxId, undefined)
  assert.equal(reloaded?.artifactUrl, undefined)
})

test("open on a missing file starts an empty store", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  assert.deepEqual(store.list(), [])
})

test("open throws a clear error on a corrupt file instead of silently resetting", async () => {
  const dir = trackDir(await freshDir())
  await writeFile(join(dir, "rooms.json"), "{ not json", "utf8")
  await assert.rejects(() => RoomStore.open(dir), /corrupt room store/i)
})

test("open throws a clear error when the file is valid JSON but the wrong shape", async () => {
  const dir = trackDir(await freshDir())
  await writeFile(join(dir, "rooms.json"), JSON.stringify({ rooms: [{ nope: true }] }), "utf8")
  await assert.rejects(() => RoomStore.open(dir), /corrupt room store/i)
})

test("open throws a clear error when a room is missing lastActivityAt or state", async () => {
  const dir = trackDir(await freshDir())
  const room = {
    code: "RDV-7F3K",
    members: [],
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    cursor: 0,
    // lastActivityAt and state deliberately omitted — predates M8
  }
  await writeFile(join(dir, "rooms.json"), JSON.stringify({ rooms: [room] }), "utf8")
  await assert.rejects(() => RoomStore.open(dir), /corrupt room store/i)
})

test("open accepts a room whose optional artifactReady key is entirely absent", async () => {
  const dir = trackDir(await freshDir())
  const room = {
    code: "RDV-7F3K",
    members: [],
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    cursor: 0,
    lastActivityAt: "2026-09-12T00:00:00.000Z",
    state: "active",
    // sessionId/sandboxId/artifactUrl/artifactReady all absent, matching a fresh `create()`
  }
  await writeFile(join(dir, "rooms.json"), JSON.stringify({ rooms: [room] }), "utf8")
  const store = await RoomStore.open(dir)
  assert.equal(store.get("RDV-7F3K")?.artifactReady, undefined)
})

test("pendingDeliveries update and round-trip through a reopen", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  const alice = await store.addMember(room.code, aliceInput())
  const pending: PendingDelivery = {
    token: "PDF-7F3K",
    requestedBy: "Alice",
    target: { kind: "messenger", member: alice },
    subject: "Room deliverable",
    mediaId: "00000000-0000-4000-8000-000000000001",
    pageCount: 2,
    createdAt: 1000,
    expiresAt: 61_000,
  }
  const updated = await store.update(room.code, { pendingDeliveries: [pending] })
  assert.deepEqual(updated.pendingDeliveries, [pending])

  const reopened = await RoomStore.open(dir)
  const reloaded = reopened.get(room.code)
  assert.deepEqual(reloaded?.pendingDeliveries, [pending])

  const cleared = await reopened.update(room.code, { pendingDeliveries: [] })
  assert.deepEqual(cleared.pendingDeliveries, [])
})

test("open rejects a room whose pendingDeliveries entry is not the right shape", async () => {
  const dir = trackDir(await freshDir())
  const room = {
    code: "RDV-7F3K",
    members: [],
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    cursor: 0,
    lastActivityAt: "2026-09-12T00:00:00.000Z",
    state: "active",
    pendingDeliveries: [{ token: 7 }],
  }
  await writeFile(join(dir, "rooms.json"), JSON.stringify({ rooms: [room] }), "utf8")
  await assert.rejects(() => RoomStore.open(dir), /corrupt room store/i)
})

test("open accepts a room without a pendingDeliveries key (predates the field)", async () => {
  const dir = trackDir(await freshDir())
  const room = {
    code: "RDV-7F3K",
    members: [],
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    cursor: 0,
    lastActivityAt: "2026-09-12T00:00:00.000Z",
    state: "active",
  }
  await writeFile(join(dir, "rooms.json"), JSON.stringify({ rooms: [room] }), "utf8")
  const store = await RoomStore.open(dir)
  assert.equal(store.get("RDV-7F3K")?.pendingDeliveries, undefined)
})

test("writes are atomic: no partial rooms.json is ever left behind", async () => {  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  await Promise.all([
    store.addMember(room.code, aliceInput()),
    store.update(room.code, { cursor: 1 }),
    store.update(room.code, { cursor: 2 }),
  ])
  const raw = await readFile(join(dir, "rooms.json"), "utf8")
  const parsed: unknown = JSON.parse(raw)
  assert.ok(parsed !== null && typeof parsed === "object")
})
