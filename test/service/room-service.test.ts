import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { env } from "../../src/env.ts"
import { listAudience } from "../../src/audience/contract.ts"
import { DaemonClient } from "../../src/daemon/client.ts"
import type { OutboundMessage, Transport } from "../../src/fanout/types.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import { pullMemberStale } from "../../src/rooms/types.ts"
import type { Address, Member, Tier } from "../../src/rooms/types.ts"
import { publicArtifactUrl } from "../../src/service/artifact-proxy.ts"
import { LocalBooter, type SessionBooter } from "../../src/service/booter.ts"
import { MediaStore } from "../../src/service/media-store.ts"
import { RoomService } from "../../src/service/room-service.ts"
import { MemoryTransport, type RecordedSend } from "../../src/service/transports.ts"
import { startExtendedFakeDaemon, type ExtendedFakeDaemon } from "./fake-daemon-extra.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const dirs: string[] = []
const daemons: ExtendedFakeDaemon[] = []
const services: RoomService[] = []

after(async () => {
  // Fan-out readers retry forever on a dead connection (backoff, uncapped) —
  // any service left running would keep the process alive after the fake
  // daemons close, so every one built in this file must be stopped here.
  await Promise.all(services.map((service) => service.stop()))
  await Promise.all(daemons.map((daemon) => daemon.close()))
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-service-"))
  dirs.push(dir)
  return dir
}

async function freshDaemon(): Promise<ExtendedFakeDaemon> {
  const daemon = await startExtendedFakeDaemon()
  daemons.push(daemon)
  return daemon
}

// Every RoomService in this file must get its own MediaStore, backed by a
// temp dir — RoomService falls back to env.mediaDir (the LIVE store) when
// none is given, and a "new" command mints a join QR unconditionally.
async function freshMediaStore(): Promise<MediaStore> {
  return new MediaStore(await freshDir())
}

interface Harness {
  service: RoomService
  store: RoomStore
  transport: MemoryTransport
  daemon: ExtendedFakeDaemon
}

async function buildHarness(opts: { probeUrl?: (url: string) => Promise<boolean> } = {}): Promise<Harness> {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })
  const transport = new MemoryTransport()
  const service = new RoomService({
    store,
    client,
    booter,
    transport,
    daemon: { baseUrl: daemon.url, token: undefined },
    mediaStore: await freshMediaStore(),
    ...(opts.probeUrl !== undefined ? { probeUrl: opts.probeUrl } : {}),
  })
  services.push(service)
  return { service, store, transport, daemon }
}

async function buildHarnessWithTransport<T extends Transport>(
  transport: T,
): Promise<{ service: RoomService; store: RoomStore; transport: T; daemon: ExtendedFakeDaemon }> {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })
  const service = new RoomService({
    store,
    client,
    booter,
    transport,
    daemon: { baseUrl: daemon.url, token: undefined },
    mediaStore: await freshMediaStore(),
  })
  services.push(service)
  return { service, store, transport, daemon }
}

function alice(text: string): { address: Address; displayName: string; tier: Tier; text: string } {
  return {
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+15550001111" },
    displayName: "Alice",
    tier: "messenger",
    text,
  }
}

function bob(text: string): { address: Address; displayName: string; tier: Tier; text: string } {
  return {
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+15559998888" },
    displayName: "Bob",
    tier: "messenger",
    text,
  }
}

