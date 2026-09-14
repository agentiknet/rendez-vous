/**
 * Box liveness (docs/UPSTREAM.md #10, architecture.md §9.3b): session
 * liveness (`daemon-extra.ts`'s `isSessionAlive`) and BOX liveness are two
 * independent facts. A session can still read "running" in the daemon's own
 * bookkeeping while the e2b box underneath it has already vanished ("Sandbox
 * Not Found") — ground-truthed live, 2026-09-12, box `i7jos61ixgkcfrekmi1vl`.
 * Nothing upstream exposes box death to a caller holding only a sessionId, so
 * this probes e2b's own API directly, the same way `killE2bSandboxDirect`
 * (`src/sandbox/boot.ts`) already does for its own best-effort cleanup.
 */

const E2B_API_BASE = "https://api.e2b.dev"
const DEFAULT_TIMEOUT_MS = 5_000

export type SandboxLiveness = "alive" | "paused" | "gone" | "unknown"

/**
 * A probe that could not tell whether the box exists. Thrown by
 * `E2bBooter.resume` (`src/service/booter.ts`) when a probe of a known
 * `sandboxId` comes back `"unknown"`, so `RoomService` can report the refusal
 * into the room and leave the stored shape alone.
 *
 * `"unknown"` is deliberately NOT `"gone"` (see this file's header): silently
 * falling through to a reconnect that may end in a fresh boot would start a
 * second, billed box on top of one that is actually still fine. Refusing is
 * the only answer that cannot bill twice.
 */
export class BoxLivenessUnknownError extends Error {
  readonly sandboxId: string

  constructor(sandboxId: string) {
    super(`box liveness for sandbox ${sandboxId} is unknown — refusing to start a replacement`)
    this.name = "BoxLivenessUnknownError"
    this.sandboxId = sandboxId
  }
}

/** `(sandboxId) => Promise<SandboxLiveness>` — the shape both `E2bBooter`
 *  (`booter.ts`) and `RoomService`'s idle sweep (`room-service.ts`) take as
 *  an injectable constructor param, so tests can script a
 *  "gone"/"paused"/"unknown" box without reaching the real e2b API. Each
 *  defaults to calling `isSandboxAlive` itself. */
export type BoxLivenessCheck = (sandboxId: string) => Promise<SandboxLiveness>

export interface BoxLivenessOptions {
  /** Defaults to `process.env.E2B_API_KEY` — e2b's own credential, not one of
   *  this service's `RDV_*` knobs, read directly here for the same reason
   *  `killE2bSandboxDirect` reads it directly rather than through `env.ts`. */
  readonly apiKey?: string
  /** Injectable for tests; defaults to the platform `fetch`. */
  readonly fetchImpl?: typeof fetch
  /** Defaults to 5s. */
  readonly timeoutMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * `GET https://api.e2b.dev/sandboxes/<id>` — a 404 or a body whose own
 * `message` says "not found" both mean the box is gone; a `state` field
 * otherwise distinguishes `running` (alive) from `paused`. Never logs the
 * API key. A network error, a timeout, or a response this module doesn't
 * recognize all come back `"unknown"` — deliberately NOT `"gone"`: treating
 * "we couldn't tell" as "it's dead" would boot a fresh, billed box on top of
 * one that's actually still fine.
 */
export async function isSandboxAlive(sandboxId: string, opts: BoxLivenessOptions = {}): Promise<SandboxLiveness> {
  const apiKey = opts.apiKey ?? process.env.E2B_API_KEY
  if (apiKey === undefined || apiKey.trim().length === 0) {
    console.error(`isSandboxAlive: E2B_API_KEY is unset — cannot probe sandbox ${sandboxId}, treating as unknown`)
    return "unknown"
  }

  const fetchImpl = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetchImpl(`${E2B_API_BASE}/sandboxes/${sandboxId}`, {
      headers: { "X-API-Key": apiKey },
      signal: controller.signal,
    })
    if (res.status === 404) return "gone"

    const body: unknown = await res.json().catch(() => undefined)

    if (!res.ok) {
      console.error(`isSandboxAlive: e2b API returned ${res.status} for sandbox ${sandboxId} — treating as unknown`)
      return "unknown"
    }
    if (!isRecord(body)) {
      console.error(`isSandboxAlive: unrecognized response body for sandbox ${sandboxId} — treating as unknown`)
      return "unknown"
    }

    const message = typeof body.message === "string" ? body.message.toLowerCase() : undefined
    if (message !== undefined && message.includes("not found")) return "gone"

    const state = typeof body.state === "string" ? body.state.toLowerCase() : undefined
    if (state === "paused") return "paused"
    if (state === "running") return "alive"
    if (state === undefined) return "alive"

    console.error(`isSandboxAlive: unrecognized state "${state}" for sandbox ${sandboxId} — treating as unknown`)
    return "unknown"
  } catch (error) {
    console.error(
      `isSandboxAlive: treating sandbox ${sandboxId} as unknown after a network error: ${error instanceof Error ? error.message : String(error)}`,
    )
    return "unknown"
  } finally {
    clearTimeout(timer)
  }
}
