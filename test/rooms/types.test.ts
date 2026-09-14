import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { RoomStore } from "../../src/rooms/store.ts"
import { PULL_STALE_MS, pullMemberStale, retentionFloors, type Member } from "../../src/rooms/types.ts"

const dirs: string[] = []
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshStore(): Promise<RoomStore> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-types-"))
  dirs.push(dir)
  return RoomStore.open(dir)
}

test("retentionFloors warns once, at warning level, ONLY for a stale pull member that never acked at all — never for one that acked then genuinely left (brief 14, defect 5)", async () => {
  const store = await freshStore()
  const room = await store.create()
  const ghost = await store.addMember(room.code, {
    displayName: "Ghost",
    tier: "room-web",
    address: { provider: "room-web", source: "room-web", contactRef: "ghost" },
  })
  const departed = await store.addMember(room.code, {
    displayName: "Departed",
    tier: "room-web",
    address: { provider: "room-web", source: "room-web", contactRef: "departed" },
  })
  // Departed acked once, then genuinely stopped — an ordinary, unremarkable
  // departure. Ghost never acked at all — the client-bug case defect 5
  // exists to catch. `pullMemberStale` alone cannot tell these apart; the
  // warning is what closes that gap.
  await store.ackCursor(room.code, departed.id, 0, new Date().toISOString())

  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    const staleAt = Date.now() + PULL_STALE_MS + 1000
    const staleRoom = store.get(room.code)
    assert.ok(staleRoom !== undefined)
    retentionFloors(staleRoom, staleAt)
    // A second sweep, same members, further in the future: the warning must
    // not repeat.
    retentionFloors(staleRoom, staleAt + 5000)

    const ghostWarnings = warnings.filter((line) => line.includes(ghost.id))
    const departedWarnings = warnings.filter((line) => line.includes(departed.id))
    assert.equal(ghostWarnings.length, 1, "the never-acked member must be warned about exactly once, not once per sweep")
    assert.equal(departedWarnings.length, 0, "a member who acked before going stale is an ordinary departure, not a warning")
  } finally {
    console.warn = original
  }
})

// --- Brief 36 (presence): receiving a message from a member is proof they
// are there — stronger evidence than an outbox ack, and the one liveness
// signal the staleness rule ignored. A member who just spoke cannot be away:
// the agent answering "the only member who looked present" while the speaker
// reads as away is how the answer got routed around the person who asked. ---

function staleWebMember(fields: Partial<Member> = {}): Member {
  return {
    id: "m-web",
    displayName: "Web",
    tier: "room-web",
    address: { provider: "room-web", source: "room-web", contactRef: "web" },
    joinedAt: new Date(Date.now() - PULL_STALE_MS * 10).toISOString(),
    ...fields,
  }
}

test("a pull member who has just sent an inbound is NOT stale — joined long ago, never acked, but speaking is presence (brief 36)", () => {
  const member = staleWebMember({ lastSpokeAt: new Date().toISOString() })
  // A nowMs at which joinedAt ALONE would declare them stale.
  const nowMs = Date.parse(member.joinedAt) + PULL_STALE_MS + 1000
  assert.equal(pullMemberStale(member, nowMs), false, "a member who just spoke cannot be away")
})

test("a pull member who joined long ago, never acked and never spoke IS still stale — the rule is not weakened (brief 36)", () => {
  const member = staleWebMember()
  const nowMs = Date.parse(member.joinedAt) + PULL_STALE_MS + 1000
  assert.equal(pullMemberStale(member, nowMs), true, "a tab that never came back must still go stale")
})

test("an ack still refreshes as it did before — lastSpokeAt adds a signal, it does not replace ackedAt", () => {
  const nowMs = Date.now()
  // Acked recently, never spoke: present, exactly as before the field existed.
  const acked = staleWebMember({ ackedAt: new Date(nowMs - 1000).toISOString() })
  assert.equal(pullMemberStale(acked, nowMs), false)
  // Acked long ago but spoke just now: the SPEAK keeps them present — the
  // most recent liveness evidence wins, whichever signal it came from.
  const spokeAfterAck = staleWebMember({
    ackedAt: new Date(nowMs - PULL_STALE_MS * 2).toISOString(),
    lastSpokeAt: new Date(nowMs - 1000).toISOString(),
  })
  assert.equal(pullMemberStale(spokeAfterAck, nowMs), false)
  // Spoke long ago, acked even longer ago: stale — neither signal is fresh.
  const bothOld = staleWebMember({
    ackedAt: new Date(nowMs - PULL_STALE_MS * 3).toISOString(),
    lastSpokeAt: new Date(nowMs - PULL_STALE_MS * 2).toISOString(),
  })
  assert.equal(pullMemberStale(bothOld, nowMs), true)
})
