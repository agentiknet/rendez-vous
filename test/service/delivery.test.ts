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
import { DeliveryEngine } from "../../src/service/delivery.ts"
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
  return { store, code: created.code, alice, bob, screen }
}

function pendingDelivery(id: string, memberId: string, text: string, attempts = 0): Delivery {
  return {
    id,
    memberId,
    kind: "say",
    text,
    status: "pending",
    attempts,
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
  void alice
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
  assert.equal(record?.attempts, 1)
  assert.equal(record?.status, "pending")
  assert.ok(record?.lastError !== undefined)

  // Four more drains: the fifth attempt crosses the cap.
  for (let i = 0; i < MAX_DELIVERY_ATTEMPTS - 1; i += 1) {
    await eng.drain(code)
  }
  record = deliveriesOf(store.get(code)).find((d) => d.memberId === alice.id)
  assert.equal(record?.attempts, MAX_DELIVERY_ATTEMPTS)
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
  assert.equal(records.find((d) => d.id === "d2")?.attempts, MAX_DELIVERY_ATTEMPTS)
})

test("a hanging provider send times out, increments attempts, and does not block the other member", async () => {
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
  assert.equal(record?.attempts, 1)
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
  assert.equal(record?.attempts, 1)
  assert.equal(record?.status, "pending")
  assert.match(record?.lastError ?? "", /no longer in the room/)
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
    attempts: 1,
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
        attempts: 0,
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
