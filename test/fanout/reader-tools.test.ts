/**
 * The tools-protocol gate (PLAN §3.4, BRIEF-04): for a room booted
 * `protocol: "tools"`, the agent's bare turn text reaches NO phone — people
 * hear from the agent only via the `say`/`whisper` tools (their delivery
 * lives in delivery.ts / delivery.test.ts). Everything else `flush` does is
 * protocol-independent and pinned here: attachments, voice notes, the
 * artifact-change notice (standalone now, since the text that carried it is
 * gated), the unservable notices, and the cursor — whose advance is the
 * idle sweep's activity signal.
 */
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { RoomFanout } from "../../src/fanout/reader.ts"
import type { OutboundMessage, Transport } from "../../src/fanout/types.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Member } from "../../src/rooms/types.ts"
import { publicArtifactUrl } from "../../src/service/artifact-proxy.ts"
import { DeliveryEngine } from "../../src/service/delivery.ts"
import type { OutboundAttachment } from "../../src/service/transports.ts"
import { FakeSource, waitFor } from "./support.ts"

const dirs: string[] = []

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-fanout-tools-"))
  dirs.push(dir)
  return dir
}

class RecordingTransport implements Transport {
  readonly sends: { member: Member; message: OutboundMessage }[] = []
  readonly attachmentSends: { member: Member; attachment: OutboundAttachment }[] = []

  async send(member: Member, message: OutboundMessage): Promise<void> {
    this.sends.push({ member, message })
  }

  async sendAttachment(member: Member, attachment: OutboundAttachment): Promise<void> {
    this.attachmentSends.push({ member, attachment })
  }
}

interface Harness {
  store: RoomStore
  code: string
  slug: string
  source: FakeSource
  transport: RecordingTransport
  aliceId: string
  bobId: string
}

async function harness(protocol: "tools" | "markers" | undefined): Promise<Harness> {
  const dir = await freshDir()
  const store = await RoomStore.open(dir)
  const room = await store.create()
  const alice = await store.addMember(room.code, {
    displayName: "Alice",
    tier: "messenger",
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+1" },
  })
  const bob = await store.addMember(room.code, {
    displayName: "Bob",
    tier: "email",
    address: { provider: "email", source: "agentpush", contactRef: "bob@x.test" },
  })
  await store.update(room.code, {
    sessionId: "sess-1",
    ...(protocol !== undefined ? { protocol } : {}),
  })
  const source = new FakeSource()
  const transport = new RecordingTransport()
  return { store, code: room.code, slug: room.slug, source, transport, aliceId: alice.id, bobId: bob.id }
}

async function flushTurn(h: Harness, text: string, firstSeq = 1): Promise<void> {
  const fanout = await startFanout(h)
  fanout.start(h.code)
  await runTurn(h, fanout, text, firstSeq)
  await fanout.stopAll()
}

/** One long-lived reader, as production has: the detector's baseline is seeded
 *  once, when the reader starts, and tool calls land BETWEEN turns against
 *  that baseline. A reader created per turn re-seeds it after the accept and
 *  swallows the delivery into the baseline — a fixture artefact that would
 *  make every speaking turn look silent. */
async function startFanout(h: Harness): Promise<RoomFanout> {
  return new RoomFanout({ store: h.store, transport: h.transport, source: h.source.read() })
}

async function runTurn(h: Harness, _fanout: RoomFanout, text: string, firstSeq: number): Promise<void> {
  const endSeq = firstSeq + 1
  h.source.push({ seq: firstSeq, kind: "text-delta", text })
  h.source.push({ seq: endSeq, kind: "turn-end", reason: "completed" })
  await waitFor(() => h.store.get(h.code)?.cursor === endSeq)
}

test("a tools room: a turn of bare text produces zero transport sends — no messenger, no email", async () => {
  const h = await harness("tools")
  await flushTurn(h, "Here is my plan, everyone.")

  assert.equal(h.transport.sends.length, 0, "bare text is thinking; it reaches nobody's phone")
  assert.equal(h.transport.attachmentSends.length, 0)
})

test("a tools room: the reader still consumes the turn — the cursor advances (the idle sweep's activity signal)", async () => {
  const h = await harness("tools")
  await flushTurn(h, "thinking out loud")

  assert.equal(h.store.get(h.code)?.cursor, 2, "a frozen cursor would idle-pause an active room")
})

