/**
 * Typed daemon client — native fetch only, no dependencies. Every request
 * shape here is ground-truthed in docs/DAEMON-NOTES.md against a live
 * daemon; see that file for raw request/response samples.
 */

import { parseTranscriptRecord, type TranscriptRecord } from "./records.ts"
import { sseData } from "./sse.ts"

export interface DaemonClientOptions {
  readonly baseUrl: string
  readonly token: string | undefined
}

export interface HealthResult {
  readonly status: string
  readonly version: string
  readonly buildSha: string | undefined
}

/** Inline `SandboxSpec` (AIP-36) plus the `reuse` reconnect field, the exact
 *  subset `POST /sessions/agent`'s `sandbox` body field forwards to the
 *  daemon's `sandboxSpecWithReuseSchema` (`sandbox-spec-schema.ts`). `reuse`
 *  accepts a prior spawn's `sandboxId` and reconnects to that box instead of
 *  booting a fresh one — the provider must support it (e2b does). */
export interface SandboxSpecInput {
  readonly provider: string
  /** `setupCommands`/`installPackages` are the e2b provider's own array-typed
   *  config fields (`E2bSandboxConfig`, `provider.ts`) — `setupCommands` runs
   *  BEFORE the box's daemon starts and before any `app_install`/`appServe`
   *  call, on every boot AND every reconnect, so it's the deterministic
   *  seeding hook `src/sandbox/app-seed.ts` targets. */
  readonly config: Record<string, string | number | boolean | string[]>
  readonly reuse?: string
  readonly extraPorts?: number[]
}

/** WP3 in-box app serve request (`SandboxAppServeSpec`, `sandbox-app-serve.ts`).
 *  `dir` must be an absolute path INSIDE the sandbox filesystem, not on this
 *  host — see docs/UPSTREAM.md and src/sandbox/boot.ts for how that dir gets
 *  populated before this can succeed. */
export interface AppServeSpecInput {
  readonly dir: string
  readonly port?: number
}

/** `SessionAppServeInfo`'s caller-visible subset (`sandbox-app-serve.ts`
 *  also carries `appId`/`dir`, omitted here — not needed by any caller in
 *  this repo). `ready: false` means the URL is the right address but the
 *  server hadn't answered within the daemon's readiness window yet. */
export interface AppServeResultInfo {
  readonly url: string
  readonly port: number
  readonly ready: boolean
}

export interface SpawnAgentInput {
  readonly adapter: string
  readonly model: string
  readonly cwd: string
  readonly label: string
  readonly prompt?: string
  readonly sandbox?: string | SandboxSpecInput
  readonly appServe?: AppServeSpecInput
  /** MCP servers mounted on the spawned session. The shape the daemon
   *  accepts on `POST /sessions/agent`'s `mcpServers` field — an
   *  http-transport server is `{ name, transport, ref, headers }`
   *  (src/service/mcp-canvakit.ts's `McpServerMount`). Omit for none. */
  readonly mcpServers?: readonly McpServerMount[]
}

/** One MCP server mount — re-declared here rather than imported from
 *  `mcp-canvakit.ts` so the daemon client stays dependency-free. */
export interface McpServerMount {
  readonly name: string
  readonly transport: "http"
  readonly ref: string
  readonly headers: Readonly<Record<string, string>>
}

export interface SpawnAgentResult {
  readonly id: string
  readonly status: string
  readonly sandboxId: string | undefined
  readonly appServe: AppServeResultInfo | undefined
}

/** Thrown by `spawnAgent` specifically for a `401` — the bearer the daemon
 *  currently expects does not match the one this request sent (BRIEF-22).
 *  Distinguished from every other `spawnAgent` failure so a caller can
 *  answer it with a room-visible notice instead of a generic throw: it is
 *  never transient (retrying will not make a stale token valid), and it is
 *  the one failure mode a member has no way to diagnose from their own side. */
export class SpawnAgentUnauthorizedError extends Error {
  constructor(body: string) {
    super(`spawnAgent failed: 401 ${body}`)
    this.name = "SpawnAgentUnauthorizedError"
  }
}

