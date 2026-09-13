import assert from "node:assert/strict"
import { test } from "node:test"
import { env } from "../../src/env.ts"
import type { Member, Room } from "../../src/rooms/types.ts"
import { ArtifactRenderStore } from "../../src/service/artifact-renders.ts"
import { artifactViewHtml } from "../../src/service/artifact-view.html.ts"
import { roomAudienceToken } from "../../src/service/mcp-room.ts"
import {
  createMcpCanvakitHandler,
  roomRenderToken,
  type McpCanvakitDeps,
  type McpResponse,
} from "../../src/service/mcp-canvakit.ts"

/** Flattens a handler response into the fields the assertions below need,
 *  mirroring mcp-canvakit.test.ts's own `asRpc`. */
function asRpc(res: McpResponse): {
  readonly status: number
  readonly result?: Record<string, unknown>
  readonly error?: { readonly code: number; readonly message: string }
} {
  if (res.status === 202) return { status: 202 }
  if ("result" in res.body) return { status: res.status, result: res.body.result }
  return { status: res.status, error: res.body.error }
}

function member(id: string): Member {
  return {
    id,
    displayName: "Member",
    tier: "messenger",
    address: { provider: "telegram", source: "test", contactRef: `ref-${id}` },
    joinedAt: "2026-09-12T10:00:00.000Z",
  }
}

function room(code: string): Room {
  return {
    code,
    sessionId: undefined,
    sandboxId: undefined,
    artifactUrl: undefined,
    artifactReady: undefined,
    members: [member("m1")],
    createdAt: "2026-09-12T10:00:00.000Z",
    updatedAt: "2026-09-12T10:00:00.000Z",
    cursor: 0,
    lastActivityAt: "2026-09-12T10:00:00.000Z",
    state: "active",
  }
}

const ROOM_A = "RDV-AAAA"
const ROOM_B = "RDV-BBBB"

function harness(rooms: readonly Room[]) {
  const deps: McpCanvakitDeps = {
    roomExists: (code) => rooms.some((r) => r.code === code),
    rooms: () => rooms,
    renders: new ArtifactRenderStore(),
    renderHtml: async () => {
      throw new Error("not used by these tests")
    },
    renderPdf: async () => {
      throw new Error("not used by these tests")
    },
  }
  return { handler: createMcpCanvakitHandler(deps) }
}

function renderTokenFor(code: string): string {
  return `Bearer ${roomRenderToken(code, env.roomTokenSecret)}`
}

function audienceTokenFor(code: string): string {
  return `Bearer ${roomAudienceToken(code, env.roomTokenSecret)}`
}

test("initialize advertises both the tools and resources capabilities", async () => {
  const { handler } = harness([room(ROOM_A)])
  const res = asRpc(await handler({ jsonrpc: "2.0", id: 1, method: "initialize" }, undefined))
  assert.equal(res.status, 200)
  assert.deepEqual(res.result?.capabilities, { tools: {}, resources: {} })
})

test("tools/list carries _meta.ui.resourceUri on render_artifact", async () => {
  const { handler } = harness([room(ROOM_A)])
  const res = asRpc(await handler({ jsonrpc: "2.0", id: 1, method: "tools/list" }, undefined))
  const tools = res.result?.tools as { name: string; _meta?: { ui?: { resourceUri?: string } } }[]
  assert.ok(Array.isArray(tools))
  const renderArtifact = tools.find((tool) => tool.name === "render_artifact")
  assert.ok(renderArtifact !== undefined)
  assert.equal(renderArtifact._meta?.ui?.resourceUri, "ui://render_artifact/view")
})

test("resources/list returns exactly one resource with the right uri and mimeType", async () => {
  const { handler } = harness([room(ROOM_A)])
  const res = asRpc(await handler({ jsonrpc: "2.0", id: 1, method: "resources/list" }, undefined))
  assert.equal(res.status, 200)
  const resources = res.result?.resources as { uri: string; name: string; mimeType: string }[]
  assert.equal(resources.length, 1)
  assert.deepEqual(resources[0], {
    uri: "ui://render_artifact/view",
    name: "render_artifact",
    mimeType: "text/html;profile=mcp-app",
  })
})

test("resources/read with room A's render token returns HTML containing room A's code and not room B's", async () => {
  const { handler } = harness([room(ROOM_A), room(ROOM_B)])
  const res = asRpc(
    await handler(
      { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "ui://render_artifact/view" } },
      renderTokenFor(ROOM_A),
    ),
  )
  assert.equal(res.status, 200)
  const contents = res.result?.contents as { uri: string; mimeType: string; text: string }[]
  assert.equal(contents.length, 1)
  assert.equal(contents[0]!.uri, "ui://render_artifact/view")
  assert.equal(contents[0]!.mimeType, "text/html;profile=mcp-app")
  assert.ok(contents[0]!.text.includes(ROOM_A))
  assert.ok(!contents[0]!.text.includes(ROOM_B))
})

test("resources/read with no bearer returns the 401 shape", async () => {
  const { handler } = harness([room(ROOM_A)])
  const res = await handler(
    { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "ui://render_artifact/view" } },
    undefined,
  )
  assert.equal(res.status, 401)
})

test("resources/read with an unknown uri is -32602", async () => {
  const { handler } = harness([room(ROOM_A)])
  const res = asRpc(
    await handler(
      { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "ui://something-else/view" } },
      renderTokenFor(ROOM_A),
    ),
  )
  assert.equal(res.error?.code, -32602)
})

test("a room's audience token (roster/say/whisper's label) is rejected by canvakit's resources/read", async () => {
  const { handler } = harness([room(ROOM_A)])
  const res = await handler(
    { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "ui://render_artifact/view" } },
    audienceTokenFor(ROOM_A),
  )
  assert.equal(res.status, 401, "the audience: and render: labels grant exactly one capability each")
})

test("resources/read's result carries _meta.ui.csp.connectDomains containing env.publicUrl", async () => {
  const { handler } = harness([room(ROOM_A)])
  const res = asRpc(
    await handler(
      { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "ui://render_artifact/view" } },
      renderTokenFor(ROOM_A),
    ),
  )
  const contents = res.result?.contents as { _meta?: { ui?: { csp?: { connectDomains?: string[] } } } }[]
  assert.ok(contents[0]?._meta?.ui?.csp?.connectDomains?.includes(env.publicUrl))
})

test("artifactViewHtml escapes a code containing < and \" so it cannot break out of the HTML", () => {
  const html = artifactViewHtml(`RDV-<script>"`, env.publicUrl)
  assert.ok(!html.includes(`RDV-<script>"`), "the raw contrived code must not appear unescaped")
  assert.ok(html.includes("&lt;script&gt;"), "escapeHtml must have transformed the angle brackets")
  assert.ok(html.includes("&quot;"), "escapeHtml must have transformed the quote")
})
