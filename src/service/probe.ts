/**
 * The ONE attachment-URL probe (BRIEF 46). The fanout reader wrote it and
 * lived by its rule — an attachment is only ever delivered on a confirmed
 * 2xx — and BRIEF 46 extends that rule to every other path that hands a
 * file to a member: the delivery engine's attachment attempt (the tool
 * path and the boot replay both go through it). One implementation, two
 * importers; a second implementation of the same rule is exactly what
 * BRIEF-44 had to undo in outbound.ts.
 */

/** The attachment URL is behind our own tunnel on a box we control — if it
 *  has not answered in two seconds, it is not going to answer. */
const PROBE_TIMEOUT_MS = 2000

/** Whether a URL actually serves something right now. Injected so tests
 *  never touch the network; the default probes over HTTP (see
 *  `probeArtifactUrl`). A probe that throws — timeout, DNS, anything — is a
 *  failure: an attachment is only ever delivered on a confirmed 2xx. */
export type ArtifactProbe = (url: string) => Promise<boolean>

/** Default probe: `HEAD` with a short timeout, falling back to a ranged `GET`
 *  when the upstream rejects `HEAD` (405) or the `HEAD` itself fails at the
 *  transport level. Only a 2xx answer counts as "served". */
export async function probeArtifactUrl(url: string): Promise<boolean> {
  try {
    const head = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (head.ok) return true
    if (head.status !== 405) return false
  } catch {
    // Fall through to the ranged GET: some servers refuse HEAD outright, and
    // the GET is the authoritative answer either way.
  }
  try {
    const range = await fetch(url, { headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return range.ok
  } catch {
    return false
  }
}