export interface PromptInput {
  readonly prompt: string
  readonly queue: boolean
  readonly origin: string
  readonly force?: boolean
}

export type PromptFailureReason = "mid-turn" | "not-alive" | "not-found" | "unauthorized" | "other"

export type PromptResult =
  | { readonly ok: true; readonly queued: false }
  | { readonly ok: true; readonly queued: true; readonly queueId: string; readonly queuePosition: number }
  | { readonly ok: false; readonly reason: PromptFailureReason; readonly status: number; readonly message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key]
  return typeof v === "string" ? v : undefined
}

function numberField(rec: Record<string, unknown>, key: string): number | undefined {
  const v = rec[key]
  return typeof v === "number" ? v : undefined
}

function recordField(rec: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = rec[key]
  return isRecord(v) ? v : undefined
}

function booleanField(rec: Record<string, unknown>, key: string): boolean | undefined {
  const v = rec[key]
  return typeof v === "boolean" ? v : undefined
}

/** Parse the descriptor's `appServe` field (`SessionAppServeInfo`) into the
 *  caller-visible subset. Returns undefined on a shape mismatch — the
 *  caller then treats the spawn as having produced no artifact rather than
 *  throwing on an unexpected but non-fatal field drift. */
function parseAppServeResult(rec: Record<string, unknown>): AppServeResultInfo | undefined {
  const url = stringField(rec, "url")
  const port = numberField(rec, "port")
  const ready = booleanField(rec, "ready")
  if (url === undefined || port === undefined || ready === undefined) return undefined
  return { url, port, ready }
}

/** Classify a non-2xx `/sessions/:id/prompt?wait=false` response.
 *  - `401` → the bearer was missing or wrong (`sessions_unauthorized`).
 *  - `404` → `send_prompt_failed` with a "no session" message.
 *  - `409` with `error: "session_not_alive"` → the session exists but its
 *    process died or exited.
 *  - `409` with a "mid-turn" message → the busy rejection R3 describes;
 *    this is exactly what a caller forgetting `queue: true` hits.
 *  All shapes are ground-truthed in docs/DAEMON-NOTES.md. */
function classifyPromptError(status: number, errorCode: string | undefined, message: string): PromptFailureReason {
  if (status === 401) return "unauthorized"
  if (status === 404) return "not-found"
  if (status === 409) {
    if (errorCode === "session_not_alive") return "not-alive"
    if (message.includes("mid-turn")) return "mid-turn"
    return "not-alive"
  }
  return "other"
}

export class DaemonClient {
  private readonly baseUrl: string
  private readonly token: string | undefined

  constructor(opts: DaemonClientOptions) {
    this.baseUrl = opts.baseUrl.endsWith("/") ? opts.baseUrl.slice(0, -1) : opts.baseUrl
    this.token = opts.token
  }

  private authHeaders(): Record<string, string> {
    return this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {}
  }

  async health(): Promise<HealthResult> {
    const res = await fetch(`${this.baseUrl}/health`)
    const body: unknown = await res.json()
    if (!isRecord(body)) throw new Error("malformed /health response")
    const status = stringField(body, "status")
    const version = stringField(body, "version")
    if (status === undefined || version === undefined) {
      throw new Error(`malformed /health response: ${JSON.stringify(body).slice(0, 200)}`)
    }
    const build = recordField(body, "build")
    const buildSha = build !== undefined ? stringField(build, "sha") : undefined
    return { status, version, buildSha }
  }

