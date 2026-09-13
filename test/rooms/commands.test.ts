import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { handleCommand, parseCommand } from "../../src/rooms/commands.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Member } from "../../src/rooms/types.ts"

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "rdv-commands-"))
}

const dirs: string[] = []
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

function trackDir(dir: string): string {
  dirs.push(dir)
  return dir
}

function alice(): Omit<Member, "id" | "joinedAt"> {
  return {
    displayName: "Alice",
    tier: "messenger",
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+15551234567" },
  }
}

function bob(): Omit<Member, "id" | "joinedAt"> {
  return {
    displayName: "Bob",
    tier: "messenger",
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+15559876543" },
  }
}

const parseTable: Array<[string, unknown]> = [
  ["new", { kind: "new" }],
  ["NEW", { kind: "new" }],
  ["  new  ", { kind: "new" }],
  ["join RDV-7F3K", { kind: "join", code: "RDV-7F3K" }],
  ["JOIN rdv-7f3k", { kind: "join", code: "RDV-7F3K" }],
  ["join 7f3k", { kind: "join", code: "RDV-7F3K" }],
  ["resume RDV-7F3K", { kind: "resume", code: "RDV-7F3K" }],
  ["  resume   rdv-7f3k  ", { kind: "resume", code: "RDV-7F3K" }],
  ["join RDV-I0O1", undefined],
  ["join", undefined],
  ["hello there", undefined],
  ["", undefined],
  ["newly created thing", undefined],
  ["leave", { kind: "leave" }],
  ["LEAVE", { kind: "leave" }],
  ["  leave  ", { kind: "leave" }],
  ["leaves", undefined],
  ["leave RDV-7F3K", undefined],
]

for (const [input, expected] of parseTable) {
  test(`parseCommand(${JSON.stringify(input)})`, () => {
    assert.deepEqual(parseCommand(input), expected)
  })
}

test("handleCommand new creates a room and adds the sender as first member", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)

  const result = await handleCommand(store, { kind: "new" }, alice())
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.created, true)
  assert.equal(result.room.members.length, 1)
  assert.equal(result.member.displayName, "Alice")
  assert.equal(result.room.members[0]?.id, result.member.id)
  assert.match(result.room.code, /^RDV-[A-Z0-9]{4}$/)
})

test("handleCommand join adds a second member to an existing room", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)

  const created = await handleCommand(store, { kind: "new" }, alice())
  assert.ok(created.ok)
  if (!created.ok) return

  const joined = await handleCommand(store, { kind: "join", code: created.room.code }, bob())
  assert.equal(joined.ok, true)
  if (!joined.ok) return
  assert.equal(joined.created, false)
  assert.equal(joined.room.code, created.room.code)
  assert.equal(joined.room.members.length, 2)
  assert.equal(joined.member.displayName, "Bob")
})

test("handleCommand join on an unknown code returns a typed error, not a throw", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)

  const result = await handleCommand(store, { kind: "join", code: "RDV-ZZZZ" }, alice())
  assert.deepEqual(result, { ok: false, reason: "unknown-code" })
})

test("handleCommand resume returns the existing room for a known code", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)

  const created = await handleCommand(store, { kind: "new" }, alice())
  assert.ok(created.ok)
  if (!created.ok) return

  const resumed = await handleCommand(store, { kind: "resume", code: created.room.code }, alice())
  assert.equal(resumed.ok, true)
  if (!resumed.ok) return
  assert.equal(resumed.room.code, created.room.code)
  assert.equal(resumed.room.members.length, 1)
  assert.equal(resumed.member.id, created.member.id)
})

test("handleCommand resume on an unknown code returns a typed error, not a throw", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)

  const result = await handleCommand(store, { kind: "resume", code: "RDV-ZZZZ" }, alice())
  assert.deepEqual(result, { ok: false, reason: "unknown-code" })
})

test("handleCommand leave removes the sender from their room", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)

  const created = await handleCommand(store, { kind: "new" }, alice())
  assert.ok(created.ok)
  if (!created.ok) return

  const left = await handleCommand(store, { kind: "leave" }, alice())
  assert.equal(left.ok, true)
  if (!left.ok) return
  assert.equal(left.room.code, created.room.code)
  assert.equal(left.member.id, created.member.id)
  assert.equal(left.room.members.length, 0)

  const stored = store.get(created.room.code)
  assert.equal(stored?.members.length, 0)
})

test("handleCommand leave for a sender in no room returns a typed error, not a throw", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)

  const result = await handleCommand(store, { kind: "leave" }, alice())
  assert.deepEqual(result, { ok: false, reason: "not-in-room" })
})

