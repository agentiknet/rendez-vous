import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Address, Ask, Delivery, Member, PendingDelivery } from "../../src/rooms/types.ts"

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

test("BRIEF-20: create mints slugs that never collide, checked across the WHOLE store, not pairwise", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const rooms = await Promise.all(Array.from({ length: 30 }, () => store.create()))
  const slugs = new Set(rooms.map((r) => r.slug))
  assert.equal(slugs.size, rooms.length, "every room's slug must be unique across the entire store")
  for (const room of rooms) {
    assert.match(room.slug, /^[a-z]+-[a-z]+-[a-z]+$/, "a slug is three words joined by hyphens")
  }
})

test("BRIEF-20: getBySlug resolves the same room get(code) does (case-insensitive), and get(code) still works", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()

  assert.deepEqual(store.getBySlug(room.slug), room)
  assert.deepEqual(store.getBySlug(room.slug.toUpperCase()), room, "slug lookup tolerates case the way code lookup does")
  assert.equal(store.getBySlug("not-a-real-slug"), undefined)
  // The security boundary of BRIEF-20 starts here: `get` is unaffected by
  // any of the above — an existing room's code still resolves exactly as it
  // did before this brief.
  assert.deepEqual(store.get(room.code), room)
})

test("BRIEF-20: a room persisted before `slug` existed is backfilled with one on load, and gets the SAME one on a second load", async () => {
  const dir = trackDir(await freshDir())
  const legacy = {
    code: "RDV-9LD2",
    members: [],
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    cursor: 0,
    lastActivityAt: "2026-09-11T00:00:00.000Z",
    state: "active",
    // `slug` deliberately absent — this is the shape of the 19 rooms already
    // live in `.rdv/rooms.json` before BRIEF-20.
  }
  await writeFile(join(dir, "rooms.json"), JSON.stringify({ rooms: [legacy] }), "utf8")

  const first = await RoomStore.open(dir)
  const room = first.get("RDV-9LD2")
  assert.ok(room !== undefined)
  assert.equal(typeof room.slug, "string")
  assert.ok(room.slug.length > 0, "a pre-existing room must be assigned a slug on load, not left blank")

  // Idempotent: re-opening the same dir must NOT mint a second, different
  // slug — the backfill above must have persisted through the store's own
  // write path already.
  const second = await RoomStore.open(dir)
  assert.equal(second.get("RDV-9LD2")?.slug, room.slug)

  const raw = JSON.parse(await readFile(join(dir, "rooms.json"), "utf8")) as { rooms: { code: string; slug: string }[] }
  assert.equal(raw.rooms[0]?.slug, room.slug, "the backfilled slug must be written to disk, not kept in memory only")
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
    address: { provider: "email", source: "agentpush", contactRef: "bob@example.com" },
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
  assert.equal(found.kind, "one")
  if (found.kind !== "one") return
  assert.equal(found.room.code, room.code)
  assert.equal(found.member.id, member.id)
})

test("findByAddress reports 'none' for an unknown address", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  await store.create()

  const unknown: Address = { provider: "whatsapp", source: "agentpush", contactRef: "+10000000000" }
  assert.deepEqual(store.findByAddress(unknown), { kind: "none" })
})

test("findByAddress reports 'ambiguous' and names both codes when the same address is a member of two rooms (BRIEF-13)", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const roomA = await store.create()
  const roomB = await store.create()
  await store.addMember(roomA.code, aliceInput())
  await store.addMember(roomB.code, aliceInput())

  const found = store.findByAddress(aliceInput().address)
  assert.equal(found.kind, "ambiguous")
  if (found.kind !== "ambiguous") return
  const codes = found.matches.map((match) => match.room.code).sort()
  assert.deepEqual(codes, [roomA.code, roomB.code].sort())
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

test("asks update and round-trip through a reopen (docs/MIDDLEMAN.md step i)", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  const alice = await store.addMember(room.code, aliceInput())
  const ask: Ask = {
    id: "a1",
    toMemberId: alice.id,
    what: "the product shot",
    askedAt: "2026-09-12T04:00:00.000Z",
    status: "open",
    answeredBy: undefined,
    answeredAt: undefined,
    mediaId: undefined,
  }
  const updated = await store.update(room.code, { asks: [ask] })
  assert.deepEqual(updated.asks, [ask])

  const reopened = await RoomStore.open(dir)
  const reloaded = reopened.get(room.code)
  // JSON drops `undefined` values, so the reloaded ask has the keys absent
  // rather than present-as-undefined — same rule as `pendingDeliveries`.
  assert.deepEqual(reloaded?.asks, [JSON.parse(JSON.stringify(ask))])

  // An answered ask persists its closure fields too.
  const closed: Ask = { ...ask, status: "answered", answeredBy: alice.id, answeredAt: "2026-09-12T04:05:00.000Z" }
  const updated2 = await reopened.update(room.code, { asks: [closed] })
  assert.equal(updated2.asks?.[0]?.status, "answered")
  const reopened2 = await RoomStore.open(dir)
  assert.deepEqual(reopened2.get(room.code)?.asks, [JSON.parse(JSON.stringify(closed))])
})

