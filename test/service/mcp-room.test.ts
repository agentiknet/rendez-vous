import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { env } from "../../src/env.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Member, Room } from "../../src/rooms/types.ts"
import { DeliveryEngine } from "../../src/service/delivery.ts"
import { roomRenderToken, type McpResponse } from "../../src/service/mcp-canvakit.ts"
import {
  createMcpRoomHandler,
  localRoomMcpServer,
  roomAudienceToken,
  roomMcpServer,
  type McpRoomDeps,
} from "../../src/service/mcp-room.ts"
import { FakeTransport } from "../fanout/support.ts"

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "rdv-mcp-room-"))
}

const dirs: string[] = []
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

function trackDir(dir: string): string {
  dirs.push(dir)
  return dir
}

function member(id: string, displayName: string, tier: Member["tier"], provider: string): Member {
  return {
    id,
    displayName,
    tier,
    address: { provider, source: "test", contactRef: `ref-${id}` },
    joinedAt: "2026-09-12T10:00:00.000Z",
  }
}

function room(code: string, members: Member[]): Room {
  return {
    code,
    slug: `slug-${code}`.toLowerCase(),
    sessionId: undefined,
    sandboxId: undefined,
    artifactUrl: undefined,
    artifactReady: undefined,
    members,
    createdAt: "2026-09-12T10:00:00.000Z",
    updatedAt: "2026-09-12T10:00:00.000Z",
    cursor: 0,
    lastActivityAt: "2026-09-12T10:00:00.000Z",
    state: "active",
  }
}

/** Flattens a handler response into the fields the assertions below need,
 *  with narrowing `node:test`'s `assert.ok` can't give across union types. */
function asRpc(res: McpResponse): { readonly status: number; readonly result?: Record<string, unknown>; readonly error?: { readonly code: number; readonly message: string } } {
  if (res.status === 202) return { status: 202 }
  if ("result" in res.body) return { status: res.status, result: res.body.result }
  return { status: res.status, error: res.body.error }
}

const ROOM_A = "RDV-AAAA"
const ROOM_B = "RDV-BBBB"

const MEMBERS_A: Member[] = [
  member("m1", "Alice", "messenger", "telegram"),
  member("m2", "Bob", "messenger", "whatsapp"),
  member("m3", "Screen", "room-web", "room-web"),
]

function harness(rooms: readonly Room[]) {
  const deps: McpRoomDeps = { rooms: () => rooms }
  return { handler: createMcpRoomHandler(deps) }
}

function tokenFor(code: string): string {
  return `Bearer ${roomAudienceToken(code, env.roomTokenSecret)}`
}

test("roomAudienceToken is deterministic in (code, secret) and 40 hex chars", () => {
  const a = roomAudienceToken(ROOM_A, "secret-1")
  assert.equal(a, roomAudienceToken(ROOM_A, "secret-1"))
  assert.notEqual(a, roomAudienceToken(ROOM_A, "secret-2"))
  assert.notEqual(a, roomAudienceToken(ROOM_B, "secret-1"))
  assert.match(a, /^[0-9a-f]{40}$/)
})

test("roomAudienceToken differs from roomRenderToken for the same inputs (the labels must not collide)", () => {
  assert.notEqual(roomAudienceToken(ROOM_A, env.roomTokenSecret), roomRenderToken(ROOM_A, env.roomTokenSecret))
})

test("roster with the room's valid token returns one entry per member, keyed by member_id", async () => {
  const { handler } = harness([room(ROOM_A, MEMBERS_A)])

  const res = asRpc(await handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "roster", arguments: {} } }, tokenFor(ROOM_A)))

  assert.equal(res.status, 200)
  assert.equal(res.result?.isError, false)
  const content = res.result?.content
  assert.ok(Array.isArray(content) && content.length === 1)
  const payload = JSON.parse(String((content[0] as Record<string, unknown>).text)) as {
    count: number
    members: { member_id: string; display_name: string; surface: string; tier: string; joined_at: string }[]
  }
  assert.equal(payload.count, 3)
  assert.deepEqual(
    payload.members.map((m) => [m.member_id, m.display_name, m.surface, m.tier]),
    [
      ["m1", "Alice", "telegram", "messenger"],
      ["m2", "Bob", "whatsapp", "messenger"],
      ["m3", "Screen", "room-web", "room-web"],
    ],
  )
  assert.ok(payload.members.every((m) => m.joined_at === "2026-09-12T10:00:00.000Z"))
})

