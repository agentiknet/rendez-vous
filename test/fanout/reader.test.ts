import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { RoomFanout } from "../../src/fanout/reader.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Member } from "../../src/rooms/types.ts"
import { publicArtifactUrl } from "../../src/service/artifact-proxy.ts"
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
    assert.equal(send.text, `Hello world\n[${room.code}]`)
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
  assert.equal(transport.sends[0]?.text, `first\n[${room.code}]`)

  source.push({ seq: 3, kind: "text-delta", text: "second" })
  source.push({ seq: 4, kind: "turn-end" })
  await waitFor(() => transport.sends.length === 2)
  assert.equal(transport.sends[1]?.text, `second\n[${room.code}]`)

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
  assert.equal(transport.sends[0]?.text, `now something\n[${room.code}]`)

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
  assert.equal(transport2.sends[0]?.text, `turn two\n[${room.code}]`)
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
  assert.equal(transport.sends[0]?.text, `after reconnect\n[${room.code}]`)
  assert.equal(store.get(room.code)?.cursor, 2)

  await fanout.stopAll()
})

test("artifact url is announced on the first flush after boot when the room already has one — as the room-code-keyed public URL, never the raw box URL", async () => {
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
  assert.equal(transport.sends[0]?.text, `live now\n${publicArtifactUrl(room.code)}`)

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
  assert.equal(transport.sends[0]?.text, `back online\n[${room.code}]`)

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
  assert.equal(transport.sends[0]?.text, `after reconnect\n[${room.code}]`)

  await fanout.stopAll()
})

test("a whisper reaches only its target with the private prefix; other members get a marker, the web member gets nothing pushed", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  const alice = await store.addMember(room.code, memberInput("Alice", "messenger", "+1"))
  const bob = await store.addMember(room.code, memberInput("Bob", "messenger", "+2"))
  await store.addMember(room.code, memberInput("Chloe", "room-web", "chloe@x.test"))
  await store.update(room.code, { sessionId: "sess-1" })

  const source = new FakeSource()
  const transport = new FakeTransport()
  const fanout = new RoomFanout({ store, transport, source: source.read() })

  const reply = ["Hi both.", "[[whisper to Alice]]", "reconciled it your way", "[[/whisper]]", "done."].join("\n")
  source.push({ seq: 1, kind: "text-delta", text: reply })
  source.push({ seq: 2, kind: "turn-end" })

  fanout.start(room.code)

  // Only the two messenger members get pushed at all; room-web is skipped by
  // renderForTier regardless (its transcript comes from the raw daemon
  // stream directly — src/web/page.ts renders the whisper marker itself).
  await waitFor(() => transport.sends.length === 2)

  const toAlice = transport.sends.find((send) => send.memberId === alice.id)
  const toBob = transport.sends.find((send) => send.memberId === bob.id)
  assert.equal(toAlice?.text, `Hi both.\n(private) reconciled it your way\ndone.\n[${room.code}]`)
  assert.equal(toBob?.text, `Hi both.\n(the agent whispered to Alice)\ndone.\n[${room.code}]`)

  await fanout.stopAll()
})

test("one turn addresses two different members plus a broadcast line: N addressed messages from a single turn-end, not N turns", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  const alice = await store.addMember(room.code, memberInput("Alice", "messenger", "+1"))
  const bob = await store.addMember(room.code, memberInput("Bob", "messenger", "+2"))
  await store.update(room.code, { sessionId: "sess-1" })

  const source = new FakeSource()
  const transport = new FakeTransport()
  const fanout = new RoomFanout({ store, transport, source: source.read() })

  const reply = [
    "Hi both.",
    "[[whisper to Alice]]",
    "went with your version",
    "[[/whisper]]",
    "[[whisper to Bob]]",
    "yours conflicted, sorry",
    "[[/whisper]]",
    "moving ahead.",
  ].join("\n")
  source.push({ seq: 1, kind: "text-delta", text: reply })
  source.push({ seq: 2, kind: "turn-end" })

  fanout.start(room.code)

  // One turn, one turn-end record, two differently addressed pushes.
  await waitFor(() => transport.sends.length === 2)

  const toAlice = transport.sends.find((send) => send.memberId === alice.id)
  const toBob = transport.sends.find((send) => send.memberId === bob.id)
  assert.equal(
    toAlice?.text,
    `Hi both.\n(private) went with your version\n(the agent whispered to Bob)\nmoving ahead.\n[${room.code}]`,
  )
  assert.equal(
    toBob?.text,
    `Hi both.\n(the agent whispered to Alice)\n(private) yours conflicted, sorry\nmoving ahead.\n[${room.code}]`,
  )

  await fanout.stopAll()
})