test("create leaves a fresh room with an empty asks list, and an old room file without the key still loads", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  assert.deepEqual(room.asks, [])

  const reopened = await RoomStore.open(dir)
  assert.deepEqual(reopened.get(room.code)?.asks, [])

  // A room persisted before the field existed loads with asks undefined.
  const legacy = {
    code: "RDV-OLD1",
    members: [],
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    cursor: 0,
    lastActivityAt: "2026-09-11T00:00:00.000Z",
    state: "active",
  }
  await writeFile(join(dir, "rooms.json"), JSON.stringify({ rooms: [legacy] }), "utf8")
  const legacyStore = await RoomStore.open(dir)
  assert.equal(legacyStore.get("RDV-OLD1")?.asks, undefined)
})

test("open rejects a room whose asks entry is not the right shape", async () => {
  const dir = trackDir(await freshDir())
  const room = {
    code: "RDV-7F3K",
    members: [],
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    cursor: 0,
    lastActivityAt: "2026-09-12T00:00:00.000Z",
    state: "active",
    asks: [{ id: 7 }],
  }
  await writeFile(join(dir, "rooms.json"), JSON.stringify({ rooms: [room] }), "utf8")
  await assert.rejects(() => RoomStore.open(dir), /corrupt room store/i)
})

test("addMember derives the member's delivery from their address", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()

  const alice = await store.addMember(room.code, aliceInput())
  assert.deepEqual(alice.delivery, { mode: "push", provider: "whatsapp", contactRef: "+15551234567" })

  const web = await store.addMember(room.code, {
    displayName: "Chloe",
    tier: "room-web",
    address: { provider: "room-web", source: "room-web", contactRef: "chloe" },
  })
  assert.deepEqual(web.delivery, { mode: "pull" })

  // And it persists.
  const reopened = await RoomStore.open(dir)
  const loaded = reopened.get(room.code)
  assert.deepEqual(loaded?.members[0]?.delivery, { mode: "push", provider: "whatsapp", contactRef: "+15551234567" })
  assert.deepEqual(loaded?.members[1]?.delivery, { mode: "pull" })
})

test("addMember throws on an address with no delivery mode — unrouted recipients are loud, not console-written", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  await assert.rejects(
    () => store.addMember(room.code, {
      displayName: "Ghost",
      tier: "messenger",
      address: { provider: "slack", source: "somewhere", contactRef: "x" },
    }),
    /unrouted delivery/,
  )
})

test("ackCursor persists monotonically on the member and round-trips through the store (PLAN-02 step 4)", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  const web = await store.addMember(room.code, {
    displayName: "Chloe",
    tier: "room-web",
    address: { provider: "room-web", source: "room-web", contactRef: "chloe" },
  })

  assert.equal(await store.ackCursor(room.code, web.id, 4, "2026-09-13T00:00:00.000Z"), "applied")
  // A backwards ack is ignored as a cursor move but still refreshes liveness.
  assert.equal(await store.ackCursor(room.code, web.id, 2, "2026-09-13T00:00:05.000Z"), "ignored")
  const member = store.get(room.code)?.members.find((candidate) => candidate.id === web.id)
  assert.ok(member !== undefined)
  assert.equal(member.ackedSeq, 4)
  assert.equal(member.ackedAt, "2026-09-13T00:00:05.000Z")

  const reopened = await RoomStore.open(dir)
  const loaded = reopened.get(room.code)?.members.find((candidate) => candidate.id === web.id)
  assert.ok(loaded !== undefined)
  assert.equal(loaded.ackedSeq, 4)
  assert.equal(loaded.ackedAt, "2026-09-13T00:00:05.000Z")
})