test("a tools room: an attachment still reaches every member, independent of the gated text", async () => {
  const h = await harness("tools")
  const fanout = new RoomFanout({
    store: h.store,
    transport: h.transport,
    source: h.source.read(),
    probeUrl: () => Promise.resolve(true),
  })
  h.source.push({ seq: 1, kind: "text-delta", text: "[[attach deck.pdf]]" })
  h.source.push({ seq: 2, kind: "turn-end", reason: "completed" })
  fanout.start(h.code)
  await waitFor(() => h.transport.attachmentSends.length === 2)
  await fanout.stopAll()

  const recipients = h.transport.attachmentSends.map((send) => send.member.id).sort()
  assert.deepEqual(recipients, [h.aliceId, h.bobId].sort())
  assert.equal(h.transport.attachmentSends[0]?.attachment.filename, "deck.pdf")
  assert.equal(h.transport.sends.length, 0, "no text rides along with the gated turn")
})

test("a tools room: a [[say …]] voice note still delivers (caption fallback when TTS is unconfigured)", async () => {
  const h = await harness("tools")
  await flushTurn(h, "[[say hello, the room is ready]]")

  assert.equal(h.transport.sends.length, 2, "the spoken sentence is not agent text — it goes out")
  for (const send of h.transport.sends) {
    assert.equal(send.message.text, `hello, the room is ready\n[${h.slug}]`)
  }
})

test("a tools room: an artifact-URL change goes out as its own standalone message", async () => {
  const h = await harness("tools")
  await h.store.update(h.code, { artifactUrl: "https://x.test" })
  // One reader across both turns: `lastArtifactUrl` is per-fanout (reset on
  // restart, like the markers protocol), so the re-announce check below is
  // only meaningful within a single reader's lifetime.
  const fanout = new RoomFanout({ store: h.store, transport: h.transport, source: h.source.read() })
  h.source.push({ seq: 1, kind: "text-delta", text: "the page is live" })
  h.source.push({ seq: 2, kind: "turn-end", reason: "completed" })
  fanout.start(h.code)
  await waitFor(() => h.transport.sends.length === 2)

  assert.equal(h.transport.sends.length, 2, "exactly one notice per member, despite the gated text")
  for (const send of h.transport.sends) {
    assert.equal(send.message.text, `${publicArtifactUrl(h.code)}\n[${h.slug}]`)
    assert.equal(send.message.artifactUrl, publicArtifactUrl(h.code))
  }

  h.transport.sends.length = 0
  h.source.push({ seq: 3, kind: "text-delta", text: "still here" })
  h.source.push({ seq: 4, kind: "turn-end", reason: "completed" })
  await waitFor(() => h.store.get(h.code)?.cursor === 4)
  assert.equal(h.transport.sends.length, 0, "an unchanged artifact is not re-announced")
  await fanout.stopAll()
})

test("a tools room: a turn with zero say/whisper deliveries logs a warning naming the room (PLAN risk R2)", async () => {
  const h = await harness("tools")
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    await flushTurn(h, "prose only, no tool call")
  } finally {
    console.warn = original
  }

  assert.equal(warnings.length, 1)
  assert.ok(warnings[0]?.includes(h.code), "the warning must name the room code")
  assert.ok(warnings[0]?.includes("zero say/whisper"))
})

test("a tools room whose agent DID call say (a Delivery record exists) logs no warning", async () => {
  const h = await harness("tools")
  // One reader across both turns, as production has: the baseline must
  // predate the tool call.
  const fanout = await startFanout(h)
  fanout.start(h.code)
  await runTurn(h, fanout, "first turn, before the agent addressed anyone", 1)
  // The real tool-handler path: `DeliveryEngine.accept` mints the records AND
  // the counters (`deliverySeq`, `spokenSeq`) in one patch. A fixture that
  // hand-writes only part of that patch is not simulating an accept.
  const engine = new DeliveryEngine({ store: h.store, transport: h.transport, autoDrain: false })
  await engine.accept(h.code, "say", "delivered via the tool", [h.aliceId])
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    await runTurn(h, fanout, "thinking, plus the say above", 3)
  } finally {
    console.warn = original
    await fanout.stopAll()
  }

  assert.equal(warnings.length, 0)
})