function carol(text: string): { address: Address; displayName: string; tier: Tier; text: string } {
  return {
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+15557778888" },
    displayName: "Carol",
    tier: "messenger",
    text,
  }
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** A plain `Transport` with no `sendMedia` at all — for asserting that the
 *  QR send is skipped, not just silently swallowed, when unsupported. */
class PlainTransport implements Transport {
  readonly sends: RecordedSend[] = []

  async send(member: Member, message: OutboundMessage): Promise<void> {
    this.sends.push({ member, message })
  }
}

test("new boots a session via the booter and replies to the sender with the code and artifact url", async () => {
  const { service, transport } = await buildHarness()

  const outcome = await service.handleInbound(alice("new"))
  assert.equal(outcome.kind, "created")
  if (outcome.kind !== "created") return
  assert.match(outcome.room.code, /^RDV-[A-Z0-9]{4}$/)
  assert.equal(outcome.room.sessionId, "sess_fake")
  assert.equal(outcome.room.members.length, 1)

  assert.equal(transport.sends.length, 1)
  assert.equal(transport.sends[0]?.member.displayName, "Alice")
  assert.ok(transport.sends[0]?.message.text.includes(outcome.room.code))
})

test("new includes the web join link in the reply and sends a QR when the transport supports media", async () => {
  const { service, transport } = await buildHarness()

  const outcome = await service.handleInbound(alice("new"))
  assert.equal(outcome.kind, "created")
  if (outcome.kind !== "created") return

  const replyText = transport.sends[0]?.message.text ?? ""
  assert.ok(replyText.includes(`/r/${outcome.room.code}`), "reply should include the web join link")

  assert.equal(transport.mediaSends.length, 1)
  assert.equal(transport.mediaSends[0]?.member.displayName, "Alice")
  assert.ok(transport.mediaSends[0]?.caption.includes(outcome.room.code))
  assert.ok((transport.mediaSends[0]?.png.length ?? 0) > 0, "should send actual PNG bytes")
})

test("new never calls sendMedia when the transport does not support it", async () => {
  const plain = new PlainTransport()
  const { service } = await buildHarnessWithTransport(plain)

  const outcome = await service.handleInbound(alice("new"))
  assert.equal(outcome.kind, "created")
  assert.equal(plain.sends.length, 1)
  // PlainTransport has no sendMedia at all — if RoomService ever called it
  // unconditionally this test would throw a TypeError instead of just failing.
})

test("join adds a second member to an existing room and replies with a welcome that lists the roster", async () => {
  const { service, transport } = await buildHarness()

  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return

  const joined = await service.handleInbound(bob(`join ${created.room.code}`))
  assert.equal(joined.kind, "joined")
  if (joined.kind !== "joined") return
  assert.equal(joined.room.code, created.room.code)
  assert.equal(joined.room.members.length, 2)
  assert.equal(joined.member.displayName, "Bob")

  assert.equal(transport.sends.length, 2)
  assert.equal(transport.sends[1]?.member.displayName, "Bob")
  const joinReplyText = transport.sends[1]?.message.text ?? ""
  assert.ok(joinReplyText.includes("Alice"), "join reply should list the roster, including who was already there")
  assert.ok(joinReplyText.includes("Bob"))
})

test("join moves a member already in another room, updating both rosters and replying with the move", async () => {
  const { service, transport } = await buildHarness()

  const createdA = await service.handleInbound(alice("new"))
  assert.ok(createdA.kind === "created")
  if (createdA.kind !== "created") return

  const createdB = await service.handleInbound(bob("new"))
  assert.ok(createdB.kind === "created")
  if (createdB.kind !== "created") return

  const moved = await service.handleInbound(alice(`join ${createdB.room.code}`))
  assert.equal(moved.kind, "moved")
  if (moved.kind !== "moved") return
  assert.equal(moved.from, createdA.room.code)
  assert.equal(moved.room.code, createdB.room.code)

  const roomA = service.getRoom(createdA.room.code)
  assert.equal(roomA?.members.length, 0, "alice's old room no longer lists her")
  const roomB = service.getRoom(createdB.room.code)
  assert.equal(roomB?.members.length, 2, "bob is untouched, alice is added")
  assert.ok(roomB?.members.some((m) => m.displayName === "Alice"))

  const lastSend = transport.sends[transport.sends.length - 1]
  assert.equal(lastSend?.member.displayName, "Alice")
  assert.ok(lastSend?.message.text.includes(createdA.room.slug), "should name the room moved FROM by its slug")
  assert.ok(lastSend?.message.text.includes(createdB.room.slug), "should name the room moved TO by its slug")
})

test("join on the room a member is already in is a no-op, replying with the roster rather than a move", async () => {
  const { service, transport } = await buildHarness()

  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return

  const rejoined = await service.handleInbound(alice(`join ${created.room.code}`))
  assert.equal(rejoined.kind, "joined")
  if (rejoined.kind !== "joined") return
  assert.equal(rejoined.room.members.length, 1)

  const lastSend = transport.sends[transport.sends.length - 1]
  assert.ok(lastSend?.message.text.includes(created.room.slug))
})

test("leave removes the sender from their room and replies confirming it, without killing the session", async () => {
  const { service, store, transport, daemon } = await buildHarness()

  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return

  const left = await service.handleInbound(alice("leave"))
  assert.equal(left.kind, "left")
  if (left.kind !== "left") return
  assert.equal(left.room.code, created.room.code)

  assert.equal(store.get(created.room.code)?.members.length, 0)
  assert.equal(store.get(created.room.code)?.state, "active", "leaving does not pause the room")

  const lastSend = transport.sends[transport.sends.length - 1]
  assert.equal(lastSend?.member.displayName, "Alice")
  assert.ok(lastSend?.message.text.includes(created.room.slug))
  assert.match(lastSend?.message.text ?? "", /left/i)

  const killCalls = daemon.requestsReceived.filter((r) => r.path.includes("/kill"))
  assert.equal(killCalls.length, 0, "leaving one member must not kill the room's session")
})

test("leave for a sender in no room replies with guidance instead of throwing", async () => {
  const { service, transport } = await buildHarness()

  const outcome = await service.handleInbound(alice("leave"))
  assert.deepEqual(outcome, { kind: "not-in-room" })
  assert.equal(transport.sends.length, 1)
  assert.match(transport.sends[0]?.message.text ?? "", /not in a room/i)
})

test("BRIEF-13 regression, end to end: a stray duplicate membership left behind by a pre-fix 'resume' must not silently outrank an explicit 'join' — the next inbound lands in the room just joined", async () => {
  const { service } = await buildHarness()

  // STRAY: alice's first room. Oldest in the store's insertion order — the
  // exact position `findByAddress` used to prefer on `main` when an address
  // matched more than one room.
  const stray = await service.handleInbound(alice("new"))
  assert.ok(stray.kind === "created")
  if (stray.kind !== "created") return

  const target = await service.handleInbound(bob("new"))
  assert.ok(target.kind === "created")
  if (target.kind !== "created") return

  // On `main`, `resume` calls `store.addMember` directly and never removes
  // the sender from STRAY — this line alone is what used to leave alice a
  // member of two rooms at once (BRIEF-13 "The mechanism, proven", defect
  // 1). On the current code `resume` goes through `ensureMembership`, so
  // this is an ordinary move and leaves no duplicate at all.
  const resumed = await service.handleInbound(alice(`resume ${target.room.code}`))
  assert.equal(resumed.kind, "resumed")

  const fresh = await service.handleInbound(carol("new"))
  assert.ok(fresh.kind === "created")
  if (fresh.kind !== "created") return

  // The explicit act (R2): alice names FRESH by code. On `main`, `join`'s
  // internal `ensureMembership` resolves "the room to move out of" via the
  // same `findByAddress` that scans in insertion order — with alice in both
  // STRAY and TARGET, it finds STRAY (defect 2) and removes THAT, leaving
  // TARGET behind as a second stray duplicate.
  const joined = await service.handleInbound(alice(`join ${fresh.room.code}`))
  assert.ok(joined.kind === "joined" || joined.kind === "moved")

  // The composed failure: a plain inbound (no command) resolves through
  // `findByAddress` one more time. On `main` alice is still in {TARGET,
  // FRESH} and TARGET was inserted first, so the message is delivered
  // there — silently overriding the `join` she just sent, byte for byte
  // the bug from "What Jeremy saw".
  const inbound = await service.handleInbound(alice("hello?"))
  assert.equal(inbound.kind, "message")
  if (inbound.kind !== "message") return
  assert.equal(inbound.room.code, fresh.room.code, "an inbound after an explicit join must land in the room just joined")
})

test("BRIEF-13 R4: after 'leave', an inbound from that address is an unknown sender — never re-attached to a stray room left over from a pre-fix 'resume'", async () => {
  const { service } = await buildHarness()

  const stray = await service.handleInbound(alice("new"))
  assert.ok(stray.kind === "created")
  if (stray.kind !== "created") return

  const target = await service.handleInbound(bob("new"))
  assert.ok(target.kind === "created")
  if (target.kind !== "created") return

  // Same pre-fix duplicate scenario as the end-to-end regression test above.
  const resumed = await service.handleInbound(alice(`resume ${target.room.code}`))
  assert.equal(resumed.kind, "resumed")

  const left = await service.handleInbound(alice("leave"))
  assert.equal(left.kind, "left")

  const inbound = await service.handleInbound(alice("hello?"))
  assert.equal(inbound.kind, "unknown-sender", "leave must attach the sender to nothing — not fall back to a stray earlier room")

  assert.equal(service.getRoom(stray.room.code)?.members.length, 0)
  assert.equal(service.getRoom(target.room.code)?.members.length, 1, "only bob remains")
})

test("BRIEF-20/BRIEF-13 R6: 'where' answers the room's slug (never its code) and the roster for a sender with an active room", async () => {
  const { service, transport } = await buildHarness()

  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  await service.handleInbound(bob(`join ${created.room.code}`))

  const outcome = await service.handleInbound(alice("where"))
  assert.equal(outcome.kind, "where")
  if (outcome.kind !== "where") return
  assert.equal(outcome.room.code, created.room.code)

  const lastSend = transport.sends[transport.sends.length - 1]
  assert.ok(lastSend?.message.text.includes(created.room.slug), "the where reply should name the room by its slug")
  assert.ok(!lastSend?.message.text.includes(created.room.code), "the where reply must not leak the room's join code")
  assert.ok(lastSend?.message.text.includes("Bob"), "the roster names the other member")
})

// --- assertion 3 (BRIEF-15, post-turn-assertions): an ordinary inbound
// message from an address that is (illegally) a member of more than one
// room, naming no room code. The pair is the point: the SAME ambiguous
// address sending an explicit `join <code>` must not report anything — R3
// says a message naming a room wins, for that message only. ---

test("BRIEF-15: an ordinary message from an address ambiguously in two rooms reports assertion 3 as a log-only warning — no delivery, and replyGuidance still serves the member", async () => {
  const { service, store, transport } = await buildHarness()

  const roomA = await service.handleInbound(alice("new"))
  assert.ok(roomA.kind === "created")
  if (roomA.kind !== "created") return
  const roomB = await service.handleInbound(bob("new"))
  assert.ok(roomB.kind === "created")
  if (roomB.kind !== "created") return

  // Seed the broken invariant directly (BRIEF-13): alice becomes a member of
  // B too, WITHOUT going through `ensureMembership` — every live join path
  // now prevents exactly this, so the only way it happens is the legacy
  // defect brief 13 describes (a stray duplicate left over from before the
  // fix). `store.addMember` is the bypass on purpose, to reproduce that
  // pre-existing state rather than a state this code could still create.
  await store.addMember(roomB.room.code, { displayName: "Alice", tier: "messenger", address: alice("").address })

  transport.sends.length = 0
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")) }
  try {
    const inbound = await service.handleInbound(alice("hello, anyone there?"))
    assert.equal(inbound.kind, "unknown-sender", "an ambiguous address degrades to unknown-sender, never a silent pick")
  } finally {
    console.warn = original
  }

  // Zero assertion deliveries — ambiguous-sender is log-only because
  // replyGuidance already tells the member what happened and what to do.
  const assertionDeliveries = transport.sends.filter((send) => send.message.text.startsWith("Send `new`"))
  assert.ok(assertionDeliveries.length > 0, "replyGuidance still serves the member")
  const spamDeliveries = transport.sends.filter((send) =>
    send.message.text.includes("ambiguous") || send.message.text.includes("could not be routed"),
  )
  assert.equal(spamDeliveries.length, 0, "ambiguous-sender mints zero deliveries to any member")

  // console.warn fires for each candidate room.
  const assertionWarnings = warnings.filter((w) => w.includes("ambiguous-sender"))
  assert.equal(assertionWarnings.length, 2)
  assert.ok(assertionWarnings[0]?.includes(roomA.room.code))
  assert.ok(assertionWarnings[0]?.includes(roomB.room.code))
  assert.ok(assertionWarnings[1]?.includes(roomA.room.code))
  assert.ok(assertionWarnings[1]?.includes(roomB.room.code))

  transport.sends.length = 0
  const joined = await service.handleInbound(alice(`join ${roomA.room.code}`))
  assert.ok(joined.kind === "joined" || joined.kind === "moved")

  transport.sends.length = 0
  // BRIEF-27: `join <code>` now resolves the ambiguity — after the join, the
  // address is in exactly one room, and the next message is no longer treated
  // as ambiguous-sender. The read-side invariant (an unaddressed message from
  // an address genuinely in several rooms is NOT silently routed) is verified
  // by the first part of this test, above.
  const warnings2: string[] = []
  const warn2 = console.warn
  console.warn = (...args: unknown[]) => { warnings2.push(args.map(String).join(" ")) }
  try {
    const next = await service.handleInbound(alice("still no room code?"))
    assert.ok(next.kind !== "unknown-sender", "after a join that resolves the ambiguity, the next message routes normally")
  } finally {
    console.warn = warn2
  }
  const assertionWarnings2 = warnings2.filter((w) => w.includes("ambiguous-sender"))
  assert.equal(assertionWarnings2.length, 0, "the ambiguity is resolved by the join, so the next message does not trigger ambiguous-sender")
})

test("BRIEF-20: 'join <slug>' refuses a stranger, resolves for an existing member, and 'resume <slug>' revives a paused room for that member", async () => {
  const { service } = await buildHarness()

  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  const slug = created.room.slug

  // Bob has never been in this room — naming its slug must refuse him, not
  // silently add him the way `join <code>` would.
  const refused = await service.handleInbound(bob(`join ${slug}`))
  assert.equal(refused.kind, "not-a-member")
  assert.equal(service.getRoom(created.room.code)?.members.length, 1)

  // Alice IS a member of the room the slug names — it resolves cleanly for her.
  const confirmed = await service.handleInbound(alice(`join ${slug}`))
  assert.equal(confirmed.kind, "joined")

  await service.pauseRoom(created.room.code)
  const resumed = await service.handleInbound(alice(`resume ${slug}`))
  assert.equal(resumed.kind, "resumed")
  assert.equal(service.getRoom(created.room.code)?.state, "active")
})

test("BRIEF-13 R6: 'where' answers plainly that a sender with no active room is in no room — not an error, not silence", async () => {
  const { service, transport } = await buildHarness()

  const outcome = await service.handleInbound(alice("where"))
  assert.equal(outcome.kind, "not-in-room")

  const lastSend = transport.sends[transport.sends.length - 1]
  assert.ok(lastSend !== undefined, "a sender in no room asking 'where' must still get an answer, not silence")
  assert.match(lastSend.message.text, /no room/i)
})

test("join on an unknown code replies with guidance and returns a typed error", async () => {
  const { service, transport } = await buildHarness()

  const outcome = await service.handleInbound(alice("join RDV-ZZZZ"))
  assert.deepEqual(outcome, { kind: "unknown-code" })
  assert.equal(transport.sends.length, 1)
  assert.match(transport.sends[0]?.message.text ?? "", /isn't known/i)
})

test("resume on an unknown code replies with guidance and returns a typed error", async () => {
  const { service, transport } = await buildHarness()

  const outcome = await service.handleInbound(alice("resume RDV-ZZZZ"))
  assert.deepEqual(outcome, { kind: "unknown-code" })
  assert.equal(transport.sends.length, 1)
  assert.match(transport.sends[0]?.message.text ?? "", /isn't known/i)
})

test("a message from an unknown sender gets guidance, not delivered to any session", async () => {
  const { service, transport, daemon } = await buildHarness()

  const outcome = await service.handleInbound(alice("hello, anyone there?"))
  assert.deepEqual(outcome, { kind: "unknown-sender" })
  assert.equal(transport.sends.length, 1)
  assert.match(transport.sends[0]?.message.text ?? "", /new|join/i)
  assert.equal(daemon.requestsReceived.some((r) => r.path.includes("/prompt")), false)
})

test("resume revives a room whose session is still alive without booting a new one", async () => {
  const { service, daemon } = await buildHarness()

  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  const spawnCallsBefore = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent").length

  const resumed = await service.handleInbound(alice(`resume ${created.room.code}`))
  assert.equal(resumed.kind, "resumed")
  if (resumed.kind !== "resumed") return
  assert.equal(resumed.room.sessionId, created.room.sessionId)

  const spawnCallsAfter = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent").length
  assert.equal(spawnCallsAfter, spawnCallsBefore, "resume should not boot a fresh session when the old one is alive")
})

test("doResume resets the cursor when the session id changes, so a turn on the new session still reaches members (Finding 3)", async () => {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const store = await RoomStore.open(dir)
  const transport = new MemoryTransport()

  // A scripted booter, not LocalBooter: the shared fake daemon hands out the
  // same fixed session id on every spawn, which can never reproduce "resume
  // mints a new session id" on its own. This is the actual seam
  // (`SessionBooter`) `RoomService` drives, so scripting it directly proves
  // `doResume`'s own cursor logic without needing a fancier fake daemon.
  const booter: SessionBooter = {
    async boot() {
      return { sessionId: "sess-old", sandboxId: undefined, artifactUrl: undefined, artifactReady: undefined }
    },
    async resume() {
      return { sessionId: "sess-new", sandboxId: undefined, artifactUrl: undefined, artifactReady: undefined }
    },
  }
  const service = new RoomService({
    store,
    client,
    booter,
    transport,
    daemon: { baseUrl: daemon.url, token: undefined },
    mediaStore: await freshMediaStore(),
  })
  services.push(service)

  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  const code = created.room.code

  // Advance the cursor well past where the new session's own numbering will
  // restart — exactly Run 2's failure mode (`cursor` stuck at a previous
  // session's seq, e.g. 41, forever above the new session's own numbers).
  daemon.pushRecord("sess-old", { seq: 1, kind: "text-delta", text: "before pause" })
  daemon.pushRecord("sess-old", { seq: 2, kind: "turn-end", reason: "completed" })
  await waitFor(() => (store.get(code)?.cursor ?? 0) === 2)

  await service.pauseRoom(code)
  assert.equal(store.get(code)?.state, "paused")

  const resumed = await service.handleInbound(alice(`resume ${code}`))
  assert.equal(resumed.kind, "resumed")
  const resumedRoom = store.get(code)
  assert.equal(resumedRoom?.sessionId, "sess-new")
  assert.equal(resumedRoom?.cursor, 0, "cursor must reset to 0 for the new session, not stay at the old session's seq")

  const sendsBefore = transport.sends.length
  daemon.pushRecord("sess-new", { seq: 1, kind: "text-delta", text: "after resume" })
  daemon.pushRecord("sess-new", { seq: 2, kind: "turn-end", reason: "completed" })
  await waitFor(() => transport.sends.length > sendsBefore)
  assert.ok(transport.sends[sendsBefore]?.message.text.includes("after resume"))
})

test("the raw artifactUrl never reaches a member: replies carry the room-code-keyed public URL instead (architecture.md §9.3b)", async () => {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const store = await RoomStore.open(dir)
  const transport = new MemoryTransport()
  const rawArtifactUrl = "https://3210-someboxid.e2b.app"
  const booter: SessionBooter = {
    async boot() {
      return { sessionId: "sess-1", sandboxId: "box-1", artifactUrl: rawArtifactUrl, artifactReady: true }
    },
    async resume() {
      throw new Error("not exercised")
    },
  }
  const service = new RoomService({
    store,
    client,
    booter,
    transport,
    daemon: { baseUrl: daemon.url, token: undefined },
    mediaStore: await freshMediaStore(),
  })
  services.push(service)

  const created = await service.handleInbound(alice("new"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return
  const expectedUrl = publicArtifactUrl(created.room.code)

  const send = transport.sends[0]
  assert.ok(send !== undefined)
  assert.ok(!send?.message.text.includes(rawArtifactUrl), "the raw box URL must never appear in a member-facing reply")
  assert.ok(send?.message.text.includes(expectedUrl), "the reply should carry the stable, room-code-keyed URL instead")
  assert.equal(send?.message.artifactUrl, expectedUrl)

  // The store itself is the one place the raw URL is allowed to live.
  assert.equal(store.get(created.room.code)?.artifactUrl, rawArtifactUrl)
})

test("resuming onto a replaced box notifies every member once, in addition to the resumer's own reply — the link itself never changes", async () => {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const store = await RoomStore.open(dir)
  const transport = new MemoryTransport()
  const booter: SessionBooter = {
    async boot() {
      return { sessionId: "sess-old", sandboxId: "box-old", artifactUrl: "https://3210-boxold.e2b.app", artifactReady: true }
    },
    async resume() {
      return { sessionId: "sess-new", sandboxId: "box-new", artifactUrl: "https://3210-boxnew.e2b.app", artifactReady: true }
    },
  }
  const service = new RoomService({
    store,
    client,
    booter,
    transport,
    daemon: { baseUrl: daemon.url, token: undefined },
    mediaStore: await freshMediaStore(),
  })
  services.push(service)

  const created = await service.handleInbound(alice("new"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return
  const code = created.room.code

  const joined = await service.handleInbound(bob(`join ${code}`))
  assert.equal(joined.kind, "joined")

  await service.pauseRoom(code)
  const sendsBeforeResume = transport.sends.length

  const resumed = await service.handleInbound(alice(`resume ${code}`))
  assert.equal(resumed.kind, "resumed")

  const notices = transport.sends
    .slice(sendsBeforeResume)
    .filter((send) => send.message.text === `Artifact restored on a new box, same link.\n[${created.room.slug}]`)
  assert.equal(notices.length, 2, "both current members should get the notice, not just whoever typed resume")
  assert.deepEqual(
    notices.map((send) => send.member.displayName).sort(),
    ["Alice", "Bob"],
  )
  const expectedUrl = publicArtifactUrl(code)
  assert.ok(notices.every((send) => send.message.artifactUrl === expectedUrl))
})

test("resuming onto the SAME box sends no box-replaced notice", async () => {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const store = await RoomStore.open(dir)
  const transport = new MemoryTransport()
  const booter: SessionBooter = {
    async boot() {
      return { sessionId: "sess-old", sandboxId: "box-1", artifactUrl: "https://3210-box1.e2b.app", artifactReady: true }
    },
    async resume() {
      return { sessionId: "sess-new", sandboxId: "box-1", artifactUrl: "https://3210-box1.e2b.app", artifactReady: true }
    },
  }
  const service = new RoomService({
    store,
    client,
    booter,
    transport,
    daemon: { baseUrl: daemon.url, token: undefined },
    mediaStore: await freshMediaStore(),
  })
  services.push(service)

  const created = await service.handleInbound(alice("new"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return
  const code = created.room.code

  await service.pauseRoom(code)
  await service.handleInbound(alice(`resume ${code}`))

  assert.equal(transport.sends.some((send) => send.message.text.includes("restored on a new box")), false)
})

test("a session killed out of band (bypassing doPause) is revived on the next fan-in instead of stranding the room (Finding 2a)", async () => {
  const { service, store, transport, daemon } = await buildHarness()

  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  const code = created.room.code
  const sessionId = created.room.sessionId
  assert.ok(sessionId !== undefined)
  if (sessionId === undefined) return

  // Out-of-band: kill the session directly, never through
  // `RoomService.doPause` — the store still says "active" pointing at the
  // now-dead sessionId, exactly like a daemon crash, restart, or an
  // operator's own recovery attempt.
  const outOfBandClient = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  await outOfBandClient.kill(sessionId)
  assert.equal(store.get(code)?.state, "active", "the store cannot know about an out-of-band kill by itself")

  const sendsBefore = transport.sends.length
  const outcome = await service.handleInbound(alice("are you still there?"))
  assert.equal(outcome.kind, "message")

  const revived = store.get(code)
  assert.equal(revived?.state, "active")
  assert.ok(revived?.sessionId !== undefined)

  const resumingMessage = transport.sends[sendsBefore]
  assert.ok(
    resumingMessage?.message.text.includes("Resuming"),
    "should tell the sender it is resuming, proving auto-resume fired instead of a dead-session error",
  )
})

test("resume <code> on an active room whose session died out of band revives it, instead of replying 'already active' (Finding 2b)", async () => {
  const { service, store, transport, daemon } = await buildHarness()

  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  const code = created.room.code
  const sessionId = created.room.sessionId
  assert.ok(sessionId !== undefined)
  if (sessionId === undefined) return

  const outOfBandClient = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  await outOfBandClient.kill(sessionId)
  assert.equal(store.get(code)?.state, "active")

  const spawnCallsBefore = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent").length
  const sendsBefore = transport.sends.length

  const outcome = await service.handleInbound(alice(`resume ${code}`))
  assert.equal(outcome.kind, "resumed")

  const spawnCallsAfter = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent").length
  assert.ok(spawnCallsAfter > spawnCallsBefore, "resume must boot a fresh session instead of treating the dead one as active")

  const reply = transport.sends[sendsBefore]
  assert.ok(!(reply?.message.text.toLowerCase().includes("already active")), "must not claim the room is already active")

  const resumedRoom = store.get(code)
  assert.equal(resumedRoom?.state, "active")
  assert.ok(resumedRoom?.sessionId !== undefined)
})

test("a plain message from a known member fans in with queue:true and the [Name · channel] prefix", async () => {
  const { service, daemon } = await buildHarness()

  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return

  const outcome = await service.handleInbound(alice("what is the plan?"))
  assert.equal(outcome.kind, "message")

  const promptRequests = daemon.requestsReceived.filter((r) => r.path === `/sessions/${created.room.sessionId}/prompt`)
  assert.equal(promptRequests.length, 1)
  const body = promptRequests[0]?.body
  assert.ok(isRecord(body))
  if (!isRecord(body)) return
  assert.equal(body.queue, true)
  assert.equal(body.prompt, "[Alice · whatsapp] what is the plan?")

  await service.stop()
})

test("start() after reopening the store resumes fan-out from the persisted cursor, with no re-delivery", async () => {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })

  const store1 = await RoomStore.open(dir)
  const transport1 = new MemoryTransport()
  const service1 = new RoomService({
    store: store1,
    client,
    booter,
    transport: transport1,
    daemon: { baseUrl: daemon.url, token: undefined },
    mediaStore: await freshMediaStore(),
  })
  services.push(service1)

  const created = await service1.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  const sessionId = created.room.sessionId
  assert.ok(sessionId !== undefined)
  if (sessionId === undefined) return

  // LocalBooter rooms boot `protocol: "tools"`, so a turn's BARE text no
  // longer reaches any transport (PLAN §3.4) — the reader's consumption of
  // the turn is observable through the cursor, and the tools' own sends are
  // covered in test/fanout/reader-tools.test.ts and delivery.test.ts.
  const transport1CountBeforeFirstTurn = transport1.sends.length
  daemon.pushRecord(sessionId, { seq: 1, kind: "text-delta", text: "hello " })
  daemon.pushRecord(sessionId, { seq: 2, kind: "text-delta", text: "world" })
  daemon.pushRecord(sessionId, { seq: 3, kind: "turn-end", reason: "completed" })
  await waitFor(() => (store1.get(created.room.code)?.cursor ?? 0) === 3)
  assert.equal(
    transport1.sends.length,
    transport1CountBeforeFirstTurn,
    "a tools room's bare turn text reaches no transport",
  )
  await service1.stop()

  const store2 = await RoomStore.open(dir)
  const transport2 = new MemoryTransport()
  const service2 = new RoomService({
    store: store2,
    client,
    booter,
    transport: transport2,
    daemon: { baseUrl: daemon.url, token: undefined },
    mediaStore: await freshMediaStore(),
  })
  services.push(service2)
  service2.start()

  daemon.pushRecord(sessionId, { seq: 4, kind: "text-delta", text: "second turn" })
  daemon.pushRecord(sessionId, { seq: 5, kind: "turn-end", reason: "completed" })

  await waitFor(() => (store2.get(created.room.code)?.cursor ?? 0) === 5)
  assert.equal(transport2.sends.length, 0, "the reopened service re-delivers nothing from before the cursor")
  assert.equal(
    transport1.sends.length,
    transport1CountBeforeFirstTurn,
    "the original transport must never see the second turn",
  )

  await service2.stop()
})

// ---------------------------------------------------------------------------
// Box liveness (docs/UPSTREAM.md #10, architecture.md §9.3b): session
// liveness and box liveness are independent facts. A session can read
// "running" while its own e2b box has already vanished, so the idle sweep
// probes each active room's box directly, and a box confirmed gone must
// self-heal on the next message rather than silently keep advertising a dead
// artifact. `checkBoxLiveness` is injected so these tests never reach the
// real e2b API.
// ---------------------------------------------------------------------------

test("sweepIdleRooms marks a room whose box is confirmed gone as paused with artifactReady:false, hides the artifact link meanwhile, and the next message revives it on a fresh box", async () => {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const store = await RoomStore.open(dir)
  const transport = new MemoryTransport()
  const booter: SessionBooter = {
    async boot() {
      return { sessionId: "sess-old", sandboxId: "box-1", artifactUrl: "https://box-1.example", artifactReady: true }
    },
    async resume() {
      return { sessionId: "sess-new", sandboxId: "box-2", artifactUrl: "https://box-2.example", artifactReady: true }
    },
  }
  const service = new RoomService({
    store,
    client,
    booter,
    transport,
    daemon: { baseUrl: daemon.url, token: undefined },
    mediaStore: await freshMediaStore(),
    checkBoxLiveness: async (sandboxId) => (sandboxId === "box-1" ? "gone" : "alive"),
  })
  services.push(service)

  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  const code = created.room.code
  assert.equal(store.get(code)?.sandboxId, "box-1")

  await service.sweepIdleRooms()

  const paused = store.get(code)
  assert.equal(paused?.state, "paused", "a confirmed-gone box must pause the room")
  assert.equal(paused?.artifactReady, false)
  assert.equal(paused?.sessionId, undefined)

  const sendsBefore = transport.sends.length
  const outcome = await service.handleInbound(alice("are you still there?"))
  assert.equal(outcome.kind, "message")

  const resumingMessage = transport.sends[sendsBefore]
  assert.ok(resumingMessage?.message.text.includes("Resuming"), "should self-heal on the very next message")
  assert.equal(
    resumingMessage?.message.artifactUrl,
    undefined,
    "must not claim the artifact is live while artifactReady is false",
  )

  const revived = store.get(code)
  assert.equal(revived?.state, "active")
  assert.equal(revived?.sandboxId, "box-2", "should have booted a fresh box, not the gone one")
  assert.equal(revived?.artifactReady, true)
})

test("sweepIdleRooms does not treat an unknown box-liveness probe as gone", async () => {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const store = await RoomStore.open(dir)
  const transport = new MemoryTransport()
  const booter: SessionBooter = {
    async boot() {
      return { sessionId: "sess-1", sandboxId: "box-1", artifactUrl: "https://box-1.example", artifactReady: true }
    },
    async resume() {
      throw new Error("not exercised")
    },
  }
  const service = new RoomService({
    store,
    client,
    booter,
    transport,
    daemon: { baseUrl: daemon.url, token: undefined },
    mediaStore: await freshMediaStore(),
    checkBoxLiveness: async () => "unknown",
  })
  services.push(service)

  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return

  await service.sweepIdleRooms()

  const room = store.get(created.room.code)
  assert.equal(room?.state, "active", "an unknown probe result must never be treated as gone")
  assert.equal(room?.artifactReady, true)
  assert.equal(room?.sandboxId, "box-1")
})

test("sweepIdleRooms probes a room's box at most once per boxProbeMinutes, not on every sweep tick", async () => {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const store = await RoomStore.open(dir)
  const transport = new MemoryTransport()
  const booter: SessionBooter = {
    async boot() {
      return { sessionId: "sess-1", sandboxId: "box-1", artifactUrl: "https://box-1.example", artifactReady: true }
    },
    async resume() {
      throw new Error("not exercised")
    },
  }
  let probeCalls = 0
  const service = new RoomService({
    store,
    client,
    booter,
    transport,
    daemon: { baseUrl: daemon.url, token: undefined },
    mediaStore: await freshMediaStore(),
    boxProbeMinutes: 10,
    checkBoxLiveness: async () => {
      probeCalls++
      return "alive"
    },
  })
  services.push(service)

  await service.handleInbound(alice("new"))
  await service.sweepIdleRooms()
  await service.sweepIdleRooms()
  await service.sweepIdleRooms()

  assert.equal(probeCalls, 1, "a second and third sweep within the same interval must not re-probe the box")
})

test("a box confirmed gone during resume gets the precise 'previous box expired' notice, not the generic box-replaced one", async () => {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const store = await RoomStore.open(dir)
  const transport = new MemoryTransport()
  const booter: SessionBooter = {
    async boot() {
      return { sessionId: "sess-old", sandboxId: "box-1", artifactUrl: "https://box-1.example", artifactReady: true }
    },
    async resume() {
      return { sessionId: "sess-new", sandboxId: "box-2", artifactUrl: "https://box-2.example", artifactReady: true, boxWasGone: true }
    },
  }
  const service = new RoomService({
    store,
    client,
    booter,
    transport,
    daemon: { baseUrl: daemon.url, token: undefined },
    mediaStore: await freshMediaStore(),
  })
  services.push(service)

  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  const code = created.room.code

  await service.pauseRoom(code)
  const sendsBefore = transport.sends.length

  const resumed = await service.handleInbound(alice(`resume ${code}`))
  assert.equal(resumed.kind, "resumed")

  const notice = transport.sends.slice(sendsBefore).find((send) => send.message.text.includes("previous box expired"))
  assert.ok(notice !== undefined, "should send the precise box-expired notice")
  assert.equal(notice?.message.text, `The previous box expired; artifact restored on a new box.\n[${created.room.slug}]`)

  const generic = transport.sends.slice(sendsBefore).find((send) => send.message.text.startsWith("Artifact restored on a new box, same link."))
  assert.equal(generic, undefined, "must not ALSO send the generic notice")
})

// ---------------------------------------------------------------------------
// Concurrent revive/resume (ground-truthed live, 2026-09-12): two fan-ins
// arriving for the same paused room can both independently decide "this
// needs resuming" and both call the booter, each booting a REAL session/box
// — the store keeps only the last write, orphaning the other's session and
// billed box. `doResume` must serialize per room code and re-check the store
// after acquiring that lock, so a second concurrent caller sees the first's
// already-completed resume instead of booting again.
// ---------------------------------------------------------------------------

test("two concurrent fan-ins to a room with a dead session trigger exactly one resume, one spawn, and one sandboxId in the store", async () => {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const store = await RoomStore.open(dir)
  const transport = new MemoryTransport()

  let resumeCalls = 0
  const booter: SessionBooter = {
    async boot() {
      const spawned = await client.spawnAgent({
        adapter: "claude-code",
        model: "claude-sonnet-5",
        cwd: process.cwd(),
        label: "rdv-test",
        prompt: "hi",
      })
      return { sessionId: spawned.id, sandboxId: "box-0", artifactUrl: undefined, artifactReady: undefined }
    },
    async resume(room) {
      resumeCalls++
      // A real resume boots a real, billed session/box — modeled here as its
      // own spawn call on the fake daemon, so a regression (the lock not
      // actually preventing a second resume) shows up as a second spawn
      // request, not just a second in-process counter increment.
      const spawned = await client.spawnAgent({
        adapter: "claude-code",
        model: "claude-sonnet-5",
        cwd: process.cwd(),
        label: `rdv-${room.code}`,
        prompt: "resumed",
      })
      return { sessionId: spawned.id, sandboxId: `box-resumed-${resumeCalls}`, artifactUrl: undefined, artifactReady: undefined }
    },
  }
  const service = new RoomService({
    store,
    client,
    booter,
    transport,
    daemon: { baseUrl: daemon.url, token: undefined },
    mediaStore: await freshMediaStore(),
  })
  services.push(service)

  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  const code = created.room.code
  const sessionId = created.room.sessionId
  assert.ok(sessionId !== undefined)
  if (sessionId === undefined) return

  const spawnCallsBeforeKill = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent").length

  // Out-of-band, exactly like Finding 2a: the store still says "active"
  // pointing at a session the daemon no longer runs.
  const outOfBandClient = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  await outOfBandClient.kill(sessionId)
  assert.equal(store.get(code)?.state, "active")

  // Two fan-ins for the SAME room, fired without awaiting either first —
  // both independently run `reviveIfSessionDied` (both see the session dead,
  // both mark the room paused) and both then call `doResume`.
  const [outcomeA, outcomeB] = await Promise.all([
    service.handleInbound(alice("ping one")),
    service.handleInbound(alice("ping two")),
  ])
  assert.equal(outcomeA.kind, "message")
  assert.equal(outcomeB.kind, "message")

  assert.equal(resumeCalls, 1, "only one of the two concurrent callers should actually reach the booter's resume")

  const spawnCallsAfter = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent").length
  assert.equal(spawnCallsAfter - spawnCallsBeforeKill, 1, "exactly one spawn on the fake daemon for the resume, not two")

  const finalRoom = store.get(code)
  assert.equal(finalRoom?.state, "active")
  assert.equal(finalRoom?.sandboxId, "box-resumed-1", "the store must hold the one resume's sandboxId, not a clobbered second one")
})

test("a fan-out turn attaching a file nothing serves fans a queue:true correction back into the session", async () => {
  // A probe that always fails: the file is genuinely not being served,
  // which is exactly the MilanoTripItinerary shape.
  const { service, transport, daemon } = await buildHarness({ probeUrl: () => Promise.resolve(false) })

  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  const sessionId = created.room.sessionId
  assert.ok(sessionId !== undefined)
  if (sessionId === undefined) return

  const promptsBefore = daemon.requestsReceived.filter((r) => r.path.endsWith("/prompt")).length
  daemon.pushRecord(sessionId, { seq: 1, kind: "text-delta", text: "Here you go.\n[[attach MilanoTripItinerary.txt]]" })
  daemon.pushRecord(sessionId, { seq: 2, kind: "turn-end", reason: "completed" })

  await waitFor(() => daemon.requestsReceived.filter((r) => r.path.endsWith("/prompt")).length > promptsBefore)

  const correctionRequests = daemon.requestsReceived.filter(
    (r) => r.path.endsWith("/prompt") && isRecord(r.body) && typeof r.body.prompt === "string" && r.body.prompt.includes("MilanoTripItinerary.txt"),
  )
  assert.equal(correctionRequests.length, 1, "exactly one correction for the one missing file")
  const body = correctionRequests[0]?.body
  assert.ok(isRecord(body))
  if (!isRecord(body)) return
  assert.equal(body.queue, true, "the correction must queue mid-turn, never be lost (STATE.md finding #1)")
  assert.equal(body.origin, "rdv:system")
  const correction = body.prompt
  assert.ok(typeof correction === "string")
  assert.ok(correction.includes("MilanoTripItinerary.txt"), "the agent is told which file failed")
  assert.ok(correction.includes(`${env.artifactAppDir}/.agentproto/ui`), "the agent is told the directory to write into")

  // And the member got the honest line, not a link. Waited for explicitly:
  // the correction prompt and the member notice leave on two independent
  // async paths, so the `waitFor` above says nothing about this one. Reading
  // `sends` straight after it asserts on an absence that may simply not have
  // arrived yet — a flake that reports "members are told the attachment
  // failed" as FALSE when the only true statement is "not yet".
  await waitFor(() => transport.sends.some((send) => send.message.text.includes("MilanoTripItinerary.txt")))
  const notice = transport.sends.find((send) => send.message.text.includes("MilanoTripItinerary.txt"))
  assert.ok(notice !== undefined, "members are told the attachment failed")
  assert.ok(!notice.message.text.includes("http"))

  await service.stop()
})

function web(text: string): { address: Address; displayName: string; tier: Tier; text: string } {
  return {
    address: { provider: "room-web", source: "room-web", contactRef: "ecran" },
    displayName: "Ecran",
    tier: "room-web",
    text,
  }
}

test("creating a room whose only member is room-web succeeds, and the join links + QR land in its outbox (brief 07)", async () => {
  const { service, store, transport } = await buildHarness()

  const outcome = await service.handleInbound(web("new"))
  assert.equal(outcome.kind, "created")
  if (outcome.kind !== "created") return

  const member = outcome.room.members[0]
  assert.ok(member !== undefined)
  assert.equal(member.address.provider, "room-web")

  // Not a single transport push: a pull member is never handed to a
  // transport (that was the unrouted-throw / console-fallback swallow).
  assert.equal(transport.sends.length, 0)
  assert.equal(transport.mediaSends.length, 0)

  const records = (store.get(outcome.room.code)?.deliveries ?? []).filter((d) => d.memberId === member.id)
  assert.ok(records.length >= 2, "the join-links reply and the QR both land as records")
  assert.ok(records.every((record) => record.kind === "system"), "room notices are kind system, never say")
  const linksRecord = records.find((record) => record.text.includes(`Room created: ${outcome.room.code}`))
  assert.ok(linksRecord !== undefined, "the join-links reply record exists")
  assert.ok(linksRecord.text.includes(`/r/${outcome.room.code}`), "the web join link is in the record text")
  const qrRecord = records.find((record) => record.text.includes(`Scan to join ${outcome.room.code}`))
  assert.ok(qrRecord !== undefined, "the QR caption record exists")
  assert.ok(qrRecord.text.includes("/r/" + outcome.room.code + "/media/"), "the QR record carries the published URL")
})

test("a resume notice lands in a room-web member's outbox (brief 07)", async () => {
  const { service, store } = await buildHarness()

  const created = await service.handleInbound(web("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  const member = created.room.members[0]
  assert.ok(member !== undefined)

  await service.pauseRoom(created.room.code)
  const resumed = await service.handleInbound(web(`resume ${created.room.code}`))
  assert.equal(resumed.kind, "resumed")

  const records = (store.get(created.room.code)?.deliveries ?? []).filter((record) => record.memberId === member.id)
  const resumeRecord = records.find((record) => record.text.startsWith("Resumed room") || record.text.includes("Resuming room"))
  assert.ok(resumeRecord !== undefined, "the resume notice lands in the member's outbox")
  assert.equal(resumeRecord.kind, "system")
})

test("a push member's path is byte-for-byte unchanged while a room-web member in the same room gets outbox records instead (brief 07)", async () => {
  const { service, store, transport } = await buildHarness()

  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  await service.handleInbound(web(`join ${created.room.code}`))

  // Alice (whatsapp, push) got exactly the same pushes the pre-helper path
  // made: the room-created reply, then the join welcome to Bob — none of
  // them for the web member.
  const aliceSends = transport.sends.filter((send) => send.member.displayName === "Alice")
  assert.equal(aliceSends.length, 1)
  assert.ok(aliceSends[0]?.message.text.includes(`Room created: ${created.room.code}`))
  assert.equal(transport.sends.filter((send) => send.member.displayName === "Ecran").length, 0)

  const webMember = store.get(created.room.code)?.members.find((candidate) => candidate.displayName === "Ecran")
  assert.ok(webMember !== undefined)
  // The web member's join reply never touched a transport — it is an outbox
  // record, kind "system".
  const webRecords = (store.get(created.room.code)?.deliveries ?? []).filter((record) => record.memberId === webMember.id)
  assert.ok(webRecords.length >= 1)
  assert.ok(webRecords.every((record) => record.kind === "system"))
  assert.ok(webRecords.some((record) => record.text.includes(`Joined room: ${created.room.slug}`)))
})

test("an unroutable member is answered as an undeliverable outcome, not an uncaught throw (brief D)", async () => {
  const { service } = await buildHarness()

  const outcome = await service.handleInbound({
    address: { provider: "smoke-signal", source: "agentpush", contactRef: "+15550000000" },
    displayName: "Ghost",
    tier: "messenger",
    text: "new",
  })
  assert.equal(outcome.kind, "undeliverable")
  if (outcome.kind !== "undeliverable") return
  assert.match(outcome.reason, /unrouted delivery/)
})

// --- BRIEF-13 step 2's bugfix: ensureRoomWebMember must be idempotent on an
// address that is ALREADY a room-web screen. ------------------------------

function roomWebMembersOf(store: RoomStore, code: string): readonly Member[] {
  return (store.get(code)?.members ?? []).filter((member) => member.address.provider === "room-web")
}

test("ensureRoomWebMember on an address that is already a room-web screen finds the SAME member every time — it must not mint a twin", async () => {
  const { service, store } = await buildHarness()
  const room = await store.create()
  const screenAddress: Address = { provider: "room-web", source: "room-web", contactRef: "camille" }
  await store.addMember(room.code, { displayName: "Camille", tier: "room-web", address: screenAddress })
  assert.equal(roomWebMembersOf(store, room.code).length, 1, "the fixture starts with exactly one screen")

  const first = await service.ensureRoomWebMember(room.code, screenAddress, "Camille")
  assert.equal(roomWebMembersOf(store, room.code).length, 1, "resolving the screen must not create a second member")
  assert.equal(first.address.contactRef, "camille", "an already-room-web address passes through unchanged, not double-namespaced")

  const second = await service.ensureRoomWebMember(room.code, screenAddress, "Camille")
  assert.equal(second.id, first.id, "a second resolution of the same screen must return the SAME member id")
  assert.equal(roomWebMembersOf(store, room.code).length, 1, "still exactly one screen after a second drain")
})

test("ensureRoomWebMember does not rename an existing room-web screen's displayName", async () => {
  const { service, store } = await buildHarness()
  const room = await store.create()
  const screenAddress: Address = { provider: "room-web", source: "room-web", contactRef: "camille" }
  await store.addMember(room.code, { displayName: "Camille (claimed)", tier: "room-web", address: screenAddress })

  // The real call path (mcp-personal.ts's callDrainTool) always passes the
  // membership's OWN current displayName, so this is what a real drain does
  // — never a caller-supplied name that could overwrite a claimed screen's.
  const member = await service.ensureRoomWebMember(room.code, screenAddress, "Camille (claimed)")
  assert.equal(member.displayName, "Camille (claimed)", "the claimed screen's displayName must survive a drain untouched")
})

test("a telegram principal's room-web screen still carries the namespaced contactRef — the fix must not weaken this for every other provider", async () => {
  const { service, store } = await buildHarness()
  const room = await store.create()
  const telegramAddress: Address = { provider: "telegram", source: "telegram", contactRef: "6371794295" }

  const screen = await service.ensureRoomWebMember(room.code, telegramAddress, "Telegram Screen")
  assert.equal(screen.address.provider, "room-web")
  assert.equal(screen.address.contactRef, "telegram:6371794295", "still namespaced by the principal's own provider")
})

test("a telegram principal whose contactRef equals a browser's OWN claimed room-web name still cannot collide with it", async () => {
  const { service, store } = await buildHarness()
  const room = await store.create()
  // A browser-claimed screen whose contactRef is exactly the raw string the
  // OLD (unfixed) derivation would have produced for the telegram principal
  // below — the exact collision this namespacing exists to prevent.
  await store.addMember(room.code, {
    displayName: "Human In The Browser",
    tier: "room-web",
    address: { provider: "room-web", source: "room-web", contactRef: "6371794295" },
  })

  const telegramAddress: Address = { provider: "telegram", source: "telegram", contactRef: "6371794295" }
  const screen = await service.ensureRoomWebMember(room.code, telegramAddress, "Telegram Screen")

  assert.equal(roomWebMembersOf(store, room.code).length, 2, "the telegram principal's screen must be a DIFFERENT member")
  assert.notEqual(screen.displayName, "Human In The Browser")
  assert.equal(screen.address.contactRef, "telegram:6371794295")
})

// ---------------------------------------------------------------------------
// BRIEF 36: assertion 4's trigger fact is a ONE-SHOT obligation, not a
// standing property of the room. The measured sequence on `RDV-W6H6`
// (rehearsal 02, finding 1): the member was answered — the resume banner's
// `say`, minted on the room's own path — and five seconds later the same
// room told him "Your message did not get a reply this turn.", because the
// trigger fact was set and never cleared, so a later flush that minted
// nothing was still judged against it. Delivery reading as absence.
//
// These run through the REAL wiring — `handleInbound` sets the fact, the
// fan-out's post-turn check consumes it — so the take-once discharge in
// `RoomService` is exactly what is under test.
// ---------------------------------------------------------------------------

const REPLY_WARNING = "Your message did not get a reply this turn."

function replyWarnings(transport: MemoryTransport): RecordedSend[] {
  return transport.sends.filter((send) => send.message.text.includes(REPLY_WARNING))
}

interface Brief36Room {
  service: RoomService
  store: RoomStore
  transport: MemoryTransport
  daemon: ExtendedFakeDaemon
  code: string
  aliceId: string
  sessionId: string
}

async function brief36Room(): Promise<Brief36Room> {
  const { service, store, transport, daemon } = await buildHarness()
  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") throw new Error("room creation failed")
  const aliceMember = created.room.members[0]
  assert.ok(aliceMember !== undefined)
  const sessionId = created.room.sessionId
  assert.ok(sessionId !== undefined)
  return { service, store, transport, daemon, code: created.room.code, aliceId: aliceMember.id, sessionId }
}

async function runDaemonTurn(daemon: ExtendedFakeDaemon, sessionId: string, store: RoomStore, code: string, seq: number, text: string): Promise<void> {
  daemon.pushRecord(sessionId, { seq, kind: "text-delta", text })
  daemon.pushRecord(sessionId, { seq: seq + 1, kind: "turn-end", reason: "completed" })
  const target = seq + 1
  await waitFor(() => (store.get(code)?.cursor ?? 0) === target)
}

test("BRIEF-36: the measured sequence — banner answers on one flush, a later empty flush must not fire turn-answered-nobody", async () => {
  const { service, store, transport, daemon, code, aliceId, sessionId } = await brief36Room()

  const inbound = await service.handleInbound(alice("On en etait ou ?"))
  assert.equal(inbound.kind, "message")

  // The resume banner, minted the way the room's own voice mints it: a
  // `say` and a `system` record, both addressed to the member who spoke.
  await service.deliveryEngine.accept(code, "say", "Room shale-lagoon-sage is back — I still have us at: le PDF envoyé.", [aliceId])
  await service.deliveryEngine.accept(code, "system", "Room resumed. https://rdv.clipgen.co/r/shale-lagoon-sage/artifact/", [aliceId])

  // First flush: the banner is in this turn's window, so the member WAS
  // answered — and the obligation is discharged here.
  await runDaemonTurn(daemon, sessionId, store, code, 1, "reprise de la salle")

  // Second flush mints nothing. The stale trigger must not fire here.
  await runDaemonTurn(daemon, sessionId, store, code, 3, "thinking, nothing minted")

  assert.equal(replyWarnings(transport).length, 0, "a member who was answered by the banner must not be told nobody replied")
})

test("BRIEF-36: a genuine silent turn — an inbound the agent never answers — still reports exactly once, to that member alone", async () => {
  const { service, store, transport, daemon, code, aliceId, sessionId } = await brief36Room()

  const inbound = await service.handleInbound(alice("hello?"))
  assert.equal(inbound.kind, "message")

  // The turn mints nothing addressed to anyone — the assertion must not be
  // weakened into uselessness by the one-shot discharge.
  await runDaemonTurn(daemon, sessionId, store, code, 1, "prose only, no tool call")

  const warnings = replyWarnings(transport)
  assert.equal(warnings.length, 1, "a genuinely unanswered inbound must still produce the warning, exactly once")
  assert.equal(warnings[0]?.member.id, aliceId, "the warning goes to the member who was not answered, alone")
})

test("BRIEF-36: after M's turn is answered and discharged, a turn M did not start mints nothing for M and fires nothing", async () => {
  const { service, store, transport, daemon, code, aliceId, sessionId } = await brief36Room()

  const inbound = await service.handleInbound(alice("what did we decide?"))
  assert.equal(inbound.kind, "message")
  await service.deliveryEngine.accept(code, "say", "We decided on the 1200€ plan.", [aliceId])
  await runDaemonTurn(daemon, sessionId, store, code, 1, "answering alice")

  // A turn alice did not start — an idle sweep, a resume, anything — with
  // no new inbound and nothing minted for her. Without the discharge this
  // flush is still judged against her stale trigger.
  await runDaemonTurn(daemon, sessionId, store, code, 3, "thinking, nothing minted")

  assert.equal(replyWarnings(transport).length, 0, "a member must never be judged on a turn they did not start")
})

test("BRIEF-36: two inbounds in a row from the same member — the first answered, the second not — and the second still fires", async () => {
  const { service, store, transport, daemon, code, aliceId, sessionId } = await brief36Room()

  const first = await service.handleInbound(alice("first question"))
  assert.equal(first.kind, "message")
  await service.deliveryEngine.accept(code, "say", "Here is the answer.", [aliceId])
  await runDaemonTurn(daemon, sessionId, store, code, 1, "answering the first question")

  // The obligation is per-inbound: a second unanswered inbound re-arms it.
  const second = await service.handleInbound(alice("second question"))
  assert.equal(second.kind, "message")
  await runDaemonTurn(daemon, sessionId, store, code, 3, "thinking, nothing minted for the second")

  const warnings = replyWarnings(transport)
  assert.equal(warnings.length, 1, "the second inbound was genuinely unanswered — exactly one warning")
  assert.equal(warnings[0]?.member.id, aliceId)
})

test("BRIEF-36: an answer minted before the fan-out's baseline is seeded (the resume shape) still discharges the obligation — the window alone cannot see it", async () => {
  const { service, store, transport, daemon, code, aliceId, sessionId } = await brief36Room()

  // `new` already started the fan-out, seeding the assertion-4 baseline at
  // the delivery counter as of now. Stop the reader to reproduce the resume
  // shape: the room's own answer is minted while NO reader exists...
  await service.stop()
  const inbound = await service.handleInbound(alice("On en etait ou ?"))
  assert.equal(inbound.kind, "message")
  await service.deliveryEngine.accept(code, "say", "Room shale-lagoon-sage is back — I still have us at: le PDF envoyé.", [aliceId])
  await service.deliveryEngine.accept(code, "system", "Room resumed. https://rdv.clipgen.co/r/shale-lagoon-sage/artifact/", [aliceId])

  // ...and the reader starts AFTER the mint: the baseline is seeded past
  // the banner, so no window can ever contain it. Discharge must therefore
  // happen at mint time, not at window time.
  service.start()
  await runDaemonTurn(daemon, sessionId, store, code, 1, "reprise de la salle")

  assert.equal(replyWarnings(transport).length, 0, "the mint itself answered the member — the window is not the only witness")
})

test("BRIEF-36 presence: an inbound from a pull member stamps their liveness — they are neither stale nor away in the roster, even never-acked with an ancient joinedAt", async () => {
  const { service, store } = await buildHarness()
  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  const code = created.room.code
  const joined = await service.handleInbound(web(`join ${created.room.code}`))
  assert.equal(joined.kind, "joined")

  // Receiving a message is proof of presence: the sender cannot read as
  // away in the same instant. The stamp is the fact; the roster reads it.
  const inbound = await service.handleInbound(web("On en etait ou ?"))
  assert.equal(inbound.kind, "message")

  const room = store.get(code)
  assert.ok(room !== undefined)
  const webMember = room.members.find((candidate) => candidate.address.provider === "room-web")
  assert.ok(webMember !== undefined)
  assert.ok(webMember.lastSpokeAt !== undefined, "the inbound stamped the sender's lastSpokeAt")
  assert.equal(pullMemberStale(webMember, Date.now()), false, "the member who just spoke is not stale")
  const roster = listAudience(room, Date.now())
  const rosterEntry = roster.members.find((candidate) => candidate.memberId === webMember.id)
  assert.equal(rosterEntry?.presence, "present", "the roster must agree with the delivery path")
})
