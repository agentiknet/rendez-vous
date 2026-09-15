/**
 * BRIEF-48 step 2 — the identity plumbing for react/reply (docs/REACT-REPLY.md §2),
 * pieces 1-3 only; the member-facing attribution line is deliberately out of
 * scope. Fail-first: this file was written against a tree where none of it
 * existed.
 *
 * What must be true when this file passes:
 * - an inbound member message keeps its provider-native id, durably, on the
 *   room (it used to die in the dedup FIFO);
 * - an outbound push send keeps the message id the provider returned, on the
 *   delivery record and as a resolvable ref (it used to be discarded by
 *   AgentpushTransport.checkedSend);
 * - a handle resolves to a provider id and back — and an unknown handle
 *   fails NAMED (undefined from the resolver), never a guessed send;
 * - nothing a member receives changes by one byte.
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import type { OutboundMessage, Transport } from "../../src/fanout/types.ts"
import type { Member } from "../../src/rooms/types.ts"
import {
  MAX_RETAINED_MESSAGE_REFS,
  MESSAGE_REF_RETENTION_MS,
  pruneMessageRefs,
} from "../../src/rooms/types.ts"
import type { RoomStore } from "../../src/rooms/store.ts"
import { DeliveryEngine } from "../../src/service/delivery.ts"
import type { RoomService } from "../../src/service/room-service.ts"
import type { RecordedSend } from "../../src/service/transports.ts"
import { startExtendedFakeDaemon, type ExtendedFakeDaemon } from "./fake-daemon-extra.ts"

const dirs: string[] = []
const daemons: ExtendedFakeDaemon[] = []
const services: RoomService[] = []

after(async () => {
  await Promise.all(services.map((service) => service.stop()))
  await Promise.all(daemons.map((daemon) => daemon.close()))
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-msgrefs-"))
  dirs.push(dir)
  return dir
}

async function storeIn(dir?: string): Promise<{ store: RoomStore; dir: string }> {
  const { RoomStore } = await import("../../src/rooms/store.ts")
  const used = dir ?? (await freshDir())
  return { store: await RoomStore.open(used), dir: used }
}

/** Same roster as delivery.test.ts: Alice (telegram), Screen (room-web). */
async function roomWith(dir?: string): Promise<{
  store: RoomStore
  code: string
  dir: string
  alice: Member
  screen: Member
}> {
  const opened = await storeIn(dir)
  const created = await opened.store.create()
  const add = async (displayName: string, tier: Member["tier"], provider: string): Promise<Member> =>
    opened.store.addMember(created.code, {
      displayName,
      tier,
      address: { provider, source: "test", contactRef: `ref-${displayName}` },
    })
  const alice = await add("Alice", "messenger", "telegram")
  const screen = await add("Screen", "room-web", "room-web")
  return { store: opened.store, code: created.code, dir: opened.dir, alice, screen }
}

interface IdRecordedSend extends RecordedSend {
  readonly returnedId: string | undefined
}

/** A transport that hands back a provider message id — what
 *  AgentpushTransport.send will do once checkedSend stops discarding it. */
class IdTransport implements Transport {
  readonly sends: IdRecordedSend[] = []
  private readonly id: string | undefined

  constructor(id: string | undefined) {
    this.id = id
  }

  async send(member: Member, message: OutboundMessage): Promise<string | undefined> {
    this.sends.push({ member, message, returnedId: this.id })
    return this.id
  }
}

function engine(store: RoomStore, transport: Transport): DeliveryEngine {
  return new DeliveryEngine({ store, transport, autoDrain: false })
}

function deliveriesOf(room: ReturnType<RoomStore["get"]> | undefined): readonly import("../../src/rooms/types.ts").Delivery[] {
  return room?.deliveries ?? []
}

// --- store level: the map itself -------------------------------------------

