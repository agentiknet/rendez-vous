import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { env } from "../../src/env.ts"
import type { Member, Room } from "../../src/rooms/types.ts"
import { ArtifactRenderStore } from "../../src/service/artifact-renders.ts"
import { artifactShowKey, artifactViewHtml } from "../../src/service/artifact-view.html.ts"
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
    slug: `slug-${code}`.toLowerCase(),
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

// ArtifactRenderStore falls back to env.mediaDir (the LIVE store) when built
// with no directory — renderHtml/renderPdf below throw, so nothing here ever
// actually saves, but the store must still never point at the live dir.
const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function trackDir(dir: string): string {
  dirs.push(dir)
  return dir
}

function harness(rooms: readonly Room[]) {
  const deps: McpCanvakitDeps = {
    roomExists: (code) => rooms.some((r) => r.code === code),
    rooms: () => rooms,
    renders: new ArtifactRenderStore(trackDir(mkdtempSync(join(tmpdir(), "rdv-artifact-view-")))),
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

test("resources/read's result carries _meta.ui.csp.frameDomains containing env.publicUrl (BRIEF-03: the panel frames the live artifact in an inner iframe)", async () => {
  const { handler } = harness([room(ROOM_A)])
  const res = asRpc(
    await handler(
      { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "ui://render_artifact/view" } },
      renderTokenFor(ROOM_A),
    ),
  )
  const contents = res.result?.contents as { _meta?: { ui?: { csp?: { frameDomains?: string[] } } } }[]
  assert.ok(contents[0]?._meta?.ui?.csp?.frameDomains?.includes(env.publicUrl))
})

test("artifactViewHtml escapes a code containing < and \" so it cannot break out of the HTML", () => {
  const html = artifactViewHtml(`RDV-<script>"`, env.publicUrl)
  assert.ok(!html.includes(`RDV-<script>"`), "the raw contrived code must not appear unescaped")
  assert.ok(html.includes("&lt;script&gt;"), "escapeHtml must have transformed the angle brackets")
  assert.ok(html.includes("&quot;"), "escapeHtml must have transformed the quote")
})

// BRIEF-05: `artifactViewHtml`'s script embeds `artifactShowKey.toString()`
// verbatim, so driving the exported function directly proves the SHIPPED
// decision, not a string that merely looks right in the template.
test("artifactShowKey has no shown-style one-shot latch: the same ready state with a NEW renderedAt produces a NEW key", () => {
  const first = artifactShowKey(true, "2026-09-12T10:00:00.000Z")
  const second = artifactShowKey(true, "2026-09-12T10:00:03.000Z")
  assert.notEqual(first, second, "two different renders must compare as different, not latch on the first")
})

test("artifactShowKey returns the SAME key for the same renderedAt polled twice — no reload without a real change", () => {
  const a = artifactShowKey(true, "2026-09-12T10:00:00.000Z")
  const b = artifactShowKey(true, "2026-09-12T10:00:00.000Z")
  assert.equal(a, b)
})

test("artifactShowKey is undefined while not ready, regardless of a stale renderedAt — the pause reset still holds", () => {
  assert.equal(artifactShowKey(false, "2026-09-12T10:00:00.000Z"), undefined)
})

test("artifactShowKey is defined but stable for a ready room with no stored render yet (box-only liveness)", () => {
  const a = artifactShowKey(true, undefined)
  const b = artifactShowKey(true, undefined)
  assert.notEqual(a, undefined)
  assert.equal(a, b)
})

test("artifactViewHtml's script contains the renderedAt comparison, not a `shown` boolean gate", () => {
  const html = artifactViewHtml(ROOM_A, env.publicUrl)
  assert.ok(!/\blet shown\s*=\s*false/.test(html), "no boolean latch variable")
  assert.ok(html.includes("artifactShowKey"), "the generated script must embed the pure comparison helper")
})

test("artifactViewHtml cache-busts the iframe src with the render version, but only when one exists", () => {
  const html = artifactViewHtml(ROOM_A, env.publicUrl)
  assert.ok(html.includes('"?v=" + encodeURIComponent(renderedAt)'), "a real renderedAt must cache-bust the src")
})

test("artifactViewHtml sends ui/notifications/size-changed with a constant height (BRIEF-05: the artifact is cross-origin and cannot be measured)", () => {
  const html = artifactViewHtml(ROOM_A, env.publicUrl)
  assert.ok(html.includes("ui/notifications/size-changed"), "must send the size-changed notification")
  assert.ok(html.includes("ARTIFACT_PANEL_HEIGHT"), "the height sent must be the fixed constant, not a measurement")
  assert.ok(!html.includes("ResizeObserver"), "the artifact panel must not attempt to measure its cross-origin content")
})
