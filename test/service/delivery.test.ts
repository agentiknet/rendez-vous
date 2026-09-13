import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { after, test } from "node:test"
import { DaemonClient } from "../../src/daemon/client.ts"
import { RoomFanout } from "../../src/fanout/reader.ts"
import type { Transport } from "../../src/fanout/types.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import { MAX_DELIVERY_ATTEMPTS, type Delivery, type Member } from "../../src/rooms/types.ts"
import { LocalBooter } from "../../src/service/booter.ts"
import {
  DELIVERED_RETENTION_MS,
  DeliveryEngine,
  MAX_RETAINED_DELIVERED,
  pruneDeliveries,
  prunedUpTo,
} from "../../src/service/delivery.ts"
import { PULL_STALE_MS, retentionFloors } from "../../src/rooms/types.ts"
import { createHttpServer } from "../../src/service/http.ts"
import { RoomService } from "../../src/service/room-service.ts"
import { MemoryTransport } from "../../src/service/transports.ts"
import { FakeSource, FakeTransport, type RecordedSend, waitFor } from "../fanout/support.ts"
import { startExtendedFakeDaemon, type ExtendedFakeDaemon } from "./fake-daemon-extra.ts"

const dirs: string[] = []
const daemons: ExtendedFakeDaemon[] = []
const services: RoomService[] = []
const servers: { close(): Promise<void> }[] = []