test("an inbound message's provider id is kept, durably, and resolves", async () => {
  const { store, code } = await roomWith()
  const ref = await store.recordMessageRef(code, {
    memberId: "member-a",
    direction: "inbound",
    channel: "telegram",
    providerId: "wamid.in.123",
  })
  assert.match(ref.handle, /^m\d+$/)
  const resolved = await store.resolveMessageRef(code, ref.handle)
  assert.ok(resolved !== undefined, "a minted handle must resolve")
  assert.equal(resolved.providerId, "wamid.in.123")
  assert.equal(resolved.direction, "inbound")
  assert.equal(resolved.channel, "telegram")
  assert.equal(resolved.memberId, "member-a")
})

test("an outbound ref resolves the same way, under its own handle", async () => {
  const { store, code } = await roomWith()
  const inbound = await store.recordMessageRef(code, {
    memberId: "member-a",
    direction: "inbound",
    channel: "whatsapp",
    providerId: "wamid.in.1",
  })
  const outbound = await store.recordMessageRef(code, {
    memberId: "member-a",
    direction: "outbound",
    channel: "whatsapp",
    providerId: "wamid.out.2",
  })
  assert.notEqual(inbound.handle, outbound.handle, "handles are minted once, never reused")
  const resolved = await store.resolveMessageRef(code, outbound.handle)
  assert.equal(resolved?.providerId, "wamid.out.2")
  assert.equal(resolved?.direction, "outbound")
})

test("an unknown handle fails named — undefined, never a guess", async () => {
  const { store, code } = await roomWith()
  await store.recordMessageRef(code, {
    memberId: "member-a",
    direction: "inbound",
    channel: "telegram",
    providerId: "wamid.in.7",
  })
  assert.equal(await store.resolveMessageRef(code, "m999"), undefined)
  assert.equal(await store.resolveMessageRef(code, "not-a-handle"), undefined)
  assert.equal(await store.resolveMessageRef("RDV-NOPE", "m1"), undefined)
})

test("the map is a bounded tail like the room's other tails", async () => {
  const old = "2026-09-01T00:00:00.000Z"
  const now = "2026-09-15T00:00:00.000Z"
  const many = Array.from({ length: MAX_RETAINED_MESSAGE_REFS + 10 }, (_unused, index) => ({
    handle: `m${index + 1}`,
    memberId: "member-a",
    direction: "inbound" as const,
    channel: "telegram",
    providerId: `wamid.${index}`,
    createdAt: old,
  }))
  const pruned = pruneMessageRefs(many, Date.parse(now))
  assert.equal(pruned.length, 0, "everything past the age window is dropped, whatever the count cap")
  const fresh = many.map((ref, index) => ({ ...ref, createdAt: index === 0 ? old : now }))
  const kept = pruneMessageRefs(fresh, Date.parse(now))
  assert.equal(kept.length, MAX_RETAINED_MESSAGE_REFS)
  assert.ok(kept.every((ref) => ref.createdAt === now), "the undrained recent tail survives the cap")
  void MESSAGE_REF_RETENTION_MS
})

test("a room persisted before the fields existed loads unchanged", async () => {
  const { store, code, dir } = await roomWith()
  assert.equal(store.get(code)?.messageRefs, undefined)
  const { RoomStore } = await import("../../src/rooms/store.ts")
  const { readFile, writeFile } = await import("node:fs/promises")
  const filePath = join(dir, "rooms.json")
  const raw = JSON.parse(await readFile(filePath, "utf8")) as { rooms: Record<string, unknown>[] }
  for (const room of raw.rooms) {
    delete room.messageRefs
    delete room.messageRefSeq
  }
  await writeFile(filePath, JSON.stringify(raw))
  const reopened = await RoomStore.open(dir)
  assert.ok(reopened.get(code) !== undefined, "a legacy room file must still validate")
  assert.equal(reopened.get(code)?.messageRefs, undefined)
})

// --- engine level: the outbound capture -------------------------------------

