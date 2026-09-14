import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { env } from "../../src/env.ts"
import { DaemonClient } from "../../src/daemon/client.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Address, Delivery, Tier } from "../../src/rooms/types.ts"
import { deliveryModeOf } from "../../src/rooms/types.ts"
import { LocalBooter } from "../../src/service/booter.ts"
import { MediaStore } from "../../src/service/media-store.ts"
import { RoomService } from "../../src/service/room-service.ts"
import { MemoryTransport } from "../../src/service/transports.ts"
import { outboxFor } from "../../src/service/outbox.ts"
import type { McpResponse } from "../../src/service/mcp-canvakit.ts"
import { createMcpRoomHandler, roomAudienceToken, type McpRoomDeps } from "../../src/service/mcp-room.ts"
import { createMcpPersonalHandler, principalToken, type McpPersonalDeps } from "../../src/service/mcp-personal.ts"
import { startExtendedFakeDaemon, type ExtendedFakeDaemon } from "./fake-daemon-extra.ts"

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "rdv-mcp-personal-"))
}

const dirs: string[] = []
const daemons: ExtendedFakeDaemon[] = []
const services: RoomService[] = []
after(async () => {
  // Same teardown rule as room-service.test.ts: a fan-out reader retries
  // forever on a dead connection, so every service built here must be
  // stopped before its daemon closes or the process never exits.
  await Promise.all(services.map((service) => service.stop()))
  await Promise.all(daemons.map((daemon) => daemon.close()))
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

function trackDir(dir: string): string {
  dirs.push(dir)
  return dir
}

function deps(store: RoomStore): McpPersonalDeps {
  return {
    rooms: () => store.list(),
    findByAddress: (address) => store.findByAddress(address),
  }
}

function bearerFor(address: Address): string {
  return `Bearer ${principalToken(address, env.roomTokenSecret)}`
}

/** BRIEF-19, AMENDMENT 2: the send-capable derivation. A DIFFERENT HMAC
 *  label, so this is a different 40-hex string, not a decorated one. */
function sendBearerFor(address: Address): string {
  return `Bearer ${principalToken(address, env.roomTokenSecret, "send")}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

interface SendHarness {
  readonly service: RoomService
  readonly store: RoomStore
  readonly daemon: ExtendedFakeDaemon
  readonly handler: ReturnType<typeof createMcpPersonalHandler>
}

/** A real `RoomService` over a fake daemon, with the personal MCP handler
 *  wired to `handleInbound` exactly as `http.ts` wires it — so a
 *  `rendezvous_send` in these tests travels the production inbound path,
 *  not a stand-in for it. */
async function buildSendHarness(): Promise<SendHarness> {
  const dir = trackDir(await freshDir())
  const daemon = await startExtendedFakeDaemon()
  daemons.push(daemon)
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  // RoomService falls back to env.mediaDir (the LIVE store) when no
  // mediaStore is given, and a "new" command mints a join QR unconditionally.
  const service = new RoomService({
    store,
    client,
    booter: new LocalBooter(client, { baseUrl: daemon.url, token: undefined }),
    transport: new MemoryTransport(),
    daemon: { baseUrl: daemon.url, token: undefined },
    mediaStore: new MediaStore(trackDir(await freshDir())),
  })
  services.push(service)
  const handler = createMcpPersonalHandler({
    rooms: () => store.list(),
    findByAddress: (address) => store.findByAddress(address),
    sendInbound: (input) => service.handleInbound(input),
    // BRIEF-12: the listening half, wired exactly as http.ts wires it — the
    // one `outboxFor`, the one `ackCursor`, and the service's stable
    // room-web membership.
    roomRead: {
      drain: (roomCode, memberId, since, sinceGiven) => {
        const room = store.get(roomCode)
        if (room === undefined) throw new Error(`unknown room: ${roomCode}`)
        const member = room.members.find((candidate) => candidate.id === memberId)
        if (member === undefined) throw new Error(`unknown member in room ${roomCode}`)
        return outboxFor(room, member, since, sinceGiven)
      },
      ackCursor: (roomCode, memberId, seq) => service.deliveryEngine.ackCursor(roomCode, memberId, seq),
      ensureRoomWebMember: (roomCode, address, displayName) => service.ensureRoomWebMember(roomCode, address, displayName),
    },
  })
  return { service, store, daemon, handler }
}

const ALICE: Address = { provider: "whatsapp", source: "agentpush", contactRef: "+15550001111" }

function inboundFromAlice(text: string): { address: Address; displayName: string; tier: Tier; text: string } {
  return { address: ALICE, displayName: "Alice", tier: "messenger", text }
}

function callSend(
  handler: ReturnType<typeof createMcpPersonalHandler>,
  authorization: string | undefined,
  args: { roomSlug: string; text: string },
): Promise<McpResponse> {
  return handler(
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "rendezvous_send", arguments: args } },
    authorization,
  )
}

/** The bytes `resources/read` actually served, with no `as` anywhere: every
 *  step is an assertion that narrows. A server that answered an error rather
 *  than HTML fails here, loudly, instead of silently asserting on "". */
function servedResourceText(res: McpResponse): string {
  const rpc = asRpc(res)
  assert.equal(rpc.status, 200, "resources/read must succeed for a valid principal bearer")
  const contents = rpc.result?.contents
  assert.ok(Array.isArray(contents) && contents.length > 0, "resources/read must return contents")
  const first = contents[0]
  assert.ok(isRecord(first), "the first content entry must be an object")
  const text = first.text
  assert.ok(typeof text === "string", "the first content entry must carry its HTML as text")
  return text
}

/** Reads `contents[0]._meta.ui.csp.<field>` as a list of strings, guard by
 *  guard. Returns `[]` when any link in the chain is missing, so a test that
 *  wants a domain present fails on absence rather than throwing. */
function cspDomains(res: McpResponse, field: string): readonly string[] {
  const rpc = asRpc(res)
  const contents = rpc.result?.contents
  if (!Array.isArray(contents)) return []
  const first = contents[0]
  if (!isRecord(first) || !isRecord(first._meta)) return []
  const ui = first._meta.ui
  if (!isRecord(ui) || !isRecord(ui.csp)) return []
  const domains = ui.csp[field]
  if (!Array.isArray(domains)) return []
  return domains.filter((entry) => typeof entry === "string")
}

/** The single text block a `tools/call` result carries, narrowed without a
 *  cast — same shape `listResult` reads, reused by the send tests. */
function contentTextOf(rpc: { readonly result?: Record<string, unknown> }): string {
  const content = rpc.result?.content
  assert.ok(Array.isArray(content) && content.length > 0, "a tool result must carry one content block")
  const first = content[0]
  assert.ok(isRecord(first), "the content block must be an object")
  const text = first.text
  assert.ok(typeof text === "string", "the content block must carry text")
  return text
}

const ROSTER_RESOURCE_URI = "ui://rendezvous/roster"

function readRoster(
  handler: ReturnType<typeof createMcpPersonalHandler>,
  authorization: string | undefined,
): Promise<McpResponse> {
  return handler(
    { jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: ROSTER_RESOURCE_URI } },
    authorization,
  )
}

function delivery(id: string, memberId: string, text: string, status: Delivery["status"] = "pending"): Delivery {
  return {
    id,
    memberId,
    kind: "say",
    text,
    status,
    failures: 0,
    lastError: undefined,
    createdAt: "2026-09-13T10:00:00.000Z",
    deliveredAt: undefined,
  }
}

/** Flattens a handler response the same way mcp-room.test.ts does, so union
 *  narrowing does not fight `assert` across the whole file. */
function asRpc(res: McpResponse): { readonly status: number; readonly result?: Record<string, unknown>; readonly error?: { readonly code: number; readonly message: string } } {
  if (res.status === 202) return { status: 202 }
  if ("result" in res.body) return { status: res.status, result: res.body.result }
  return { status: res.status, error: res.body.error }
}

/** `membershipRefusal`/`codeShapedRefusal` carry the calling tool's OWN name
 *  as a `"<toolName>: <body>"` prefix — the REASON (the body) is one shared
 *  wording across every `roomSlug`-taking tool, but the prefix must name the
 *  tool the caller actually called. Split on the first `": "` so a test can
 *  assert both facts separately, rather than either a same-string equality
 *  (which the prefix now breaks) or a substring match (which could pass on
 *  one shared word instead of the whole reason). */
function refusalPrefixAndBody(message: string | undefined): { readonly prefix: string; readonly body: string } {
  const text = message ?? ""
  const separatorIndex = text.indexOf(": ")
  if (separatorIndex === -1) return { prefix: "", body: text }
  return { prefix: text.slice(0, separatorIndex), body: text.slice(separatorIndex + 2) }
}

interface ListPayload {
  principal: { provider: string; contactRef: string; displayName: string }
  rooms: {
    slug: string
    memberId: string
    displayName: string
    tier: string
    presence: string
    presenceBasis: string
    memberCount: number
    unread: number
    active: boolean
    lastActivityAt: string
  }[]
  ambiguous: boolean
}

/** The room codes `rendezvous_list` now carries out-of-band: they are the
 *  join capability, so they travel in the result's host-only `_meta`
 *  (BRIEF-24), never in the text payload a model reads. Read guard by guard,
 *  no cast, so a missing `_meta` fails an assertion rather than throwing. */
function metaRoomCodes(res: McpResponse): readonly { slug: string; code: string }[] {
  const rpc = asRpc(res)
  const result = rpc.result
  if (result === undefined) return []
  const meta = result._meta
  if (!isRecord(meta)) return []
  const rooms = meta.rooms
  if (!Array.isArray(rooms)) return []
  const out: { slug: string; code: string }[] = []
  for (const room of rooms) {
    if (!isRecord(room)) continue
    if (typeof room.slug !== "string" || typeof room.code !== "string") continue
    out.push({ slug: room.slug, code: room.code })
  }
  return out
}

function listResult(res: McpResponse): ListPayload {
  const rpc = asRpc(res)
  const content = rpc.result?.content
  assert.ok(Array.isArray(content) && content.length === 1)
  return JSON.parse(String((content[0] as { text: string }).text)) as ListPayload
}

function callList(handler: ReturnType<typeof createMcpPersonalHandler>, authorization: string | undefined): Promise<McpResponse> {
  return handler(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rendezvous_list", arguments: {} } },
    authorization,
  )
}

test("an address that is a member of two rooms gets both back from rendezvous_list, with ambiguous: true", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const address: Address = { provider: "telegram", source: "telegram", contactRef: "+15550001111" }

  const roomA = await store.create()
  await store.addMember(roomA.code, { displayName: "Alice", tier: "messenger", address })
  const roomB = await store.create()
  await store.addMember(roomB.code, { displayName: "Alice", tier: "messenger", address })

  const handler = createMcpPersonalHandler(deps(store))
  const payload = listResult(await callList(handler, bearerFor(address)))

  assert.equal(payload.ambiguous, true)
  const slugs = payload.rooms.map((r) => r.slug).sort()
  assert.deepEqual(slugs, [roomA.slug, roomB.slug].sort())
  assert.ok(payload.rooms.every((r) => r.active === false), "a broken invariant crowns no room active")
})

test("a bearer matching no address gets the byte-identical 401 a malformed bearer gets", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  await store.addMember(room.code, {
    displayName: "Alice",
    tier: "messenger",
    address: { provider: "telegram", source: "telegram", contactRef: "+1" },
  })
  const handler = createMcpPersonalHandler(deps(store))

  const unknownAddressToken = principalToken({ provider: "telegram", source: "telegram", contactRef: "+2-nobody" }, env.roomTokenSecret)
  const unknown = await callList(handler, `Bearer ${unknownAddressToken}`)
  const malformed = await callList(handler, "Bearer not-a-real-token-at-all")

  assert.equal(unknown.status, 401)
  assert.equal(malformed.status, 401)
  assert.deepEqual(unknown, malformed, "an oracle would let a caller tell these apart")
})

test("unread counts only records above the member's ackedSeq, and reports 0 once everything is acked", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  const address: Address = { provider: "telegram", source: "telegram", contactRef: "+1" }
  await store.addMember(room.code, { displayName: "Alice", tier: "messenger", address })
  const memberId = store.get(room.code)?.members[0]?.id
  assert.ok(memberId !== undefined)

  await store.update(room.code, {
    deliveries: [delivery("d1", memberId, "one"), delivery("d2", memberId, "two"), delivery("d3", "someone-else", "not mine")],
  })

  const handler = createMcpPersonalHandler(deps(store))
  const before = listResult(await callList(handler, bearerFor(address)))
  assert.equal(before.rooms[0]?.unread, 2, "only the two records owned by this member count")

  await store.ackCursor(room.code, memberId, 2, "2026-09-13T10:05:00.000Z")
  const after1 = listResult(await callList(handler, bearerFor(address)))
  assert.equal(after1.rooms[0]?.unread, 0, "everything acked reports zero, not a leftover count")
})

test("presenceBasis is never-acked with no ackedAt, and acked once one exists", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)

  const neverRoom = await store.create()
  const neverAddress: Address = { provider: "telegram", source: "telegram", contactRef: "+1-never" }
  await store.addMember(neverRoom.code, { displayName: "Never", tier: "messenger", address: neverAddress })

  const ackedRoom = await store.create()
  const ackedAddress: Address = { provider: "telegram", source: "telegram", contactRef: "+1-acked" }
  await store.addMember(ackedRoom.code, { displayName: "Acked", tier: "messenger", address: ackedAddress })
  const ackedMemberId = store.get(ackedRoom.code)?.members[0]?.id
  assert.ok(ackedMemberId !== undefined)
  await store.ackCursor(ackedRoom.code, ackedMemberId, 0, "2026-09-13T10:05:00.000Z")

  const handler = createMcpPersonalHandler(deps(store))
  const never = listResult(await callList(handler, bearerFor(neverAddress)))
  assert.equal(never.rooms[0]?.presenceBasis, "never-acked")

  const acked = listResult(await callList(handler, bearerFor(ackedAddress)))
  assert.equal(acked.rooms[0]?.presenceBasis, "acked")
})

test("a principal token does not authenticate /mcp/room, and a room token does not authenticate /mcp", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const address: Address = { provider: "telegram", source: "telegram", contactRef: "+1" }
  const room = await store.create()
  await store.addMember(room.code, { displayName: "Alice", tier: "messenger", address })

  const roomDeps: McpRoomDeps = { rooms: () => store.list() }
  const roomHandler = createMcpRoomHandler(roomDeps)
  const personalHandler = createMcpPersonalHandler(deps(store))

  const personalBearer = bearerFor(address)
  const roomBearer = `Bearer ${roomAudienceToken(room.code, env.roomTokenSecret)}`

  const rosterCall = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "roster", arguments: {} } }
  const rejectedByRoom = await roomHandler(rosterCall, personalBearer)
  assert.equal(rejectedByRoom.status, 401, "the principal token must not open the room-scoped mount")

  const rejectedByPersonal = await callList(personalHandler, roomBearer)
  assert.equal(rejectedByPersonal.status, 401, "the room token must not open the person-scoped mount")
})

test("rendezvous_list's payload carries no message text anywhere in its serialized result", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const address: Address = { provider: "telegram", source: "telegram", contactRef: "+1" }
  const room = await store.create()
  await store.addMember(room.code, { displayName: "Alice", tier: "messenger", address })
  const memberId = store.get(room.code)?.members[0]?.id
  assert.ok(memberId !== undefined)
  const secret = "the picnic moves to the north field at noon"
  await store.update(room.code, { deliveries: [delivery("d1", memberId, secret)] })

  const handler = createMcpPersonalHandler(deps(store))
  const res = await callList(handler, bearerFor(address))
  const serialized = JSON.stringify(res)
  assert.ok(!serialized.includes(secret))
  assert.ok(!serialized.includes("picnic"))
  assert.ok(!serialized.includes("noon"))
})

// --- BRIEF-24: the code stops being narrated; the slug addresses the room. ----

test("rendezvous_list's model-visible text names each room by SLUG and never by its join CODE", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const address: Address = { provider: "telegram", source: "telegram", contactRef: "+1" }
  const room = await store.create()
  await store.addMember(room.code, { displayName: "Alice", tier: "messenger", address })

  const handler = createMcpPersonalHandler(deps(store))
  const res = await callList(handler, bearerFor(address))
  const text = contentTextOf(asRpc(res))

  // BOTH arms, deliberately: an absence-only assertion passes against an
  // empty payload, and a presence-only one passes on the un-fixed server.
  assert.ok(text.includes(room.slug), `the text payload must carry the slug, got: ${text}`)
  assert.ok(!text.includes(room.code), `the text payload must not carry the join code, got: ${text}`)
})

test("rendezvous_list carries the join code in the result's host-only _meta, so the panel can still fetch /r/:code/state", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const address: Address = { provider: "telegram", source: "telegram", contactRef: "+1" }
  const room = await store.create()
  await store.addMember(room.code, { displayName: "Alice", tier: "messenger", address })

  const handler = createMcpPersonalHandler(deps(store))
  const res = await callList(handler, bearerFor(address))

  assert.deepEqual(
    metaRoomCodes(res),
    [{ slug: room.slug, code: room.code }],
    "the panel's fetch target must survive the move out of the model-visible text",
  )
})

// --- BRIEF-19: the roster panel, and the one write this surface gains. ----

test("resources/read serves the roster panel with the resolved principal baked in, and no token anywhere in the bytes", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  await store.addMember(room.code, { displayName: "Alice", tier: "messenger", address: ALICE })

  const handler = createMcpPersonalHandler(deps(store))
  const html = servedResourceText(await readRoster(handler, bearerFor(ALICE)))

  // The principal, resolved from the BEARER — never a query parameter, never
  // a postMessage handshake, never an argument.
  assert.ok(html.includes(ALICE.contactRef), "the panel must be told which address it is looking at")
  assert.ok(html.includes("whatsapp"), "the provider is half of the principal's identity")
  assert.ok(html.includes("Alice"), "the display name the rooms know this address by")

  // And NOT the credential. Both derivations, because either one in these
  // bytes is a replayable capability sitting inside an iframe.
  const readToken = principalToken(ALICE, env.roomTokenSecret)
  const sendToken = principalToken(ALICE, env.roomTokenSecret, "send")
  assert.ok(!html.includes(readToken), "the read token must never be baked into the panel")
  assert.ok(!html.includes(sendToken), "the send token must never be baked into the panel")
  assert.ok(!/bearer/i.test(html), "no bearer header, in any form, belongs in these bytes")
  assert.ok(!/authorization/i.test(html), "the panel has no auth surface of its own")
})

test("the roster panel's resources/read carries _meta.ui.csp.frameDomains, and the panel emits ui/notifications/size-changed", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  await store.addMember(room.code, { displayName: "Alice", tier: "messenger", address: ALICE })

  const handler = createMcpPersonalHandler(deps(store))
  const res = await readRoster(handler, bearerFor(ALICE))

  // `frameDomains` defaults to `frame-src 'none'` when omitted, and a
  // spec-compliant host then blocks. Shipped broken once already.
  assert.ok(
    cspDomains(res, "frameDomains").includes(env.publicUrl),
    "_meta.ui.csp.frameDomains must name env.publicUrl",
  )
  // `connectDomains` is what lets the per-room roster fetch reach
  // `GET /r/:code/state` at all.
  assert.ok(
    cspDomains(res, "connectDomains").includes(env.publicUrl),
    "_meta.ui.csp.connectDomains must name env.publicUrl",
  )

  // Omitting the size report rendered the artifact panel as a ~20px strip.
  // Shipped broken once already too.
  const html = servedResourceText(res)
  assert.ok(html.includes("ui/notifications/size-changed"), "the panel must report its own height")
  assert.ok(html.includes("ResizeObserver"), "the height must be measured, not guessed once at load")
})

test("rendezvous_send into a room the principal is in produces the byte-identical record an inbound message from that address produces", async () => {
  const { service, daemon, handler } = await buildSendHarness()

  const created = await service.handleInbound(inboundFromAlice("new"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return
  const sessionId = created.room.sessionId
  assert.ok(sessionId !== undefined)

  const promptPath = `/sessions/${sessionId}/prompt`
  const TEXT = "what is the plan?"

  // 1. The real thing: Alice types it on her phone.
  const inbound = await service.handleInbound(inboundFromAlice(TEXT))
  assert.equal(inbound.kind, "message")
  const afterInbound = daemon.requestsReceived.filter((r) => r.path === promptPath)
  assert.equal(afterInbound.length, 1, "the inbound path must have fanned one prompt in")

  // 2. The panel: Alice types the same words into the roster, addressing the
  // room by its SLUG — the only identifier this tool takes (BRIEF-24).
  const res = asRpc(await callSend(handler, sendBearerFor(ALICE), { roomSlug: created.room.slug, text: TEXT }))
  assert.equal(res.error, undefined, `rendezvous_send must be accepted: ${res.error?.message ?? ""}`)

  const afterSend = daemon.requestsReceived.filter((r) => r.path === promptPath)
  assert.equal(afterSend.length, 2, "rendezvous_send must fan in through the same path, not a second one")

  // The whole point: not "a record exists" — the SAME record. Same
  // attribution prefix, same queue:true, same `rdv:<memberId>` origin.
  assert.deepEqual(
    afterSend[1]?.body,
    afterInbound[0]?.body,
    "a message sent from the panel must be indistinguishable from the same message typed on a phone",
  )
  const body = afterSend[1]?.body
  assert.ok(isRecord(body))
  if (!isRecord(body)) return
  assert.equal(body.prompt, "[Alice · whatsapp] what is the plan?", "attributed to Alice, in her own voice")
  assert.equal(body.queue, true)

  // And the result says nothing about the content (the file-top HARD RULE),
  // and names the room by SLUG, never by its join code (BRIEF-24).
  const payload: { roomSlug: string; memberId: string; outcome: string; accepted: boolean } = JSON.parse(contentTextOf(res))
  assert.equal(payload.roomSlug, created.room.slug, "the result must address the room by slug")
  assert.equal(payload.accepted, true)
  assert.ok(!JSON.stringify(res).includes(created.room.code), "the send result must never narrate the join code")
  assert.ok(!JSON.stringify(res).includes("what is the plan"), "the send result must never echo the text")
})

test("rendezvous_send into a room the principal is NOT in is refused, identically whether or not that room exists", async () => {
  const { service, store, handler } = await buildSendHarness()

  const created = await service.handleInbound(inboundFromAlice("new"))
  assert.equal(created.kind, "created")

  // A room that exists and that Alice has nothing to do with.
  const stranger = await store.create()
  await store.addMember(stranger.code, {
    displayName: "Bob",
    tier: "messenger",
    address: { provider: "telegram", source: "telegram", contactRef: "+15550002222" },
  })

  // A slug no room carries at all.
  const missingSlug = "nowhere-at-all-here"

  const existing = asRpc(await callSend(handler, sendBearerFor(ALICE), { roomSlug: stranger.slug, text: "hello?" }))
  const missing = asRpc(await callSend(handler, sendBearerFor(ALICE), { roomSlug: missingSlug, text: "hello?" }))
  const existingMessage = existing.error?.message ?? ""
  const missingMessage = missing.error?.message ?? ""

  assert.notEqual(existing.status, 401, "a good credential naming the wrong room is not an authentication failure")
  assert.ok(existing.error !== undefined, "never a silent no-op")
  assert.ok(/member/i.test(existingMessage), `the refusal must name membership, got: ${existingMessage}`)
  assert.ok(
    !/unauthori|authenticat|credential|token|forbidden|permission/i.test(existingMessage),
    `the refusal must not read as an auth error, got: ${existingMessage}`,
  )

  // The no-information property: the two arms differ ONLY in the identifier
  // the caller itself supplied, never in what they reveal about the room's
  // existence. Both must name the slug the caller passed (which is how we
  // know this is the membership refusal and not the generic argument error).
  assert.ok(existingMessage.includes(stranger.slug), `the refusal must name the slug it refused, got: ${existingMessage}`)
  assert.ok(missingMessage.includes(missingSlug), `the refusal must name the slug it refused, got: ${missingMessage}`)
  assert.equal(existing.status, missing.status, "existence must not change the status")
  assert.equal(existing.error?.code, missing.error?.code, "existence must not change the error code")
  assert.equal(
    existingMessage.split(stranger.slug).join("<slug>"),
    missingMessage.split(missingSlug).join("<slug>"),
    "a slug the principal is not in must answer identically whether or not the room exists",
  )
})

test("rendezvous_send refuses a room CODE with its own message: a slug is expected, and that is not the membership refusal", async () => {
  const { service, handler } = await buildSendHarness()

  const created = await service.handleInbound(inboundFromAlice("new"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return

  const res = asRpc(await callSend(handler, sendBearerFor(ALICE), { roomSlug: created.room.code, text: "hello" }))
  const message = res.error?.message ?? ""

  assert.notEqual(res.status, 401, "the token is good; the ARGUMENT is the wrong shape")
  assert.ok(res.error !== undefined, "never a silent no-op")
  // Assert the MESSAGE, not merely that it was refused: the membership
  // refusal also refuses, and the whole point is that these are different.
  assert.ok(/slug/i.test(message), `the refusal must say a slug is expected, got: ${message}`)
  assert.ok(/code/i.test(message), `the refusal must name the code shape it refused, got: ${message}`)
  assert.ok(
    !/not a member/i.test(message),
    `a code-shaped argument is not a membership question, got: ${message}`,
  )
})

test("a read-only principal token is refused by rendezvous_send, naming the reason", async () => {
  const { service, handler } = await buildSendHarness()

  const created = await service.handleInbound(inboundFromAlice("new"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return

  const res = asRpc(await callSend(handler, bearerFor(ALICE), { roomSlug: created.room.slug, text: "hello" }))
  const message = res.error?.message ?? ""

  assert.notEqual(res.status, 401, "the token is valid — it simply does not carry this capability")
  assert.ok(res.error !== undefined, "never a silent no-op")
  assert.ok(/read-only/i.test(message), `the refusal must name the reason, got: ${message}`)
  assert.ok(/can-send/i.test(message), `the refusal must name the remedy, got: ${message}`)
})

test("a read-only principal token still works on rendezvous_list, and the send-capable one is a genuinely different token that also lists", async () => {
  const { service, handler } = await buildSendHarness()

  const created = await service.handleInbound(inboundFromAlice("new"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return

  // AMENDMENT 2: the capability lives in the DERIVATION. Two labels, two
  // HMACs, two different strings — a read token cannot be edited into a
  // send token, because the secret is what produced it.
  const readToken = principalToken(ALICE, env.roomTokenSecret)
  const sendToken = principalToken(ALICE, env.roomTokenSecret, "send")
  assert.notEqual(readToken, sendToken, "read and send must be separate derivations, not one token plus a flag")

  const read = listResult(await callList(handler, bearerFor(ALICE)))
  assert.deepEqual(
    read.rooms.map((room) => room.slug),
    [created.room.slug],
    "BRIEF-18's read-only token must keep doing exactly what it was minted for",
  )

  // And send is a SUPERSET, not a separate account: the same rooms come back.
  const write = listResult(await callList(handler, sendBearerFor(ALICE)))
  assert.deepEqual(
    write.rooms.map((room) => room.slug),
    read.rooms.map((room) => room.slug),
    "a send-capable token must see exactly what a read-only one sees",
  )
})

// --- BRIEF-12: the panel stops being a directory and becomes a device. ---

function callDrain(
  handler: ReturnType<typeof createMcpPersonalHandler>,
  authorization: string | undefined,
  args: { roomSlug: string; since?: number },
): Promise<McpResponse> {
  return handler(
    { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "rendezvous_drain", arguments: args } },
    authorization,
  )
}

function callAck(
  handler: ReturnType<typeof createMcpPersonalHandler>,
  authorization: string | undefined,
  args: { roomSlug: string; seq: number },
): Promise<McpResponse> {
  return handler(
    { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "rendezvous_ack", arguments: args } },
    authorization,
  )
}

function callToolsList(
  handler: ReturnType<typeof createMcpPersonalHandler>,
  authorization: string | undefined,
): Promise<McpResponse> {
  return handler({ jsonrpc: "2.0", id: 13, method: "tools/list", params: {} }, authorization)
}

interface DrainPayload {
  memberId: string
  cursor: number
  pruned: boolean
  deliveries: { id: string; memberId: string; kind: string; text: string }[]
}

function drainPayload(res: McpResponse): DrainPayload {
  return JSON.parse(contentTextOf(asRpc(res))) as DrainPayload
}

function ackPayload(res: McpResponse): { applied: boolean; ackedSeq: number } {
  return JSON.parse(contentTextOf(asRpc(res))) as { applied: boolean; ackedSeq: number }
}

function toolNames(res: McpResponse): string[] {
  const rpc = asRpc(res)
  const tools = rpc.result?.tools
  if (!Array.isArray(tools)) return []
  const names: string[] = []
  for (const tool of tools) {
    if (isRecord(tool) && typeof tool.name === "string") names.push(tool.name)
  }
  return names
}

function roomWebMembers(store: RoomStore, code: string): readonly { id: string; displayName: string }[] {
  const room = store.get(code)
  if (room === undefined) return []
  return room.members.filter((member) => member.address.provider === "room-web")
}

test("rendezvous_drain/rendezvous_ack are advertised only when the mount can perform them", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  await store.addMember(room.code, { displayName: "Alice", tier: "messenger", address: ALICE })

  // The BRIEF-18 surface with no listener wired: neither drain/ack tool
  // exists, but rendezvous_invite (BRIEF-13 step 2) needs no listener — it
  // is advertised alongside rendezvous_list on read alone.
  const plain = createMcpPersonalHandler(deps(store))
  assert.deepEqual(toolNames(await callToolsList(plain, bearerFor(ALICE))), ["rendezvous_list", "rendezvous_invite"])

  const { handler } = await buildSendHarness()
  const names = toolNames(await callToolsList(handler, bearerFor(ALICE)))
  assert.ok(names.includes("rendezvous_drain") && names.includes("rendezvous_ack"), `got: ${names.join(", ")}`)
  assert.ok(names.includes("rendezvous_send"), "the send tool remains advertised alongside them")
})

test("a drain for a principal with no membership in that room refuses with the SAME reason rendezvous_send gives, prefixed with its OWN tool name", async () => {
  const { service, store, handler } = await buildSendHarness()
  const created = await service.handleInbound(inboundFromAlice("new"))
  assert.equal(created.kind, "created")

  const stranger = await store.create()
  await store.addMember(stranger.code, {
    displayName: "Bob",
    tier: "messenger",
    address: { provider: "telegram", source: "telegram", contactRef: "+15550002222" },
  })

  const drain = asRpc(await callDrain(handler, bearerFor(ALICE), { roomSlug: stranger.slug }))
  const send = asRpc(await callSend(handler, sendBearerFor(ALICE), { roomSlug: stranger.slug, text: "hello?" }))

  assert.notEqual(drain.status, 401, "a good credential naming the wrong room is not an authentication failure")
  assert.ok(drain.error !== undefined, "never a silent no-op")
  assert.ok(/member/i.test(drain.error?.message ?? ""), "the refusal must name membership")

  const drainParts = refusalPrefixAndBody(drain.error?.message)
  const sendParts = refusalPrefixAndBody(send.error?.message)
  assert.equal(drainParts.prefix, "rendezvous_drain", "the refusal must name the tool actually called, not rendezvous_send")
  assert.equal(sendParts.prefix, "rendezvous_send")
  assert.equal(
    drainParts.body,
    sendParts.body,
    "the REASON is one shared wording, even though the prefix now differs per tool",
  )
})

test("a drain never auto-acks, and the first drain creates exactly one STABLE, pull room-web member", async () => {
  const { service, store, handler } = await buildSendHarness()
  const created = await service.handleInbound(inboundFromAlice("new"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return
  const code = created.room.code

  // A directory read must never join anyone.
  await callList(handler, bearerFor(ALICE))
  assert.equal(roomWebMembers(store, code).length, 0, "rendezvous_list must create no membership")

  const first = drainPayload(await callDrain(handler, bearerFor(ALICE), { roomSlug: created.room.slug }))
  assert.equal(roomWebMembers(store, code).length, 1, "the first drain creates exactly one room-web member")
  const created2 = roomWebMembers(store, code)[0]
  assert.ok(created2 !== undefined)
  assert.equal(created2.displayName, "Alice", "the member wears the principal's display name")

  const member = store.get(code)?.members.find((candidate) => candidate.id === first.memberId)
  assert.ok(member !== undefined)
  assert.equal(deliveryModeOf(member), "pull", "a screen drains, it is not pushed to")
  assert.equal(member.ackedSeq, undefined, "a drain must never ack — only the renderer may")
  assert.equal(member.ackedAt, undefined, "and no liveness is manufactured by a read")

  // Stability: a second drain finds the same member, not a new one.
  const second = drainPayload(await callDrain(handler, bearerFor(ALICE), { roomSlug: created.room.slug }))
  assert.equal(roomWebMembers(store, code).length, 1, "a second drain must not mint a second member")
  assert.equal(second.memberId, first.memberId, "the member id is stable across drains")
})

test("a drain returns only that member's own deliveries and never another member's", async () => {
  const { service, store, handler } = await buildSendHarness()
  const created = await service.handleInbound(inboundFromAlice("new"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return
  const code = created.room.code

  const first = drainPayload(await callDrain(handler, bearerFor(ALICE), { roomSlug: created.room.slug }))
  const mine = first.memberId
  const bob = await store.addMember(code, {
    displayName: "Bob",
    tier: "messenger",
    address: { provider: "telegram", source: "telegram", contactRef: "+15550002222" },
  })
  await store.update(code, {
    deliveries: [delivery("d1", mine, "mine one"), delivery("d2", bob.id, "bob's"), delivery("d3", mine, "mine two")],
  })

  const payload = drainPayload(await callDrain(handler, bearerFor(ALICE), { roomSlug: created.room.slug, since: 0 }))
  assert.deepEqual(
    payload.deliveries.map((entry) => entry.text),
    ["mine one", "mine two"],
    "the transcript is this member's mail, never the room's",
  )
  assert.ok(payload.deliveries.every((entry) => entry.memberId === mine))
})

test("an ack on the read capability moves ackedSeq and refreshes ackedAt", async () => {
  const { service, store, handler } = await buildSendHarness()
  const created = await service.handleInbound(inboundFromAlice("new"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return
  const code = created.room.code

  const first = drainPayload(await callDrain(handler, bearerFor(ALICE), { roomSlug: created.room.slug }))
  const before = store.get(code)?.members.find((candidate) => candidate.id === first.memberId)
  assert.ok(before !== undefined)
  assert.equal(before.ackedSeq, undefined)

  // Read-only bearer: an ack is a liveness statement about the reader, not a
  // word spoken into the room, so it must NOT need `principal-rw`.
  const acked = ackPayload(await callAck(handler, bearerFor(ALICE), { roomSlug: created.room.slug, seq: 1 }))
  assert.equal(acked.applied, true)
  assert.equal(acked.ackedSeq, 1)

  const after = store.get(code)?.members.find((candidate) => candidate.id === first.memberId)
  assert.ok(after !== undefined)
  assert.equal(after.ackedSeq, 1)
  assert.ok(typeof after.ackedAt === "string" && after.ackedAt.length > 0, "the ack IS the liveness signal")

  // Monotonic, server-side: a backwards ack is ignored, not an error.
  const backwards = ackPayload(await callAck(handler, bearerFor(ALICE), { roomSlug: created.room.slug, seq: 0 }))
  assert.equal(backwards.applied, false)
  assert.equal(backwards.ackedSeq, 1, "the effective cursor does not rewind")
})

// --- BRIEF-13 step 2's bugfix, end to end: a principal whose OWN address is
// already a room-web screen must not duplicate itself on drain. -----------

test("a room-web principal draining a room where that exact address is already a member creates NO new member and returns the existing id, stably", async () => {
  const { store, handler } = await buildSendHarness()
  const room = await store.create()
  const claimedScreen: Address = { provider: "room-web", source: "room-web", contactRef: "camille" }
  await store.addMember(room.code, { displayName: "Camille", tier: "room-web", address: claimedScreen })

  const roomWebCount = (): number =>
    (store.get(room.code)?.members ?? []).filter((member) => member.address.provider === "room-web").length
  assert.equal(roomWebCount(), 1, "the fixture starts with exactly one screen")

  const first = drainPayload(await callDrain(handler, bearerFor(claimedScreen), { roomSlug: room.slug }))
  assert.equal(roomWebCount(), 1, "draining the screen's own address must not mint a twin")

  const second = drainPayload(await callDrain(handler, bearerFor(claimedScreen), { roomSlug: room.slug }))
  assert.equal(second.memberId, first.memberId, "the member id is stable across repeated drains")
  assert.equal(roomWebCount(), 1, "still exactly one screen after a second drain")

  const member = store.get(room.code)?.members.find((candidate) => candidate.id === first.memberId)
  assert.ok(member !== undefined)
  assert.equal(member.displayName, "Camille", "the drain must not rename the claimed screen")
})

// --- BRIEF-13 step 2: rendezvous_invite. -------------------------------

function callInvite(
  handler: ReturnType<typeof createMcpPersonalHandler>,
  authorization: string | undefined,
  args: { roomSlug: string },
): Promise<McpResponse> {
  return handler(
    { jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "rendezvous_invite", arguments: args } },
    authorization,
  )
}

/** `_meta.invite`, read guard by guard — no cast, so a missing or malformed
 *  `_meta` fails the assertion rather than throwing. */
function inviteMetaOf(res: McpResponse): Record<string, unknown> | undefined {
  const rpc = asRpc(res)
  const meta = rpc.result?._meta
  if (!isRecord(meta)) return undefined
  const invite = meta.invite
  return isRecord(invite) ? invite : undefined
}

test("rendezvous_invite is advertised with no other capability wired — it needs only read", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  await store.addMember((await store.create()).code, { displayName: "Alice", tier: "messenger", address: ALICE })
  const handler = createMcpPersonalHandler(deps(store))
  assert.ok(toolNames(await callToolsList(handler, bearerFor(ALICE))).includes("rendezvous_invite"))
})

test("rendezvous_invite's content text names only the room's slug — never the join code, never a link", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  await store.addMember(room.code, { displayName: "Alice", tier: "messenger", address: ALICE })
  const handler = createMcpPersonalHandler(deps(store))

  const res = await callInvite(handler, bearerFor(ALICE), { roomSlug: room.slug })
  const text = contentTextOf(asRpc(res))
  assert.ok(text.includes(room.slug), `content text may still name the room by its slug, got: ${text}`)
  assert.ok(!text.includes(room.code), `content text must never carry the join code, got: ${text}`)
  assert.ok(!text.toLowerCase().includes("http"), `content text must never carry a link, got: ${text}`)
})

test("rendezvous_invite's _meta.invite carries the join links, keyed by the room's own code", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  await store.addMember(room.code, { displayName: "Alice", tier: "messenger", address: ALICE })
  const handler = createMcpPersonalHandler(deps(store))

  const res = await callInvite(handler, bearerFor(ALICE), { roomSlug: room.slug })
  const invite = inviteMetaOf(res)
  assert.ok(invite !== undefined, "the invite links must ride in _meta.invite")
  assert.equal(invite?.slug, room.slug)
  assert.ok(
    typeof invite?.web === "string" && invite.web.includes(room.code),
    `web link must carry the join code, got: ${String(invite?.web)}`,
  )
})

test("an unconfigured invite channel is OMITTED from _meta.invite, never sent as an empty string", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const room = await store.create()
  await store.addMember(room.code, { displayName: "Alice", tier: "messenger", address: ALICE })
  const handler = createMcpPersonalHandler(deps(store))

  assert.equal(env.whatsappNumber, undefined, "this test assumes no whatsapp number is configured in this env")
  assert.equal(env.telegramBot, undefined, "this test assumes no telegram bot is configured in this env")
  assert.equal(env.smsNumber, undefined, "this test assumes no sms number is configured in this env")

  const res = await callInvite(handler, bearerFor(ALICE), { roomSlug: room.slug })
  const invite = inviteMetaOf(res)
  assert.ok(invite !== undefined)
  assert.ok(!("whatsapp" in (invite ?? {})), "an unconfigured whatsapp channel must be absent, not an empty string")
  assert.ok(!("telegram" in (invite ?? {})), "an unconfigured telegram channel must be absent, not an empty string")
  assert.ok(!("sms" in (invite ?? {})), "an unconfigured sms channel must be absent, not an empty string")
})

test("rendezvous_invite for a room the principal is not a member of gets the SAME reason rendezvous_send gives, prefixed with its OWN tool name", async () => {
  const { service, store, handler } = await buildSendHarness()
  const created = await service.handleInbound(inboundFromAlice("new"))
  assert.equal(created.kind, "created")

  const stranger = await store.create()
  await store.addMember(stranger.code, {
    displayName: "Bob",
    tier: "messenger",
    address: { provider: "telegram", source: "telegram", contactRef: "+15550002222" },
  })

  const invite = asRpc(await callInvite(handler, bearerFor(ALICE), { roomSlug: stranger.slug }))
  const send = asRpc(await callSend(handler, sendBearerFor(ALICE), { roomSlug: stranger.slug, text: "hello?" }))

  assert.notEqual(invite.status, 401, "a good credential naming the wrong room is not an authentication failure")
  assert.ok(invite.error !== undefined, "never a silent no-op")

  const inviteParts = refusalPrefixAndBody(invite.error?.message)
  const sendParts = refusalPrefixAndBody(send.error?.message)
  assert.equal(inviteParts.prefix, "rendezvous_invite", "the refusal must name the tool actually called, not rendezvous_send")
  assert.equal(sendParts.prefix, "rendezvous_send")
  assert.equal(
    inviteParts.body,
    sendParts.body,
    "the REASON is one shared wording, even though the prefix now differs per tool",
  )
})

// --- The code-shaped guard: rendezvous_invite is the one tool whose whole
// payload IS the join capability, so it must not rely on the accident that a
// code never matches a slug — and neither should drain/ack. --------------

test("rendezvous_invite refuses a room CODE with the SAME code-shaped reason rendezvous_send gives, correctly prefixed, never the membership one", async () => {
  const { service, handler } = await buildSendHarness()
  const created = await service.handleInbound(inboundFromAlice("new"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return

  const invite = asRpc(await callInvite(handler, bearerFor(ALICE), { roomSlug: created.room.code }))
  const send = asRpc(await callSend(handler, sendBearerFor(ALICE), { roomSlug: created.room.code, text: "hello" }))

  assert.notEqual(invite.status, 401, "the token is good; the ARGUMENT is the wrong shape")
  assert.ok(invite.error !== undefined, "never a silent no-op")

  const inviteParts = refusalPrefixAndBody(invite.error?.message)
  const sendParts = refusalPrefixAndBody(send.error?.message)
  assert.equal(inviteParts.prefix, "rendezvous_invite", "the refusal must name the tool actually called, not rendezvous_send")
  assert.equal(sendParts.prefix, "rendezvous_send")
  assert.equal(inviteParts.body, sendParts.body, "the REASON is one shared wording across tools")
  assert.ok(!/not a member/i.test(invite.error?.message ?? ""), "a code-shaped argument is not a membership question")
})

test("rendezvous_drain refuses a room CODE with the SAME code-shaped reason rendezvous_send gives, correctly prefixed, never the membership one", async () => {
  const { service, handler } = await buildSendHarness()
  const created = await service.handleInbound(inboundFromAlice("new"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return

  const drain = asRpc(await callDrain(handler, bearerFor(ALICE), { roomSlug: created.room.code }))
  const send = asRpc(await callSend(handler, sendBearerFor(ALICE), { roomSlug: created.room.code, text: "hello" }))

  assert.notEqual(drain.status, 401, "the token is good; the ARGUMENT is the wrong shape")
  assert.ok(drain.error !== undefined, "never a silent no-op")

  const drainParts = refusalPrefixAndBody(drain.error?.message)
  const sendParts = refusalPrefixAndBody(send.error?.message)
  assert.equal(drainParts.prefix, "rendezvous_drain", "the refusal must name the tool actually called, not rendezvous_send")
  assert.equal(sendParts.prefix, "rendezvous_send")
  assert.equal(drainParts.body, sendParts.body, "the REASON is one shared wording across tools")
  assert.ok(!/not a member/i.test(drain.error?.message ?? ""), "a code-shaped argument is not a membership question")
})

test("rendezvous_ack refuses a room CODE with the SAME code-shaped reason rendezvous_send gives, correctly prefixed, never the membership one", async () => {
  const { service, handler } = await buildSendHarness()
  const created = await service.handleInbound(inboundFromAlice("new"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return

  const ack = asRpc(await callAck(handler, bearerFor(ALICE), { roomSlug: created.room.code, seq: 1 }))
  const send = asRpc(await callSend(handler, sendBearerFor(ALICE), { roomSlug: created.room.code, text: "hello" }))

  assert.notEqual(ack.status, 401, "the token is good; the ARGUMENT is the wrong shape")
  assert.ok(ack.error !== undefined, "never a silent no-op")

  const ackParts = refusalPrefixAndBody(ack.error?.message)
  const sendParts = refusalPrefixAndBody(send.error?.message)
  assert.equal(ackParts.prefix, "rendezvous_ack", "the refusal must name the tool actually called, not rendezvous_send")
  assert.equal(sendParts.prefix, "rendezvous_send")
  assert.equal(ackParts.body, sendParts.body, "the REASON is one shared wording across tools")
  assert.ok(!/not a member/i.test(ack.error?.message ?? ""), "a code-shaped argument is not a membership question")
})

// --- BRIEF-13 step 3: rendezvous_new. -----------------------------------

function callNew(
  handler: ReturnType<typeof createMcpPersonalHandler>,
  authorization: string | undefined,
): Promise<McpResponse> {
  return handler({ jsonrpc: "2.0", id: 16, method: "tools/call", params: { name: "rendezvous_new", arguments: {} } }, authorization)
}

interface NewPayload {
  roomSlug: string
  ready: boolean
}

function newPayload(res: McpResponse): NewPayload {
  return JSON.parse(contentTextOf(asRpc(res))) as NewPayload
}

test("rendezvous_new is advertised only when the mount can send, alongside rendezvous_send", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  await store.addMember((await store.create()).code, { displayName: "Alice", tier: "messenger", address: ALICE })

  const plain = createMcpPersonalHandler(deps(store))
  const plainNames = toolNames(await callToolsList(plain, bearerFor(ALICE)))
  assert.ok(!plainNames.includes("rendezvous_new"), "rendezvous_new must not be advertised with no send capability wired")

  const { handler } = await buildSendHarness()
  const names = toolNames(await callToolsList(handler, bearerFor(ALICE)))
  assert.ok(names.includes("rendezvous_new") && names.includes("rendezvous_send"), `got: ${names.join(", ")}`)
})

test("rendezvous_new creates a room, moves the caller's pointer off the room they were in, and puts no join code in content text", async () => {
  const { service, store, handler } = await buildSendHarness()
  const firstRoom = await service.handleInbound(inboundFromAlice("new"))
  assert.equal(firstRoom.kind, "created")
  if (firstRoom.kind !== "created") return

  const res = await callNew(handler, sendBearerFor(ALICE))
  const text = contentTextOf(asRpc(res))
  const payload = newPayload(res)

  assert.notEqual(payload.roomSlug, firstRoom.room.slug, "a brand-new room must not be the room the caller was already in")
  assert.ok(payload.roomSlug.length > 0, "the new room must be named by its slug")
  assert.equal(typeof payload.ready, "boolean")

  const rooms = metaRoomCodes(res)
  const meta = rooms.find((room) => room.slug === payload.roomSlug)
  assert.ok(meta !== undefined, "the new room's code must ride in _meta.rooms, the same shape rendezvous_list uses")

  assert.ok(!text.includes(firstRoom.room.code), "content text must never carry the OLD room's join code")
  assert.ok(meta !== undefined && !text.includes(meta.code), "content text must never carry the NEW room's join code either")

  const oldRoomAfter = store.get(firstRoom.room.code)
  assert.ok(
    !(oldRoomAfter?.members ?? []).some((member) => member.address.provider === "whatsapp" && member.address.contactRef === ALICE.contactRef),
    "rendezvous_new must move the pointer OFF the room the caller was in, exactly like join/resume",
  )

  const afterLookup = store.findByAddress(ALICE)
  assert.equal(afterLookup.kind, "one", "the caller must end up in EXACTLY one room after new")
  if (afterLookup.kind === "one") {
    assert.equal(afterLookup.room.slug, payload.roomSlug, "the one room the pointer now names must be the room just created")
  }
})

test("rendezvous_new carries the caller's own displayName and tier over into the new room", async () => {
  const { service, store, handler } = await buildSendHarness()
  const created = await service.handleInbound(inboundFromAlice("new"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return

  const res = await callNew(handler, sendBearerFor(ALICE))
  const payload = newPayload(res)
  const newRoom = store.getBySlug(payload.roomSlug)
  assert.ok(newRoom !== undefined)
  const member = newRoom.members.find((candidate) => candidate.address.provider === "whatsapp" && candidate.address.contactRef === ALICE.contactRef)
  assert.ok(member !== undefined)
  assert.equal(member.displayName, "Alice", "the caller's own display name carries over, never a placeholder")
  assert.equal(member.tier, "messenger", "the caller's own tier carries over")
  assert.equal(payload.ready, newRoom.artifactReady === true, "the reported readiness must be an honest read of the room's own field")
})

test("a read-only principal token is refused by rendezvous_new, naming the reason and the tool actually called", async () => {
  const { service, handler } = await buildSendHarness()
  const created = await service.handleInbound(inboundFromAlice("new"))
  assert.equal(created.kind, "created")

  const res = asRpc(await callNew(handler, bearerFor(ALICE)))
  const message = res.error?.message ?? ""

  assert.notEqual(res.status, 401, "the token is valid — it simply does not carry this capability")
  assert.ok(res.error !== undefined, "never a silent no-op")
  assert.ok(/read-only/i.test(message), `the refusal must name the reason, got: ${message}`)
  assert.ok(/can-send/i.test(message), `the refusal must name the remedy, got: ${message}`)
  assert.ok(message.startsWith("rendezvous_new:"), `the refusal must name the tool actually called, got: ${message}`)
})

// --- BRIEF-13 step 4: rendezvous_leave. ---------------------------------

function callLeave(
  handler: ReturnType<typeof createMcpPersonalHandler>,
  authorization: string | undefined,
  args: { roomSlug: string },
): Promise<McpResponse> {
  return handler({ jsonrpc: "2.0", id: 17, method: "tools/call", params: { name: "rendezvous_leave", arguments: args } }, authorization)
}

interface LeavePayload {
  roomSlug: string
  remaining: number
}

function leavePayload(res: McpResponse): LeavePayload {
  return JSON.parse(contentTextOf(asRpc(res))) as LeavePayload
}

test("rendezvous_leave is advertised only when the mount can send, alongside rendezvous_send/rendezvous_new", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  await store.addMember((await store.create()).code, { displayName: "Alice", tier: "messenger", address: ALICE })

  const plain = createMcpPersonalHandler(deps(store))
  const plainNames = toolNames(await callToolsList(plain, bearerFor(ALICE)))
  assert.ok(!plainNames.includes("rendezvous_leave"), "rendezvous_leave must not be advertised with no send capability wired")

  const { handler } = await buildSendHarness()
  const names = toolNames(await callToolsList(handler, bearerFor(ALICE)))
  assert.ok(
    names.includes("rendezvous_leave") && names.includes("rendezvous_send") && names.includes("rendezvous_new"),
    `got: ${names.join(", ")}`,
  )
})

test("rendezvous_leave removes the caller from the named room, puts no code in content text, and reports zero rooms remaining", async () => {
  const { service, store, handler } = await buildSendHarness()
  const created = await service.handleInbound(inboundFromAlice("new"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return

  const res = await callLeave(handler, sendBearerFor(ALICE), { roomSlug: created.room.slug })
  const text = contentTextOf(asRpc(res))
  const payload = leavePayload(res)

  assert.equal(payload.roomSlug, created.room.slug)
  assert.equal(payload.remaining, 0, "leaving the only room the caller was in leaves zero rooms")
  assert.ok(!text.includes(created.room.code), "content text must never carry the room's join code")

  assert.equal(
    (store.get(created.room.code)?.members ?? []).length,
    0,
    "the caller must actually be removed from the room's roster",
  )
  assert.equal(store.findByAddress(ALICE).kind, "none", "the caller is now a member of no room at all")
})

test("rendezvous_leave on a room the caller is ambiguously in touches ONLY the named room, and reports the one room still remaining", async () => {
  const { service, store, handler } = await buildSendHarness()
  const roomA = await service.handleInbound(inboundFromAlice("new"))
  assert.equal(roomA.kind, "created")
  if (roomA.kind !== "created") return

  // Force a second membership for the same address without going through
  // ensureMembership's move semantics — a genuinely ambiguous address, the
  // exact state the panel's #ambiguous banner is about.
  const roomB = await store.create()
  await store.addMember(roomB.code, { displayName: "Alice", tier: "messenger", address: ALICE })
  assert.equal(store.findByAddress(ALICE).kind, "ambiguous", "the fixture must start genuinely ambiguous")

  const res = await callLeave(handler, sendBearerFor(ALICE), { roomSlug: roomA.room.slug })
  const payload = leavePayload(res)

  assert.equal(payload.roomSlug, roomA.room.slug)
  assert.equal(payload.remaining, 1, "the OTHER room the address was ambiguously in must still count")
  assert.equal((store.get(roomA.room.code)?.members ?? []).length, 0, "the named room lost its member")
  assert.equal((store.get(roomB.code)?.members ?? []).length, 1, "the room NOT named must be untouched")

  const after = store.findByAddress(ALICE)
  assert.equal(after.kind, "one", "the ambiguity is now resolved — exactly one room remains")
  if (after.kind === "one") assert.equal(after.room.code, roomB.code)
})

test("a read-only principal token is refused by rendezvous_leave, naming the reason and the tool actually called", async () => {
  const { service, handler } = await buildSendHarness()
  const created = await service.handleInbound(inboundFromAlice("new"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return

  const res = asRpc(await callLeave(handler, bearerFor(ALICE), { roomSlug: created.room.slug }))
  const message = res.error?.message ?? ""

  assert.notEqual(res.status, 401, "the token is valid — it simply does not carry this capability")
  assert.ok(res.error !== undefined, "never a silent no-op")
  assert.ok(/read-only/i.test(message), `the refusal must name the reason, got: ${message}`)
  assert.ok(/can-send/i.test(message), `the refusal must name the remedy, got: ${message}`)
  assert.ok(message.startsWith("rendezvous_leave:"), `the refusal must name the tool actually called, got: ${message}`)
})

test("rendezvous_leave for a room the principal is not a member of gets the SAME reason rendezvous_send gives, prefixed with its OWN tool name", async () => {
  const { service, store, handler } = await buildSendHarness()
  const created = await service.handleInbound(inboundFromAlice("new"))
  assert.equal(created.kind, "created")

  const stranger = await store.create()
  await store.addMember(stranger.code, {
    displayName: "Bob",
    tier: "messenger",
    address: { provider: "telegram", source: "telegram", contactRef: "+15550002222" },
  })

  const leave = asRpc(await callLeave(handler, sendBearerFor(ALICE), { roomSlug: stranger.slug }))
  const send = asRpc(await callSend(handler, sendBearerFor(ALICE), { roomSlug: stranger.slug, text: "hello?" }))

  assert.notEqual(leave.status, 401, "a good credential naming the wrong room is not an authentication failure")
  assert.ok(leave.error !== undefined, "never a silent no-op")

  const leaveParts = refusalPrefixAndBody(leave.error?.message)
  const sendParts = refusalPrefixAndBody(send.error?.message)
  assert.equal(leaveParts.prefix, "rendezvous_leave", "the refusal must name the tool actually called, not rendezvous_send")
  assert.equal(sendParts.prefix, "rendezvous_send")
  assert.equal(leaveParts.body, sendParts.body, "the REASON is one shared wording across tools")
})

test("rendezvous_leave refuses a room CODE with the SAME code-shaped reason rendezvous_send gives, correctly prefixed, never the membership one", async () => {
  const { service, handler } = await buildSendHarness()
  const created = await service.handleInbound(inboundFromAlice("new"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return

  const leave = asRpc(await callLeave(handler, sendBearerFor(ALICE), { roomSlug: created.room.code }))
  const send = asRpc(await callSend(handler, sendBearerFor(ALICE), { roomSlug: created.room.code, text: "hello" }))

  assert.notEqual(leave.status, 401, "the token is good; the ARGUMENT is the wrong shape")
  assert.ok(leave.error !== undefined, "never a silent no-op")

  const leaveParts = refusalPrefixAndBody(leave.error?.message)
  const sendParts = refusalPrefixAndBody(send.error?.message)
  assert.equal(leaveParts.prefix, "rendezvous_leave", "the refusal must name the tool actually called, not rendezvous_send")
  assert.equal(sendParts.prefix, "rendezvous_send")
  assert.equal(leaveParts.body, sendParts.body, "the REASON is one shared wording across tools")
  assert.ok(!/not a member/i.test(leave.error?.message ?? ""), "a code-shaped argument is not a membership question")
})

// --- BRIEF-13 step 4b: an ambiguous address resolves itself, through the
// EXISTING rendezvous_send — no new tool, no new admission mechanism. -----

test("BRIEF-13 step 4b: an ambiguous address resolves via rendezvous_send('resume <slug>') — no new tool needed", async () => {
  const { service, store, handler } = await buildSendHarness()

  const roomA = await service.handleInbound(inboundFromAlice("new"))
  assert.equal(roomA.kind, "created")
  if (roomA.kind !== "created") return
  const roomB = await store.create()
  await store.addMember(roomB.code, { displayName: "Alice", tier: "messenger", address: ALICE })
  const roomC = await store.create()
  await store.addMember(roomC.code, { displayName: "Alice", tier: "messenger", address: ALICE })

  assert.equal(store.findByAddress(ALICE).kind, "ambiguous", "the fixture must start genuinely ambiguous")

  // This is exactly the fact the panel's #ambiguous banner asserts.
  const before = listResult(await callList(handler, bearerFor(ALICE)))
  assert.equal(before.ambiguous, true, "rendezvous_list must report the ambiguity the banner is about")
  assert.equal(before.rooms.length, 3)
  assert.ok(before.rooms.every((room) => room.active === false), "no room is active while ambiguous")

  // The resolving action: reuse rendezvous_send to speak the SAME "resume
  // <slug>" command a phone would send — enterBySlug (commands.ts) now
  // resolves an ambiguous match on the named room instead of refusing it.
  const resolveRes = await callSend(handler, sendBearerFor(ALICE), { roomSlug: roomB.slug, text: `resume ${roomB.slug}` })
  const resolvePayload = JSON.parse(contentTextOf(asRpc(resolveRes))) as { roomSlug: string; memberId: string; outcome: string; accepted: boolean }
  assert.equal(resolvePayload.accepted, true, `expected the resume to be accepted, got outcome: ${resolvePayload.outcome}`)

  const after = listResult(await callList(handler, bearerFor(ALICE)))
  assert.equal(after.ambiguous, false, "the banner's claim must now be false")
  assert.equal(after.rooms.length, 1, "exactly one room remains — the ambiguity actually collapsed")
  assert.equal(after.rooms[0]?.slug, roomB.slug, "the room named to resolve it is the one that survives")
  assert.equal(after.rooms[0]?.active, true, "the resolved room becomes THE active one")
})
