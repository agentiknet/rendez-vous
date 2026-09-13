import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { env } from "../../src/env.ts"
import { DaemonClient } from "../../src/daemon/client.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Address, Delivery, Tier } from "../../src/rooms/types.ts"
import { LocalBooter } from "../../src/service/booter.ts"
import { MediaStore } from "../../src/service/media-store.ts"
import { RoomService } from "../../src/service/room-service.ts"
import { MemoryTransport } from "../../src/service/transports.ts"
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
  args: { roomCode: string; text: string },
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

interface ListPayload {
  principal: { provider: string; contactRef: string; displayName: string }
  rooms: {
    code: string
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
  const codes = payload.rooms.map((r) => r.code).sort()
  assert.deepEqual(codes, [roomA.code, roomB.code].sort())
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

  // 2. The panel: Alice types the same words into the roster.
  const res = asRpc(await callSend(handler, sendBearerFor(ALICE), { roomCode: created.room.code, text: TEXT }))
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

  // And the result says nothing about the content (the file-top HARD RULE).
  const payload: { roomCode: string; memberId: string; outcome: string; accepted: boolean } = JSON.parse(contentTextOf(res))
  assert.equal(payload.roomCode, created.room.code)
  assert.equal(payload.accepted, true)
  assert.ok(!JSON.stringify(res).includes("what is the plan"), "the send result must never echo the text")
})

test("rendezvous_send into a room the principal is NOT in is refused, and the refusal is about membership, not authentication", async () => {
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

  const res = asRpc(await callSend(handler, sendBearerFor(ALICE), { roomCode: stranger.code, text: "hello?" }))
  const message = res.error?.message ?? ""

  assert.notEqual(res.status, 401, "a good credential naming the wrong room is not an authentication failure")
  assert.ok(res.error !== undefined, "never a silent no-op")
  assert.ok(/member/i.test(message), `the refusal must name membership, got: ${message}`)
  assert.ok(
    !/unauthori|authenticat|credential|token|forbidden|permission/i.test(message),
    `the refusal must not read as an auth error, got: ${message}`,
  )
})

test("a read-only principal token is refused by rendezvous_send, naming the reason", async () => {
  const { service, handler } = await buildSendHarness()

  const created = await service.handleInbound(inboundFromAlice("new"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return

  const res = asRpc(await callSend(handler, bearerFor(ALICE), { roomCode: created.room.code, text: "hello" }))
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
    read.rooms.map((room) => room.code),
    [created.room.code],
    "BRIEF-18's read-only token must keep doing exactly what it was minted for",
  )

  // And send is a SUPERSET, not a separate account: the same rooms come back.
  const write = listResult(await callList(handler, sendBearerFor(ALICE)))
  assert.deepEqual(
    write.rooms.map((room) => room.code),
    read.rooms.map((room) => room.code),
    "a send-capable token must see exactly what a read-only one sees",
  )
})
