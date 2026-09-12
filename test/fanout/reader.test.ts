import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { RoomFanout } from "../../src/fanout/reader.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Member } from "../../src/rooms/types.ts"
import { FakeSource, FakeTransport, waitFor } from "./support.ts"

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "rdv-fanout-"))
}

const dirs: string[] = []
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

function trackDir(dir: string): string {
  dirs.push(dir)
  return dir
}

function memberInput(displayName: string, tier: Member["tier"], contactRef: string): Omit<Member, "id" | "joinedAt"> {
  return { displayName, tier, address: { provider: "whatsapp", source: "agentpush", contactRef } }
}

test("flushes a turn to messenger members, skips room-web, and persists the cursor to the turn-end seq", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  await store.addMember(room.code, memberInput("Alice", "messenger", "+1"))
  await store.addMember(room.code, memberInput("Bob", "messenger", "+2"))
  await store.addMember(room.code, memberInput("Chloe", "room-web", "chloe@x.test"))
  await store.update(room.code, { sessionId: "sess-1" })

  const source = new FakeSource()
  const transport = new FakeTransport()
  const fanout = new RoomFanout({ store, transport, source: source.read() })

  source.push({ seq: 1, kind: "text-delta", text: "Hello " })
  source.push({ seq: 2, kind: "text-delta", text: "world" })
  source.push({ seq: 3, kind: "turn-end", reason: "completed" })

  fanout.start(room.code)

  await waitFor(() => transport.sends.length === 2)
  for (const send of transport.sends) {
    assert.equal(send.text, "Hello world")
  }
  await waitFor(() => (store.get(room.code)?.cursor ?? 0) === 3)

  await fanout.stopAll()
})

test("two consecutive turns produce two flushes with no text bleed between them", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  await store.addMember(room.code, memberInput("Alice", "messenger", "+1"))
  await store.update(room.code, { sessionId: "sess-1" })

  const source = new FakeSource()
  const transport = new FakeTransport()
  const fanout = new RoomFanout({ store, transport, source: source.read() })

  source.push({ seq: 1, kind: "text-delta", text: "first" })
  source.push({ seq: 2, kind: "turn-end" })
  fanout.start(room.code)
  await waitFor(() => transport.sends.length === 1)
  assert.equal(transport.sends[0]?.text, "first")

  source.push({ seq: 3, kind: "text-delta", text: "second" })
  source.push({ seq: 4, kind: "turn-end" })
  await waitFor(() => transport.sends.length === 2)
  assert.equal(transport.sends[1]?.text, "second")

  await fanout.stopAll()
})

test("a turn-end with no accumulated text is skipped: no send, next real turn still flushes", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  await store.addMember(room.code, memberInput("Alice", "messenger", "+1"))
  await store.update(room.code, { sessionId: "sess-1" })

  const source = new FakeSource()
  const transport = new FakeTransport()
  const fanout = new RoomFanout({ store, transport, source: source.read() })

  source.push({ seq: 1, kind: "turn-end" })
  fanout.start(room.code)

  source.push({ seq: 2, kind: "text-delta", text: "now something" })
  source.push({ seq: 3, kind: "turn-end" })
  await waitFor(() => transport.sends.length === 1)
  assert.equal(transport.sends.length, 1)
  assert.equal(transport.sends[0]?.text, "now something")

  await fanout.stopAll()
})

test("start is idempotent: a second call does not spawn a second reader", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  await store.addMember(room.code, memberInput("Alice", "messenger", "+1"))
  await store.update(room.code, { sessionId: "sess-1" })

  const source = new FakeSource()
  const transport = new FakeTransport()
  const fanout = new RoomFanout({ store, transport, source: source.read() })

  fanout.start(room.code)
  fanout.start(room.code)

  source.push({ seq: 1, kind: "text-delta", text: "hi" })
  source.push({ seq: 2, kind: "turn-end" })
  await waitFor(() => transport.sends.length >= 1)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(transport.sends.length, 1)

  await fanout.stopAll()
})

test("start is a no-op for a room with no sessionId", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  await store.addMember(room.code, memberInput("Alice", "messenger", "+1"))

  const source = new FakeSource()
  const transport = new FakeTransport()
  const fanout = new RoomFanout({ store, transport, source: source.read() })

  fanout.start(room.code)
  source.push({ seq: 1, kind: "text-delta", text: "hi" })
  source.push({ seq: 2, kind: "turn-end" })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(transport.sends.length, 0)

  await fanout.stopAll()
})

test("restart without duplicates: a fresh store and fanout on the same dir resumes after the persisted cursor", async () => {
  const dir = trackDir(await freshDir())
  const store1 = await RoomStore.open(dir)
  const room = await store1.create()
  await store1.addMember(room.code, memberInput("Alice", "messenger", "+1"))
  await store1.update(room.code, { sessionId: "sess-1" })

  const source = new FakeSource()
  source.push({ seq: 1, kind: "text-delta", text: "turn one" })
  source.push({ seq: 2, kind: "turn-end" })

  const transport1 = new FakeTransport()
  const fanout1 = new RoomFanout({ store: store1, transport: transport1, source: source.read() })
  fanout1.start(room.code)
  await waitFor(() => transport1.sends.length === 1)
  await waitFor(() => (store1.get(room.code)?.cursor ?? 0) === 2)
  await fanout1.stop(room.code)

  const store2 = await RoomStore.open(dir)
  const transport2 = new FakeTransport()
  const fanout2 = new RoomFanout({ store: store2, transport: transport2, source: source.read() })
  fanout2.start(room.code)

  source.push({ seq: 3, kind: "text-delta", text: "turn two" })
  source.push({ seq: 4, kind: "turn-end" })
  await waitFor(() => transport2.sends.length === 1)
  assert.equal(transport2.sends[0]?.text, "turn two")
  assert.equal(transport1.sends.length, 1, "the original transport never saw the second turn")

  await fanout2.stopAll()
})

