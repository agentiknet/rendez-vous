/**
 * The canvakit render tool, exposed to the sandbox agent as MCP over HTTP.
 *
 * Why HTTP and not stdio: `@canvakit/cli` is not published to npm (its own
 * package.json says "Publish lands in Phase 2"), so the box cannot `npx` it
 * and there is no stdio MCP server inside the sandbox. Canvakit stays on this
 * host — it is the only place with the Chromium PDF export needs — and the
 * box reaches it over the public tunnel (`env.publicUrl`) as a real MCP
 * server mounted on the room's agent session (`DaemonClient.spawnAgent`'s
 * `mcpServers`).
 *
 * A tool with a return value, not a `[[render]]` marker: the agent sees the
 * render's URL, byte sizes and page count on success, and canvakit's own
 * error text VERBATIM on failure — it can read what went wrong and retry
 * without a human in the loop.
 *
 * Auth: a per-room HMAC bearer token (`roomRenderToken`, derived from
 * `env.roomTokenSecret` and the room code). This endpoint sits on a public
 * tunnel and renders whatever it is handed into the page members watch — an
 * unauthenticated version of that is not acceptable. The token binds a call
 * to its room code: a token for room A cannot render room B's artifact.
 *
 * `resources/list`/`resources/read` (BRIEF-02) are `mcp-room.ts`'s
 * `room_view` resources' deliberate sibling: same shape, same reasoning,
 * serving `render_artifact`'s MCP Apps panel (`ui://render_artifact/view`,
 * `artifact-view.html.ts`) instead of `room_view`'s.
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { env } from "../env.ts"
import type { Room } from "../rooms/types.ts"
import { artifactViewHtml } from "./artifact-view.html.ts"
import { publicArtifactPdfUrl, publicArtifactUrl } from "./artifact-proxy.ts"
import { renderArtifactHtml, renderArtifactPdf } from "./artifact-render.ts"
import type { ArtifactRenderStore } from "./artifact-renders.ts"

/** The per-room bearer token for `POST /mcp/canvakit`. Deterministic in the
 *  secret, so the booter can compute the mount's header at spawn time and
 *  the endpoint can recompute it per call with no shared mutable state.
 *  40 hex chars — long enough to be unguessable, short enough for a header. */
export function roomRenderToken(code: string, secret: string): string {
  return createHmac("sha256", secret).update(`render:${code}`).digest("hex").slice(0, 40)
}

/** One MCP server mount in `POST /sessions/agent`'s `mcpServers` body field.
 *  Shape ground-truthed against the daemon's spawn body: an http-transport
 *  server is `{ name, transport, ref, headers }`. */
export interface McpServerMount {
  readonly name: string
  readonly transport: "http"
  readonly ref: string
  readonly headers: Readonly<Record<string, string>>
}

/** The room-scoped mount the e2b booter passes to the daemon. Local rooms
 *  get nothing — there is no artifact to render and no tunnel to reach the
 *  endpoint through. */
export function canvakitMcpServer(code: string): McpServerMount {
  return {
    name: "canvakit",
    transport: "http",
    ref: `${env.publicUrl}/mcp/canvakit`,
    headers: { authorization: `Bearer ${roomRenderToken(code, env.roomTokenSecret)}` },
  }
}

/** Absolute path to the seeded canvakit template the tool renders with. The
 *  agent does not choose the template — the design system is enforced by
 *  construction, the tool only takes the DATA. Resolved from this file's own
 *  location, like `booter.ts`'s `ARTIFACT_SEED_DIR`. */
export const ARTIFACT_TEMPLATE_PATH = fileURLToPath(
  new URL("../../apps/room-artifact/.agentproto/ui/room.canvakit.html", import.meta.url),
)

/** Injectable pieces, so tests can prove auth/render/failure behaviour
 *  without canvakit, a tunnel, or a real room store. */
