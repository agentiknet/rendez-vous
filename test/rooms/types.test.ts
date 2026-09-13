import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { RoomStore } from "../../src/rooms/store.ts"
import { PULL_STALE_MS, retentionFloors } from "../../src/rooms/types.ts"

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
