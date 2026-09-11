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