export interface McpCanvakitDeps {
  /** Room existence check — a token proves knowledge of the room code, but
   *  the room must still exist in the store for the render to be servable. */
  readonly roomExists: (code: string) => boolean
  /** All rooms this endpoint can serve, read fresh per call (BRIEF-02, D3):
   *  `resources/read` has no argument to carry a `roomCode` (unlike
   *  `render_artifact` — see D2's doc on `RENDER_ARTIFACT_TOOL`), so the
   *  bearer is the only signal, resolved by recompute-and-compare over this
   *  list — exactly `mcp-room.ts`'s `resolveRoom`, against `roomRenderToken`
   *  instead of `roomAudienceToken`. */
  readonly rooms: () => readonly Room[]
  readonly renders: ArtifactRenderStore
  /** Render the data file to `outPath` as HTML; resolve with the bytes.
   *  Throw with canvakit's verbatim error text on failure. */
  readonly renderHtml: (dataPath: string, outPath: string) => Promise<Buffer>
  /** Render the data file to `outPath` as PDF; resolve with the bytes and
   *  page count. Throw with canvakit's verbatim error text on failure. */
  readonly renderPdf: (dataPath: string, outPath: string) => Promise<{ bytes: Buffer; pages: number }>
  /** BRIEF-15: record, in the room's own outbox, that the agent re-rendered
   *  the shared document — so every watching surface learns the document
   *  moved on the same stream it already reads, instead of finding out by
   *  chance on its next poll.
   *
   *  Optional, and called ONLY after a successful save: a render that threw
   *  produced nothing and must announce nothing (same rule as the `_meta`
   *  omitted from the error branch below). When it is absent, or when it
   *  throws, the render still succeeds — telling the room is downstream of
   *  the document existing, and must never be able to undo it. */
  readonly recordToolCall?: (code: string, toolName: string, args: unknown) => Promise<void>
}

/** The real deps for production wiring (`http.ts`): the seeded template,
 *  the real canvakit CLI, the real render store. The `roomExists` and `rooms`
 *  closures are supplied by http.ts over its `RoomService` — set them there. */
export function defaultMcpCanvakitDeps(renders: ArtifactRenderStore): McpCanvakitDeps {
  return {
    roomExists: () => false,
    rooms: () => [],
    renders,
    renderHtml: async (dataPath, outPath) => {
      await renderArtifactHtml(ARTIFACT_TEMPLATE_PATH, dataPath, outPath)
      return readFile(outPath)
    },
    renderPdf: async (dataPath, outPath) => {
      const rendered = await renderArtifactPdf(ARTIFACT_TEMPLATE_PATH, dataPath, outPath)
      return { bytes: await readFile(outPath), pages: rendered.pages }
    },
  }
}

// --- JSON-RPC / MCP wire types (hand-rolled, no SDK — the surface is three
// methods and a handful of shapes; an SDK dependency would cost more than it
// buys and the build brief forbids new ones). ----

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602

export type McpResponse =
  | { readonly status: 200 | 401; readonly body: McpResultBody | McpErrorBody }
  | { readonly status: 202; readonly body: undefined }

export interface McpResultBody {
  readonly jsonrpc: "2.0"
  readonly id: string | number | null
  readonly result: Record<string, unknown>
}

export interface McpErrorBody {
  readonly jsonrpc: "2.0"
  readonly id: string | number | null
  readonly error: { readonly code: number; readonly message: string }
}

/** The MCP Apps resource this server serves (BRIEF-02, same spec brief 01's
 *  `ROOM_VIEW_RESOURCE_URI` documents): a host that recognises it renders
 *  `render_artifact`'s tool as a panel instead of (or alongside) its text
 *  result. */
const RENDER_ARTIFACT_RESOURCE_URI = "ui://render_artifact/view"

/** The one tool this server advertises. The input schema mirrors
 *  `apps/room-artifact/.agentproto/ui/data.json`'s shape (a list of typed
 *  blocks) plus the room the render belongs to.
 *
 *  D2: `roomCode` stays an argument, unlike `mcp-room.ts`'s no-argument
 *  tools — the asymmetry is out of scope (BRIEF-02) because a live room's
 *  agent is running against the current schema and changing a tool's
 *  arguments is a change it can observe mid-room. It is now OPTIONAL
 *  (BRIEF-06): nothing in the agent's reachable world tells it its own room
 *  code, so a caller that omits it gets the room its bearer token is for,
 *  via `resolveRoom`. Supplying it is still bound: the handler rejects a
 *  `roomCode` that names a room other than the token's, so a token for room
 *  A still cannot render room B — but that rejection is a tool-level
 *  `INVALID_PARAMS`, not a 401 (`callRenderTool`'s doc comment).
 *
 *  `_meta.ui.resourceUri` is carried BOTH here (the `tools/list` definition)
 *  AND on the `tools/call` result — deliberately redundant, for the same
 *  reason `ROOM_VIEW_TOOL`'s doc comment in mcp-room.ts gives: hosts differ
 *  on which one they read. */

