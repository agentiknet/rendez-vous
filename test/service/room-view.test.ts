import assert from "node:assert/strict"
import { test } from "node:test"
import { env } from "../../src/env.ts"
import type { Member, Room } from "../../src/rooms/types.ts"
import { createMcpRoomHandler, roomAudienceToken, type McpRoomDeps } from "../../src/service/mcp-room.ts"
import { roomViewHtml } from "../../src/service/room-view.html.ts"
import type { McpResponse } from "../../src/service/mcp-canvakit.ts"

/** Flattens a handler response into the fields the assertions below need,
 *  mirroring mcp-room.test.ts's own `asRpc`. */
function asRpc(res: McpResponse): {
  readonly status: number
  readonly result?: Record<string, unknown>
  readonly error?: { readonly code: number; readonly message: string }
} {
  if (res.status === 202) return { status: 202 }
  if ("result" in res.body) return { status: res.status, result: res.body.result }
  return { status: res.status, error: res.body.error }
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

test("initialize advertises both the tools and resources capabilities", async () => {
  const { handler } = harness([room(ROOM_A, MEMBERS_A)])
  const res = asRpc(await handler({ jsonrpc: "2.0", id: 1, method: "initialize" }, undefined))
  assert.equal(res.status, 200)
  assert.deepEqual(res.result?.capabilities, { tools: {}, resources: {} })
})

test("tools/list includes room_view with its resourceUri, present even with no deliveries dependency", async () => {
  const { handler } = harness([room(ROOM_A, MEMBERS_A)])
  const res = asRpc(await handler({ jsonrpc: "2.0", id: 1, method: "tools/list" }, undefined))
  const tools = res.result?.tools as { name: string; _meta?: { ui?: { resourceUri?: string } } }[]
  assert.ok(Array.isArray(tools))
  const roomView = tools.find((tool) => tool.name === "room_view")
  assert.ok(roomView !== undefined, "room_view must be advertised even when deps.deliveries is undefined")
  assert.equal(roomView._meta?.ui?.resourceUri, "ui://room_view/view")
})

test("tools/call room_view returns code, state and member_count — and nothing else", async () => {
  const { handler } = harness([room(ROOM_A, MEMBERS_A)])
  const res = asRpc(
    await handler(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "room_view", arguments: {} } },
      tokenFor(ROOM_A),
    ),
  )
  assert.equal(res.status, 200)
  assert.equal(res.result?.isError, false)
  const content = res.result?.content as { type: string; text: string }[]
  assert.ok(Array.isArray(content) && content.length === 1)
  const payload = JSON.parse(content[0]!.text) as { code: string; state: string; member_count: number }
  assert.deepEqual(payload, { code: ROOM_A, state: "live", member_count: 3 })

  // D2, the rule that gets broken first: no member display name and no
  // transcript text anywhere in the serialised result.
  const serialised = JSON.stringify(res)
  for (const name of ["Alice", "Bob", "Screen"]) {
    assert.ok(!serialised.includes(name), `result must not contain member display name "${name}"`)
  }
})

test("resources/list returns exactly one resource with the right uri and mimeType", async () => {
  const { handler } = harness([room(ROOM_A, MEMBERS_A)])
  const res = asRpc(await handler({ jsonrpc: "2.0", id: 1, method: "resources/list" }, undefined))
  assert.equal(res.status, 200)
  const resources = res.result?.resources as { uri: string; name: string; mimeType: string }[]
  assert.equal(resources.length, 1)
  assert.deepEqual(resources[0], { uri: "ui://room_view/view", name: "room_view", mimeType: "text/html;profile=mcp-app" })
})

test("resources/read returns room A's own code in the HTML, never room B's", async () => {
  const { handler } = harness([room(ROOM_A, MEMBERS_A), room(ROOM_B, MEMBERS_A)])
  const res = asRpc(
    await handler({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "ui://room_view/view" } }, tokenFor(ROOM_A)),
  )
  assert.equal(res.status, 200)
  const contents = res.result?.contents as { uri: string; mimeType: string; text: string }[]
  assert.equal(contents.length, 1)
  assert.equal(contents[0]!.uri, "ui://room_view/view")
  assert.equal(contents[0]!.mimeType, "text/html;profile=mcp-app")
  assert.ok(contents[0]!.text.includes(ROOM_A))
  assert.ok(!contents[0]!.text.includes(ROOM_B))
})

test("resources/read with no bearer returns the 401 shape", async () => {
  const { handler } = harness([room(ROOM_A, MEMBERS_A)])
  const res = await handler({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "ui://room_view/view" } }, undefined)
  assert.equal(res.status, 401)
})

test("resources/read with an unknown uri is -32602", async () => {
  const { handler } = harness([room(ROOM_A, MEMBERS_A)])
  const res = asRpc(
    await handler({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "ui://something-else/view" } }, tokenFor(ROOM_A)),
  )
  assert.equal(res.error?.code, -32602)
})

test("resources/read's result carries _meta.ui.csp.connectDomains containing env.publicUrl", async () => {
  const { handler } = harness([room(ROOM_A, MEMBERS_A)])
  const res = asRpc(
    await handler({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "ui://room_view/view" } }, tokenFor(ROOM_A)),
  )
  const contents = res.result?.contents as { _meta?: { ui?: { csp?: { connectDomains?: string[] } } } }[]
  assert.ok(contents[0]?._meta?.ui?.csp?.connectDomains?.includes(env.publicUrl))
})

test("roomViewHtml escapes a room code containing < and \" so it cannot break out of the HTML", () => {
  const html = roomViewHtml(`RDV-<script>"`, env.publicUrl)
  assert.ok(!html.includes(`RDV-<script>"`), "the raw contrived code must not appear unescaped")
  assert.ok(html.includes("&lt;script&gt;"), "escapeHtml must have transformed the angle brackets")
  assert.ok(html.includes("&quot;"), "escapeHtml must have transformed the quote")
})

test("roomViewHtml sends ui/notifications/size-changed, measured by a ResizeObserver (BRIEF-05: this panel's content is its own DOM)", () => {
  const html = roomViewHtml(ROOM_A, env.publicUrl)
  assert.ok(html.includes("ui/notifications/size-changed"), "must send the size-changed notification")
  assert.ok(html.includes("ResizeObserver"), "room_view measures its own DOM instead of sending a constant")
})