after(async () => {
  await Promise.all(servers.map((server) => server.close()))
  await Promise.all(services.map((service) => service.stop()))
  await Promise.all(daemons.map((daemon) => daemon.close()))
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-delivery-"))
  dirs.push(dir)
  return dir
}

/** A room with Alice (messenger/telegram), Bob (messenger/whatsapp) and
 *  Screen (room-web). `addMember` mints the real `Member.id`s — exactly the
 *  instability the plan documents — so every test targets through the
 *  returned `alice`/`bob`/`screen` Members, never through a literal. */
async function roomWith(): Promise<{
  dir: string
  store: RoomStore
  code: string
  alice: Member
  bob: Member
  screen: Member
}> {
  const dir = await freshDir()
  const store = await RoomStore.open(dir)
  const created = await store.create()
  const add = async (displayName: string, tier: Member["tier"], provider: string): Promise<Member> =>
    store.addMember(created.code, {
      displayName,
      tier,
      address: { provider, source: "test", contactRef: `ref-${displayName}` },
    })
  const alice = await add("Alice", "messenger", "telegram")
  const bob = await add("Bob", "messenger", "whatsapp")
  const screen = await add("Screen", "room-web", "room-web")
  return { dir, store, code: created.code, alice, bob, screen }
}

function pendingDelivery(id: string, memberId: string, text: string, failures = 0): Delivery {
  return {
    id,
    memberId,
    kind: "say",
    text,
    status: "pending",
    failures,
    lastError: undefined,
    createdAt: "2026-09-12T10:00:00.000Z",
    deliveredAt: undefined,
  }
}

interface EngineOpts {
  sendTimeoutMs?: number
  reportFailure?: (code: string, correction: string) => Promise<void>
}

function engine(store: RoomStore, transport: Transport, opts: EngineOpts = {}): DeliveryEngine {
  return new DeliveryEngine({
    store,
    transport,
    // Engine-level suites drive `drain` explicitly: no auto-drain race.
    autoDrain: false,
    ...(opts.sendTimeoutMs !== undefined ? { sendTimeoutMs: opts.sendTimeoutMs } : {}),
    ...(opts.reportFailure !== undefined ? { reportFailure: opts.reportFailure } : {}),
  })
}

/** A transport that fails persistently for a given member id, recording the
 *  sends it does make. */
function failingTransport(failing: ReadonlySet<string>, sends: RecordedSend[]): Transport {
  return {
    async send(target: Member, message) {
      if (failing.has(target.id)) throw new Error(`provider rejected ${target.id}`)
      sends.push({ memberId: target.id, text: message.text, artifactUrl: message.artifactUrl })
    },
  }
}

function deliveriesOf(room: ReturnType<RoomStore["get"]>): Delivery[] {
  return room?.deliveries ?? []
}

test("say with an explicit `to` list makes no transport call for anyone else", async () => {
  const { store, code, alice, bob } = await roomWith()
  const transport = new FakeTransport()
  const eng = engine(store, transport)

  const outcome = await eng.accept(code, "say", "boards at gate 4", [bob.id])
  assert.deepEqual(outcome.accepted, [bob.id])
  assert.deepEqual(outcome.unknown, [])
  await eng.drain(code)

  assert.deepEqual(transport.sends.map((send) => send.memberId), [bob.id])
  assert.equal(transport.sends[0]?.text, "boards at gate 4")
  const record = deliveriesOf(store.get(code))[0]
  assert.equal(record?.status, "delivered")
  assert.ok(record?.deliveredAt !== undefined)
  // A push hand-off the provider accepted is confirmed by the transport —
  // the only confirmation that ships today (PLAN-02 §3-D2, amendment F8).
  assert.equal(record?.confirmedBy, "transport")
  void alice
})

test("a pull member's delivery completes with no transport call and honestly no confirmation (D2/F8)", async () => {
  const { store, code, screen } = await roomWith()
  const transport = new FakeTransport()
  const eng = engine(store, transport)

  await eng.accept(code, "whisper", "the vault code is 44-21", [screen.id])
  await eng.drain(code)

  const record = deliveriesOf(store.get(code)).find((delivery) => delivery.memberId === screen.id)
  assert.equal(record?.status, "delivered")
  assert.ok(record?.deliveredAt !== undefined)
  assert.equal(
    record?.confirmedBy,
    undefined,
    "an SSE flush proves the server sent, not that anyone received — no guessed confirmation",
  )
  assert.ok(!JSON.stringify(record).includes('"confirmedBy"'))
  void transport
})

test("say accepts every member when the handler expands the omitted `to`, and room-web draws no transport call", async () => {
  const { store, code, alice, bob, screen } = await roomWith()
  const transport = new FakeTransport()
  const eng = engine(store, transport)
  const room = store.get(code)
  assert.ok(room !== undefined)

  // Exactly the call the MCP handler makes for an omitted `to`.
  const outcome = await eng.accept(code, "say", "room update", room.members.map((member) => member.id))
  assert.deepEqual(outcome.accepted, [alice.id, bob.id, screen.id])
  assert.deepEqual(outcome.unknown, [])
  await eng.drain(code)

  assert.deepEqual(
    transport.sends.map((send) => send.memberId).sort(),
    [alice.id, bob.id].sort(),
  )
  for (const send of transport.sends) assert.equal(send.text, "room update")
})

test("whisper: target gets the text, other messengers get the content-free notice, room-web gets no transport call", async () => {
  const { store, code, alice, bob, screen } = await roomWith()
  const transport = new FakeTransport()
  const eng = engine(store, transport)

  await eng.accept(code, "whisper", "the vault code is 44-21", [alice.id, bob.id, screen.id])
  await eng.drain(code)

  const toAlice = transport.sends.find((send) => send.memberId === alice.id)
  const toBob = transport.sends.find((send) => send.memberId === bob.id)
  assert.equal(toAlice?.text, "(private) the vault code is 44-21")
  assert.equal(toBob?.text, "(the agent whispered to Alice)")
  assert.ok(!toBob?.text.includes("44-21"))
  assert.equal(transport.sends.some((send) => send.memberId === screen.id), false)
})

test("a transport that throws for one member still delivers to the others; at the cap the record fails and the reactive channel is told", async () => {
  const { store, code, alice, bob } = await roomWith()
  const sends: RecordedSend[] = []
  const transport = failingTransport(new Set([alice.id]), sends)
  const corrections: string[] = []
  const eng = engine(store, transport, {
    reportFailure: async (_code, correction) => {
      corrections.push(correction)
    },
  })

  await eng.accept(code, "say", "weather looks fine", [alice.id, bob.id])
  await eng.drain(code)

  // Bob went out on the very first drain despite Alice's provider failing.
  assert.deepEqual(sends.map((send) => send.memberId), [bob.id])
  let record = deliveriesOf(store.get(code)).find((d) => d.memberId === alice.id)
  assert.equal(record?.failures, 1)
  assert.equal(record?.status, "pending")
  assert.ok(record?.lastError !== undefined)

  // Four more drains: the fifth attempt crosses the cap.
  for (let i = 0; i < MAX_DELIVERY_ATTEMPTS - 1; i += 1) {
    await eng.drain(code)
  }
  record = deliveriesOf(store.get(code)).find((d) => d.memberId === alice.id)
  assert.equal(record?.failures, MAX_DELIVERY_ATTEMPTS)
  assert.equal(record?.status, "failed")
  assert.equal(corrections.length, 1)
  assert.ok(!corrections[0]!.includes("weather"), "the correction must not echo the message text")

  // A failed record is dead: a later boot's drainAll must not retry it.
  const sendsBefore = sends.length
  await eng.drainAll()
  assert.equal(sends.length, sendsBefore)
})

test("a pending record present at boot is re-attempted; one already at the cap is not", async () => {
  const { store, code, alice } = await roomWith()
  const fresh = pendingDelivery("d1", alice.id, "left over from a dead process")
  const capped = {
    ...pendingDelivery("d2", alice.id, "doomed retry", MAX_DELIVERY_ATTEMPTS),
    lastError: "provider rejected",
  }
  await store.update(code, { deliveries: [fresh, capped] })

  const transport = new FakeTransport()
  const eng = engine(store, transport)
  await eng.drainAll()

  assert.deepEqual(transport.sends.map((send) => send.text), ["left over from a dead process"])
  const records = deliveriesOf(store.get(code))
  assert.equal(records.find((d) => d.id === "d1")?.status, "delivered")
  assert.equal(records.find((d) => d.id === "d2")?.status, "pending", "an at-cap record is left exactly as it was")
  assert.equal(records.find((d) => d.id === "d2")?.failures, MAX_DELIVERY_ATTEMPTS)
})

test("a hanging provider send times out, increments failures, and does not block the other member", async () => {
  const { store, code, alice, bob } = await roomWith()
  const sends: RecordedSend[] = []
  const hanging: Transport = {
    async send(target: Member, message) {
      if (target.id === alice.id) await new Promise<void>(() => undefined) // never settles
      sends.push({ memberId: target.id, text: message.text, artifactUrl: message.artifactUrl })
    },
  }
  const eng = engine(store, hanging, { sendTimeoutMs: 20 })

  await eng.accept(code, "say", "slow provider", [alice.id, bob.id])
  await eng.drain(code)

  assert.equal(sends.find((send) => send.memberId === bob.id)?.text, "slow provider")
  const record = deliveriesOf(store.get(code)).find((d) => d.memberId === alice.id)
  assert.equal(record?.failures, 1)
  assert.match(record?.lastError ?? "", /timed out/)
})

test("a member who left between acceptance and drain is an ordinary failure — delivered to nobody else", async () => {
  const { store, code, alice } = await roomWith()
  const transport = new FakeTransport()
  const eng = engine(store, transport)

  await store.update(code, {
    deliveries: [{ ...pendingDelivery("d1", "ghost", "for whoever used to be here"), kind: "whisper" as const }],
  })
  void alice
  await eng.drain(code)

  assert.equal(transport.sends.length, 0)
  const record = deliveriesOf(store.get(code))[0]
  assert.equal(record?.failures, 1)
  assert.equal(record?.status, "pending")
  assert.match(record?.lastError ?? "", /no longer in the room/)
})

// Retention (the unbounded-growth finding): `deliveries` is a work queue, not
// a log. `pending` and `failed` are load-bearing — `drainAll` retries the
// former on boot and the latter is the evidence behind a correction already
// sent — so the prune may only ever touch `delivered` records.

function deliveredAt(id: string, memberId: string, text: string, stamp: string): Delivery {
  return { ...pendingDelivery(id, memberId, text), status: "delivered", createdAt: stamp, deliveredAt: stamp }
}

function failedDelivery(id: string, memberId: string, text: string): Delivery {
  return { ...pendingDelivery(id, memberId, text, MAX_DELIVERY_ATTEMPTS), status: "failed", lastError: "provider rejected" }
}

test("pruning keeps every pending and failed record, however old and however many", () => {
  const ancient = new Date(Date.now() - 10 * DELIVERED_RETENTION_MS).toISOString()
  const records: Delivery[] = []
  for (let i = 0; i < 40; i += 1) records.push(deliveredAt(`d${i + 1}`, "m1", `done ${i}`, ancient))
  for (let i = 0; i < 6; i += 1) records.push({ ...pendingDelivery(`p${i + 1}`, "m1", `waiting ${i}`), createdAt: ancient })
  for (let i = 0; i < 4; i += 1) records.push({ ...failedDelivery(`f${i + 1}`, "m1", `gave up ${i}`), createdAt: ancient })

  const pruned = pruneDeliveries(records, Date.now())

  assert.deepEqual(
    pruned.map((record) => record.id),
    ["p1", "p2", "p3", "p4", "p5", "p6", "f1", "f2", "f3", "f4"],
    "every pending and failed record survives, in its original order; every delivered one is gone",
  )
})

test("pruning keeps only the newest MAX_RETAINED_DELIVERED delivered records", () => {
  const now = Date.now()
  const records: Delivery[] = []
  const total = MAX_RETAINED_DELIVERED + 7
  for (let i = 0; i < total; i += 1) {
    records.push(deliveredAt(`d${i + 1}`, "m1", `done ${i}`, new Date(now - (total - i) * 1000).toISOString()))
  }

  const pruned = pruneDeliveries(records, now)

  assert.equal(pruned.length, MAX_RETAINED_DELIVERED)
  assert.equal(pruned[0]?.id, `d${total - MAX_RETAINED_DELIVERED + 1}`)
  assert.equal(pruned[pruned.length - 1]?.id, `d${total}`)
})

test("a delivered record past the retention window is dropped even in a room too quiet to hit the count cap", () => {
  const now = Date.now()
  const stale = new Date(now - DELIVERED_RETENTION_MS - 60_000).toISOString()
  const fresh = new Date(now - 1000).toISOString()
  const records: Delivery[] = [
    { ...deliveredAt("d1", "m1", "the vault code is 44-21", stale), kind: "whisper" },
    deliveredAt("d2", "m1", "still recent", fresh),
  ]

  const pruned = pruneDeliveries(records, now)

  assert.deepEqual(pruned.map((record) => record.id), ["d2"])
  assert.ok(!JSON.stringify(pruned).includes("44-21"), "the stale whisper text is gone from the record at rest")
})

test("a delivered record whose timestamps cannot be dated is dropped, not kept forever", () => {
  const records: Delivery[] = [{ ...deliveredAt("d1", "m1", "undateable", "not-a-date"), deliveredAt: undefined }]
  assert.deepEqual(pruneDeliveries(records, Date.now()), [])
})

// The retention floor (PLAN-02 step 4, brief C): a live pull member's
// undrained delivered records survive BOTH axes; a stale member's floor is
// released and the same records go; the member itself is never removed.

test("the floor keeps a delivered record the count cap and the age window would both drop", () => {
  const now = Date.now()
  const ancient = new Date(now - 10 * DELIVERED_RETENTION_MS).toISOString()
  const records: Delivery[] = []
  for (let i = 0; i < MAX_RETAINED_DELIVERED + 5; i += 1) {
    records.push(deliveredAt(`d${i + 1}`, "m1", `done ${i}`, ancient))
  }
  // Without a floor: everything is ancient, so the age window drops it all.
  assert.deepEqual(pruneDeliveries(records, now), [])
  // With a floor for m1 at d10: m1's every seq above it survives, overriding
  // both axes; everything at or below it prunes exactly as it does today.
  const pruned = pruneDeliveries(records, now, new Map([["m1", 10]]))
  assert.deepEqual(
    pruned.map((record) => record.id),
    Array.from({ length: MAX_RETAINED_DELIVERED + 5 - 10 }, (_, i) => `d${11 + i}`),
  )
})

test("the floor holds a pull member's record against live traffic; the stale release lets it go; the member stays, id intact", async () => {
  const { store, code, alice, screen } = await roomWith()
  const eng = engine(store, new FakeTransport())

  // d1 goes to the screen (pull) and is delivered; the tab renders it and
  // acks — d1 is now drained mail. Then three MORE records for the screen,
  // delivered but never acked: those are its undrained backlog.
  await eng.accept(code, "say", "for the screen", [screen.id])
  await eng.drain(code)
  assert.equal(await eng.ackCursor(code, screen.id, 1), "applied")
  for (let i = 2; i <= 4; i += 1) {
    await eng.accept(code, "say", `undrained ${i}`, [screen.id])
    await eng.drain(code)
  }

  // Then the count cap floods: 25 push deliveries. The floor is PER-MEMBER
  // (brief A), so it holds ONLY the screen's undrained d2..d4 — the push
  // tail is nobody's undrained mail and the cap reclaims it as usual. That
  // is the fix the brief asks for: one laggard tab no longer pins records
  // that have nothing to do with it.
  for (let i = 5; i <= MAX_RETAINED_DELIVERED + 9; i += 1) {
    await eng.accept(code, "say", `flood ${i}`, [alice.id])
    await eng.drain(code)
  }
  const held = deliveriesOf(store.get(code))
  assert.equal(held.length, MAX_RETAINED_DELIVERED + 3, "the push tail is bounded by the cap; only the screen's backlog is extra")
  assert.ok(
    held.some((record) => record.id === "d2" && record.memberId === screen.id),
    "the screen's undrained backlog survives both retention axes",
  )
  assert.ok(
    !held.some((record) => record.id === "d5" && record.memberId === alice.id),
    "the push tail is bounded by the cap, not pinned by the screen's lag",
  )
  // Whatever the flood pruned raised the room's low-water mark (brief B).
  assert.ok(
    (store.get(code)?.deliveryLowWater ?? 0) >= 5,
    "the highest seq actually dropped is recorded as the low-water mark",
  )

  // Release: past PULL_STALE_MS with no further ack the member is stale, its
  // floor is gone, and the prune reclaims the backlog — the cap takes the
  // oldest records, the screen's d2..d4 among them.
  const later = Date.now() + PULL_STALE_MS + 1000
  const room = store.get(code)
  assert.ok(room !== undefined)
  const heldThen = deliveriesOf(room)
  const afterRelease = pruneDeliveries(heldThen, later, retentionFloors(room, later))
  const releasedUpTo = prunedUpTo(heldThen, afterRelease)
  await store.update(code, {
    deliveries: afterRelease,
    ...(releasedUpTo !== undefined ? { deliveryLowWater: releasedUpTo } : {}),
  })
  assert.ok(
    !deliveriesOf(store.get(code)).some((record) => record.id === "d2"),
    "the released floor lets the prune take the backlog",
  )
  assert.ok(
    (store.get(code)?.deliveryLowWater ?? 0) >= 4,
    "the released backlog raises the low-water mark — the returning tab gets the gap marker",
  )
  // And the release NEVER removes the member (D6 constraint 1): same member,
  // same id — the reconnecting tab is the same principal, not a fresh one.
  const after = store.get(code)
  assert.ok(after !== undefined)
  assert.ok(after.members.some((member) => member.id === screen.id))
})

test("one laggard pull member pins only its own records, never another member's (brief A)", () => {
  const now = Date.now()
  const ancient = new Date(now - 10 * DELIVERED_RETENTION_MS).toISOString()
  const records: Delivery[] = []
  for (let i = 0; i < 4; i += 1) records.push(deliveredAt(`d${i + 1}`, "m1", `hers ${i}`, ancient))
  for (let i = 0; i < 2; i += 1) records.push(deliveredAt(`d${i + 5}`, "m2", `his ${i}`, ancient))
  records.push(deliveredAt("d7", "m3", "a push member's record", ancient))

  // m1 is a live pull member acked at d2; m2 is a live pull member that has
  // never acked (its floor is 0 — it holds everything of its own); m3 is a
  // push member with no floor at all.
  const floors = new Map([
    ["m1", 2],
    ["m2", 0],
  ])
  const pruned = pruneDeliveries(records, now, floors)

  assert.deepEqual(
    pruned.map((record) => record.id),
    ["d3", "d4", "d5", "d6"],
    "m1's records above ITS floor survive; m2's undrained mail survives; m3's push record is the age window's business alone",
  )
  // And the room-wide rule this replaces would also have kept d7: the
  // per-member rule is strictly smaller retention, strictly more correct.
})

test("prunedUpTo reports the highest seq actually dropped, whoever owned it (brief B)", () => {
  const ancient = new Date(Date.now() - 10 * DELIVERED_RETENTION_MS).toISOString()
  const records: Delivery[] = [
    deliveredAt("d1", "m1", "old", ancient),
    deliveredAt("d5", "m2", "the highest drop, another member's", ancient),
    deliveredAt("d6", "m1", "kept by m1's floor", new Date(Date.now() - 1000).toISOString()),
    pendingDelivery("d7", "m1", "pending is never pruned"),
  ]
  // Keep only m1's d6 (floor 5 for m1): d1 and d5 drop, and the mark is d5 —
  // the highest dropped, even though it belonged to a different member than
  // the floor that did the keeping.
  const after = pruneDeliveries(records, Date.now(), new Map([["m1", 5]]))
  assert.deepEqual(
    after.map((record) => record.id),
    ["d6", "d7"],
  )
  assert.equal(prunedUpTo(records, after), 5)
  assert.equal(prunedUpTo(records, records), undefined, "nothing dropped, no mark to raise")
})

test("an ack confirms by recipient exactly the records at or below the cursor, and a backwards ack is ignored", async () => {
  const { store, code, screen } = await roomWith()
  const eng = engine(store, new FakeTransport())
  await eng.accept(code, "say", "first", [screen.id])
  await eng.accept(code, "say", "second", [screen.id])
  await eng.drain(code)

  assert.equal(await eng.ackCursor(code, screen.id, 1), "applied")
  const records = () => deliveriesOf(store.get(code))
  assert.equal(records().find((record) => record.id === "d1")?.confirmedBy, "recipient")
  assert.equal(
    records().find((record) => record.id === "d2")?.confirmedBy,
    undefined,
    "a record above the acked cursor is NOT confirmed by the recipient",
  )

  // A replayed/old ack must not rewind anything: ignored, cursor stays.
  assert.equal(await eng.ackCursor(code, screen.id, 1), "ignored")
  const member = store.get(code)?.members.find((candidate) => candidate.id === screen.id)
  assert.ok(member !== undefined)
  assert.equal(member.ackedSeq, 1)
  assert.equal(records().find((record) => record.id === "d2")?.confirmedBy, undefined)
  // ...and a later ack at or below the cursor cannot re-write history either.
  assert.equal(await eng.ackCursor(code, screen.id, 0), "ignored")

  assert.equal(await eng.ackCursor(code, screen.id, 2), "applied")
  assert.equal(records().find((record) => record.id === "d2")?.confirmedBy, "recipient")
})

test("a record that completes below an already-acked cursor is confirmed by the recipient, not left unconfirmed (brief F)", async () => {
  const { store, code, screen } = await roomWith()
  const eng = engine(store, new FakeTransport())
  // The tab acked up to d5 (it received those turns); d3 was still `pending`
  // at that moment — the drain must not leave it honestly-unconfirmed, the
  // recipient provably already has it.
  await eng.ackCursor(code, screen.id, 5)
  await store.update(code, { deliveries: [pendingDelivery("d3", screen.id, "the slow one")] })

  await eng.drain(code)

  const record = deliveriesOf(store.get(code)).find((candidate) => candidate.id === "d3")
  assert.equal(record?.status, "delivered")
  assert.equal(record?.confirmedBy, "recipient")
})

test("an id minted after a prune cannot collide with a record the prune kept", async () => {
  const { store, code, alice } = await roomWith()
  const stale = new Date(Date.now() - DELIVERED_RETENTION_MS - 60_000).toISOString()
  // Under the old `d${deliveries.length + index + 1}` scheme, dropping d1
  // shortens the array to 2 and the next id is `d3` — the id the FAILED
  // record still holds. `mark` patches by id, so the next successful send
  // would flip that dead record to `delivered` and leave the real one behind.
  await store.update(code, {
    deliveries: [
      deliveredAt("d1", alice.id, "long since delivered", stale),
      pendingDelivery("d2", alice.id, "still waiting"),
      failedDelivery("d3", alice.id, "gave up"),
    ],
    deliverySeq: 3,
  })

  const eng = engine(store, new FakeTransport())
  await eng.accept(code, "say", "the next one", [alice.id])

  const records = deliveriesOf(store.get(code))
  assert.deepEqual(records.map((record) => record.id), ["d2", "d3", "d4"])
  assert.equal(new Set(records.map((record) => record.id)).size, records.length, "ids stay unique across a prune")
  assert.equal(records.find((record) => record.id === "d2")?.status, "pending")
  assert.equal(records.find((record) => record.id === "d3")?.status, "failed")
  assert.equal(store.get(code)?.deliverySeq, 4, "the counter only ever moves forward")
})

test("a room predating deliverySeq falls back to its array length, so its first minted id still does not collide", async () => {
  const { store, code, alice } = await roomWith()
  // No `deliverySeq`: a room written before the counter existed, whose ids are
  // exactly d1..dN.
  await store.update(code, {
    deliveries: [pendingDelivery("d1", alice.id, "one"), pendingDelivery("d2", alice.id, "two")],
  })
  assert.equal(store.get(code)?.deliverySeq, undefined)

  const eng = engine(store, new FakeTransport())
  await eng.accept(code, "say", "three", [alice.id])

  const records = deliveriesOf(store.get(code))
  assert.deepEqual(records.map((record) => record.id), ["d1", "d2", "d3"])
  assert.equal(store.get(code)?.deliverySeq, 3, "the counter is adopted on the first write")
})

test("a busy room stops growing: the array is bounded and every id it ever minted is distinct", async () => {
  const { store, code, alice } = await roomWith()
  const eng = engine(store, new FakeTransport())
  const rounds = MAX_RETAINED_DELIVERED + 5

  const seen: string[] = []
  for (let i = 0; i < rounds; i += 1) {
    await eng.accept(code, "say", `turn ${i}`, [alice.id])
    for (const record of deliveriesOf(store.get(code))) {
      if (!seen.includes(record.id)) seen.push(record.id)
    }
    await eng.drain(code)
  }

  const records = deliveriesOf(store.get(code))
  assert.equal(records.length, MAX_RETAINED_DELIVERED, "the array is capped, not growing with the room's age")
  assert.equal(seen.length, rounds, "one id per accepted delivery, none reused")
  assert.equal(new Set(seen).size, rounds)
  assert.equal(store.get(code)?.deliverySeq, rounds)
  assert.deepEqual(
    records.map((record) => record.text),
    Array.from({ length: MAX_RETAINED_DELIVERED }, (_, i) => `turn ${rounds - MAX_RETAINED_DELIVERED + i}`),
    "the retained tail is the newest one",
  )
})

test("a say mint advances spokenSeq; a system mint does not (brief 08)", async () => {
  const { store, code, alice, screen, bob } = await roomWith()
  const eng = engine(store, new FakeTransport())

  await eng.accept(code, "system", "the room's own notice", [screen.id])
  const afterSystem = store.get(code)
  assert.ok((afterSystem?.deliverySeq ?? 0) > 0, "the system mint advanced the delivery counter")
  assert.equal(afterSystem?.spokenSeq, undefined, "the room's voice is not the agent's")

  await eng.accept(code, "say", "to everyone", [alice.id])
  assert.equal(store.get(code)?.spokenSeq, store.get(code)?.deliverySeq, "a say mint IS the agent speaking")

  const seqBefore = store.get(code)?.deliverySeq
  await eng.accept(code, "whisper", "to one", [bob.id])
  assert.ok((store.get(code)?.deliverySeq ?? 0) > (seqBefore ?? 0))
  assert.equal(store.get(code)?.spokenSeq, store.get(code)?.deliverySeq, "a whisper mint IS the agent speaking")
})

test("spokenSeq survives a store write/read cycle (brief 08)", async () => {
  const { dir, store, code, alice, screen } = await roomWith()
  const eng = engine(store, new FakeTransport())
  await eng.accept(code, "say", "hello", [alice.id])
  const before = store.get(code)
  assert.ok((before?.spokenSeq ?? 0) > 0)

  const reopened = await RoomStore.open(dir)
  const loaded = reopened.get(code)
  assert.equal(loaded?.spokenSeq, before?.spokenSeq, "persisted on the room, not derived from the array")

  // And after the reopen, a system mint still leaves it alone.
  assert.ok(screen !== undefined)
  const eng2 = engine(reopened, new FakeTransport())
  await eng2.accept(code, "system", "post-restart notice", [screen.id])
  assert.equal(reopened.get(code)?.spokenSeq, before?.spokenSeq)
})

test("a Room round-trips through the store with deliveries", async () => {
  const dir = await freshDir()
  const store = await RoomStore.open(dir)
  const created = await store.create()
  const delivery: Delivery = {
    id: "d1",
    memberId: "m1",
    kind: "whisper",
    text: "persisted whisper",
    status: "delivered",
    failures: 1,
    lastError: undefined,
    createdAt: "2026-09-12T10:00:00.000Z",
    deliveredAt: "2026-09-12T10:00:01.000Z",
  }
  await store.update(created.code, { deliveries: [delivery] })

  const reopened = await RoomStore.open(dir)
  const loaded = reopened.get(created.code)
  assert.ok(loaded !== undefined)
  // JSON.stringify drops `lastError: undefined`, so the round-tripped record
  // legitimately lacks the key — compare against that shape.
  const { lastError: _dropped, ...persisted } = delivery
  void _dropped
  assert.deepEqual(loaded.deliveries, [persisted])
})

test("a pruned Room round-trips through the store, deliverySeq and all", async () => {
  const dir = await freshDir()
  const store = await RoomStore.open(dir)
  const created = await store.create()
  const alice = await store.addMember(created.code, {
    displayName: "Alice",
    tier: "messenger",
    address: { provider: "telegram", source: "test", contactRef: "ref-Alice" },
  })
  const eng = engine(store, new FakeTransport())

  // Enough traffic to push the array through at least one prune, so what is
  // persisted is a room whose ids no longer start at d1.
  for (let i = 0; i < MAX_RETAINED_DELIVERED + 3; i += 1) {
    await eng.accept(created.code, "say", `turn ${i}`, [alice.id])
    await eng.drain(created.code)
  }
  const before = store.get(created.code)
  assert.ok(before !== undefined)

  const reopened = await RoomStore.open(dir)
  const loaded = reopened.get(created.code)
  assert.ok(loaded !== undefined)
  // `JSON.stringify` drops `lastError: undefined`, so compare the fields the
  // prune is about rather than the whole record — the full-shape round trip is
  // the test above.
  const shapeOf = (records: readonly Delivery[] | undefined): unknown[] =>
    (records ?? []).map((record) => ({
      id: record.id,
      status: record.status,
      text: record.text,
      deliveredAt: record.deliveredAt,
    }))
  assert.deepEqual(shapeOf(loaded.deliveries), shapeOf(before.deliveries))
  assert.equal(loaded.deliverySeq, MAX_RETAINED_DELIVERED + 3)
  assert.equal(loaded.deliveries?.[0]?.id, "d4", "the pruned prefix does not come back")

  // And the counter survives the reload: the next id is still ahead of every
  // id in the file, not a replay of one the prune dropped.
  const resumed = engine(reopened, new FakeTransport())
  await resumed.accept(created.code, "say", "after the restart", [alice.id])
  const ids = (reopened.get(created.code)?.deliveries ?? []).map((record) => record.id)
  assert.equal(ids[ids.length - 1], `d${MAX_RETAINED_DELIVERED + 4}`)
  assert.equal(new Set(ids).size, ids.length)
})

test("a room persisted WITHOUT the deliveries key still loads (the pre-existing-rooms guard)", async () => {
  const dir = await freshDir()
  const store = await RoomStore.open(dir)
  const created = await store.create()
  await store.update(created.code, { deliveries: [] })

  const filePath = join(dir, "rooms.json")
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as { rooms: Record<string, unknown>[] }
  for (const room of parsed.rooms) delete room.deliveries
  await writeFile(filePath, JSON.stringify(parsed, null, 2), "utf8")

  const reopened = await RoomStore.open(dir)
  const loaded = reopened.get(created.code)
  assert.ok(loaded !== undefined)
  assert.equal(loaded.deliveries, undefined)
})

test("a room persisted with a malformed delivery is rejected, not silently loaded", async () => {
  const dir = await freshDir()
  const store = await RoomStore.open(dir)
  await store.create()

  const filePath = join(dir, "rooms.json")
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as { rooms: Record<string, unknown>[] }
  parsed.rooms[0]!.deliveries = [{ id: "d1" }]
  await writeFile(filePath, JSON.stringify(parsed, null, 2), "utf8")

  await assert.rejects(() => RoomStore.open(dir), /corrupt room store/i)
})

test("GET /rooms/:code exposes no Delivery text for a room holding a whisper delivery", async () => {
  const dir = await freshDir()
  const daemon = await startExtendedFakeDaemon()
  daemons.push(daemon)
  const store = await RoomStore.open(dir)
  const created = await store.create()
  const alice = await store.addMember(created.code, {
    displayName: "Alice",
    tier: "messenger",
    address: { provider: "whatsapp", source: "test", contactRef: "+1" },
  })
  await store.update(created.code, {
    deliveries: [
      {
        id: "d1",
        memberId: alice.id,
        kind: "whisper",
        text: "the secret whisper body",
        status: "pending",
        failures: 0,
        lastError: undefined,
        createdAt: "2026-09-12T10:00:00.000Z",
        deliveredAt: undefined,
      },
    ],
  })

  const dead = "http://127.0.0.1:1"
  const client = new DaemonClient({ baseUrl: dead, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: dead, token: undefined })
  const service = new RoomService({
    store,
    client,
    booter,
    transport: new MemoryTransport(),
    daemon: { baseUrl: dead, token: undefined },
  })
  services.push(service)

  const server = createHttpServer(service)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
  const address = server.address()
  assert.ok(address !== null && typeof address === "object")
  const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`

  const res = await fetch(`${baseUrl}/rooms/${created.code}`)
  assert.equal(res.status, 200)
  const body = await res.text()
  assert.ok(!body.includes("secret whisper body"), "the whisper text must not leak onto GET /rooms/:code")
  const parsed = JSON.parse(body) as Record<string, unknown>
  assert.ok(!("deliveries" in parsed), "the deliveries key itself must be absent from the public projection")
})

test("bare agent text still reaches phones exactly as before (the additive constraint)", async () => {
  const { store, code, alice, bob, screen } = await roomWith()
  await store.update(code, { sessionId: "sess-1" })

  const source = new FakeSource()
  const transport = new FakeTransport()
  const fanout = new RoomFanout({ store, transport, source: source.read() })

  source.push({ seq: 1, kind: "text-delta", text: "plain broadcast, no tools" })
  source.push({ seq: 2, kind: "turn-end", reason: "completed" })
  fanout.start(code)

  await waitFor(() => transport.sends.length === 2)
  assert.deepEqual(
    transport.sends.map((send) => send.memberId).sort(),
    [alice.id, bob.id].sort(),
  )
  assert.ok(transport.sends.every((send) => send.text === "plain broadcast, no tools"))
  assert.equal(transport.sends.some((send) => send.memberId === screen.id), false, "room-web stays transport-silent")
  await fanout.stopAll()
})