// The R2 detector must read `spokenSeq` — never `deliveries.length` (the
// array is a pruned work queue, so a length comparison cries wolf on busy
// rooms) and never `deliverySeq` (the room's own `system` records move it
// too since brief B, which silenced the warning exactly when the agent said
// nothing — brief 08's defect).
test("a tools room at the prune cap: the array length is unchanged but the spoken counter moved — no warning", async () => {
  const h = await harness("tools")
  const at = new Date().toISOString()
  const delivered = {
    memberId: h.aliceId,
    kind: "say" as const,
    text: "one of many",
    status: "delivered" as const,
    failures: 1,
    lastError: undefined,
    createdAt: at,
    deliveredAt: at,
  }
  // A room whose pruned tail is already full: the agent called `say` again
  // this turn, the prune dropped the oldest record, so the array is the same
  // LENGTH as at the last flush while the spoken counter advanced. The
  // hand-written patch carries both counters, as the real accept does.
  const tail = Array.from({ length: 20 }, (_, index) => ({ ...delivered, id: `d${index + 41}` }))
  await h.store.update(h.code, { deliverySeq: 60, spokenSeq: 60, deliveries: tail })
  const fanout = await startFanout(h)
  fanout.start(h.code)
  await runTurn(h, fanout, "first turn, establishes the baseline", 59)

  await h.store.update(h.code, {
    deliverySeq: 61,
    spokenSeq: 61,
    deliveries: [...tail.slice(1), { ...delivered, id: "d61" }],
  })

  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    await runTurn(h, fanout, "thinking, plus the say above", 61)
  } finally {
    console.warn = original
    await fanout.stopAll()
  }

  assert.equal(warnings.length, 0, "the spoken counter moved, so the agent did address someone")
})

test("a tools room: a turn whose only minted delivery is the room's own system record still warns (brief 08)", async () => {
  const h = await harness("tools")
  const web = await h.store.addMember(h.code, {
    displayName: "Chloe",
    tier: "room-web",
    address: { provider: "room-web", source: "room-web", contactRef: "chloe" },
  })
  const fanout = await startFanout(h)
  fanout.start(h.code)
  await runTurn(h, fanout, "first turn, establishes the baseline", 1)
  // The room's own notice (a join link, a QR caption, a resume notice) rides
  // the real mint path: `deliverySeq` moves, `spokenSeq` must not. Under the
  // pre-brief-08 detector this advance WAS the comparison, so the warning
  // never fired.
  const engine = new DeliveryEngine({ store: h.store, transport: h.transport, autoDrain: false })
  await engine.accept(h.code, "system", "the room's own notice", [web.id])
  const after = h.store.get(h.code)
  assert.equal(after?.deliverySeq, 1, "the system mint advanced the delivery counter")
  assert.equal(after?.spokenSeq, undefined, "the system mint must NOT advance the spoken counter")

  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    await runTurn(h, fanout, "prose only, no tool call", 3)
  } finally {
    console.warn = original
    await fanout.stopAll()
  }

  assert.equal(warnings.length, 1, "a system record inside the turn window must not silence the detector")
  assert.ok(warnings[0]?.includes(h.code))
})

test("a tools room: a turn with only a whisper does not warn", async () => {
  const h = await harness("tools")
  const fanout = await startFanout(h)
  fanout.start(h.code)
  await runTurn(h, fanout, "first turn, establishes the baseline", 1)
  const engine = new DeliveryEngine({ store: h.store, transport: h.transport, autoDrain: false })
  await engine.accept(h.code, "whisper", "just between us", [h.bobId])

  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    await runTurn(h, fanout, "thinking, plus the whisper above", 3)
  } finally {
    console.warn = original
    await fanout.stopAll()
  }

  assert.equal(warnings.length, 0, "a whisper mint IS the agent speaking")
})