// BRIEF-05 fix 3: `items: { type: "object" }` (an empty object schema, no
// properties) got past OpenAI's "array must have items" validator, but an
// empty schema is what the model decodes against — the schema wins over the
// prose description every time, so gpt-4.1 emitted `data: [{}, {}]`
// (traced live; rdv-copilotkit-host/REPORT.md's Test 1 "Related bug"
// paragraph). These five shapes are the real union the description already
// documented in prose; `parseRenderArgs` stays exactly as permissive as
// before (a wrong shape still comes back as canvakit's verbatim error, the
// design this repo wants) — only the ADVERTISED schema changes, so the
// model has real properties to fill in instead of nothing.
const TITLE_BLOCK_SCHEMA = {
  type: "object",
  properties: {
    isTitle: { const: true },
    title: { type: "string" },
    subtitle: { type: "string" },
    date: { type: "string" },
  },
  required: ["isTitle", "title"],
} as const

const PROSE_BLOCK_SCHEMA = {
  type: "object",
  properties: {
    isProse: { const: true },
    heading: { type: "string" },
    paragraphs: { type: "array", items: { type: "string" } },
  },
  required: ["isProse", "paragraphs"],
} as const

const BULLETS_BLOCK_SCHEMA = {
  type: "object",
  properties: {
    isBullets: { const: true },
    heading: { type: "string" },
    items: { type: "array", items: { type: "string" } },
  },
  required: ["isBullets", "items"],
} as const

const TABLE_ROW_SCHEMA = {
  type: "object",
  properties: {
    col1: { type: "string" },
    col2: { type: "string" },
    col3: { type: "string" },
  },
  required: ["col1", "col2", "col3"],
} as const

const TABLE_BLOCK_SCHEMA = {
  type: "object",
  properties: {
    isTable: { const: true },
    heading: { type: "string" },
    head: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
    rows: { type: "array", items: TABLE_ROW_SCHEMA },
  },
  required: ["isTable", "head", "rows"],
} as const

const FIGURE_SCHEMA = {
  type: "object",
  properties: {
    value: { type: "string" },
    label: { type: "string" },
  },
  required: ["value", "label"],
} as const

const FIGURES_BLOCK_SCHEMA = {
  type: "object",
  properties: {
    isFigures: { const: true },
    items: { type: "array", items: FIGURE_SCHEMA },
  },
  required: ["isFigures", "items"],
} as const

const RENDER_ARTIFACT_TOOL = {
  name: "render_artifact",
  description:
    "Render the room's shared document from structured data. Updates the live artifact page every member can open AND produces the deliverable PDF. Call this after writing content — calling it is how members see anything. On error the canvakit message is returned verbatim: read it, fix the data, call again.",
  inputSchema: {
    type: "object",
    properties: {
      roomCode: {
        type: "string",
        description:
          "Optional. Defaults to the room this connection's token is for — omit it unless you are deliberately targeting a specific room.",
      },
      data: {
        type: "array",
        items: {
          oneOf: [
            TITLE_BLOCK_SCHEMA,
            PROSE_BLOCK_SCHEMA,
            BULLETS_BLOCK_SCHEMA,
            TABLE_BLOCK_SCHEMA,
            FIGURES_BLOCK_SCHEMA,
          ],
        },
        description:
          "The document as a list of typed blocks. Each block is one of: {isTitle:true,title,subtitle,date}, {isProse:true,heading,paragraphs:[...]}, {isBullets:true,heading,items:[...]}, {isTable:true,heading,head:[3 strings],rows:[{col1,col2,col3}]}, {isFigures:true,items:[{value,label}]}. Blocks are optional and repeatable, in any order.",
      },
    },
    required: ["data"],
  },
  _meta: { ui: { resourceUri: RENDER_ARTIFACT_RESOURCE_URI } },
} as const

/** `read_artifact` — the missing half of `render_artifact`.
 *
 *  Until this existed the agent could WRITE the room's shared document and
 *  never read it back: asked what was on the screen it answered from an
 *  empty context while the members looked at the render. `room_view` now
 *  reports that a document EXISTS; this reports what is in it.
 *
 *  NO ARGUMENTS, deliberately — the BRIEF-06 lesson, not re-learned: the
 *  bearer token already names exactly one room, and a `roomCode` argument
 *  would be both a way to name another room and a value the agent has no
 *  reliable way to know.
 *
 *  Returns the typed BLOCKS, not the rendered HTML: an agent asked to fix a
 *  heading needs the thing it would pass back to `render_artifact`, and the
 *  page is mostly stylesheet. Feed the result straight back to
 *  `render_artifact` with the edits applied — the round trip is the point.
 *
 *  No `_meta.ui.resourceUri`: this is data for the model, not a panel. The
 *  panel is `render_artifact`'s, and pointing a host at it from a read would
 *  redraw the document on every question asked about it. */