test("artifactReady === false gates the artifact line: no URL at all until the room is ready again", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  await store.addMember(room.code, memberInput("Alice", "messenger", "+1"))
  // The idle sweep marks a room whose box it confirmed gone like this.
  await store.update(room.code, { sessionId: "sess-1", artifactUrl: "https://x.test", artifactReady: false })

  const source = new FakeSource()
  const transport = new FakeTransport()
  const fanout = new RoomFanout({ store, transport, source: source.read() })

  source.push({ seq: 1, kind: "text-delta", text: "still here" })
  source.push({ seq: 2, kind: "turn-end" })
  fanout.start(room.code)
  await waitFor(() => transport.sends.length === 1)
  assert.equal(transport.sends[0]?.text, `still here\n[${room.code}]`, "no artifact line while the box is confirmed dead")
  assert.equal(transport.sends[0]?.artifactUrl, undefined, "no dead URL rides along on the message either")

  // A revive re-marks the room ready; the next flush announces the URL again.
  await store.update(room.code, { artifactReady: true })
  source.push({ seq: 3, kind: "text-delta", text: "back" })
  source.push({ seq: 4, kind: "turn-end" })
  await waitFor(() => transport.sends.length === 2)
  assert.equal(transport.sends[1]?.text, `back\n${publicArtifactUrl(room.code)}`)

  await fanout.stopAll()
})

test("one turn with two asks, a whisper, and broadcast: N asks recorded as a1..aN, targets get the waiting-on-you line, others get the marker (docs/MIDDLEMAN.md step ii)", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  const alice = await store.addMember(room.code, memberInput("Alice", "messenger", "+1"))
  const bob = await store.addMember(room.code, memberInput("Bob", "messenger", "+2"))
  await store.update(room.code, { sessionId: "sess-1" })

  const source = new FakeSource()
  const transport = new FakeTransport()
  const fanout = new RoomFanout({ store, transport, source: source.read() })

  const reply = [
    "Collecting pieces now.",
    "[[whisper to Alice]]",
    "quiet note",
    "[[/whisper]]",
    "[[ask Alice]]",
    "the product shot",
    "[[/ask]]",
    "[[ask Bob]]",
    "the one-line positioning",
    "[[/ask]]",
    "Anyone with anything else, say so.",
  ].join("\n")
  source.push({ seq: 1, kind: "text-delta", text: reply })
  source.push({ seq: 2, kind: "turn-end" })

  fanout.start(room.code)

  await waitFor(() => transport.sends.length === 2)

  const toAlice = transport.sends.find((send) => send.memberId === alice.id)
  const toBob = transport.sends.find((send) => send.memberId === bob.id)
  assert.equal(
    toAlice?.text,
    [
      "Collecting pieces now.",
      "(private) quiet note",
      "(the room is waiting on you) the product shot",
      "(waiting on Bob: the one-line positioning)",
      "Anyone with anything else, say so.",
      `[${room.code}]`,
    ].join("\n"),
  )
  assert.equal(
    toBob?.text,
    [
      "Collecting pieces now.",
      "(the agent whispered to Alice)",
      "(waiting on Alice: the product shot)",
      "(the room is waiting on you) the one-line positioning",
      "Anyone with anything else, say so.",
      `[${room.code}]`,
    ].join("\n"),
  )

  const asks = store.get(room.code)?.asks ?? []
  assert.equal(asks.length, 2)
  assert.equal(asks[0]?.id, "a1")
  assert.equal(asks[0]?.toMemberId, alice.id, "toMemberId is the member id, not the name")
  assert.equal(asks[0]?.what, "the product shot")
  assert.equal(asks[0]?.status, "open")
  assert.equal(asks[1]?.id, "a2")
  assert.equal(asks[1]?.toMemberId, bob.id)

  await fanout.stopAll()
})

