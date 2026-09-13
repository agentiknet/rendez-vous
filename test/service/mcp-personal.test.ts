import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { env } from "../../src/env.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Address, Delivery } from "../../src/rooms/types.ts"
import type { McpResponse } from "../../src/service/mcp-canvakit.ts"
import { createMcpRoomHandler, roomAudienceToken, type McpRoomDeps } from "../../src/service/mcp-room.ts"
import { createMcpPersonalHandler, principalToken, type McpPersonalDeps } from "../../src/service/mcp-personal.ts"

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "rdv-mcp-personal-"))
}

const dirs: string[] = []
after(async () => {
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
