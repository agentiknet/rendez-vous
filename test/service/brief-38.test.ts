/**
 * BRIEF-38: addressing a human addresses that human, on every surface they
 * are in the room on. A `say`/`whisper` resolved to one member id fans out
 * to every member of the room sharing that member's display name
 * (`sameHumanName`, BRIEF-37's one-human rule) — and to nobody else.
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
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
  const dir = await mkdtemp(join(tmpdir(), "rdv-brief38-"))
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

test("say to ONE of a human's two ids mints a record for BOTH of them, and reports only the id that was sent", async () => {
  const { store, code, members } = await roomWith([
    ["Mathilde", "telegram"],
    ["Jeremy", "whatsapp"],
    ["Jeremy", "telegram"],
  ])
  const [mathilde, jeremy1, jeremy2] = members
  if (mathilde === undefined || jeremy1 === undefined || jeremy2 === undefined) throw new Error("roster incomplete")
  const transport = new FakeTransport()
  const outcome = await engine(store, transport).accept(code, "say", "the recap", [jeremy1.id])

  // The honest receipt: one id named, one id accepted — not two.
  assert.deepEqual(outcome.accepted, [jeremy1.id])
  assert.deepEqual(outcome.unknown, [])

  const minted = store.get(code)?.deliveries ?? []
  const mintedFor = minted.map((delivery) => delivery.memberId).sort()
  assert.deepEqual(mintedFor, [jeremy1.id, jeremy2.id].sort())
  assert.ok(minted.every((delivery) => delivery.text === "the recap"))
})

test("whisper to one of a human's two ids reaches BOTH of that human's members and NO other member", async () => {
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

  const privateTexts = transport.sends.filter((send) => send.text.startsWith("(private)"))
  // Arm 1 — both surfaces of the same human got the whisper itself.
  assert.deepEqual(
    privateTexts.map((send) => send.memberId).sort(),
    [jeremy1.id, jeremy2.id].sort(),
  )
  // Arm 2 — nobody else saw the content, and the notice fired once as a
  // system record, over the transport to the outsider (BRIEF-39 shape).
  assert.ok(transport.sends.every((send) => send.memberId !== mathilde.id || !send.text.includes("the real numbers")))
  const notices = transport.sends.filter((send) => send.text.includes("(the agent whispered to Jeremy)"))
  assert.equal(notices.length, 1)
  assert.equal(notices[0]?.memberId, mathilde.id)
})

test("say to one member of a room where names are all different mints for exactly that one", async () => {
  const { store, code, members } = await roomWith([
    ["Mathilde", "telegram"],
    ["Jeremy", "whatsapp"],
  ])
  const [mathilde, jeremy] = members
  if (mathilde === undefined || jeremy === undefined) throw new Error("roster incomplete")
  const transport = new FakeTransport()
  await engine(store, transport).accept(code, "say", "only for jeremy", [jeremy.id])

  const mintedFor = (store.get(code)?.deliveries ?? []).map((delivery) => delivery.memberId)
  assert.deepEqual(mintedFor, [jeremy.id])
})

test("an unknown member id still lands in `unknown` and mints nothing", async () => {
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

test("name matching is case-insensitive: `jeremy` and `Jeremy` are one human", async () => {
  const { store, code, members } = await roomWith([
    ["Mathilde", "telegram"],
    ["Jeremy", "whatsapp"],
    ["jeremy", "telegram"],
  ])
  const [, jeremy1, jeremy2] = members
  if (jeremy1 === undefined || jeremy2 === undefined) throw new Error("roster incomplete")
  const transport = new FakeTransport()
  await engine(store, transport).accept(code, "say", "caseless", [jeremy1.id])

  const mintedFor = (store.get(code)?.deliveries ?? []).map((delivery) => delivery.memberId).sort()
  assert.deepEqual(mintedFor, [jeremy1.id, jeremy2.id].sort())
})

test("an answer minted for one surface discharges the turn trigger minted on the sibling surface", async () => {
  const { store, code, members } = await roomWith([
    ["Mathilde", "telegram"],
    ["Jeremy", "whatsapp"],
    ["Jeremy", "telegram"],
  ])
  const [, jeremy1, jeremy2] = members
  if (jeremy1 === undefined || jeremy2 === undefined) throw new Error("roster incomplete")
  const transport = new FakeTransport()
  const seen: string[] = []
  const delivery = new DeliveryEngine({
    store,
    transport,
    autoDrain: false,
    onMint: (_code, kind, memberIds) => {
      if (kind !== "say" && kind !== "whisper") return
      seen.push(...memberIds)
    },
  })
  await delivery.accept(code, "say", "answering jeremy", [jeremy1.id])
  assert.deepEqual([...seen].sort(), [jeremy1.id, jeremy2.id].sort())
})