test("a push send keeps the message id the provider returned", async () => {
  const { store, code, alice } = await roomWith()
  const transport = new IdTransport("wamid.out.42")
  const eng = engine(store, transport)
  await eng.accept(code, "say", "boards at gate 4", [alice.id])
  await eng.drain(code)

  const record = deliveriesOf(store.get(code))[0]
  assert.equal(record?.status, "delivered")
  assert.equal(record?.providerMessageId, "wamid.out.42", "the id is ON the record, not in a log")

  const refs = store.get(code)?.messageRefs ?? []
  const outbound = refs.find((ref) => ref.direction === "outbound")
  assert.ok(outbound !== undefined, "a delivered push send mints a resolvable outbound ref")
  assert.equal(outbound?.providerId, "wamid.out.42")
  assert.equal(outbound?.memberId, alice.id)
  assert.equal(outbound?.channel, "telegram")
})

test("a provider that returns no id records none — absence, not a fabricated handle", async () => {
  const { store, code, alice } = await roomWith()
  const eng = engine(store, new IdTransport(undefined))
  await eng.accept(code, "say", "hello", [alice.id])
  await eng.drain(code)
  const record = deliveriesOf(store.get(code))[0]
  assert.equal(record?.status, "delivered")
  assert.equal(record?.providerMessageId, undefined)
  assert.equal((store.get(code)?.messageRefs ?? []).length, 0)
})

test("a pull member's delivered record mints no handle — nothing the provider ever saw", async () => {
  const { store, code, screen } = await roomWith()
  const eng = engine(store, new IdTransport("wamid.out.1"))
  await eng.accept(code, "say", "on the screen", [screen.id])
  await eng.drain(code)
  const record = deliveriesOf(store.get(code))[0]
  assert.equal(record?.status, "delivered")
  assert.equal(record?.providerMessageId, undefined)
  assert.equal((store.get(code)?.messageRefs ?? []).length, 0)
})

test("the text a member receives is byte-identical with and without the capture", async () => {
  const first = await roomWith()
  const second = await roomWith()
  const text = "boards at gate 4"
  const withId = new IdTransport("wamid.out.9")
  const withoutId = new IdTransport(undefined)
  const engA = engine(first.store, withId)
  const engB = engine(second.store, withoutId)
  await engA.accept(first.code, "say", text, [first.alice.id])
  await engB.accept(second.code, "say", text, [second.alice.id])
  await engA.drain(first.code)
  await engB.drain(second.code)
  // Different rooms mint different member UUIDs by design; what must be
  // byte-identical is the TEXT each member received.
  assert.deepEqual(
    withId.sends.map((send) => send.message.text),
    [text],
  )
  assert.deepEqual(
    withoutId.sends.map((send) => send.message.text),
    [text],
  )
})

// --- service level: the inbound capture --------------------------------------

async function serviceWith(): Promise<{ service: RoomService; store: RoomStore; code: string; alice: Member }> {
  const { DaemonClient } = await import("../../src/daemon/client.ts")
  const { LocalBooter } = await import("../../src/service/booter.ts")
  const { RoomService: RoomServiceCtor } = await import("../../src/service/room-service.ts")
  const { MediaStore } = await import("../../src/service/media-store.ts")
  const { MemoryTransport } = await import("../../src/service/transports.ts")
  const daemon = await startExtendedFakeDaemon()
  daemons.push(daemon)
  const opened = await storeIn()
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })
  const service = new RoomServiceCtor({
    store: opened.store,
    client,
    booter,
    transport: new MemoryTransport(),
    daemon: { baseUrl: daemon.url, token: undefined },
    mediaStore: new MediaStore(opened.dir),
  })
  services.push(service)
  const created = await opened.store.create()
  const alice = await opened.store.addMember(created.code, {
    displayName: "Alice",
    tier: "messenger",
    address: { provider: "telegram", source: "test", contactRef: "+15550001111" },
  })
  return { service, store: opened.store, code: created.code, alice }
}

