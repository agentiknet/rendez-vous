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

/** A 200 means the daemon still knows the session; anything else (404, network
 *  failure) is treated as gone, never thrown — callers just boot fresh instead. */
export async function isSessionAlive(opts: DaemonExtraOptions, sessionId: string): Promise<boolean> {
  const base = opts.baseUrl.endsWith("/") ? opts.baseUrl.slice(0, -1) : opts.baseUrl
  const headers: Record<string, string> = opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {}
  try {
    const res = await fetch(`${base}/sessions/${sessionId}`, { headers })
    return res.ok
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