/** `export_artifact` — the document's two shareable URLs and nothing else.
 *
 *  Split from `read_artifact` on purpose: an agent that wants to SEND the
 *  document should not have to pull the whole thing into its context first.
 *  Read is for contents, export is for links.
 *
 *  Both URLs already existed as bytes: the live page has been served at
 *  `publicArtifactUrl` since the first render, and the PDF has sat in the
 *  render store with no URL at all. Nothing new is generated here — this
 *  tool tells the agent the addresses of things it already made.
 *
 *  It does NOT send. Handing the links to members is `say`'s job, which is
 *  already member-scoped; sending to somebody who is NOT in the room stays
 *  behind the confirm-token gate in `deliverable.ts`, which exists precisely
 *  so one member cannot email a stranger under the room owner's agentpush
 *  identity. A tool that sent from here would route around that gate. */
const EXPORT_ARTIFACT_TOOL = {
  name: "export_artifact",
  description:
    "Get THIS room's shared document as shareable links: a live HTML page and a PDF. Use this when someone asks for the document, a copy, a PDF, or a link to send. Both URLs are stable and safe to paste into a message — pass them to `say`/`whisper` to deliver them. Returns {rendered:false} when nothing has been rendered yet: render it first, do not invent a URL. This tool does not send anything by itself.",
  inputSchema: { type: "object", properties: {} },
} as const

