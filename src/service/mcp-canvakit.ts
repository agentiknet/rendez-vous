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
import { publicArtifactUrl } from "./artifact-proxy.ts"
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
 *  arguments is a change it can observe mid-room. It is bound anyway: the
 *  handler recomputes `roomRenderToken(roomCode, …)` and rejects a mismatch,
 *  so a token for room A cannot render room B.
 *
 *  `_meta.ui.resourceUri` is carried BOTH here (the `tools/list` definition)
 *  AND on the `tools/call` result — deliberately redundant, for the same
 *  reason `ROOM_VIEW_TOOL`'s doc comment in mcp-room.ts gives: hosts differ
 *  on which one they read. */
const RENDER_ARTIFACT_TOOL = {
  name: "render_artifact",
  description:
    "Render the room's shared document from structured data. Updates the live artifact page every member can open AND produces the deliverable PDF. Call this after writing content — calling it is how members see anything. On error the canvakit message is returned verbatim: read it, fix the data, call again.",
  inputSchema: {
    type: "object",
    properties: {
      roomCode: { type: "string", description: "This room's code, e.g. RDV-7F3K." },
      data: {
        type: "array",
        description:
          "The document as a list of typed blocks. Each block is one of: {isTitle:true,title,subtitle,date}, {isProse:true,heading,paragraphs:[...]}, {isBullets:true,heading,items:[...]}, {isTable:true,heading,head:[3 strings],rows:[{col1,col2,col3}]}, {isFigures:true,items:[{value,label}]}. Blocks are optional and repeatable, in any order.",
      },
    },
    required: ["roomCode", "data"],
  },
  _meta: { ui: { resourceUri: RENDER_ARTIFACT_RESOURCE_URI } },
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

/** Resolve the room `resources/read`'s bearer names (D3): recompute-and-
 *  compare over every known room's `roomRenderToken`, exactly
 *  `mcp-room.ts`'s `resolveRoom` against `roomAudienceToken` — the token is
 *  not reversible, so this is the only honest binding. `render_artifact`
 *  itself does not use this: its own `roomCode` argument is bound directly
 *  in `callRenderTool` (D2). */
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
 *  carry it verbatim. */
function parseRenderArgs(params: Record<string, unknown>):
  | { readonly ok: true; readonly roomCode: string; readonly data: readonly unknown[] }
  | { readonly error: string } {
  const args = params.arguments
  if (!isRecord(args)) return { error: "params.arguments must be an object" }
  const roomCode = args.roomCode
  if (typeof roomCode !== "string" || roomCode.trim().length === 0) {
    return { error: "arguments.roomCode must be a non-empty string" }
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
  const { roomCode, data } = parsed

  // Token must be for THIS room, checked before touching canvakit: a bad
  // token must never render — the render's output is what members see.
  const expected = roomRenderToken(roomCode, env.roomTokenSecret)
  const provided = bearerOf(authorization)
  if (provided === undefined || !tokensMatch(provided, expected)) {
    return {
      status: 401,
      body: {
        jsonrpc: "2.0",
        id,
        error: { code: INVALID_REQUEST, message: "unauthorized: missing or invalid bearer token for this room" },
      },
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
    const record = await deps.renders.save(roomCode, html, pdf.bytes, pdf.pages)
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
      return ok(id, { tools: [RENDER_ARTIFACT_TOOL] })
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
            _meta: { ui: { csp: { connectDomains: [env.publicUrl], resourceDomains: [env.publicUrl] } } },
          },
        ],
      })
    }

    if (method === "tools/call") {
      const tool = params.name
      if (tool !== RENDER_ARTIFACT_TOOL.name) {
        return fail(id, METHOD_NOT_FOUND, `unknown tool: ${String(tool)}`)
      }
      return callRenderTool(params, authorization, id, deps)
    }

    return fail(id, METHOD_NOT_FOUND, `unknown method: ${method}`)
  }
}