test("a tools room whose say records have all been pruned still does not warn on a speaking turn", async () => {
  const h = await harness("tools")
  const fanout = await startFanout(h)
  fanout.start(h.code)
  await runTurn(h, fanout, "first turn, establishes the baseline", 1)
  const engine = new DeliveryEngine({ store: h.store, transport: h.transport, autoDrain: false })
  await engine.accept(h.code, "say", "since aged out of the tail", [h.aliceId])
  // The prune is exactly this: the array drops the record, the counter stays.
  // `spokenSeq` is persisted on the room, never derived from the array — a
  // room whose only say aged out must not read as "never spoke".
  await h.store.update(h.code, { deliveries: [] })
  assert.deepEqual(h.store.get(h.code)?.deliveries, [])
  assert.ok((h.store.get(h.code)?.spokenSeq ?? 0) > 0)

  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    await runTurn(h, fanout, "thinking, plus the say above", 3)
  } finally {
    console.warn = original
    await fanout.stopAll()
  }

  assert.equal(warnings.length, 0, "pruning must never manufacture a warning")
})

// --- assertion 4 (BRIEF-15, post-turn-assertions): an inbound message
// triggered this turn, and no accepted say/whisper delivery this turn
// targeted its sender. The pair is the point: a turn that whispers a THIRD
// party while ignoring the sender must fire; a turn that actually answers
// the sender (by name) must not. `triggeredBy` is the fact `RoomService`
// wires in production (right before it fans an inbound into the session) —
// these tests wire it directly, since nothing here goes through
// `RoomService`. ---

test("BRIEF-15: a turn that whispers a third party but never the triggering member reports assertion 4 (turn-answered-nobody)", async () => {
  const h = await harness("tools")
  const fanout = new RoomFanout({
    store: h.store,
    transport: h.transport,
    source: h.source.read(),
    triggeredBy: () => h.aliceId,
  })
  fanout.start(h.code)
  await runTurn(h, fanout, "first turn, establishes the baseline", 1)

  const engine = new DeliveryEngine({ store: h.store, transport: h.transport, autoDrain: false })
  await engine.accept(h.code, "whisper", "a secret for bob", [h.bobId])

  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    await runTurn(h, fanout, "whispering to bob, never answering alice", 3)
  } finally {
    console.warn = original
    await fanout.stopAll()
  }

  const fired = warnings.filter((w) => w.includes("turn-answered-nobody"))
  assert.equal(fired.length, 1)
  assert.ok(fired[0]?.includes(h.code))
  assert.ok(fired[0]?.includes(h.aliceId), "the warning must name the member who was never answered")
})

test("BRIEF-15: a turn that says/whispers to the triggering member does NOT report assertion 4", async () => {
  const h = await harness("tools")
  const fanout = new RoomFanout({
    store: h.store,
    transport: h.transport,
    source: h.source.read(),
    triggeredBy: () => h.aliceId,
  })
  fanout.start(h.code)
  await runTurn(h, fanout, "first turn, establishes the baseline", 1)

  const engine = new DeliveryEngine({ store: h.store, transport: h.transport, autoDrain: false })
  await engine.accept(h.code, "say", "answering alice's question", [h.aliceId])

  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    await runTurn(h, fanout, "answering alice, plus the say above", 3)
  } finally {
    console.warn = original
    await fanout.stopAll()
  }

  const fired = warnings.filter((w) => w.includes("turn-answered-nobody"))
  assert.equal(fired.length, 0, "the say above named the triggering member — the turn did answer them")
})

// --- BRIEF-29: system records from the room count as having told the member ---

test("BRIEF-29: assertion 4 does NOT fire when a system record was delivered to the trigger member — the room spoke to them", async () => {
  const h = await harness("tools")
  const fanout = new RoomFanout({
    store: h.store,
    transport: h.transport,
    source: h.source.read(),
    triggeredBy: () => h.aliceId,
  })
  fanout.start(h.code)
  await runTurn(h, fanout, "first turn, establishes the baseline", 1)

  const engine = new DeliveryEngine({ store: h.store, transport: h.transport, autoDrain: false })
  await engine.accept(h.code, "system", "the room's own notice to alice", [h.aliceId])

  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    await runTurn(h, fanout, "thinking, system notice to alice above, no say/whisper", 3)
  } finally {
    console.warn = original
    await fanout.stopAll()
  }

  const fired = warnings.filter((w) => w.includes("turn-answered-nobody"))
  assert.equal(fired.length, 0, "a system record to the trigger member must not fire assertion 4")
})