test("crash mid-flush: one member's transport failure does not block the other or the cursor", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  const alice = await store.addMember(room.code, memberInput("Alice", "messenger", "+1"))
  const bob = await store.addMember(room.code, memberInput("Bob", "messenger", "+2"))
  await store.update(room.code, { sessionId: "sess-1" })

  const source = new FakeSource()
  const transport = new FakeTransport()
  transport.failFor(alice.id)
  const fanout = new RoomFanout({ store, transport, source: source.read() })

  source.push({ seq: 1, kind: "text-delta", text: "hello" })
  source.push({ seq: 2, kind: "turn-end" })
  fanout.start(room.code)

  await waitFor(() => transport.sends.length === 1)
  assert.equal(transport.sends[0]?.memberId, bob.id)
  await waitFor(() => (store.get(room.code)?.cursor ?? 0) === 2)
  assert.equal(store.get(room.code)?.cursor, 2)

  await fanout.stopAll()
})

test("source error then reconnect: delivery continues from the persisted cursor after a backoff", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  await store.addMember(room.code, memberInput("Alice", "messenger", "+1"))
  await store.update(room.code, { sessionId: "sess-1" })

  const source = new FakeSource()
  source.failNext(new Error("simulated connection drop"))
  const transport = new FakeTransport()
  const fanout = new RoomFanout({ store, transport, source: source.read() })

  fanout.start(room.code)
  source.push({ seq: 1, kind: "text-delta", text: "after reconnect" })
  source.push({ seq: 2, kind: "turn-end" })

  await waitFor(() => transport.sends.length === 1, 5000)
  assert.equal(transport.sends[0]?.text, "after reconnect")
  assert.equal(store.get(room.code)?.cursor, 2)

  await fanout.stopAll()
})

test("artifact url is announced on the first flush after boot when the room already has one", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  await store.addMember(room.code, memberInput("Alice", "messenger", "+1"))
  await store.update(room.code, { sessionId: "sess-1", artifactUrl: "https://x.test" })

  const source = new FakeSource()
  const transport = new FakeTransport()
  const fanout = new RoomFanout({ store, transport, source: source.read() })

  source.push({ seq: 1, kind: "text-delta", text: "live now" })
  source.push({ seq: 2, kind: "turn-end" })
  fanout.start(room.code)

  await waitFor(() => transport.sends.length === 1)
  assert.equal(transport.sends[0]?.text, "live now\nhttps://x.test")

  await fanout.stopAll()
})

test("a reader stops retrying and removes itself once isAlive reports the session gone, and a later start() attaches a fresh one", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  await store.addMember(room.code, memberInput("Alice", "messenger", "+1"))
  await store.update(room.code, { sessionId: "sess-1" })

  const source = new FakeSource()
  source.failNext(new Error("simulated: session gone"))
  const transport = new FakeTransport()
  let sessionAlive = false
  const fanout = new RoomFanout({
    store,
    transport,
    source: source.read(),
    isAlive: () => Promise.resolve(sessionAlive),
  })

  fanout.start(room.code)
  // Give the failed read + isAlive check a moment to land and self-terminate,
  // instead of retrying forever against a session that is confirmed gone.
  await new Promise((resolve) => setTimeout(resolve, 50))

  // The old reader must have removed itself from the readers map — prove it
  // black-box: a fresh start() actually attaches a new reader and delivers a
  // real turn, which would never happen if start() still thought one was running.
  sessionAlive = true
  fanout.start(room.code)
  source.push({ seq: 1, kind: "text-delta", text: "back online" })
  source.push({ seq: 2, kind: "turn-end" })
  await waitFor(() => transport.sends.length === 1)
  assert.equal(transport.sends[0]?.text, "back online")

  await fanout.stopAll()
})

test("a reader keeps retrying with backoff when isAlive still reports the session alive after a source error", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  await store.addMember(room.code, memberInput("Alice", "messenger", "+1"))
  await store.update(room.code, { sessionId: "sess-1" })

  const source = new FakeSource()
  source.failNext(new Error("transient connection drop"))
  const transport = new FakeTransport()
  const fanout = new RoomFanout({ store, transport, source: source.read(), isAlive: () => Promise.resolve(true) })

  fanout.start(room.code)
  source.push({ seq: 1, kind: "text-delta", text: "after reconnect" })
  source.push({ seq: 2, kind: "turn-end" })
  await waitFor(() => transport.sends.length === 1, 5000)
  assert.equal(transport.sends[0]?.text, "after reconnect")

  await fanout.stopAll()
})

test("artifact url is not repeated on a later flush when it has not changed", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  await store.addMember(room.code, memberInput("Alice", "messenger", "+1"))
  await store.update(room.code, { sessionId: "sess-1", artifactUrl: "https://x.test" })

  const source = new FakeSource()
  const transport = new FakeTransport()
  const fanout = new RoomFanout({ store, transport, source: source.read() })

  source.push({ seq: 1, kind: "text-delta", text: "first" })
  source.push({ seq: 2, kind: "turn-end" })
  fanout.start(room.code)
  await waitFor(() => transport.sends.length === 1)
  assert.equal(transport.sends[0]?.text, "first\nhttps://x.test")

  source.push({ seq: 3, kind: "text-delta", text: "second" })
  source.push({ seq: 4, kind: "turn-end" })
  await waitFor(() => transport.sends.length === 2)
  assert.equal(transport.sends[1]?.text, "second")

  await fanout.stopAll()
})