test("the open marker is emitted once, on open only: a later plain turn does not repeat it", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  const alice = await store.addMember(room.code, memberInput("Alice", "messenger", "+1"))
  await store.update(room.code, { sessionId: "sess-1" })

  const source = new FakeSource()
  const transport = new FakeTransport()
  const fanout = new RoomFanout({ store, transport, source: source.read() })

  const reply = ["Working.", "[[ask Alice]]", "the product shot", "[[/ask]]"].join("\n")
  source.push({ seq: 1, kind: "text-delta", text: reply })
  source.push({ seq: 2, kind: "turn-end" })

  fanout.start(room.code)
  await waitFor(() => transport.sends.length === 1)
  assert.equal(transport.sends[0]?.memberId, alice.id)
  assert.equal(transport.sends[0]?.text, `Working.\n(the room is waiting on you) the product shot\n[${room.code}]`)
  await waitFor(() => (store.get(room.code)?.asks ?? []).length === 1)

  source.push({ seq: 3, kind: "text-delta", text: "Still collecting." })
  source.push({ seq: 4, kind: "turn-end" })
  await waitFor(() => transport.sends.length === 2)
  assert.equal(transport.sends[1]?.text, `Still collecting.\n[${room.code}]`, "the marker must not repeat on later turns")
  assert.equal((store.get(room.code)?.asks ?? []).length, 1, "no second ask recorded either")

  await fanout.stopAll()
})

test("a malformed ask block records nothing and delivers plain broadcast text; an unmatched name records nothing and falls back visibly", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  await store.addMember(room.code, memberInput("Alice", "messenger", "+1"))
  await store.update(room.code, { sessionId: "sess-1" })

  const source = new FakeSource()
  const transport = new FakeTransport()

  const malformed = ["Before.", "[[ask Alice]]", "never closed", "still going"].join("\n")
  source.push({ seq: 1, kind: "text-delta", text: malformed })
  source.push({ seq: 2, kind: "turn-end" })
  const unmatched = ["Start.", "[[ask Dave]]", "the thing", "[[/ask]]"].join("\n")
  source.push({ seq: 3, kind: "text-delta", text: unmatched })
  source.push({ seq: 4, kind: "turn-end" })

  const fanout = new RoomFanout({ store, transport, source: source.read() })
  fanout.start(room.code)
  await waitFor(() => transport.sends.length === 2)

  assert.equal(transport.sends[0]?.text, `${malformed}\n[${room.code}]`, "malformed block folds back into broadcast text untouched")
  assert.equal(transport.sends[1]?.text, `Start.\n(ask target not found: Dave)\nthe thing\n[${room.code}]`)
  assert.equal(store.get(room.code)?.asks?.length ?? 0, 0, "neither fallback records an ask")

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
  assert.equal(transport.sends[0]?.text, `first\n${publicArtifactUrl(room.code)}`)

  source.push({ seq: 3, kind: "text-delta", text: "second" })
  source.push({ seq: 4, kind: "turn-end" })
  await waitFor(() => transport.sends.length === 2)
  assert.equal(transport.sends[1]?.text, `second\n[${room.code}]`)

  await fanout.stopAll()
})

test("a box replacement (a new raw artifactUrl behind the same code) does not re-trigger the artifact line — the public URL never changes", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  await store.addMember(room.code, memberInput("Alice", "messenger", "+1"))
  await store.update(room.code, { sessionId: "sess-1", artifactUrl: "https://box-old.test" })

  const source = new FakeSource()
  const transport = new FakeTransport()
  const fanout = new RoomFanout({ store, transport, source: source.read() })

  source.push({ seq: 1, kind: "text-delta", text: "first" })
  source.push({ seq: 2, kind: "turn-end" })
  fanout.start(room.code)
  await waitFor(() => transport.sends.length === 1)
  assert.equal(transport.sends[0]?.text, `first\n${publicArtifactUrl(room.code)}`)

  // Simulate a resume that cold-booted onto a different box (architecture.md
  // §9.3b) — a new raw URL for the same room code.
  await store.update(room.code, { artifactUrl: "https://box-new.test" })
  source.push({ seq: 3, kind: "text-delta", text: "second" })
  source.push({ seq: 4, kind: "turn-end" })
  await waitFor(() => transport.sends.length === 2)
  assert.equal(
    transport.sends[1]?.text,
    `second\n[${room.code}]`,
    "no artifact line: the public URL the member sees is unchanged",
  )

  await fanout.stopAll()
})
