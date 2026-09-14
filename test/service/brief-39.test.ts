/**
 * BRIEF-39: every member who is not the whispered-to human learns that a
 * whisper happened — on whatever surface they are on. The notice is a
 * `system` record minted from BOTH delivered arms of `attempt` (push after a
 * transport-confirmed send, pull after its outbox record), so the projected
 * screen — a pull member, the surface the camera films — finally sees the
 * beat's visible half. The record mints with the brief-36 discharge OFF: a
 * notice about someone else's whisper is not an answer to the reader.
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import type { Transport } from "../../src/fanout/types.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Member, Tier } from "../../src/rooms/types.ts"
import { DeliveryEngine } from "../../src/service/delivery.ts"
import { FakeTransport } from "../fanout/support.ts"

const dirs: string[] = []

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-brief39-"))
  dirs.push(dir)
  return dir
}

/** A room whose roster is exactly the `spec`: one member per
 *  `[displayName, provider, tier]` row, real `Member.id`s minted by
 *  `addMember`. Distinct contactRefs — two members may share a provider. */
async function roomWith(spec: readonly (readonly [name: string, provider: string, tier: Tier])[]): Promise<{
  store: RoomStore
  code: string
  members: Member[]
}> {
  const dir = await freshDir()
  const store = await RoomStore.open(dir)
  const created = await store.create()
  const members: Member[] = []
  for (const [displayName, provider, tier] of spec) {
    members.push(
      await store.addMember(created.code, {
        displayName,
        tier,
        address: { provider, source: "test", contactRef: `ref-${displayName}-${provider}` },
      }),
    )
  }
  return { store, code: created.code, members }
}

function engine(store: RoomStore, transport: Transport): DeliveryEngine {
  return new DeliveryEngine({ store, transport, autoDrain: false })
}

function systemRecordsFor(store: RoomStore, code: string, memberId: string): { text: string }[] {
  return (store.get(code)?.deliveries ?? [])
    .filter((delivery) => delivery.kind === "system" && delivery.memberId === memberId)
    .map((delivery) => ({ text: delivery.text }))
}

test("a whisper in a room of pull outsiders gives every outsider exactly one notice record", async () => {
  const { store, code, members } = await roomWith([
    ["Jeremy", "room-web", "room-web"],
    ["Mathilde", "room-web", "room-web"],
    ["Claire", "room-web", "room-web"],
  ])
  const [jeremy, mathilde, claire] = members
  if (jeremy === undefined || mathilde === undefined || claire === undefined) throw new Error("roster incomplete")
  const transport = new FakeTransport()
  const delivery = engine(store, transport)
  await delivery.accept(code, "whisper", "the real numbers", [jeremy.id])
  await delivery.drain(code)

  for (const outsider of [mathilde, claire]) {
    const notices = systemRecordsFor(store, code, outsider.id)
    assert.equal(notices.length, 1, `outsider ${outsider.displayName} got ${notices.length} notices`)
    assert.ok(notices[0]!.text.includes("whispered to Jeremy"))
  }
  // The whisper itself reached Jeremy through his outbox, and he was not
  // also told about it.
  assert.equal(systemRecordsFor(store, code, jeremy.id).length, 0)
})

test("a mixed room: the push outsider's notice goes over the transport, the pull outsider's sits in the outbox — one each", async () => {
  const { store, code, members } = await roomWith([
    ["Jeremy", "whatsapp", "messenger"],
    ["Mathilde", "telegram", "messenger"],
    ["Claire", "room-web", "room-web"],
  ])
  const [jeremy, mathilde, claire] = members
  if (jeremy === undefined || mathilde === undefined || claire === undefined) throw new Error("roster incomplete")
  const transport = new FakeTransport()
  const delivery = engine(store, transport)
  await delivery.accept(code, "whisper", "hush", [jeremy.id])
  await delivery.drain(code)

  const pushNotices = transport.sends.filter((send) => send.memberId === mathilde.id)
  assert.equal(pushNotices.length, 1)
  assert.equal(pushNotices[0]?.text, "Room: (the agent whispered to Jeremy)")
  assert.equal(transport.sends.some((send) => send.memberId === claire.id), false)
  const pullNotices = systemRecordsFor(store, code, claire.id)
  assert.equal(pullNotices.length, 1)
  assert.ok(pullNotices[0]!.text.includes("whispered to Jeremy"))
})