test("the two messengers are distinguishable by surface even though their tier is identical", async () => {
  const { handler } = harness([room(ROOM_A, MEMBERS_A)])

  const res = asRpc(await handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "roster", arguments: {} } }, tokenFor(ROOM_A)))
  const content = res.result?.content
  assert.ok(Array.isArray(content))
  const payload = JSON.parse(String((content[0] as { text: string }).text)) as { members: { member_id: string; surface: string; tier: string }[] }
  const surfaces = payload.members.filter((m) => m.tier === "messenger").map((m) => `${m.member_id}:${m.surface}`).sort()
  assert.deepEqual(surfaces, ["m1:telegram", "m2:whatsapp"])
})

test("room A's token is rejected when it targets room B's server instance (the room binding)", async () => {
  // A server instance scoped to room B only — the same scoping canvakit's
  // room-binding test gets from its roomExists dep.
  const { handler } = harness([room(ROOM_B, MEMBERS_A)])

  const res = await handler(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "roster", arguments: {} } },
    tokenFor(ROOM_A),
  )

  assert.equal(res.status, 401, "a valid token for room A is INVALID on room B's instance")
})

test("a missing or malformed bearer is rejected", async () => {
  const { handler } = harness([room(ROOM_A, MEMBERS_A)])
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "roster", arguments: {} } }

  const noToken = await handler(call, undefined)
  assert.equal(noToken.status, 401)

  const garbage = await handler(call, "Bearer deadbeef")
  assert.equal(garbage.status, 401)

  const notBearer = await handler(call, "Basic dXNlcjpwYXNz")
  assert.equal(notBearer.status, 401)
})

test("roster ignores any arguments passed to it — it must not accept a room code", async () => {
  const { handler } = harness([room(ROOM_A, MEMBERS_A)])

  // Even a call that NAMES another room resolves nothing: the room comes
  // from the token, and the arguments are never read.
  const res = asRpc(
    await handler(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "roster", arguments: { roomCode: ROOM_B } } },
      tokenFor(ROOM_A),
    ),
  )

  assert.equal(res.status, 200)
  const content = res.result?.content
  assert.ok(Array.isArray(content))
  const payload = JSON.parse(String((content[0] as { text: string }).text)) as { count: number }
  assert.equal(payload.count, 3, "the roster is room A's — the roomCode argument was ignored")
})

test("roster reflects live membership (a member added after the handler was built is visible)", async () => {
  const members = [...MEMBERS_A]
  const deps: McpRoomDeps = { rooms: () => [room(ROOM_A, members)] }
  const handler = createMcpRoomHandler(deps)

  members.push(member("m4", "Late", "email", "email"))
  const res = asRpc(await handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "roster", arguments: {} } }, tokenFor(ROOM_A)))
  const content = res.result?.content
  assert.ok(Array.isArray(content))
  const payload = JSON.parse(String((content[0] as { text: string }).text)) as { count: number }
  assert.equal(payload.count, 4)
})

// The contract's presence rule, through the MCP wire (appendix §7.1): a
// stale pull member is LISTED — still a member, still holding its id — and
// marked away, in both the contract's `presence` union and the legacy
// `away` boolean the live room runs against. Push members are never away.
test("a stale pull member is listed, marked away, and still holds its id; a push member is never away", async () => {
  const { handler } = harness([room(ROOM_A, MEMBERS_A)])

  const res = asRpc(await handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "roster", arguments: {} } }, tokenFor(ROOM_A)))
  const content = res.result?.content
  assert.ok(Array.isArray(content))
  const payload = JSON.parse(String((content[0] as { text: string }).text)) as {
    members: { member_id: string; mode: string; presence: string; away: boolean }[]
  }
  assert.equal(payload.members.length, 3, "presence is not membership — the stale member stays in the roster")
  const screen = payload.members.find((m) => m.member_id === "m3")
  assert.ok(screen !== undefined)
  assert.equal(screen.presence, "away")
  assert.equal(screen.away, true)
  assert.equal(screen.mode, "pull")
  const alice = payload.members.find((m) => m.member_id === "m1")
  assert.ok(alice !== undefined)
  assert.equal(alice.presence, "present")
  assert.equal(alice.away, false)
  assert.equal(alice.mode, "push")
})

