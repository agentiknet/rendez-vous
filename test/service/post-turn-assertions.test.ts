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

async function twoPushRoom(): Promise<{
  code: string
  memberIds: string[]
  room: import("../../src/rooms/types.ts").Room
  sender: MemberSender
  store: RoomStore
  transport: MemoryTransport
  engine: DeliveryEngine
}> {
  const dir = await freshDir()
  const store = await RoomStore.open(dir)
  const created = await store.create()
  const memberIds: string[] = []
  for (let i = 0; i < 2; i++) {
    const m = await store.addMember(created.code, {
      displayName: `Member ${i}`,
      tier: "messenger",
      address: { provider: "whatsapp", source: "agentpush", contactRef: `+${i}` },
    })
    memberIds.push(m.id)
  }
  const transport = new MemoryTransport()
  const engine = new DeliveryEngine({ store, transport, autoDrain: false })
  const sender = new MemberSender({ store, transport, engine })
  const room = store.get(created.code)
  assert.ok(room !== undefined)
  return { code: created.code, memberIds, room, sender, store, transport, engine }
}

async function fiveMemberRoom(): Promise<{
  code: string
  memberIds: string[]
  room: import("../../src/rooms/types.ts").Room
  sender: MemberSender
  store: RoomStore
  transport: MemoryTransport
  engine: DeliveryEngine
}> {
  const dir = await freshDir()
  const store = await RoomStore.open(dir)
  const created = await store.create()
  const memberIds: string[] = []
  for (let i = 0; i < 5; i++) {
    const m = await store.addMember(created.code, {
      displayName: `Member ${i}`,
      tier: "messenger",
      address: { provider: "whatsapp", source: "agentpush", contactRef: `+${i}` },
    })
    memberIds.push(m.id)
  }
  const transport = new MemoryTransport()
  const engine = new DeliveryEngine({ store, transport, autoDrain: false })
  const sender = new MemberSender({ store, transport, engine })
  const room = store.get(created.code)
  assert.ok(room !== undefined)
  return { code: created.code, memberIds, room, sender, store, transport, engine }
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

// --- reportAssertionViolation: the one reporting mechanism ---

test("reportAssertionViolation logs a warning naming the assertion and the room, and sends exactly one system notice — to the specified member", async () => {
  const { room, sender, transport, memberIds } = await twoPushRoom()
  const subjectId = memberIds[0]!

  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    await reportAssertionViolation(sender, room, "turn-answered-nobody", "a made-up detail sentence", subjectId, "Your message did not get a reply this turn.")
  } finally {
    console.warn = original
  }

  assert.equal(warnings.length, 1)
  assert.ok(warnings[0]?.includes("turn-answered-nobody"), "the warning must name the assertion")
  assert.ok(warnings[0]?.includes(room.code), "the warning must name the room")
  assert.ok(warnings[0]?.includes("a made-up detail sentence"))

  assert.equal(transport.sends.length, 1)
  assert.equal(transport.sends[0]?.member.id, subjectId, "the only delivery is to the specified member")
})

test("turn-answered-nobody in a room with five members mints exactly one delivery to the trigger member", async () => {
  const { room, sender, transport, memberIds } = await fiveMemberRoom()
  const triggerId = memberIds[2]!

  await reportAssertionViolation(sender, room, "turn-answered-nobody", "detail", triggerId, "Your message did not get a reply this turn.")

  assert.equal(transport.sends.length, 1)
  assert.equal(transport.sends[0]?.member.id, triggerId)
})

test("the delivered text contains no member id, no room code, and no assertion name", async () => {
  const { room, sender, transport, memberIds } = await twoPushRoom()
  const subjectId = memberIds[0]!

  await reportAssertionViolation(sender, room, "turn-answered-nobody", "technical detail for the log", subjectId, "Your message did not get a reply this turn.")

  assert.equal(transport.sends.length, 1)
  const text = transport.sends[0]?.message.text ?? ""
  assert.ok(!text.includes(subjectId), "must not contain the member id")
  assert.ok(!text.includes(room.code), "must not contain the room code")
  assert.ok(!text.includes("turn-answered-nobody"), "must not contain the assertion name")
  assert.ok(!text.includes("system"), "must not contain the system prefix")
  assert.ok(text.includes("Your message did not get a reply this turn."))
})

test("console.warn still carries the assertion name and the room — the operator path is not downgraded", async () => {
  const { room, sender, memberIds } = await twoPushRoom()

  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    await reportAssertionViolation(sender, room, "ambiguous-sender", `room ${room.code}: inbound from test`, memberIds[0]!, "Your message could not be routed.")
  } finally {
    console.warn = original
  }

  assert.equal(warnings.length, 1)
  assert.ok(warnings[0]?.includes("ambiguous-sender"), "warning must name the assertion")
  assert.ok(warnings[0]?.includes(room.code), "warning must name the room")
  assert.ok(warnings[0]?.includes("inbound from test"), "warning must carry the full detail")
})

test("a member who is neither the subject nor involved receives nothing", async () => {
  const { room, sender, transport, memberIds } = await fiveMemberRoom()
  const subjectId = memberIds[1]!
  const uninvolvedId = memberIds[4]!

  await reportAssertionViolation(sender, room, "turn-answered-nobody", "detail", subjectId, "Your message did not get a reply this turn.")

  const recipientIds = transport.sends.map((s) => s.member.id)
  assert.equal(transport.sends.length, 1)
  assert.ok(recipientIds.includes(subjectId), "the subject must receive it")
  assert.ok(!recipientIds.includes(uninvolvedId), "the uninvolved member must not receive it")
  for (const id of memberIds) {
    if (id !== subjectId) {
      assert.ok(!recipientIds.includes(id), `member ${id} must not receive the assertion`)
    }
  }
})