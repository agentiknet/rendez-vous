import assert from "node:assert/strict"
import { test } from "node:test"
import { env } from "../../src/env.ts"
import { ArtifactRenderStore } from "../../src/service/artifact-renders.ts"
import { createMcpCanvakitHandler, roomRenderToken, type McpCanvakitDeps, type McpResponse } from "../../src/service/mcp-canvakit.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Flattens a handler response into the fields the assertions below need,
 *  with narrowing `node:test`'s `assert.ok` can't give across union types. */
function asRpc(res: McpResponse): { readonly status: number; readonly result?: Record<string, unknown>; readonly error?: { readonly code: number; readonly message: string } } {
  if (res.status === 202) return { status: 202 }
  if ("result" in res.body) return { status: res.status, result: res.body.result }
  return { status: res.status, error: res.body.error }
}

/** The exact data shape the seeded `data.json` uses — what the agent would
 *  send in `arguments.data`. */
const VALID_DATA = [
  { isTitle: true, title: "Seminar budget", subtitle: "Draft", date: "12 September 2026" },
  { isProse: true, heading: "Overview", paragraphs: ["Costs and room bookings for the autumn seminar."] },
]

const ROOM = "RDV-7F3K"
const VALID_TOKEN = `Bearer ${roomRenderToken(ROOM, env.roomTokenSecret)}`

interface Harness {
  readonly handler: ReturnType<typeof createMcpCanvakitHandler>
  readonly renders: ArtifactRenderStore
  readonly renderCalls: string[]
}

function harness(overrides?: Partial<Pick<McpCanvakitDeps, "roomExists" | "renderHtml" | "renderPdf">>): Harness {
  const renders = new ArtifactRenderStore()
  const renderCalls: string[] = []
  const deps: McpCanvakitDeps = {
    roomExists: (code) => code === ROOM,
    rooms: () => [],
    renders,
    renderHtml: async (dataPath, outPath) => {
      renderCalls.push(`html:${outPath}`)
      return Buffer.from(`<!doctype html><html><body>rendered from ${dataPath}</body></html>`)
    },
    renderPdf: async (_dataPath, _outPath) => {
      renderCalls.push("pdf")
      return { bytes: Buffer.from("%PDF-1.7 fake"), pages: 1 }
    },
    ...overrides,
  }
  return { handler: createMcpCanvakitHandler(deps), renders, renderCalls }
}

function callParams(code: string, data: unknown): Record<string, unknown> {
  return { name: "render_artifact", arguments: { roomCode: code, data } }
}

test("initialize answers with a protocol version, the tool capability, and the echoed id", async () => {
  const { handler } = harness()
  const res = asRpc(await handler({ jsonrpc: "2.0", id: 7, method: "initialize" }, undefined))
  assert.equal(res.status, 200)
  assert.ok(isRecord(res.result))
  assert.equal(typeof res.result?.protocolVersion, "string")
  assert.deepEqual(res.result?.capabilities, { tools: {}, resources: {} })
  assert.ok(isRecord(res.result?.serverInfo) && res.result.serverInfo.name === "rdv-canvakit")
  assert.equal(res.result?.hasOwnProperty("id"), false)
})

test("initialize echoes the request id back (JSON-RPC correlation)", async () => {
  const { handler } = harness()
  const res = await handler({ jsonrpc: "2.0", id: "abc", method: "initialize" }, undefined)
  assert.equal(res.status, 200)
  assert.ok("result" in res.body)
  assert.equal(res.body.id, "abc")
})

test("a notification (no id) gets 202 with no body", async () => {
  const { handler } = harness()
  const res = await handler({ jsonrpc: "2.0", method: "notifications/initialized" }, undefined)
  assert.equal(res.status, 202)
  assert.equal(res.body, undefined)
})

test("tools/list advertises exactly the render_artifact tool with an input schema", async () => {
  const { handler } = harness()
  const res = asRpc(await handler({ jsonrpc: "2.0", id: "a", method: "tools/list" }, undefined))
  assert.equal(res.status, 200)
  const tools = res.result?.tools
  assert.ok(Array.isArray(tools))
  assert.equal(tools.length, 1, "one closed tool surface — render_artifact and nothing else")
  const tool = tools[0]
  assert.ok(isRecord(tool))
  assert.equal(tool.name, "render_artifact")
  assert.ok(isRecord(tool.inputSchema), "the tool must describe its input so the agent can fill it first try")
})

test("tools/list's data property carries an items schema (an array with none is uncallable from OpenAI function-calling)", async () => {
  const { handler } = harness()
  const res = asRpc(await handler({ jsonrpc: "2.0", id: "a", method: "tools/list" }, undefined))
  const tools = res.result?.tools
  assert.ok(Array.isArray(tools))
  const tool = tools[0]
  assert.ok(isRecord(tool) && isRecord(tool.inputSchema))
  const properties = (tool.inputSchema as Record<string, unknown>).properties
  assert.ok(isRecord(properties) && isRecord(properties.data))
  assert.deepEqual(properties.data.items, { type: "object" })
})

