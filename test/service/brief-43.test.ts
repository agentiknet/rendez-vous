/**
 * BRIEF-43: a `member_id` means that member — that one surface. Addressing
 * one surface of a human must not silently widen to their other devices:
 * the engine mints exactly for the ids the agent named, and the prompt (not
 * the engine) is what teaches the agent when to name all of a human's ids.
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { resolveTargets } from "../../src/audience/contract.ts"
import type { Transport } from "../../src/fanout/types.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Member } from "../../src/rooms/types.ts"
import { DeliveryEngine } from "../../src/service/delivery.ts"
import { FakeTransport } from "../fanout/support.ts"

const dirs: string[] = []

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-brief43-"))
  dirs.push(dir)
  return dir
}

/** A room whose roster is exactly the `spec`: one member per
 *  `[displayName, provider]` row, real `Member.id`s minted by `addMember`. */
async function roomWith(spec: readonly (readonly [name: string, provider: string])[]): Promise<{
  store: RoomStore
  code: string
  members: Member[]
}> {
  const dir = await freshDir()
  const store = await RoomStore.open(dir)
  const created = await store.create()
  const members: Member[] = []
  for (const [displayName, provider] of spec) {
    members.push(
      await store.addMember(created.code, {
        displayName,
        tier: "messenger",
        address: { provider, source: "test", contactRef: `ref-${displayName}-${provider}` },
      }),
    )
  }
  return { store, code: created.code, members }
}

function engine(store: RoomStore, transport: Transport): DeliveryEngine {
  return new DeliveryEngine({ store, transport, autoDrain: false })
}

test("say to ONE of a human's two ids mints for THAT ONE only — one surface, addressed as one surface", async () => {
  const { store, code, members } = await roomWith([
    ["Mathilde", "telegram"],
    ["Jeremy", "whatsapp"],
    ["Jeremy", "telegram"],
  ])
  const [mathilde, jeremy1, jeremy2] = members
  if (mathilde === undefined || jeremy1 === undefined || jeremy2 === undefined) throw new Error("roster incomplete")
  const transport = new FakeTransport()
  const outcome = await engine(store, transport).accept(code, "say", "the image for this screen", [jeremy1.id])

  assert.deepEqual(outcome.accepted, [jeremy1.id])
  assert.deepEqual(outcome.unknown, [])

  const mintedFor = (store.get(code)?.deliveries ?? []).map((delivery) => delivery.memberId)
  assert.deepEqual(mintedFor, [jeremy1.id])
})

test("say with BOTH of a human's ids in `to` mints for both — addressing the human, deliberately", async () => {
  const { store, code, members } = await roomWith([
    ["Mathilde", "telegram"],
    ["Jeremy", "whatsapp"],
    ["Jeremy", "telegram"],
  ])
  const [mathilde, jeremy1, jeremy2] = members
  if (mathilde === undefined || jeremy1 === undefined || jeremy2 === undefined) throw new Error("roster incomplete")
  const transport = new FakeTransport()
  const outcome = await engine(store, transport).accept(code, "say", "the resume recap", [jeremy1.id, jeremy2.id])

  assert.deepEqual([...outcome.accepted].sort(), [jeremy1.id, jeremy2.id].sort())

  const mintedFor = (store.get(code)?.deliveries ?? []).map((delivery) => delivery.memberId).sort()
  assert.deepEqual(mintedFor, [jeremy1.id, jeremy2.id].sort())
})

test("whisper to one surface reaches that surface and NO other member — including the same human's other surface", async () => {
  const { store, code, members } = await roomWith([
    ["Mathilde", "telegram"],
    ["Jeremy", "whatsapp"],
    ["Jeremy", "telegram"],
  ])
  const [mathilde, jeremy1, jeremy2] = members
  if (mathilde === undefined || jeremy1 === undefined || jeremy2 === undefined) throw new Error("roster incomplete")
  const transport = new FakeTransport()
  const delivery = engine(store, transport)
  await delivery.accept(code, "whisper", "the real numbers", [jeremy1.id])
  await delivery.drain(code)

  // Arm 1 — the named surface got the whisper itself.
  const privateTexts = transport.sends.filter((send) => send.text.startsWith("(private)"))
  assert.deepEqual(privateTexts.map((send) => send.memberId), [jeremy1.id])
  // Arm 2 (the negative) — nobody else did, the sibling surface included.
  assert.ok(transport.sends.every((send) => send.memberId !== jeremy2.id || !send.text.includes("the real numbers")))
  assert.ok(transport.sends.every((send) => send.memberId !== mathilde.id || !send.text.includes("the real numbers")))
  // The content-free notice still fires, once, to the outsider only.
  const notices = transport.sends.filter((send) => send.text.includes("(the agent whispered to Jeremy)"))
  assert.equal(notices.length, 1)
  assert.equal(notices[0]?.memberId, mathilde.id)
})

test("broadcast (no `to`) still reaches every member, both surfaces of the human included", async () => {
  const { store, code, members } = await roomWith([
    ["Mathilde", "telegram"],
    ["Jeremy", "whatsapp"],
    ["Jeremy", "telegram"],
  ])
  const [mathilde, jeremy1, jeremy2] = members
  if (mathilde === undefined || jeremy1 === undefined || jeremy2 === undefined) throw new Error("roster incomplete")
  const transport = new FakeTransport()
  // The tool path resolves an omitted `to` here first (contract.ts): every
  // current member's id, then one accept.
  const room = store.get(code)
  if (room === undefined) throw new Error("room gone")
  await engine(store, transport).accept(code, "say", "the plan changed", resolveTargets(room, undefined))

  const mintedFor = (store.get(code)?.deliveries ?? []).map((delivery) => delivery.memberId).sort()
  assert.deepEqual(mintedFor, [mathilde.id, jeremy1.id, jeremy2.id].sort())
})

test("an unknown id still lands in `unknown` and mints nothing", async () => {
  const { store, code } = await roomWith([
    ["Mathilde", "telegram"],
    ["Jeremy", "whatsapp"],
    ["Jeremy", "telegram"],
  ])
  const transport = new FakeTransport()
  const outcome = await engine(store, transport).accept(code, "say", "to a ghost", ["member-does-not-exist"])

  assert.deepEqual(outcome.unknown, ["member-does-not-exist"])
  assert.deepEqual(outcome.accepted, [])
  assert.deepEqual(store.get(code)?.deliveries ?? [], [])
})