test("tools/list advertises roster and room_view alone until a delivery engine is wired, then all four audience tools", async () => {
  const bare = harness([room(ROOM_A, MEMBERS_A)])
  const bareRes = asRpc(await bare.handler({ jsonrpc: "2.0", id: "a", method: "tools/list" }, undefined))
  const bareTools = bareRes.result?.tools
  assert.ok(Array.isArray(bareTools))
  assert.deepEqual(bareTools.map((tool) => (tool as { name: string }).name), ["roster", "room_view"])

  const { handler } = harnessWithDeliveries([room(ROOM_A, MEMBERS_A)])
  const res = asRpc(await handler({ jsonrpc: "2.0", id: "a", method: "tools/list" }, undefined))
  assert.equal(res.status, 200)
  const tools = res.result?.tools
  assert.ok(Array.isArray(tools))
  assert.deepEqual(tools.map((tool) => (tool as { name: string }).name), ["roster", "room_view", "say", "whisper"])
  // `say`'s `to` is optional (omitted = every member); `whisper`'s is not.
  const say = tools.find((tool) => (tool as { name: string }).name === "say") as { inputSchema: Record<string, unknown> }
  assert.deepEqual(say.inputSchema.required, ["text"])
  const whisper = tools.find((tool) => (tool as { name: string }).name === "whisper") as {
    inputSchema: Record<string, unknown>
  }
  assert.deepEqual(whisper.inputSchema.required, ["text", "to"])
})

/** The bug this pins: `room_view` used to return code/state/member_count and
 *  nothing else, so an agent asked "what's on screen?" had no token anywhere
 *  in its context saying a document existed — and answered "nothing has been
 *  rendered" to humans who were looking at the rendered document. Measured on
 *  the live RDV-EGCK room. `docs/OUTBOX.md` §1, pointed at the artifact.
 *
 *  A PRESENCE fact only: a boolean and a timestamp. No title, no body — the
 *  file-top HARD RULE holds, and this result is still safe to project on the
 *  room's shared screen. */
test("room_view reports whether a document is rendered, as presence and never contents", async () => {
  const rooms = [room(ROOM_A, MEMBERS_A)]
  const call = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "room_view", arguments: {} } }
  const payloadOf = (res: ReturnType<typeof asRpc>): Record<string, unknown> => {
    const content = res.result?.content
    assert.ok(Array.isArray(content) && content.length === 1)
    return JSON.parse(String((content[0] as Record<string, unknown>).text)) as Record<string, unknown>
  }

  // A room with a stored render: rendered, with the store's own timestamp.
  const withRender = createMcpRoomHandler({
    rooms: () => rooms,
    storedRender: async () => ({ renderedAt: "2026-09-13T20:11:00.000Z" }),
  })
  const hit = payloadOf(asRpc(await withRender(call, tokenFor(ROOM_A))))
  assert.equal(hit.code, ROOM_A)
  assert.equal(hit.member_count, MEMBERS_A.length)
  assert.deepEqual(hit.artifact, { rendered: true, rendered_at: "2026-09-13T20:11:00.000Z" })

  // Nothing rendered: `rendered: false` and NO timestamp — an absent render
  // must never carry a time that reads as one.
  const empty = createMcpRoomHandler({ rooms: () => rooms, storedRender: async () => undefined })
  assert.deepEqual(payloadOf(asRpc(await empty(call, tokenFor(ROOM_A)))).artifact, { rendered: false })

  // No lookup wired at all: still `false`, never a missing key the model can
  // read as "the field doesn't apply here".
  const bare = payloadOf(asRpc(await harness(rooms).handler(call, tokenFor(ROOM_A))))
  assert.deepEqual(bare.artifact, { rendered: false })

  // The HARD RULE: presence only. Nothing in this result names the document.
  const serialised = JSON.stringify(hit)
  for (const key of ["title", "url", "html", "text", "body"]) {
    assert.equal(serialised.includes(`"${key}"`), false, `room_view leaked ${key}`)
  }
})

test("a notification (no id) gets 202 with no body", async () => {
  const { handler } = harness([room(ROOM_A, MEMBERS_A)])
  const res = await handler({ jsonrpc: "2.0", method: "notifications/initialized" }, undefined)
  assert.equal(res.status, 202)
  assert.equal(res.body, undefined)
})