const READ_ARTIFACT_TOOL = {
  name: "read_artifact",
  description:
    "Read back THIS room's shared document as the same typed blocks render_artifact takes. Call it before answering any question about what the document says, and before editing it — edit the blocks you get back and pass them to render_artifact. Returns {rendered:false} when nothing has been rendered. Returns {rendered:true, source_available:false} when a document exists but its source was not kept: the document IS on screen, you simply cannot read it — say that, never that nothing has been rendered.",
  inputSchema: { type: "object", properties: {} },
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function bearerOf(authorization: string | undefined): string | undefined {
  if (authorization === undefined) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  return match?.[1]?.trim() ?? undefined
}

function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8")
  const bufB = Buffer.from(b, "utf8")
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

function ok(id: string | number | null, result: Record<string, unknown>): McpResponse {
  return { status: 200, body: { jsonrpc: "2.0", id, result } }
}

function fail(id: string | number | null, code: number, message: string): McpResponse {
  return { status: 200, body: { jsonrpc: "2.0", id, error: { code, message } } }
}

function unauthorized(id: string | number | null): McpResponse {
  return {
    status: 401,
    body: {
      jsonrpc: "2.0",
      id,
      error: { code: INVALID_REQUEST, message: "unauthorized: missing or invalid bearer token for this room" },
    },
  }
}

/** Resolve the room a bearer names: recompute-and-compare over every known
 *  room's `roomRenderToken`, exactly `mcp-room.ts`'s `resolveRoom` against
 *  `roomAudienceToken` — the token is not reversible, so this is the only
 *  honest binding. Used by `resources/read` (D3, the only signal it has) and
 *  by `callRenderTool` (BRIEF-06) when `render_artifact`'s `roomCode` is
 *  omitted or wrong. */
function resolveRoom(deps: McpCanvakitDeps, authorization: string | undefined): Room | undefined {
  const provided = bearerOf(authorization)
  if (provided === undefined) return undefined
  for (const room of deps.rooms()) {
    if (tokensMatch(provided, roomRenderToken(room.code, env.roomTokenSecret))) return room
  }
  return undefined
}

/** Validate the tool's `arguments` into the pieces the renderer needs.
 *  Returns the failure reason instead of throwing, so the JSON-RPC error can
 *  carry it verbatim. `roomCode` is optional (BRIEF-06): a caller has no
 *  reliable way to know its own room code, so a missing one is not a parse
 *  error — `callRenderTool` resolves it from the bearer instead. A PRESENT
 *  `roomCode` that is not a string is still rejected here. */
function parseRenderArgs(params: Record<string, unknown>):
  | { readonly ok: true; readonly roomCode: string | undefined; readonly data: readonly unknown[] }
  | { readonly error: string } {
  const args = params.arguments
  if (!isRecord(args)) return { error: "params.arguments must be an object" }
  const roomCode = args.roomCode
  if (roomCode !== undefined && typeof roomCode !== "string") {
    return { error: "arguments.roomCode must be a string" }
  }
  const data = args.data
  if (!Array.isArray(data)) {
    return { error: "arguments.data must be an array of document blocks (see tools/list's inputSchema)" }
  }
  return { ok: true, roomCode, data: [...data] }
}

async function callRenderTool(
  params: Record<string, unknown>,
  authorization: string | undefined,
  id: string | number | null,
  deps: McpCanvakitDeps,
): Promise<McpResponse> {
  const parsed = parseRenderArgs(params)
  if ("error" in parsed) {
    return fail(id, INVALID_PARAMS, `render_artifact: ${parsed.error}`)
  }
  const { data } = parsed
  const requested = parsed.roomCode?.trim()

  let roomCode: string
  if (requested === undefined || requested.length === 0) {
    // No room code supplied (BRIEF-06: the agent has no reliable way to know
    // its own room's code) — the bearer IS the room, recompute-and-compare
    // it against every known room exactly like `resources/read` does.
    const room = resolveRoom(deps, authorization)
    if (room === undefined) return unauthorized(id)
    roomCode = room.code
  } else {
    // A room code WAS supplied: the fast path stays a direct token check
    // (no `deps.rooms()` lookup needed) so a token for exactly this room
    // still renders even if the caller's `rooms()` list is incomplete.
    const expected = roomRenderToken(requested, env.roomTokenSecret)
    const provided = bearerOf(authorization)
    if (provided !== undefined && tokensMatch(provided, expected)) {
      roomCode = requested
    } else {
      // The token is not valid for the room NAMED, but it may still be a
      // valid token for a DIFFERENT room — that is a wrong argument, not a
      // bad credential, and must not be reported as the same 401 (BRIEF-06):
      // a caller with a real token for room X but a wrong `roomCode` needs
      // to be told X, not sent down a "check your permissions" dead end.
      const room = resolveRoom(deps, authorization)
      if (room === undefined) return unauthorized(id)
      return fail(
        id,
        INVALID_PARAMS,
        `render_artifact: this token is for room ${room.code}, not ${requested} — omit roomCode or pass ${room.code}.`,
      )
    }
  }

  if (!deps.roomExists(roomCode)) {
    return fail(id, INVALID_PARAMS, `render_artifact: unknown room ${roomCode}`)
  }

  const workDir = await mkdtemp(join(tmpdir(), "rdv-mcp-render-"))
  try {
    const dataPath = join(workDir, "data.json")
    await writeFile(dataPath, JSON.stringify(data, null, 2), "utf8")
    // Canvakit failures reach the agent verbatim: no wrapping, no paraphrase.
    // A render error is a TOOL result (isError: true), not a JSON-RPC error —
    // the agent must be able to read it either way.
    const html = await deps.renderHtml(dataPath, join(workDir, "index.html"))
    const pdf = await deps.renderPdf(dataPath, join(workDir, "deliverable.pdf"))
    // `data` is stored alongside the render so `read_artifact` can hand the
    // document back in the shape it was written in.
    const record = await deps.renders.save(roomCode, html, pdf.bytes, pdf.pages, data)
    // BRIEF-15: the room learns the document moved, on the outbox it already
    // drains. After the save, never before — announcing a render that then
    // failed is the lie this whole file is built to avoid.
    //
    // The recorded args are a SUMMARY, not the verbatim call: `data` is the
    // whole document and would be copied into one outbox record per watching
    // member, where the retention floor then pins it. A client that wants the
    // content calls `read_artifact`, which is what that tool is for. Said
    // plainly here because `TOOL_CALL_ARGS` normally means "exactly what the
    // tool was called with", and this one does not.
    if (deps.recordToolCall !== undefined) {
      try {
        await deps.recordToolCall(roomCode, RENDER_ARTIFACT_TOOL.name, {
          roomCode,
          blocks: data.length,
          artifactUrl: publicArtifactUrl(roomCode),
        })
      } catch (error: unknown) {
        // Never fatal: the document exists and the agent must be told so.
        const why = error instanceof Error ? error.message : String(error)
        console.error(`failed to record the render of ${roomCode} in the outbox: ${why}`)
      }
    }
    return {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                artifactUrl: publicArtifactUrl(roomCode),
                htmlBytes: record.htmlBytes,
                pdfBytes: record.pdfBytes,
                pages: record.pages,
              }),
            },
          ],
          isError: false,
          // Redundant with the `tools/list` definition's `_meta` — see
          // `RENDER_ARTIFACT_TOOL`'s doc comment for why both are written.
          _meta: { ui: { resourceUri: RENDER_ARTIFACT_RESOURCE_URI } },
        },
      },
    }
  } catch (error) {
    return {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          // NO `_meta.ui.resourceUri` here, deliberately — unlike the success
          // branch above. A failed render produced nothing, but the panel
          // polls `/r/:code/state` on its own and would happily show the LAST
          // SUCCESSFUL artifact: pointing a host at it from an error result
          // makes a render that produced nothing present as a render that
          // produced something. Absence reading as delivery, in panel form.
          // The verbatim canvakit error in `content` is the whole result.
          isError: true,
        },
      },
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