  async spawnAgent(input: SpawnAgentInput): Promise<SpawnAgentResult> {
    const res = await fetch(`${this.baseUrl}/sessions/agent`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeaders() },
      body: JSON.stringify({
        adapter: input.adapter,
        model: input.model,
        cwd: input.cwd,
        label: input.label,
        dedupe: false,
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.sandbox !== undefined ? { sandbox: input.sandbox } : {}),
        ...(input.appServe !== undefined ? { appServe: input.appServe } : {}),
        ...(input.mcpServers !== undefined ? { mcpServers: input.mcpServers } : {}),
      }),
    })
    const body: unknown = await res.json()
    if (!isRecord(body)) throw new Error("malformed /sessions/agent response")
    if (!res.ok) {
      const detail = JSON.stringify(body).slice(0, 200)
      if (res.status === 401) throw new SpawnAgentUnauthorizedError(detail)
      throw new Error(`spawnAgent failed: ${res.status} ${detail}`)
    }
    const id = stringField(body, "id")
    const status = stringField(body, "status")
    if (id === undefined || status === undefined) {
      throw new Error(`malformed /sessions/agent response: ${JSON.stringify(body).slice(0, 200)}`)
    }
    const sandboxId = stringField(body, "sandboxId")
    const appServeRaw = recordField(body, "appServe")
    const appServe = appServeRaw !== undefined ? parseAppServeResult(appServeRaw) : undefined
    return { id, status, sandboxId, appServe }
  }

  /**
   * Always fire-and-forget (`?wait=false`) — the blocking arm of this route
   * does not support `queue`/`force` at all (DAEMON-NOTES.md, "Queue
   * behaviour"). The daemon hardcodes `origin: "user"` server-side for this
   * route regardless of what the body sends (`http-server.ts` ~4453 calls
   * `registry.enqueuePrompt(id, prompt, { ..., origin: "user" })` — the
   * body's `origin` field is parsed but never read into that call). We still
   * send it for forward-compat; the attribution the agent actually sees
   * comes from the `[displayName · tier]` text prefix, not this field.
   *
   * Never throws on a daemon-level rejection (busy, dead session, bad auth,
   * unknown session) — those come back as `{ ok: false, reason, ... }`.
   * Throws only on network failure or a response body that isn't the shape
   * this route is documented to return.
   */
  async prompt(sessionId: string, input: PromptInput): Promise<PromptResult> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/prompt?wait=false`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeaders() },
      body: JSON.stringify({
        prompt: input.prompt,
        queue: input.queue,
        origin: input.origin,
        ...(input.force !== undefined ? { force: input.force } : {}),
      }),
    })
    const body: unknown = await res.json()
    if (!isRecord(body)) throw new Error(`malformed prompt response: ${res.status}`)

    if (res.ok) {
      const queueId = stringField(body, "queueId")
      const queuePosition = numberField(body, "queuePosition")
      if (queueId !== undefined && queuePosition !== undefined) {
        return { ok: true, queued: true, queueId, queuePosition }
      }
      return { ok: true, queued: false }
    }

    const errorCode = stringField(body, "error")
    const message = stringField(body, "message") ?? errorCode ?? JSON.stringify(body).slice(0, 200)
    return { ok: false, reason: classifyPromptError(res.status, errorCode, message), status: res.status, message }
  }

  async *events(sessionId: string, since: number, signal?: AbortSignal): AsyncIterable<TranscriptRecord> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/events/stream?since=${since}`, {
      headers: { accept: "text/event-stream", ...this.authHeaders() },
      ...(signal !== undefined ? { signal } : {}),
    })
    if (!res.ok || res.body === null) {
      throw new Error(`events/stream failed: ${res.status}`)
    }
    for await (const data of sseData(res.body)) {
      const record = parseTranscriptRecord(data)
      if (record !== undefined) yield record
    }
  }

  /**
   * `POST /sessions/:id/kill`, NOT `DELETE /sessions/:id`. The two are not
   * interchangeable: `DELETE` calls the registry's `forget(id)`, which only
   * drops the daemon's bookkeeping row — it never calls the live
   * `agentSession.close()`, so it neither terminates the underlying process
   * nor triggers a sandboxed session's pause/teardown (`sessions.ts` —
   * `forget` vs `kill`; `sandbox-agent-session-proxy.ts`'s `close()` is what
   * actually calls `host.pause()`/`host.stop()`). For a sandboxed session
   * this distinction is a real cost bug: forgetting one leaks a running
   * (billed) e2b box instead of pausing it. `kill` is the route that closes
   * the agent session first and lets the sandbox lifecycle policy run.
   */
  async kill(sessionId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/kill`, {
      method: "POST",
      headers: this.authHeaders(),
    })
    if (!res.ok) {
      const body: unknown = await res.json()
      throw new Error(`kill failed: ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
    }
  }
}