test("an unknown tool or method is a JSON-RPC failure, not a roster call", async () => {
  const { handler } = harness([room(ROOM_A, MEMBERS_A)])

  // `ask` is step 4 — not advertised, not callable.
  const unknownTool = asRpc(await handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask", arguments: {} } }, tokenFor(ROOM_A)))
  assert.equal(unknownTool.status, 200)
  assert.equal(unknownTool.error?.code, -32601, "ask is step 4 — it must not appear advertised or callable")

  // `resources/list` is now a real method (BRIEF-01) — probe with a method
  // that stays unknown.
  const unknownMethod = asRpc(await handler({ jsonrpc: "2.0", id: 2, method: "prompts/list" }, tokenFor(ROOM_A)))
  assert.equal(unknownMethod.error?.code, -32601)
})

// The token rides in BOTH the header and the `?t=` query parameter, and the
// endpoint accepts either. The header alone does not survive the trip into an
// e2b box (observed live 2026-09-12: every MCP request arrived `auth=no`),
// which is why the query arm exists at all — so BOTH carriers are asserted,
// and a regression that silently drops one is a failing test rather than a
// room that cannot address anybody.
test("the mounts carry the room's token in both carriers: tunnel ref for e2b, loopback ref for local", () => {
  const bare = tokenFor(ROOM_A).replace(/^Bearer /, "")

  const tunnel = roomMcpServer(ROOM_A)
  assert.equal(tunnel.name, "room")
  assert.equal(tunnel.transport, "http")
  assert.equal(tunnel.ref, `${env.publicUrl}/mcp/room?t=${bare}`)
  assert.equal(tunnel.headers.authorization, tokenFor(ROOM_A))

  const local = localRoomMcpServer(ROOM_A)
  assert.equal(local.ref, `http://127.0.0.1:${env.port}/mcp/room?t=${bare}`)
  assert.equal(local.headers.authorization, tokenFor(ROOM_A))

  // Same room, same token, whichever carrier and whichever base.
  assert.equal(new URL(tunnel.ref).searchParams.get("t"), bare)
  assert.equal(new URL(local.ref).searchParams.get("t"), bare)
})

test("the endpoint accepts the token from ?t= when no Authorization header arrives", async () => {
  const { handler } = harness([room(ROOM_A, MEMBERS_A)])
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "roster", arguments: {} } }
  const bare = (code: string): string => tokenFor(code).replace(/^Bearer /, "")

  const viaQuery = await handler(call, undefined, bare(ROOM_A))
  assert.equal(viaQuery.status, 200, "a query token alone must authenticate — this is the only carrier that survives a box")

  const neither = await handler(call, undefined, undefined)
  assert.equal(neither.status, 401, "no carrier at all is still unauthorized")

  const wrongRoom = await handler(call, undefined, bare(ROOM_B))
  assert.equal(wrongRoom.status, 401, "a query token for another room binds no better than a header would")
})

test("a room round-tripped through the store with protocol 'tools' keeps it", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const created = await store.create()
  await store.update(created.code, { protocol: "tools" })

  const reopened = await RoomStore.open(dir)
  assert.equal(reopened.get(created.code)?.protocol, "tools")
})

test("a room persisted WITHOUT the protocol key still loads (the pre-existing-rooms guard)", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const created = await store.create()
  await store.addMember(created.code, {
    displayName: "Alice",
    tier: "messenger",
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+15551234567" },
  })

  // Rewrite the store file without the key, exactly as an older service
  // version would have left it.
  const filePath = join(dir, "rooms.json")
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as { rooms: Record<string, unknown>[] }
  for (const room of parsed.rooms) delete room.protocol
  await writeFile(filePath, JSON.stringify(parsed, null, 2), "utf8")

  const reopened = await RoomStore.open(dir)
  const loaded = reopened.get(created.code)
  assert.ok(loaded !== undefined)
  assert.equal(loaded.protocol, undefined)
  assert.equal(loaded.members.length, 1)
})

test("a room persisted with a nonsense protocol value is rejected, not silently loaded", async () => {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const created = await store.create()

  const filePath = join(dir, "rooms.json")
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as { rooms: Record<string, unknown>[] }
  parsed.rooms[0]!.protocol = "smoke-signals"
  await writeFile(filePath, JSON.stringify(parsed, null, 2), "utf8")
  void created

  await assert.rejects(() => RoomStore.open(dir), /corrupt room store/i)
})

// --- say / whisper: the tool surface (delivery behaviour itself lives in
// test/service/delivery.test.ts) ---

interface DeliveryHarness {
  handler: (body: unknown, authorization: string | undefined) => Promise<McpResponse>
  store: RoomStore
  code: string
  memberIds: string[]
  transport: FakeTransport
  engine: DeliveryEngine
}

async function deliveryHarness(members: Member[]): Promise<DeliveryHarness> {
  const dir = trackDir(await freshDir())
  const store = await RoomStore.open(dir)
  const created = await store.create()
  for (const member of members) {
    await store.addMember(created.code, {
      displayName: member.displayName,
      tier: member.tier,
      address: member.address,
    })
  }
  const live = store.get(created.code)
  assert.ok(live !== undefined)
  const memberIds = live.members.map((member) => member.id)
  const transport = new FakeTransport()
  const engine = new DeliveryEngine({ store, transport })
  const deps: McpRoomDeps = { rooms: () => [live], deliveries: engine }
  return { store, code: created.code, memberIds, transport, engine, handler: createMcpRoomHandler(deps) }
}