test("a call with the room's valid token renders both formats and returns the artifact URL", async () => {
  const { handler, renders, renderCalls } = harness()

  const res = asRpc(
    await handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: callParams(ROOM, VALID_DATA) }, VALID_TOKEN),
  )

  assert.equal(res.status, 200)
  assert.equal(res.result?.isError, false)
  const content = res.result?.content
  assert.ok(Array.isArray(content) && content.length === 1 && isRecord(content[0]) && content[0].type === "text")
  const payload = JSON.parse(String(content[0].text))
  assert.equal(payload.artifactUrl, `${env.publicUrl}/r/${ROOM}/artifact/`)
  assert.equal(payload.pages, 1)
  assert.ok(typeof payload.htmlBytes === "number" && payload.htmlBytes > 0)
  assert.equal(renderCalls.length, 2, "both formats must be rendered from one call")
  // The store now holds the render — exactly what the artifact proxy serves.
  assert.equal(renders.has(ROOM), true)
  const html = await renders.readHtml(ROOM)
  assert.ok(html !== undefined && html.toString().includes("rendered from"))
  const pdf = await renders.readHtml(ROOM)
  assert.ok(pdf !== undefined && pdf.length > 0)
})

test("a call with a WRONG token is rejected and renders nothing", async () => {
  const { handler, renderCalls, renders } = harness()

  const res = await handler(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: callParams(ROOM, VALID_DATA) },
    "Bearer deadbeef",
  )

  assert.equal(res.status, 401, "must be an HTTP-level rejection, not a tool result")
  assert.ok("error" in res.body)
  assert.equal(renderCalls.length, 0, "a rejected call must never reach canvakit")
  assert.equal(renders.has(ROOM), false, "a rejected call must render nothing")
})

test("a call with NO token is rejected and renders nothing", async () => {
  const { handler, renderCalls, renders } = harness()

  const res = await handler(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: callParams(ROOM, VALID_DATA) },
    undefined,
  )

  assert.equal(res.status, 401)
  assert.equal(renderCalls.length, 0)
  assert.equal(renders.has(ROOM), false)
})

test("room A's token cannot render room B's artifact (the token binds to the payload's room code)", async () => {
  const { handler, renderCalls } = harness()

  const res = await handler(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: callParams("RDV-OTHER", VALID_DATA) },
    VALID_TOKEN,
  )

  assert.equal(res.status, 401, "a valid token for room A is INVALID for a call naming room B")
  assert.equal(renderCalls.length, 0)
})

test("an unknown room code is a tool error even with a structurally valid token", async () => {
  const { handler, renderCalls } = harness({ roomExists: () => false })
  const forged = `Bearer ${roomRenderToken("RDV-NOPE", env.roomTokenSecret)}`

  const res = asRpc(
    await handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: callParams("RDV-NOPE", VALID_DATA) }, forged),
  )

  assert.equal(res.status, 200)
  assert.match(res.error?.message ?? "", /unknown room/)
  assert.equal(renderCalls.length, 0)
})

test("a canvakit failure surfaces its error text verbatim as an errored tool result", async () => {
  const CAVAKIT_ERROR =
    'data source "doc" did not resolve: file not found or unreadable: data.json — refusing to render a blank document.'
  const { handler, renderCalls } = harness({
    renderHtml: async () => {
      throw new Error(CAVAKIT_ERROR)
    },
  })

  const res = asRpc(
    await handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: callParams(ROOM, VALID_DATA) }, VALID_TOKEN),
  )

  assert.equal(res.status, 200, "a tool failure is still a valid JSON-RPC response")
  assert.equal(res.result?.isError, true, "the failure must be an errored TOOL result the agent can read")
  const content = res.result?.content
  assert.ok(Array.isArray(content) && content.length === 1 && isRecord(content[0]))
  assert.ok(
    String(content[0].text).includes(CAVAKIT_ERROR),
    "the canvakit text must arrive verbatim, not paraphrased or generic",
  )
  assert.equal(renderCalls.length, 0, "neither render completes; nothing is stored on failure")
  // The panel polls `/r/:code/state` on its own and would show the LAST
  // SUCCESSFUL artifact. Pointing a host at it from a FAILED render is
  // absence reading as delivery in panel form — the success branch carries
  // `_meta.ui.resourceUri`, this one must not.
  assert.equal(
    res.result?._meta,
    undefined,
    "a failed render must not point a host at the artifact panel",
  )
})

test("an unknown tool is a JSON-RPC method-level failure, not a render attempt", async () => {
  const { handler, renderCalls } = harness()

  const res = asRpc(
    await handler(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "render_something_else", arguments: {} } },
      VALID_TOKEN,
    ),
  )

  assert.equal(res.status, 200)
  assert.equal(res.error?.code, -32601)
  assert.equal(renderCalls.length, 0)
})