/** `read_artifact`'s handler. Three outcomes, kept distinct on purpose —
 *  collapsing any two of them is how a tool starts lying:
 *
 *    1. no render at all          → `{ rendered: false }`
 *    2. render, source kept       → `{ rendered: true, rendered_at, data }`
 *    3. render, source NOT kept   → `{ rendered: true, rendered_at,
 *                                      source_available: false, … }`
 *
 *  (3) is real: every render that landed before `source.json` existed is in
 *  it, including the one currently on the live RDV-EGCK room's screen. It
 *  MUST NOT come back as (1) — that is precisely the bug this tool was added
 *  to fix, reintroduced one layer down.
 *
 *  `isError` stays false in all three: "nothing is rendered" is an answer,
 *  not a failure, and an agent that sees `isError: true` retries instead of
 *  reporting. */
async function callReadTool(
  authorization: string | undefined,
  id: string | number | null,
  deps: McpCanvakitDeps,
): Promise<McpResponse> {
  const room = resolveRoom(deps, authorization)
  if (room === undefined) return unauthorized(id)

  const record = await deps.renders.getOrLoad(room.code)
  if (record === undefined) {
    return ok(id, {
      content: [{ type: "text", text: JSON.stringify({ room_code: room.code, rendered: false }) }],
      isError: false,
    })
  }

  const source = await deps.renders.readSource(room.code)
  const payload =
    source === undefined
      ? {
          room_code: room.code,
          rendered: true,
          rendered_at: record.renderedAt,
          source_available: false,
          note: "A document IS rendered and members can see it, but its source was not stored (it predates source capture). Do not describe its contents, and do not say nothing has been rendered. Rendering again through render_artifact replaces it and makes it readable.",
        }
      : {
          room_code: room.code,
          rendered: true,
          rendered_at: record.renderedAt,
          source_available: true,
          data: source,
        }
  return ok(id, {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: false,
  })
}

/** `export_artifact`'s handler. Reports only what it can verify: the URLs
 *  come back when a render is actually stored, and `{ rendered: false }`
 *  otherwise — never a URL for a document that does not exist. A link that
 *  404s reads as "the system is broken" to whoever was sent it, when the
 *  truth is simply that nobody rendered anything yet. */
async function callExportTool(
  authorization: string | undefined,
  id: string | number | null,
  deps: McpCanvakitDeps,
): Promise<McpResponse> {
  const room = resolveRoom(deps, authorization)
  if (room === undefined) return unauthorized(id)

  const record = await deps.renders.getOrLoad(room.code)
  const payload =
    record === undefined
      ? {
          room_code: room.code,
          rendered: false,
          note: "Nothing has been rendered in this room yet, so there is no link to share. Call render_artifact first.",
        }
      : {
          room_code: room.code,
          rendered: true,
          rendered_at: record.renderedAt,
          html_url: publicArtifactUrl(room.code),
          pdf_url: publicArtifactPdfUrl(room.code),
          pdf_bytes: record.pdfBytes,
          // `pages` is 0 for a record hydrated from disk after a restart —
          // the store does not re-parse the PDF to recover it. Reported as
          // absent rather than as zero pages, which would be a lie about a
          // document that plainly has some.
          ...(record.pages > 0 ? { pages: record.pages } : {}),
        }
  return ok(id, { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false })
}