function harnessWithDeliveries(rooms: readonly Room[]) {
  // Placeholder for the tools/list shape test — schema assertions need no
  // real engine, only any McpRoomDeliveries-shaped object.
  const engine: McpRoomDeps["deliveries"] = {
    accept: async () => ({ accepted: [], unknown: [] }),
  }
  const deps: McpRoomDeps = { rooms: () => rooms, deliveries: engine }
  return { handler: createMcpRoomHandler(deps) }
}

function callTool(handler: DeliveryHarness["handler"] | ReturnType<typeof harnessWithDeliveries>["handler"], name: string, args: unknown, code: string): Promise<McpResponse> {
  return handler(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    tokenFor(code),
  )
}

const DELIVERY_MEMBERS: Member[] = [
  member("m1", "Alice", "messenger", "telegram"),
  member("m2", "Bob", "messenger", "whatsapp"),
  member("m3", "Screen", "room-web", "room-web"),
]

test("say with no `to` accepts every member; the result carries ids only, never the text", async () => {
  const h = await deliveryHarness(DELIVERY_MEMBERS)
  const res = asRpc(await callTool(h.handler, "say", { text: "the picnic moves to noon" }, h.code))

  assert.equal(res.status, 200)
  assert.equal(res.result?.isError, false)
  const content = res.result?.content
  assert.ok(Array.isArray(content) && content.length === 1)
  const payload = JSON.parse(String((content[0] as { text: string }).text)) as {
    accepted: { member_id: string; ok: boolean }[]
    unknown: string[]
  }
  const [id1, id2, id3] = h.memberIds
  assert.deepEqual(payload.accepted.map((entry) => [entry.member_id, entry.ok]), [
    [id1, true],
    [id2, true],
    [id3, true],
  ])
  assert.deepEqual(payload.unknown, [])
  const resultText = String((res.result?.content as { text: string }[] | undefined)?.[0]?.text)
  assert.ok(!resultText.includes("picnic"), "the result must not echo the message text")
  await h.engine.drain(h.code)
  // room-web draws no transport call; the two messengers each got the text.
  assert.deepEqual(
    h.transport.sends.map((send) => send.memberId).sort(),
    [id1, id2].sort(),
  )
})

test("say with `to: [one]` accepts exactly that one", async () => {
  const h = await deliveryHarness(DELIVERY_MEMBERS)
  const target = h.memberIds[1]!
  const res = asRpc(await callTool(h.handler, "say", { text: "just for you", to: [target] }, h.code))
  const content = res.result?.content
  assert.ok(Array.isArray(content))
  const payload = JSON.parse(String((content[0] as { text: string }).text)) as { accepted: unknown[]; unknown: string[] }
  assert.equal(payload.accepted.length, 1)
  assert.deepEqual(payload.unknown, [])
  await h.engine.drain(h.code)
  assert.deepEqual(
    h.transport.sends.map((send) => send.memberId),
    [target],
  )
})

test("say with an unknown id accepts the known ones, reports the unknown, and delivers that text to nobody", async () => {
  const h = await deliveryHarness(DELIVERY_MEMBERS)
  const first = h.memberIds[0]!
  const res = asRpc(await callTool(h.handler, "say", { text: "hello both", to: [first, "ghost"] }, h.code))
  const content = res.result?.content
  assert.ok(Array.isArray(content))
  const payload = JSON.parse(String((content[0] as { text: string }).text)) as { accepted: { member_id: string }[]; unknown: string[] }
  assert.deepEqual(payload.accepted.map((entry) => entry.member_id), [first])
  assert.deepEqual(payload.unknown, ["ghost"])
  await h.engine.drain(h.code)
  assert.deepEqual(h.transport.sends.map((send) => send.memberId), [first])
})

// --- assertion 2 (BRIEF-15, post-turn-assertions): a send that reached
// nobody because every id it named was unknown. The pair is the point: a
// send with a MIX of known and unknown ids (the test just above) is a
// perfectly ordinary partial send and must not report anything. ---