test("an inbound member message keeps its provider id through handleInbound", async () => {
  const { service, store, code, alice } = await serviceWith()
  const outcome = await service.handleInbound({
    address: { provider: "telegram", source: "test", contactRef: "+15550001111" },
    displayName: "Alice",
    tier: "messenger",
    text: "the gate changed",
    providerMessageId: "tg-in-777",
  })
  assert.equal(outcome.kind, "message")
  const ref = store.get(code)?.messageRefs?.find((candidate) => candidate.providerId === "tg-in-777")
  assert.ok(ref !== undefined, "the provider id must survive the ingest")
  assert.equal(ref?.direction, "inbound")
  assert.equal(ref?.memberId, alice.id)
  assert.equal(ref?.channel, "telegram")
})

test("an inbound with no provider id mints no handle — room-web and simulated sends stay handle-less", async () => {
  const { service, store } = await serviceWith()
  await service.handleInbound({
    address: { provider: "telegram", source: "test", contactRef: "+15550001111" },
    displayName: "Alice",
    tier: "messenger",
    text: "no id on this one",
  })
  assert.equal((store.get(store.list()[0]!.code)?.messageRefs ?? []).length, 0)
})

test("RoomService resolves handles: named failure for an unknown one", async () => {
  const { service, store, code } = await serviceWith()
  const ref = await store.recordMessageRef(code, {
    memberId: "x",
    direction: "inbound",
    channel: "telegram",
    providerId: "tg-1",
  })
  const resolved = await service.resolveMessageRef(code, ref.handle)
  assert.equal(resolved?.providerId, "tg-1")
  assert.equal(await service.resolveMessageRef(code, "m404"), undefined)
})

// --- agent surface: room_view's recent_messages -------------------------------

test("the 24h bound holds at READ, not just at the next mint — a quiet room loses nothing, a loud room keeps the door honest", async () => {
  const { store, code } = await roomWith()
  const now = Date.now()
  const fresh = await store.recordMessageRef(
    code,
    { memberId: "member-a", direction: "inbound", channel: "telegram", providerId: "wamid.fresh" },
    new Date(now - 1000).toISOString(),
  )
  await store.recordMessageRef(
    code,
    { memberId: "member-a", direction: "inbound", channel: "telegram", providerId: "wamid.stale" },
    new Date(now - MESSAGE_REF_RETENTION_MS - 60_000).toISOString(),
  )
  // No mint happens after this point: the stale ref is still IN the room's
  // array. The resolver must still refuse it — the bound is an expiry, not
  // a write-time retention that depends on traffic.
  assert.ok(
    (store.get(code)?.messageRefs ?? []).some((ref) => ref.providerId === "wamid.stale"),
    "precondition: the stale ref is physically still in the array",
  )
  const freshResolved = await store.resolveMessageRef(code, fresh.handle)
  assert.equal(freshResolved?.providerId, "wamid.fresh")
  const staleHandle = (store.get(code)?.messageRefs ?? []).find((ref) => ref.providerId === "wamid.stale")?.handle
  assert.ok(staleHandle !== undefined)
  assert.equal(
    await store.resolveMessageRef(code, staleHandle),
    undefined,
    "an expired handle fails named, whatever the room's traffic",
  )
})

test("an undateable ref never resolves — it can never be proven young", async () => {
  const { store, code } = await roomWith()
  const ref = await store.recordMessageRef(
    code,
    { memberId: "member-a", direction: "inbound", channel: "telegram", providerId: "wamid.x" },
    "not-a-date",
  )
  assert.equal(await store.resolveMessageRef(code, ref.handle), undefined)
})

test("RoomService.resolveMessageRef inherits the read-side bound", async () => {
  const { service, store, code } = await serviceWith()
  const stale = await store.recordMessageRef(
    code,
    { memberId: "y", direction: "inbound", channel: "telegram", providerId: "tg-old" },
    new Date(Date.now() - MESSAGE_REF_RETENTION_MS - 60_000).toISOString(),
  )
  assert.equal(await service.resolveMessageRef(code, stale.handle), undefined)
})

