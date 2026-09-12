/**
 * `GET /sessions/:id` — not exposed by `DaemonClient` (M2 didn't need it).
 * Needed here only to decide, on `resume`, whether a room's stored
 * `sessionId` is still known to the daemon or must be booted fresh.
 * Lives outside `src/daemon/client.ts` so that file stays untouched.
 */
export interface DaemonExtraOptions {
  readonly baseUrl: string
  readonly token: string | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The daemon's own `SessionStatus` union (`sessions.ts:588`): `"starting" |
 *  "running" | "exited" | "killed" | "error"`. Only these two count as a
 *  process the daemon still considers live — the same test `sessions.ts`
 *  itself uses at every call site that gates on liveness (e.g. `sessions.ts:4809`,
 *  `:7419-7421`, `:7627`, `:7756`). */
const LIVE_STATUSES: ReadonlySet<string> = new Set(["running", "starting"])

/** A killed/exited/errored session still answers `GET /sessions/:id` with
 *  `200` — the daemon keeps the bookkeeping row (only `DELETE` forgets it,
 *  `docs/DAEMON-NOTES.md` "Session teardown") — so a bare `res.ok` check
 *  reads a killed session as alive. Out-of-band kill (a daemon-side
 *  `agent_kill`, a crash, a daemon restart) never runs `doPause`, so this is
 *  the only place that later notices the death: alive means 200 AND a status
 *  in `LIVE_STATUSES`; a 404, a malformed body, and a network failure are all
 *  dead, never thrown — callers just boot fresh (or revive) instead. */
export async function isSessionAlive(opts: DaemonExtraOptions, sessionId: string): Promise<boolean> {
  const base = opts.baseUrl.endsWith("/") ? opts.baseUrl.slice(0, -1) : opts.baseUrl
  const headers: Record<string, string> = opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {}
  try {
    const res = await fetch(`${base}/sessions/${sessionId}`, { headers })
    if (!res.ok) return false
    const body: unknown = await res.json()
    if (!isRecord(body)) return false
    const status = typeof body.status === "string" ? body.status : undefined
    return status !== undefined && LIVE_STATUSES.has(status)
  } catch (error) {
    console.error(`isSessionAlive: treating session ${sessionId} as dead after a network error: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/** The session descriptor's own `busy` field (whether the agent is
 *  mid-turn), or undefined on a 404/network failure/malformed body — the
 *  room page's state endpoint surfaces it as "working" vs "idle". */
export async function getSessionBusy(opts: DaemonExtraOptions, sessionId: string): Promise<boolean | undefined> {
  const base = opts.baseUrl.endsWith("/") ? opts.baseUrl.slice(0, -1) : opts.baseUrl
  const headers: Record<string, string> = opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {}
  try {
    const res = await fetch(`${base}/sessions/${sessionId}`, { headers })
    if (!res.ok) return undefined
    const body: unknown = await res.json()
    if (!isRecord(body)) return undefined
    return typeof body.busy === "boolean" ? body.busy : undefined
  } catch {
    return undefined
  }
}

/** The session descriptor's own `status` field (e.g. `"running"`), or
 *  undefined on a 404/network failure/malformed body — used by the no-phone
 *  e2b proof to poll for a kill/pause to actually land. */
export async function getSessionStatus(opts: DaemonExtraOptions, sessionId: string): Promise<string | undefined> {
  const base = opts.baseUrl.endsWith("/") ? opts.baseUrl.slice(0, -1) : opts.baseUrl
  const headers: Record<string, string> = opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {}
  try {
    const res = await fetch(`${base}/sessions/${sessionId}`, { headers })
    if (!res.ok) return undefined
    const body: unknown = await res.json()
    if (!isRecord(body)) return undefined
    return typeof body.status === "string" ? body.status : undefined
  } catch {
    return undefined
  }
}