test("BRIEF-15: say naming ONLY unknown ids reports assertion 2 as a log-only warning, minting zero deliveries", async () => {
  const h = await deliveryHarness(DELIVERY_MEMBERS)
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    const res = asRpc(await callTool(h.handler, "say", { text: "hello", to: ["ghost1", "ghost2"] }, h.code))
    const content = res.result?.content
    assert.ok(Array.isArray(content))
    const payload = JSON.parse(String((content[0] as { text: string }).text)) as { accepted: unknown[]; unknown: string[] }
    assert.deepEqual(payload.accepted, [])
    assert.deepEqual(payload.unknown, ["ghost1", "ghost2"])
  } finally {
    console.warn = original
  }

  assert.equal(warnings.length, 1)
  assert.ok(warnings[0]?.includes("send-reached-nobody"), "the warning must name the assertion")
  assert.ok(warnings[0]?.includes("ghost1"), "the warning must name the ids")
  assert.ok(warnings[0]?.includes("ghost2"), "the warning must name the ids")
  assert.equal(h.transport.sends.length, 0, "log-only assertion mints zero deliveries")
})

test("BRIEF-15: say naming one known id alongside an unknown one does NOT report assertion 2 — a partial send is ordinary", async () => {
  const h = await deliveryHarness(DELIVERY_MEMBERS)
  const first = h.memberIds[0]!
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    const res = asRpc(await callTool(h.handler, "say", { text: "hello", to: [first, "ghost"] }, h.code))
    const content = res.result?.content
    assert.ok(Array.isArray(content))
    const payload = JSON.parse(String((content[0] as { text: string }).text)) as { accepted: { member_id: string }[]; unknown: string[] }
    assert.deepEqual(payload.accepted.map((entry) => entry.member_id), [first])
    assert.deepEqual(payload.unknown, ["ghost"])
  } finally {
    console.warn = original
  }

  assert.deepEqual(warnings, [], "at least one recipient was reached — nothing to report")
})

test("whisper returns one accepted entry; no result or error string contains any substring of the message", async () => {
  const h = await deliveryHarness(DELIVERY_MEMBERS)
  const secret = "the vault code is 44-21"
  const res = asRpc(await callTool(h.handler, "whisper", { text: secret, to: h.memberIds[1] }, h.code))
  assert.equal(res.status, 200)
  const content = res.result?.content
  assert.ok(Array.isArray(content))
  const payload = JSON.parse(String((content[0] as { text: string }).text)) as { accepted: unknown[]; unknown: string[] }
  assert.equal(payload.accepted.length, 1)
  assert.deepEqual(payload.unknown, [])
  await h.engine.drain(h.code)
  // Every byte the tool produced — result and error paths alike — is checked
  // against the message and its fragments.
  const allOutput = JSON.stringify(res)
  assert.ok(!allOutput.includes(secret))
  for (const fragment of ["vault code", "44-21", "the vault"]) {
    assert.ok(!allOutput.includes(fragment), `result must not contain "${fragment}"`)
  }
})

test("a malformed say/whisper call is rejected with an error that names the argument, not the value", async () => {
  const h = await deliveryHarness(DELIVERY_MEMBERS)
  const secret = "sensitive payload xyz"
  const noText = asRpc(await callTool(h.handler, "say", {}, h.code))
  assert.equal(noText.error?.code, -32600)
  assert.ok(!JSON.stringify(noText).includes(secret))

  const whisperNoTo = asRpc(await callTool(h.handler, "whisper", { text: secret }, h.code))
  assert.equal(whisperNoTo.error?.code, -32600)
  assert.ok(!JSON.stringify(whisperNoTo).includes(secret))

  const badTo = asRpc(await callTool(h.handler, "say", { text: secret, to: h.memberIds[0] }, h.code))
  assert.equal(badTo.error?.code, -32600)
  assert.ok(!JSON.stringify(badTo).includes(secret))
})

// --- the contract binding (PLAN-02 §5 step 6): the tools above are the
// contract's `audience_send` wearing the MCP envelope. These pin the
// semantics the contract carries, through the live tool surface. ---

test("a whisper through the contract reaches exactly one, and the room gets the content-free notice", async () => {
  const h = await deliveryHarness(DELIVERY_MEMBERS)
  const [aliceId, bobId, screenId] = h.memberIds
  const res = asRpc(await callTool(h.handler, "whisper", { text: "the vault code is 44-21", to: bobId }, h.code))
  assert.equal(res.status, 200)
  await h.engine.drain(h.code)

  // Exactly one target: the private text, marked private.
  const toBob = h.transport.sends.find((send) => send.memberId === bobId)
  assert.equal(toBob?.text, "(private) the vault code is 44-21")
  // The room is TOLD the whisper happened — content-free, in the contract's
  // own words (whisperNoticeOf). The other messenger gets it over the
  // transport with the room's voice (a BRIEF-39 system record); the pull
  // member (room-web) gets the record in its outbox, no transport call.
  const toAlice = h.transport.sends.find((send) => send.memberId === aliceId)
  assert.equal(toAlice?.text, "Room: (the agent whispered to Bob)")
  assert.ok(!toAlice?.text.includes("44-21"))
  assert.equal(h.transport.sends.some((send) => send.memberId === screenId), false)
})