test("room_view lists the citable tail for the agent, ids only", async () => {
  const { createMcpRoomHandler, roomAudienceToken } = await import("../../src/service/mcp-room.ts")
  const { env } = await import("../../src/env.ts")
  const refs = [
    {
      handle: "m1",
      memberId: "member-a",
      direction: "inbound" as const,
      channel: "whatsapp",
      providerId: "wamid.in.1",
      createdAt: "2026-09-15T08:00:00.000Z",
    },
    {
      handle: "m2",
      memberId: "member-a",
      direction: "outbound" as const,
      channel: "whatsapp",
      providerId: "wamid.out.2",
      createdAt: "2026-09-15T08:01:00.000Z",
    },
  ]
  // Minimal Room fixture, same shape room-view.test.ts mints.
  const fixture = {
    code: "RDV-REFS",
    slug: "refs",
    sessionId: undefined,
    sandboxId: undefined,
    artifactUrl: undefined,
    artifactReady: undefined,
    members: [],
    createdAt: "2026-09-15T08:00:00.000Z",
    updatedAt: "2026-09-15T08:00:00.000Z",
    cursor: 0,
    lastActivityAt: "2026-09-15T08:00:00.000Z",
    state: "active" as const,
  }
  const handler = createMcpRoomHandler({ rooms: () => [fixture], recentMessages: () => refs })
  const res = await handler(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "room_view", arguments: {} } },
    `Bearer ${roomAudienceToken("RDV-REFS", env.roomTokenSecret)}`,
  )
  const body = res.body !== undefined && "result" in res.body ? res.body.result : undefined
  const content = (body?.content as { text: string }[] | undefined)?.[0]?.text
  assert.ok(content !== undefined)
  const payload = JSON.parse(content) as { recent_messages?: Record<string, string>[] }
  assert.ok(Array.isArray(payload.recent_messages), "the wired dep must expose the tail")
  // Newest first.
  assert.equal(payload.recent_messages?.[0]?.handle, "m2")
  assert.equal(payload.recent_messages?.[1]?.handle, "m1")
  assert.equal(payload.recent_messages?.[0]?.direction, "outbound")
  assert.equal(payload.recent_messages?.[0]?.channel, "whatsapp")
  // HARD RULE: ids only — no provider id on the wire? The provider id IS an
  // id, and it is deliberately NOT listed: the agent cites the handle, and
  // resolution is the resolver's job.
  assert.ok(payload.recent_messages?.every((entry) => entry.providerId === undefined && entry.provider_id === undefined))
  assert.ok(!JSON.stringify(payload).includes("wamid"))
})

test("room_view without the dep keeps its exact pre-BRIEF-48 shape", async () => {
  const { createMcpRoomHandler, roomAudienceToken } = await import("../../src/service/mcp-room.ts")
  const { env } = await import("../../src/env.ts")
  const fixture = {
    code: "RDV-NOREF",
    slug: "noref",
    sessionId: undefined,
    sandboxId: undefined,
    artifactUrl: undefined,
    artifactReady: undefined,
    members: [],
    createdAt: "2026-09-15T08:00:00.000Z",
    updatedAt: "2026-09-15T08:00:00.000Z",
    cursor: 0,
    lastActivityAt: "2026-09-15T08:00:00.000Z",
    state: "active" as const,
  }
  const handler = createMcpRoomHandler({ rooms: () => [fixture] })
  const res = await handler(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "room_view", arguments: {} } },
    `Bearer ${roomAudienceToken("RDV-NOREF", env.roomTokenSecret)}`,
  )
  const body = res.body !== undefined && "result" in res.body ? res.body.result : undefined
  const content = (body?.content as { text: string }[] | undefined)?.[0]?.text
  const payload = JSON.parse(content ?? "{}") as Record<string, unknown>
  assert.deepEqual(payload, {
    code: "RDV-NOREF",
    state: "live",
    member_count: 0,
    artifact: { rendered: false },
  })
})