test("BRIEF-29: assertion 4 still fires when the trigger member got nothing at all — no say, no whisper, no system", async () => {
  const h = await harness("tools")
  const fanout = new RoomFanout({
    store: h.store,
    transport: h.transport,
    source: h.source.read(),
    triggeredBy: () => h.aliceId,
  })
  fanout.start(h.code)
  await runTurn(h, fanout, "first turn, establishes the baseline", 1)

  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    await runTurn(h, fanout, "thinking only, no delivery of any kind to anyone this turn", 3)
  } finally {
    console.warn = original
    await fanout.stopAll()
  }

  const fired = warnings.filter((w) => w.includes("turn-answered-nobody"))
  assert.equal(fired.length, 1, "a turn with nothing at all for the trigger must still fire assertion 4")
  assert.ok(fired[0]?.includes(h.code))
  assert.ok(fired[0]?.includes(h.aliceId))
})

test("BRIEF-29: assertion 4 still fires when a system record went to a DIFFERENT member — someone else being told is not this person being told", async () => {
  const h = await harness("tools")
  const fanout = new RoomFanout({
    store: h.store,
    transport: h.transport,
    source: h.source.read(),
    triggeredBy: () => h.aliceId,
  })
  fanout.start(h.code)
  await runTurn(h, fanout, "first turn, establishes the baseline", 1)

  const engine = new DeliveryEngine({ store: h.store, transport: h.transport, autoDrain: false })
  await engine.accept(h.code, "system", "the room's own notice to bob", [h.bobId])

  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    await runTurn(h, fanout, "thinking, system notice to bob above, nothing for alice", 3)
  } finally {
    console.warn = original
    await fanout.stopAll()
  }

  const fired = warnings.filter((w) => w.includes("turn-answered-nobody"))
  assert.equal(fired.length, 1, "a system record to bob must not count as telling alice — assertion 4 fires for alice")
  assert.ok(fired[0]?.includes(h.code))
  assert.ok(fired[0]?.includes(h.aliceId))
})

test("a pre-upgrade room (no spokenSeq in the persisted JSON) round-trips and warns on a silent turn", async () => {
  const dir = await freshDir()
  const room = {
    code: "RDV-PRE2",
    sessionId: "sess-1",
    members: [
      {
        id: "m1",
        displayName: "Alice",
        tier: "messenger",
        address: { provider: "whatsapp", source: "agentpush", contactRef: "+1" },
        joinedAt: "2026-09-12T00:00:00.000Z",
      },
    ],
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    cursor: 0,
    lastActivityAt: "2026-09-12T00:00:00.000Z",
    state: "active",
    protocol: "tools",
  }
  await writeFile(join(dir, "rooms.json"), JSON.stringify({ rooms: [room] }), "utf8")

  const store = await RoomStore.open(dir)
  const loaded = store.get("RDV-PRE2")
  assert.ok(loaded !== undefined, "the pre-upgrade room loads at all")
  assert.equal(loaded.spokenSeq, undefined, "absent on a room persisted before the field")

  const source = new FakeSource()
  const transport = new RecordingTransport()
  const fanout = new RoomFanout({ store, transport, source: source.read() })
  source.push({ seq: 1, kind: "text-delta", text: "prose only" })
  source.push({ seq: 2, kind: "turn-end", reason: "completed" })
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    fanout.start("RDV-PRE2")
    await waitFor(() => store.get("RDV-PRE2")?.cursor === 2)
  } finally {
    console.warn = original
    await fanout.stopAll()
  }

  assert.equal(warnings.length, 1, "absent reads as 0 — has not spoken — which errs toward the warning")
  assert.ok(warnings[0]?.includes("RDV-PRE2"))
})

test("a markers room behaves exactly as today: bare text, artifact line appended, same wording", async () => {
  const h = await harness("markers")
  await h.store.update(h.code, { artifactUrl: "https://x.test" })
  await flushTurn(h, "hello both")

  assert.equal(h.transport.sends.length, 2)
  const alice = h.transport.sends.find((send) => send.member.id === h.aliceId)
  assert.equal(alice?.message.text, `hello both\n${publicArtifactUrl(h.code)}\n[${h.slug}]`)
})

test("a room with no protocol key at all behaves exactly as today", async () => {
  const h = await harness(undefined)
  await flushTurn(h, "plain broadcast")

  assert.equal(h.transport.sends.length, 2)
  assert.equal(h.transport.sends[0]?.message.text, `plain broadcast\n[${h.slug}]`)
})
