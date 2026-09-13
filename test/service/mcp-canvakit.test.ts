import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { env } from "../../src/env.ts"
import type { Room } from "../../src/rooms/types.ts"
import { ArtifactRenderStore } from "../../src/service/artifact-renders.ts"
import { createMcpCanvakitHandler, roomRenderToken, type McpCanvakitDeps, type McpResponse } from "../../src/service/mcp-canvakit.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Throwaway render-store directories, swept once at the end — the
 *  `read_artifact` tests below write real files, and the default store points
 *  at `env.mediaDir`. */
const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function trackDir(dir: string): string {
  dirs.push(dir)
  return dir
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

/** A minimal `Room`, same shape `mcp-room.test.ts`'s own `room()` helper
 *  builds — only `code` matters to `resolveRoom`. */
function room(code: string): Room {
  return {
    code,
    slug: `slug-${code}`.toLowerCase(),
    sessionId: undefined,
    sandboxId: undefined,
    artifactUrl: undefined,
    artifactReady: undefined,
    members: [],
    createdAt: "2026-09-12T10:00:00.000Z",
    updatedAt: "2026-09-12T10:00:00.000Z",
    cursor: 0,
    lastActivityAt: "2026-09-12T10:00:00.000Z",
    state: "active",
  }
}

interface Harness {
  readonly handler: ReturnType<typeof createMcpCanvakitHandler>
  readonly renders: ArtifactRenderStore
  readonly renderCalls: string[]
}

function harness(overrides?: Partial<Pick<McpCanvakitDeps, "roomExists" | "rooms" | "renderHtml" | "renderPdf">>): Harness {
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

function callParamsNoRoomCode(data: unknown): Record<string, unknown> {
  return { name: "render_artifact", arguments: { data } }
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

test("tools/list advertises write, read and export of the one document, and nothing else", async () => {
  const { handler } = harness()
  const res = asRpc(await handler({ jsonrpc: "2.0", id: "a", method: "tools/list" }, undefined))
  assert.equal(res.status, 200)
  const tools = res.result?.tools
  assert.ok(Array.isArray(tools))
  assert.deepEqual(
    tools.map((tool) => (tool as { name: string }).name),
    ["render_artifact", "read_artifact", "export_artifact"],
    "a closed surface: the document can be written, read back and linked to — and nothing else",
  )
  for (const tool of tools) {
    assert.ok(isRecord(tool))
    assert.ok(isRecord(tool.inputSchema), "every tool must describe its input so the agent fills it first try")
  }

  // Neither read nor export takes arguments — the bearer is the room. A
  // `roomCode` on either would repeat the BRIEF-06 mistake: a value the agent
  // cannot know, and a way to name somebody else's room.
  //
  // And neither carries a UI resource: both return data for the model, not a
  // panel. Pointing a host at render_artifact's panel from a READ would
  // redraw the document every time somebody asked a question about it.
  for (const name of ["read_artifact", "export_artifact"]) {
    const found: unknown = tools.find((candidate) => (candidate as { name: string }).name === name)
    assert.ok(isRecord(found) && isRecord(found.inputSchema))
    assert.deepEqual((found.inputSchema as Record<string, unknown>).properties, {}, `${name} must take no arguments`)
    assert.equal(found._meta, undefined, `${name} must not claim a UI panel`)
  }
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
  assert.ok(isRecord(properties.data.items), "data.items must itself be a schema, not left absent")
})

// BRIEF-05 fix 3: `items: { type: "object" }` is an empty schema — no
// properties for the model to fill in, so gpt-4.1 emitted `data: [{}, {}]`
// every time (a real, traced finding — see mcp-canvakit.ts's comment above
// RENDER_ARTIFACT_TOOL). This asserts the advertised schema has moved to a
// real union with actual properties per block, not just a differently
// empty one.
test("tools/list's data.items is a real union over the five block shapes, not an empty object schema", async () => {
  const { handler } = harness()
  const res = asRpc(await handler({ jsonrpc: "2.0", id: "a", method: "tools/list" }, undefined))
  const tools = res.result?.tools
  assert.ok(Array.isArray(tools))
  const tool = tools[0]
  assert.ok(isRecord(tool) && isRecord(tool.inputSchema))
  const properties = (tool.inputSchema as Record<string, unknown>).properties
  assert.ok(isRecord(properties) && isRecord(properties.data) && isRecord(properties.data.items))
  const items = properties.data.items as Record<string, unknown>
  assert.notDeepEqual(items, { type: "object" }, "the empty-object schema that caused the empty-block bug must be gone")
  const branches = items.oneOf ?? items.anyOf
  assert.ok(Array.isArray(branches), "data.items must be a oneOf/anyOf union")
  assert.equal(branches.length, 5, "one branch per documented block shape")
  const discriminators = branches
    .filter(isRecord)
    .flatMap((branch) => (isRecord(branch.properties) ? Object.keys(branch.properties) : []))
  for (const flag of ["isTitle", "isProse", "isBullets", "isTable", "isFigures"]) {
    assert.ok(discriminators.includes(flag), `${flag} must be a real property somewhere in the union`)
  }
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

// BRIEF-06: nothing in the agent's reachable world tells it its own room
// code — `roster`'s result has no code, and `roomCode`'s own description
// used to hand out the literal example. The fix makes `roomCode` optional
// and resolves it from the bearer, and stops reporting a wrong-but-real
// `roomCode` as the same 401 a bad credential gets.

test("a call with NO roomCode and a valid render token renders and stores under the token's room", async () => {
  const { handler, renders, renderCalls } = harness({ rooms: () => [room(ROOM)] })

  const res = asRpc(
    await handler(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: callParamsNoRoomCode(VALID_DATA) },
      VALID_TOKEN,
    ),
  )

  assert.equal(res.status, 200)
  assert.equal(res.result?.isError, false)
  const content = res.result?.content
  assert.ok(Array.isArray(content) && isRecord(content[0]))
  const payload = JSON.parse(String(content[0].text))
  assert.equal(payload.artifactUrl, `${env.publicUrl}/r/${ROOM}/artifact/`)
  assert.equal(renderCalls.length, 2, "an omitted roomCode must still reach canvakit, resolved from the bearer")
  assert.equal(renders.has(ROOM), true, "the render must be stored under the bearer's room, not nothing")
})

test("a roomCode naming a different room than a real token's is a tool error naming the token's room, not a 401", async () => {
  const { handler, renderCalls, renders } = harness({ rooms: () => [room(ROOM)] })

  const res = asRpc(
    await handler(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: callParams("RDV-OTHER", VALID_DATA) },
      VALID_TOKEN,
    ),
  )

  assert.equal(res.status, 200, "a real token with a wrong roomCode argument is not an auth failure")
  assert.match(res.error?.message ?? "", new RegExp(ROOM), "the error must name the token's REAL room so the agent can self-correct")
  assert.doesNotMatch(res.error?.message ?? "", /unauthorized/)
  assert.equal(renderCalls.length, 0, "a mismatched roomCode must render nothing")
  assert.equal(renders.has(ROOM), false)
})

test("a garbage bearer matching no known room is still a generic 401, even when other rooms are known", async () => {
  const { handler, renderCalls, renders } = harness({ rooms: () => [room(ROOM)] })

  const res = await handler(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: callParams(ROOM, VALID_DATA) },
    "Bearer deadbeef",
  )

  assert.equal(res.status, 401, "no known room matches this bearer at all — the generic 401, not a room-naming error")
  assert.ok("error" in res.body)
  assert.match(res.body.error.message, /unauthorized/)
  assert.equal(renderCalls.length, 0)
  assert.equal(renders.has(ROOM), false)
})

test("tools/list no longer requires roomCode and its description drops the RDV-7F3K example", async () => {
  const { handler } = harness()
  const res = asRpc(await handler({ jsonrpc: "2.0", id: "a", method: "tools/list" }, undefined))
  const tools = res.result?.tools
  assert.ok(Array.isArray(tools))
  const tool = tools[0]
  assert.ok(isRecord(tool) && isRecord(tool.inputSchema))
  const schema = tool.inputSchema as Record<string, unknown>
  assert.ok(Array.isArray(schema.required))
  assert.ok(!schema.required.includes("roomCode"), "roomCode must not be required — the caller may not know it")
  assert.ok(schema.required.includes("data"))
  const properties = schema.properties
  assert.ok(isRecord(properties) && isRecord(properties.roomCode))
  assert.doesNotMatch(
    JSON.stringify(properties.roomCode),
    /RDV-7F3K/,
    "the example code must be gone — it is live bait for a model with no other source",
  )
})

// --- read_artifact (the missing half of render_artifact) ------------------
//
// The bug: the agent could WRITE the room's shared document and never read
// it back, so asked what the document said it answered from an empty context
// while every member looked at the render. `room_view` reports that a
// document exists; this reports what is IN it.

/** A harness whose render store is scoped to a throwaway directory — these
 *  tests write real files, and the default store points at `env.mediaDir`. */
function readHarness(): Harness & { readonly dir: string } {
  const dir = trackDir(mkdtempSync(join(tmpdir(), "rdv-read-artifact-")))
  const renders = new ArtifactRenderStore(dir)
  const renderCalls: string[] = []
  const deps: McpCanvakitDeps = {
    roomExists: (code) => code === ROOM,
    rooms: () => [room(ROOM)],
    renders,
    renderHtml: async () => Buffer.from("<!doctype html><html><body>doc</body></html>"),
    renderPdf: async () => ({ bytes: Buffer.from("%PDF-1.7 fake"), pages: 1 }),
  }
  return { handler: createMcpCanvakitHandler(deps), renders, renderCalls, dir }
}

const READ_CALL = { jsonrpc: "2.0", id: "r", method: "tools/call", params: { name: "read_artifact", arguments: {} } }

function readPayload(res: ReturnType<typeof asRpc>): Record<string, unknown> {
  assert.equal(res.result?.isError, false, "an unrendered or unreadable document is an ANSWER, not a tool failure")
  const content = res.result?.content
  assert.ok(Array.isArray(content) && content.length === 1)
  const first = content[0]
  assert.ok(isRecord(first))
  return JSON.parse(String(first.text)) as Record<string, unknown>
}

test("read_artifact on a room with no render says so, and does not fail", async () => {
  const { handler } = readHarness()
  const payload = readPayload(asRpc(await handler(READ_CALL, VALID_TOKEN)))
  assert.deepEqual(payload, { room_code: ROOM, rendered: false })
})

test("read_artifact round-trips render_artifact's own blocks, unchanged", async () => {
  const { handler } = readHarness()

  const rendered = asRpc(
    await handler(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: callParamsNoRoomCode(VALID_DATA) },
      VALID_TOKEN,
    ),
  )
  assert.equal(rendered.result?.isError, false)

  const payload = readPayload(asRpc(await handler(READ_CALL, VALID_TOKEN)))
  assert.equal(payload.rendered, true)
  assert.equal(payload.source_available, true)
  assert.equal(typeof payload.rendered_at, "string")
  // The whole point: what comes back is what you would hand straight back to
  // render_artifact with edits applied.
  assert.deepEqual(payload.data, VALID_DATA)
})

test("a render whose source was never stored reads as rendered-but-unreadable, NEVER as nothing rendered", async () => {
  const { handler, renders } = readHarness()

  // Exactly the state of every render that landed before source capture
  // existed — including the one on the live room's screen when this was
  // written. `save` without a `source` argument is that state.
  await renders.save(ROOM, Buffer.from("<html>old</html>"), Buffer.from("%PDF-1.7 old"), 2)

  const payload = readPayload(asRpc(await handler(READ_CALL, VALID_TOKEN)))
  assert.equal(payload.rendered, true, "the document is on screen — claiming otherwise is the bug this tool fixes")
  assert.equal(payload.source_available, false)
  assert.equal(payload.data, undefined, "no source means no data field — never an empty array standing in for one")
  assert.match(String(payload.note), /not stored/i)
})

test("read_artifact is bound to the bearer's room: no token, no read, and no argument to name another room", async () => {
  const { handler } = readHarness()

  const anonymous = await handler(READ_CALL, undefined)
  assert.equal(anonymous.status, 401)

  const otherRoom = await handler(READ_CALL, `Bearer ${roomRenderToken("RDV-ZZZZ", env.roomTokenSecret)}`)
  assert.equal(otherRoom.status, 401)

  // Even handed a roomCode, there is nothing to honour it with — the tool
  // takes no arguments, so the bearer decides and nothing else can.
  const withArg = asRpc(
    await handler(
      { jsonrpc: "2.0", id: "r", method: "tools/call", params: { name: "read_artifact", arguments: { roomCode: "RDV-ZZZZ" } } },
      VALID_TOKEN,
    ),
  )
  assert.equal(readPayload(withArg).room_code, ROOM)
})

test("re-rendering replaces the readable source, so a read never returns a previous version's blocks", async () => {
  const { handler } = readHarness()
  const second = [{ isTitle: true, title: "Seminar budget", subtitle: "Final" }]

  for (const data of [VALID_DATA, second]) {
    const res = asRpc(
      await handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: callParamsNoRoomCode(data) }, VALID_TOKEN),
    )
    assert.equal(res.result?.isError, false)
  }

  assert.deepEqual(readPayload(asRpc(await handler(READ_CALL, VALID_TOKEN))).data, second)
})