/**
 * Handle one JSON-RPC 2.0 request body (already JSON.parse'd) with its
 * `Authorization` header value: `initialize`, `notifications/initialized`,
 * `tools/list`, `tools/call`, plus `resources/list`/`resources/read`
 * (BRIEF-02), the MCP Apps half `render_artifact`'s panel is served from.
 * Unknown methods are `-32601`; notifications (`id` absent) get `202`.
 */
export function createMcpCanvakitHandler(
  deps: McpCanvakitDeps,
): (body: unknown, authorization: string | undefined) => Promise<McpResponse> {
  return async (body, authorization) => {
    if (!isRecord(body) || typeof body.method !== "string") {
      return fail(null, PARSE_ERROR, "request must be a JSON-RPC 2.0 object with a method")
    }
    const method = body.method
    const id = typeof body.id === "string" || typeof body.id === "number" ? body.id : body.id === null ? null : undefined

    if (id === undefined) {
      // A notification (no id): acknowledged, no response body. Covers the
      // client's `notifications/initialized` after `initialize`.
      return { status: 202, body: undefined }
    }

    const params = isRecord(body.params) ? body.params : {}

    if (method === "initialize") {
      return ok(id, {
        protocolVersion: "2025-06-18",
        // `resources: {}` (BRIEF-02, mirroring mcp-room.ts's BRIEF-01
        // capability) advertises `render_artifact`'s panel. A host that does
        // not see this capability never calls `resources/list`, so a client
        // stuck on the plain-tools reading of this server keeps working
        // exactly as before.
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "rdv-canvakit", version: "1.0.0" },
      })
    }

    if (method === "tools/list") {
      return ok(id, { tools: [RENDER_ARTIFACT_TOOL, READ_ARTIFACT_TOOL, EXPORT_ARTIFACT_TOOL] })
    }

    if (method === "resources/list") {
      return ok(id, {
        resources: [
          { uri: RENDER_ARTIFACT_RESOURCE_URI, name: "render_artifact", mimeType: "text/html;profile=mcp-app" },
        ],
      })
    }

    if (method === "resources/read") {
      // Bearer checked before the uri, same reason `tools/call` checks it
      // first: a rejected call must reveal nothing, not even that a room
      // exists.
      const room = resolveRoom(deps, authorization)
      if (room === undefined) return unauthorized(id)

      if (params.uri !== RENDER_ARTIFACT_RESOURCE_URI) {
        return fail(id, INVALID_PARAMS, `unknown resource uri: ${String(params.uri)}`)
      }

      return ok(id, {
        contents: [
          {
            uri: RENDER_ARTIFACT_RESOURCE_URI,
            mimeType: "text/html;profile=mcp-app",
            text: artifactViewHtml(room.code, env.publicUrl),
            // Load-bearing, not decoration: the panel polls `env.publicUrl`
            // itself and (D1's fetch fallback) may fetch the artifact from
            // it too — a host that sandboxes the panel without this
            // allowlist renders it once and then never updates, the exact
            // silent-stop failure this repo exists to avoid.
            //
            // `frameDomains` is equally load-bearing, for a different reason:
            // this panel renders the live artifact through an inner
            // `<iframe src="…/r/:code/artifact/">`, and the CSP schema's own
            // rule is "empty or omitted → no nested iframes allowed
            // (`frame-src 'none'`)". A host that enforces that (unlike the
            // CopilotKit build this was verified against, which wildcards
            // `frame-src` and never reads this field) would otherwise block
            // the inner frame with no recourse.
            _meta: {
              ui: {
                csp: {
                  connectDomains: [env.publicUrl],
                  resourceDomains: [env.publicUrl],
                  frameDomains: [env.publicUrl],
                },
              },
            },
          },
        ],
      })
    }

    if (method === "tools/call") {
      const tool = params.name
      if (tool === READ_ARTIFACT_TOOL.name) {
        return callReadTool(authorization, id, deps)
      }
      if (tool === EXPORT_ARTIFACT_TOOL.name) {
        return callExportTool(authorization, id, deps)
      }
      if (tool !== RENDER_ARTIFACT_TOOL.name) {
        return fail(id, METHOD_NOT_FOUND, `unknown tool: ${String(tool)}`)
      }
      return callRenderTool(params, authorization, id, deps)
    }

    return fail(id, METHOD_NOT_FOUND, `unknown method: ${method}`)
  }
}