test("the whispered-to human's second surface gets neither the whisper nor a notice (BRIEF-43: the sibling is not widened in)", async () => {
  const { store, code, members } = await roomWith([
    ["Jeremy", "whatsapp", "messenger"],
    ["Jeremy", "telegram", "messenger"],
    ["Mathilde", "room-web", "room-web"],
  ])
  const [jeremy1, jeremy2, mathilde] = members
  if (jeremy1 === undefined || jeremy2 === undefined || mathilde === undefined) throw new Error("roster incomplete")
  const transport = new FakeTransport()
  const delivery = engine(store, transport)
  await delivery.accept(code, "whisper", "between us", [jeremy1.id])
  await delivery.drain(code)

  // The sibling surface is treated as not-an-outsider by `sameHumanName`,
  // so it receives NO notice — and, since BRIEF-43 removed the expansion,
  // it also does not silently receive the whisper itself.
  const secondSurfaceNotices = systemRecordsFor(store, code, jeremy2.id)
  assert.equal(secondSurfaceNotices.length, 0)
  assert.equal(transport.sends.some((send) => send.memberId === jeremy2.id), false)
  assert.ok(transport.sends.some((send) => send.memberId === jeremy1.id && send.text.startsWith("(private)")))
})

test("no outsider record carries the whispered text", async () => {
  const { store, code, members } = await roomWith([
    ["Jeremy", "whatsapp", "messenger"],
    ["Mathilde", "telegram", "messenger"],
    ["Claire", "room-web", "room-web"],
  ])
  const [jeremy, mathilde, claire] = members
  if (jeremy === undefined || mathilde === undefined || claire === undefined) throw new Error("roster incomplete")
  const transport = new FakeTransport()
  const delivery = engine(store, transport)
  await delivery.accept(code, "whisper", "the margin is 210 euros", [jeremy.id])
  await delivery.drain(code)

  for (const outsider of [mathilde, claire]) {
    for (const record of store.get(code)?.deliveries ?? []) {
      if (record.memberId !== outsider.id) continue
      assert.ok(!record.text.includes("the margin is 210 euros"))
    }
  }
  assert.ok(transport.sends.every((send) => !send.text.includes("the margin is 210 euros") || send.memberId === jeremy.id))
})

test("a whisper whose delivery fails announces nothing", async () => {
  const { store, code, members } = await roomWith([
    ["Jeremy", "whatsapp", "messenger"],
    ["Mathilde", "room-web", "room-web"],
  ])
  const [jeremy, mathilde] = members
  if (jeremy === undefined || mathilde === undefined) throw new Error("roster incomplete")
  const transport = new FakeTransport()
  transport.failFor(jeremy.id)
  const delivery = engine(store, transport)
  await delivery.accept(code, "whisper", "never landed", [jeremy.id])
  await delivery.drain(code)

  // The record is still pending (retrying), the outsider got no notice —
  // announcing a whisper that did not arrive would be a lie. This arm
  // asserts behaviour that was already correct before BRIEF-39 (the old
  // code announced only on send success too), so it cannot fail first.
  assert.equal(systemRecordsFor(store, code, mathilde.id).length, 0)
})

test("a whisper notice minted for the turn-starting outsider does NOT discharge the turn-answered-nobody obligation", async () => {
  const { store, code, members } = await roomWith([
    ["Jeremy", "whatsapp", "messenger"],
    ["Mathilde", "room-web", "room-web"],
  ])
  const [jeremy, mathilde] = members
  if (jeremy === undefined || mathilde === undefined) throw new Error("roster incomplete")
  const transport = new FakeTransport()
  const discharged: string[][] = []
  const delivery = new DeliveryEngine({
    store,
    transport,
    autoDrain: false,
    onMint: (mintedCode, kind, memberIds) => {
      if (mintedCode !== code) return
      if (kind !== "say" && kind !== "whisper" && kind !== "system") return
      discharged.push([...memberIds])
    },
  })
  await delivery.accept(code, "whisper", "the answer went to Jeremy", [jeremy.id])
  await delivery.drain(code)

  // Mathilde got her notice record…
  assert.equal(systemRecordsFor(store, code, mathilde.id).length, 1)
  // …but no mint ever named her: the notice mint ran with the discharge
  // off, so brief 36's window can still fire "you got no reply" for her.
  assert.ok(discharged.every((ids) => !ids.includes(mathilde.id)))
})
