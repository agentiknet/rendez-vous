/**
 * Readiness probe for a served artifact URL (R8, architecture.md §4.2 —
 * "on room resume, probe the artifact URL and re-run app-serve if dead").
 */

const DEFAULT_TIMEOUT_MS = 5_000

/** Any response at all (2xx/3xx/4xx) means something is listening and
 *  answering at that URL — "alive". A 5xx, a network error, or a timeout
 *  means "dead": either nothing is there, or it's there but broken enough
 *  that re-serving is the right call. */
export async function probeArtifact(url: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<"alive" | "dead"> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return res.status < 500 ? "alive" : "dead"
  } catch {
    return "dead"
  }
}