test("handleCommand join moves a member from their current room to the new one", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)

  const roomA = await handleCommand(store, { kind: "new" }, alice())
  assert.ok(roomA.ok)
  if (!roomA.ok) return
  const roomB = await handleCommand(store, { kind: "new" }, bob())
  assert.ok(roomB.ok)
  if (!roomB.ok) return

  const moved = await handleCommand(store, { kind: "join", code: roomB.room.code }, alice())
  assert.equal(moved.ok, true)
  if (!moved.ok) return
  assert.equal(moved.room.code, roomB.room.code)
  assert.equal(moved.member.displayName, "Alice")

  const oldRoom = store.get(roomA.room.code)
  assert.equal(oldRoom?.members.length, 0, "alice is no longer a member of her old room")
  const newRoom = store.get(roomB.room.code)
  assert.equal(newRoom?.members.length, 2, "bob is untouched, alice is added")
  assert.ok(newRoom?.members.some((m) => m.displayName === "Alice"))
})

test("handleCommand join on the room the sender is already in is a no-op, not a move", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)

  const created = await handleCommand(store, { kind: "new" }, alice())
  assert.ok(created.ok)
  if (!created.ok) return

  const rejoined = await handleCommand(store, { kind: "join", code: created.room.code }, alice())
  assert.equal(rejoined.ok, true)
  if (!rejoined.ok) return
  assert.equal(rejoined.member.id, created.member.id)
  assert.equal(rejoined.room.members.length, 1)
})

/** Every room across the whole store that currently lists a member at this
 *  address — the count the bug this brief fixes actually violated. A room
 *  merely containing a *new* member is not the same claim as the address
 *  holding exactly one membership store-wide (BRIEF-13 rule 1/Tests). */
function roomsContaining(store: RoomStore, address: Member["address"]): string[] {
  return store
    .list()
    .filter((room) => room.members.some((member) => sameAddress(member.address, address)))
    .map((room) => room.code)
}

function sameAddress(a: Member["address"], b: Member["address"]): boolean {
  return a.provider === b.provider && a.source === b.source && a.contactRef === b.contactRef
}

test("BRIEF-13 R1: 'new' from an address already in a room leaves that address in exactly one room store-wide", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)

  const first = await handleCommand(store, { kind: "new" }, alice())
  assert.ok(first.ok)
  if (!first.ok) return

  const second = await handleCommand(store, { kind: "new" }, alice())
  assert.ok(second.ok)
  if (!second.ok) return

  const memberships = roomsContaining(store, alice().address)
  assert.deepEqual(memberships, [second.room.code], "alice must hold exactly one membership store-wide, in the room she just created")
})

test("BRIEF-20 boundary: a non-member naming a room's slug is refused as a membership problem; the same person naming its code is admitted", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)

  const created = await handleCommand(store, { kind: "new" }, alice())
  assert.ok(created.ok)
  if (!created.ok) return
  const slug = created.room.slug

  // Bob has never been a member of alice's room — naming its slug must
  // refuse him plainly, never admit him the way the code would. This is the
  // security boundary of the whole brief: a slug that admits anyone is just
  // a longer code.
  const refused = await handleCommand(store, { kind: "join-by-slug", slug }, bob())
  assert.deepEqual(refused, { ok: false, reason: "not-a-member" })
  assert.equal(store.get(created.room.code)?.members.length, 1, "naming the slug must never add a non-member to the roster")

  // The code admits him — unchanged behaviour (BRIEF-20 §3: "Routing/joining
  // by code keeps today's behaviour exactly").
  const admitted = await handleCommand(store, { kind: "join", code: created.room.code }, bob())
  assert.equal(admitted.ok, true)
  if (!admitted.ok) return
  assert.equal(admitted.room.members.length, 2)
  assert.ok(admitted.room.members.some((m) => m.displayName === "Bob"))

  // Now that Bob really is a member, naming the SAME slug resolves cleanly
  // for him too — the boundary is about membership, not about who asked.
  const confirmed = await handleCommand(store, { kind: "join-by-slug", slug }, bob())
  assert.equal(confirmed.ok, true)
})

test("BRIEF-13 R1: 'resume' on a different room than the one the address is already in leaves that address in exactly one room store-wide", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)

  const roomA = await handleCommand(store, { kind: "new" }, alice())
  assert.ok(roomA.ok)
  if (!roomA.ok) return
  const roomB = await handleCommand(store, { kind: "new" }, bob())
  assert.ok(roomB.ok)
  if (!roomB.ok) return

  const resumed = await handleCommand(store, { kind: "resume", code: roomB.room.code }, alice())
  assert.ok(resumed.ok)
  if (!resumed.ok) return

  const memberships = roomsContaining(store, alice().address)
  assert.deepEqual(memberships, [roomB.room.code], "alice must hold exactly one membership store-wide, in the room she resumed into")
})