test("the room's voice is not agent-callable: no `system` tool exists, advertised or callable", async () => {
  const h = await deliveryHarness(DELIVERY_MEMBERS)

  const listing = asRpc(await h.handler({ jsonrpc: "2.0", id: 1, method: "tools/list" }, tokenFor(h.code)))
  const names = (listing.result?.tools as { name: string }[] | undefined)?.map((tool) => tool.name) ?? []
  assert.ok(!names.includes("system"), "the room's voice is not an agent-callable audience (brief 07)")

  const call = asRpc(
    await h.handler(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "system", arguments: { text: "I am the room" } } },
      tokenFor(h.code),
    ),
  )
  assert.equal(call.error?.code, -32601)
  assert.equal(call.error?.message?.includes("I am the room"), false, "the impersonation attempt is not echoed")
})

test("say through the contract advances spokenSeq; the room's own system records still do not", async () => {
  const h = await deliveryHarness(DELIVERY_MEMBERS)
  const say = asRpc(await callTool(h.handler, "say", { text: "audible" }, h.code))
  assert.equal(say.status, 200)
  const room = h.store.get(h.code)
  assert.ok(room !== undefined)
  assert.ok((room.spokenSeq ?? 0) > 0, "a say accepted through the contract IS the agent speaking")
  assert.equal(room.spokenSeq, room.deliverySeq)

  // The engine-level `system` mint (the room's own notices) leaves it where
  // it was — the contract never exposes `system`, so the only way a system
  // record exists is the room sending it.
  const before = h.store.get(h.code)?.spokenSeq
  await h.engine.accept(h.code, "system", "a room notice", [h.memberIds[2]!])
  assert.equal(h.store.get(h.code)?.spokenSeq, before, "a system mint is not the agent's voice")
  // Settle the auto-drain the accept kicked off, so its store write cannot
  // race the suite's directory cleanup.
  await h.engine.drain(h.code)
})

// --- BRIEF-23A finding 4: `sent` overclaims delivery — the field and description must follow the house convention ---

test("BRIEF-23A: recover_identity result carries no field named 'sent', and the tool description does not promise delivery", async () => {
  const deps: McpRoomDeps = {
    rooms: () => [room(ROOM_A, MEMBERS_A)],
    deliveries: { accept: async () => ({ accepted: [], unknown: [] }) },
    recoverIdentity: async (_code, _memberId) => "accepted",
  }
  const handler = createMcpRoomHandler(deps)

  // tools/list: the description must not promise delivery
  const list = asRpc(await handler({ jsonrpc: "2.0", id: 1, method: "tools/list" }, undefined))
  const tools = list.result?.tools as { name: string; description: string }[] | undefined
  assert.ok(tools !== undefined)
  const recoverTool = tools.find((tool) => tool.name === "recover_identity")
  assert.ok(recoverTool !== undefined, "recover_identity must be advertised when the dep is wired")
  assert.ok(!recoverTool.description.includes("delivered"), "the tool description must not promise delivery")
  assert.ok(!recoverTool.description.includes("{sent:"), "the tool description must not mention sent")

  // tools/call: the result must not carry a field named `sent`
  const call = asRpc(await handler(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recover_identity", arguments: { member_id: "m1" } } },
    tokenFor(ROOM_A),
  ))
  assert.equal(call.status, 200)
  const content = call.result?.content as { text: string }[] | undefined
  assert.ok(Array.isArray(content) && content.length === 1)
  const payload = JSON.parse(String(content[0]?.text ?? "{}")) as Record<string, unknown>
  assert.ok(!("sent" in payload), "the result must not carry a field named 'sent'")
})

// --- BRIEF-31: markers work in say/whisper, one extractor shared with RoomFanout ---

test("BRIEF-31: say with [[say...]] marker strips the marker and delivers spoken words without leaking [[", async () => {
  const h = await deliveryHarness(DELIVERY_MEMBERS)
  const res = asRpc(await callTool(h.handler, "say", { text: "[[say meeting at noon]]" }, h.code))
  assert.equal(res.status, 200)
  await h.engine.drain(h.code)

  const sends = h.transport.sends
  assert.ok(sends.length > 0)
  for (const send of sends) {
    assert.ok(!send.text.includes("[["), "member must not receive literal brackets")
    assert.ok(send.text.includes("noon"), "member receives the spoken words")
  }
})