// --- export_artifact (the document's two shareable links) -----------------

const EXPORT_CALL = {
  jsonrpc: "2.0",
  id: "e",
  method: "tools/call",
  params: { name: "export_artifact", arguments: {} },
}

test("export_artifact on a room with no render offers no URL at all", async () => {
  const { handler } = readHarness()
  const payload = readPayload(asRpc(await handler(EXPORT_CALL, VALID_TOKEN)))
  assert.equal(payload.rendered, false)
  // The point: no link is better than a link that 404s. A dead URL in a
  // WhatsApp message reads as "the system is broken" to whoever opens it,
  // when the truth is only that nobody has rendered anything.
  assert.equal(payload.html_url, undefined)
  assert.equal(payload.pdf_url, undefined)
})

test("export_artifact returns both links and the PDF's size without returning the document", async () => {
  const { handler } = readHarness()
  const rendered = asRpc(
    await handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: callParamsNoRoomCode(VALID_DATA) }, VALID_TOKEN),
  )
  assert.equal(rendered.result?.isError, false)

  const payload = readPayload(asRpc(await handler(EXPORT_CALL, VALID_TOKEN)))
  assert.equal(payload.rendered, true)
  assert.equal(payload.html_url, `${env.publicUrl}/r/${ROOM}/artifact/`)
  assert.equal(payload.pdf_url, `${env.publicUrl}/r/${ROOM}/artifact/deliverable.pdf`)
  assert.equal(payload.pdf_bytes, Buffer.from("%PDF-1.7 fake").length)

  // Links, not contents — an agent that only wants to SEND the document
  // must not have to pull the whole thing into its context to do it. That
  // is read_artifact's job, and the split is the whole reason both exist.
  assert.equal(payload.data, undefined)
  assert.doesNotMatch(JSON.stringify(payload), /Seminar budget/)
})

test("export_artifact reports no page count rather than zero pages for a render hydrated from disk", async () => {
  const { handler, renders } = readHarness()
  // `pages: 0` is the store's "unknown" after a restart — it does not
  // re-parse the PDF. Reporting it verbatim would tell the agent the
  // document has no pages, which it can then repeat to a member.
  await renders.save(ROOM, Buffer.from("<html>x</html>"), Buffer.from("%PDF-1.7 x"), 0)
  const payload = readPayload(asRpc(await handler(EXPORT_CALL, VALID_TOKEN)))
  assert.equal(payload.rendered, true)
  assert.equal(payload.pages, undefined)
})

test("export_artifact is bound to the bearer's room", async () => {
  const { handler } = readHarness()
  assert.equal((await handler(EXPORT_CALL, undefined)).status, 401)
  assert.equal((await handler(EXPORT_CALL, `Bearer ${roomRenderToken("RDV-ZZZZ", env.roomTokenSecret)}`)).status, 401)
})
