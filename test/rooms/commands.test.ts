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