test("BRIEF-31: text around a [[say...]] marker survives, in order, without leaking [[", async () => {
  const h = await deliveryHarness(DELIVERY_MEMBERS)
  const res = asRpc(
    await callTool(h.handler, "say", { text: "Start\n[[say mid]]\nEnd" }, h.code),
  )
  assert.equal(res.status, 200)
  await h.engine.drain(h.code)

  for (const send of h.transport.sends) {
    assert.ok(!send.text.includes("[["), "member must not receive literal brackets")
    assert.ok(send.text.includes("Start"), "text before marker survives")
    assert.ok(send.text.includes("End"), "text after marker survives")
    assert.ok(send.text.includes("mid"), "spoken words reach the member")
  }
})

test("BRIEF-31: a say with no marker is delivered byte-identical to today", async () => {
  const h = await deliveryHarness(DELIVERY_MEMBERS)
  const text = "Just a regular message, no markers at all."
  const res = asRpc(await callTool(h.handler, "say", { text }, h.code))
  assert.equal(res.status, 200)
  await h.engine.drain(h.code)

  const sends = h.transport.sends
  assert.ok(sends.length > 0)
  for (const send of sends) {
    assert.equal(send.text, text, "text without markers passes through unchanged")
  }
})

test("BRIEF-31: whisper with [[say...]] marker strips the marker and delivers spoken words without leaking [[", async () => {
  const h = await deliveryHarness(DELIVERY_MEMBERS)
  const target = h.memberIds[0]!
  const res = asRpc(await callTool(h.handler, "whisper", { text: "[[say whisper this]]", to: target }, h.code))
  assert.equal(res.status, 200)
  await h.engine.drain(h.code)

  const targetSend = h.transport.sends.find((s) => s.memberId === target)
  assert.ok(targetSend !== undefined, "target member received the whisper")
  assert.ok(!targetSend.text.includes("[["), "target must not receive literal brackets")
  assert.ok(targetSend.text.includes("whisper this"), "target receives the spoken words")
})

test("BRIEF-31: TTS unconfigured with deliverAttachment wired — spoken words delivered as text, no [[", async () => {
  const h = await deliveryHarness(DELIVERY_MEMBERS)
  const room = h.store.get(h.code)
  assert.ok(room !== undefined)

  const deliveredAttachments: { memberId: string; caption: string }[] = []
  const deps: McpRoomDeps = {
    rooms: () => [room],
    deliveries: h.engine,
    deliverAttachment: async (_code, memberId, attachment) => {
      deliveredAttachments.push({ memberId, caption: attachment.caption ?? "" })
    },
  }
  const handler = createMcpRoomHandler(deps)

  const res = asRpc(await callTool(handler, "say", { text: "[[say TTS-fallback-text]]" }, h.code))
  assert.equal(res.status, 200)
  await h.engine.drain(h.code)

  // With deliverAttachment wired but no tts/mediaStore, renderSpeech returns
  // empty-URL attachments. deliverAttachment should be called for each
  // accepted member with the caption containing the spoken words.
  const memberIds = h.memberIds
  for (const memberId of memberIds) {
    const note = deliveredAttachments.find((d) => d.memberId === memberId)
    assert.ok(note !== undefined, `member ${memberId} got a voice-note delivery`)
    assert.ok(note.caption.includes("TTS-fallback-text"), "voice-note caption carries the spoken words")
  }
  const allOutput = JSON.stringify(res)
  assert.ok(!allOutput.includes("[["), "the tool response must not contain literal brackets")
})

test("BRIEF-35: a say with only [[say...]] and deliverAttachment wired never carries empty text in the delivery record", async () => {
  const h = await deliveryHarness(DELIVERY_MEMBERS)
  const room = h.store.get(h.code)
  assert.ok(room !== undefined)

  const deliveries: { memberId: string; text: string }[] = []
  const deps: McpRoomDeps = {
    rooms: () => [room],
    deliveries: h.engine,
    deliverAttachment: async (_code, memberId, attachment) => {
      deliveries.push({ memberId, text: attachment.caption ?? "" })
    },
  }
  const handler = createMcpRoomHandler(deps)

  const res = asRpc(await callTool(handler, "say", { text: "[[say hello there]]" }, h.code))
  assert.equal(res.status, 200)
  await h.engine.drain(h.code)

  for (const send of h.transport.sends) {
    assert.ok(send.text.length > 0, "delivery text must not be empty when a [[say…]] marker is the only content")
    assert.ok(send.text.includes("hello there"), "delivery text must carry the spoken words")
  }
})