test("open rejects a member whose ackedSeq is not a sane number", async () => {
  const dir = trackDir(await freshDir())
  const room = {
    code: "RDV-7F3K",
    members: [
      {
        id: "m1",
        displayName: "Chloe",
        tier: "room-web",
        address: { provider: "room-web", source: "room-web", contactRef: "chloe" },
        joinedAt: "2026-09-12T00:00:00.000Z",
        ackedSeq: "many",
      },
    ],
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    cursor: 0,
    lastActivityAt: "2026-09-12T00:00:00.000Z",
    state: "active",
  }
  await writeFile(join(dir, "rooms.json"), JSON.stringify({ rooms: [room] }), "utf8")
  await assert.rejects(() => RoomStore.open(dir), /corrupt room store/i)
})

test("the delivery low-water mark is monotonic and round-trips; a freshly created room starts at zero, present (brief 12)", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()

  // Present and zero from birth — a fresh room provably has never pruned
  // anything. Only a room persisted before this field existed loads with it
  // absent (the corrupt-store fixtures below cover that shape).
  assert.equal(store.get(room.code)?.deliveryLowWater, 0)

  await store.update(room.code, { deliveryLowWater: 4 })
  // A stale snapshot reporting an older mark must never pull it down — a
  // client comparing `since` against it would be told a destroyed backlog
  // was intact.
  await store.update(room.code, { deliveryLowWater: 2 })
  assert.equal(store.get(room.code)?.deliveryLowWater, 4)

  const reopened = await RoomStore.open(dir)
  assert.equal(reopened.get(room.code)?.deliveryLowWater, 4)
})

test("open migrates a pre-delivery rooms.json: delivery is derived from addresses and attempts is renamed to failures, in memory", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  const alice = await store.addMember(room.code, aliceInput())
  const web = await store.addMember(room.code, {
    displayName: "Chloe",
    tier: "room-web",
    address: { provider: "room-web", source: "room-web", contactRef: "chloe" },
  })
  await store.update(room.code, {
    deliveries: [
      {
        id: "d1",
        memberId: alice.id,
        kind: "whisper",
        text: "persisted before the rename",
        status: "delivered",
        failures: 2,
        lastError: undefined,
        createdAt: "2026-09-12T10:00:00.000Z",
        deliveredAt: "2026-09-12T10:00:01.000Z",
      },
    ],
  })

  // Rewrite the file to its pre-field shape: no `delivery` key on members,
  // `attempts` instead of `failures` on deliveries.
  const filePath = join(dir, "rooms.json")
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as {
    rooms: { members: Record<string, unknown>[]; deliveries: Record<string, unknown>[] }[]
  }
  for (const member of parsed.rooms[0]!.members) delete member.delivery
  for (const delivery of parsed.rooms[0]!.deliveries) {
    delivery.attempts = delivery.failures
    delete delivery.failures
  }
  await writeFile(filePath, JSON.stringify(parsed, null, 2), "utf8")

  const reopened = await RoomStore.open(dir)
  const loaded = reopened.get(room.code)
  assert.ok(loaded !== undefined)
  // The alice address derives push; the room-web one derives pull.
  assert.deepEqual(loaded.members[0]?.delivery, { mode: "push", provider: "whatsapp", contactRef: "+15551234567" })
  assert.deepEqual(loaded.members[1]?.delivery, { mode: "pull" })
  assert.equal(loaded.members[0]?.id, alice.id)
  assert.equal(loaded.members[1]?.id, web.id)
  // `attempts` came back as `failures`.
  const record = loaded.deliveries?.[0]
  assert.ok(record !== undefined)
  assert.equal(record.failures, 2)
  assert.ok(!JSON.stringify(record).includes('"attempts"'), "the pre-rename key does not survive the load")
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

test('a Delivery of kind "system" round-trips through the store (brief B)', async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  const web = await store.addMember(room.code, {
    displayName: "Chloe",
    tier: "room-web",
    address: { provider: "room-web", source: "room-web", contactRef: "chloe" },
  })
  const system: Delivery = {
    id: "d1",
    memberId: web.id,
    kind: "system",
    text: "Room created: RDV-TEST",
    status: "delivered",
    failures: 0,
    lastError: undefined,
    createdAt: "2026-09-13T00:00:00.000Z",
    deliveredAt: "2026-09-13T00:00:01.000Z",
  }
  await store.update(room.code, { deliveries: [system], deliverySeq: 1 })

  const reopened = await RoomStore.open(dir)
  const loaded = reopened.get(room.code)?.deliveries?.[0]
  assert.ok(loaded !== undefined)
  assert.equal(loaded.kind, "system")
  assert.equal(loaded.text, "Room created: RDV-TEST")
  assert.equal(loaded.status, "delivered")
})
