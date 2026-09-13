import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { RoomStore } from "../../src/rooms/store.ts"
import { DeliveryEngine } from "../../src/service/delivery.ts"
import { MemberSender } from "../../src/service/member-send.ts"
import {
  reportAssertionViolation,
  sendReachedNobody,
  turnAnsweredNobody,
} from "../../src/service/post-turn-assertions.ts"
import { MemoryTransport } from "../../src/service/transports.ts"

// Torn down once, after the file — not in a per-test `finally` (ENOTEMPTY
// race with the store's own async persist, see test/fanout/reader.test.ts).
const dirs: string[] = []
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-post-turn-assertions-"))
  dirs.push(dir)
  return dir
}

// --- assertion 2's predicate: sendReachedNobody ---

test("sendReachedNobody fires when every explicitly-named id was unknown", () => {
  assert.equal(sendReachedNobody({ accepted: [], unknown: ["ghost"] }), true)
})

test("sendReachedNobody does not fire when at least one named id was known, even alongside an unknown one", () => {
  assert.equal(sendReachedNobody({ accepted: ["m1"], unknown: ["ghost"] }), false)
})

test("sendReachedNobody does not fire when nobody was named at all — an empty outcome named nothing wrong", () => {
  assert.equal(sendReachedNobody({ accepted: [], unknown: [] }), false)
})

// --- assertion 4's predicate: turnAnsweredNobody ---

test("turnAnsweredNobody fires when the turn's only delivery whispered a third party, never the trigger", () => {
  const minted = [{ kind: "whisper" as const, memberId: "bob" }]
  assert.equal(turnAnsweredNobody("alice", minted), true)
})

test("turnAnsweredNobody does not fire when a say/whisper minted this turn targeted the triggering member", () => {
  const minted = [
    { kind: "whisper" as const, memberId: "bob" },
    { kind: "say" as const, memberId: "alice" },
  ]
  assert.equal(turnAnsweredNobody("alice", minted), false)
})

test("turnAnsweredNobody ignores system/tool records even when addressed to the trigger — neither is audience speech", () => {
  const minted = [
    { kind: "system" as const, memberId: "alice" },
    { kind: "tool" as const, memberId: "alice" },
  ]
  assert.equal(turnAnsweredNobody("alice", minted), true)
})

// --- reportAssertionViolation: the one reporting mechanism assertions 2-4
// share (assertion 1 stays log-only — see reader.ts's comment on why) ---

test("reportAssertionViolation logs a warning naming the assertion and the room, and broadcasts a system notice to every member", async () => {
  const dir = await freshDir()
  const store = await RoomStore.open(dir)
  const created = await store.create()
  const push = await store.addMember(created.code, {
    displayName: "Alice",
    tier: "messenger",
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+1" },
  })
  const pull = await store.addMember(created.code, {
    displayName: "Chloe",
    tier: "room-web",
    address: { provider: "room-web", source: "room-web", contactRef: "chloe" },
  })
  const transport = new MemoryTransport()
  const engine = new DeliveryEngine({ store, transport, autoDrain: false })
  const sender = new MemberSender({ store, transport, engine })
  const room = store.get(created.code)
  assert.ok(room !== undefined)

  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    await reportAssertionViolation(sender, room, "ambiguous-sender", "a made-up detail sentence")
  } finally {
    console.warn = original
  }

  assert.equal(warnings.length, 1)
  assert.ok(warnings[0]?.includes("ambiguous-sender"), "the warning must name the assertion")
  assert.ok(warnings[0]?.includes(room.code), "the warning must name the room")
  assert.ok(warnings[0]?.includes("a made-up detail sentence"))

  // The push member gets it straight over the transport — no drain required.
  assert.equal(transport.sends.length, 1)
  assert.equal(transport.sends[0]?.member.id, push.id)
  assert.ok(transport.sends[0]?.message.text.includes("a made-up detail sentence"))

  // The pull member gets a persisted `kind: "system"` outbox record instead.
  const record = store.get(created.code)?.deliveries?.find((delivery) => delivery.memberId === pull.id)
  assert.ok(record !== undefined)
  assert.equal(record.kind, "system")
  assert.ok(record.text.includes("a made-up detail sentence"))
})
