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
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { RoomFanout } from "../../src/fanout/reader.ts"
import type { OutboundMessage, Transport } from "../../src/fanout/types.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Member } from "../../src/rooms/types.ts"
import { publicArtifactUrl } from "../../src/service/artifact-proxy.ts"
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
    address: { provider: "mail", source: "agentpush", contactRef: "bob@x.test" },
  })
  await store.update(room.code, {
    sessionId: "sess-1",
    ...(protocol !== undefined ? { protocol } : {}),
  })
  const source = new FakeSource()
  const transport = new RecordingTransport()
  return { store, code: room.code, source, transport, aliceId: alice.id, bobId: bob.id }
}

async function flushTurn(h: Harness, text: string, firstSeq = 1): Promise<void> {
  const endSeq = firstSeq + 1
  const fanout = new RoomFanout({ store: h.store, transport: h.transport, source: h.source.read() })
  h.source.push({ seq: firstSeq, kind: "text-delta", text })
  h.source.push({ seq: endSeq, kind: "turn-end", reason: "completed" })
  fanout.start(h.code)
  await waitFor(() => h.store.get(h.code)?.cursor === endSeq)
  await fanout.stopAll()
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
    assert.equal(send.message.text, "hello, the room is ready")
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
    assert.equal(send.message.text, publicArtifactUrl(h.code))
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
  const room = h.store.get(h.code)
  assert.ok(room !== undefined)
  // Establish the baseline first: in production the reader is already running
  // when a tool call lands, so the detector's reference point predates the
  // delivery. A fixture that writes the delivery before the reader starts has
  // it counted in the baseline instead, and the turn then looks silent.
  await flushTurn(h, "first turn, before the agent addressed anyone")
  // Now simulate the tool handler's accept: one say Delivery AND the counter
  // it advances. `DeliveryEngine.accept` writes both in one patch — a fixture
  // that sets only the array is not simulating an accept.
  await h.store.update(h.code, {
    deliverySeq: 1,
    deliveries: [
      {
        id: "d1",
        memberId: h.aliceId,
        kind: "say",
        text: "delivered via the tool",
        status: "delivered",
        attempts: 1,
        lastError: undefined,
        createdAt: new Date().toISOString(),
        deliveredAt: new Date().toISOString(),
      },
    ],
  })
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    await flushTurn(h, "thinking, plus the say above")
  } finally {
    console.warn = original
  }

  assert.equal(warnings.length, 0)
})

// The R2 detector must read `deliverySeq`, never `deliveries.length`. The
// array is a work queue with a short tail, not a log: `pruneDeliveries` drops
// `delivered` records past `MAX_RETAINED_DELIVERED`, so on a busy room its
// length stops growing. A length-based detector then matches its own previous
// value on every turn and warns "no phone received anything" exactly when the
// agent IS addressing people — a detector that cries wolf permanently is
// worse than none. Caught by review across two parallel commits (the prune
// and the detector were written without seeing each other).
test("a tools room at the prune cap: the array length is unchanged but the counter moved — no warning", async () => {
  const h = await harness("tools")
  const at = new Date().toISOString()
  const delivered = {
    memberId: h.aliceId,
    kind: "say" as const,
    text: "one of many",
    status: "delivered" as const,
    attempts: 1,
    lastError: undefined,
    createdAt: at,
    deliveredAt: at,
  }
  // A room whose pruned tail is already full: the agent called `say` again
  // this turn, the prune dropped the oldest record, so the array is the same
  // LENGTH as at the last flush while the counter advanced.
  const tail = Array.from({ length: 20 }, (_, index) => ({ ...delivered, id: `d${index + 41}` }))
  await h.store.update(h.code, { deliverySeq: 60, deliveries: tail })
  await flushTurn(h, "first turn, establishes the baseline")

  await h.store.update(h.code, {
    deliverySeq: 61,
    deliveries: [...tail.slice(1), { ...delivered, id: "d61" }],
  })

  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    await flushTurn(h, "thinking, plus the say above")
  } finally {
    console.warn = original
  }

  assert.equal(warnings.length, 0, "the counter moved, so the agent did address someone")
})

test("a markers room behaves exactly as today: bare text, artifact line appended, same wording", async () => {
  const h = await harness("markers")
  await h.store.update(h.code, { artifactUrl: "https://x.test" })
  await flushTurn(h, "hello both")

  assert.equal(h.transport.sends.length, 2)
  const alice = h.transport.sends.find((send) => send.member.id === h.aliceId)
  assert.equal(alice?.message.text, `hello both\n${publicArtifactUrl(h.code)}`)
})

test("a room with no protocol key at all behaves exactly as today", async () => {
  const h = await harness(undefined)
  await flushTurn(h, "plain broadcast")

  assert.equal(h.transport.sends.length, 2)
  assert.equal(h.transport.sends[0]?.message.text, "plain broadcast")
})
