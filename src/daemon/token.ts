/**
 * Resolve the daemon's bearer token at startup (BRIEF-22).
 *
 * The agentproto daemon regenerates its token on every boot, so a pin in
 * `.env.local` is correct only until the next restart. `RDV_DAEMON_TOKEN`
 * stays an explicit override; when it is unset, the token comes from the
 * daemon's own `runtime.json` — matched by the `port` field, never by which
 * candidate path happened to exist or be listed first. A stale `runtime.json`
 * from a daemon once started with `$HOME` as its workspace can sit right
 * next to the live one; picking the wrong file is the same bug with extra
 * steps.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

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

/** Read one candidate file and return its token, but only when its own
 *  `port` field matches the daemon we are actually configured to call.
 *  Undefined for anything else — missing file, unreadable, malformed JSON,
 *  a `runtime.json` that belongs to some other daemon on the same box. */
function readMatchingToken(path: string, port: number): string | undefined {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  if (numberField(parsed, "port") !== port) return undefined
  const token = stringField(parsed, "token")
  return token !== undefined && token.length > 0 ? token : undefined
}

export interface ResolveDaemonTokenInput {
  /** `env.daemonToken` — wins outright when set, no file is even read. */
  readonly override: string | undefined
  /** The port of the daemon this service is configured to call
   *  (`env.daemonUrl`). The one fact that disambiguates candidate files. */
  readonly port: number
  /** Files to check, in listing order — order never decides the winner;
   *  the first one whose own `port` field matches does. */
  readonly candidatePaths: readonly string[]
}

export type ResolveDaemonTokenResult =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly message: string }

export function resolveDaemonToken(input: ResolveDaemonTokenInput): ResolveDaemonTokenResult {
  if (input.override !== undefined) return { ok: true, token: input.override }
  for (const path of input.candidatePaths) {
    const token = readMatchingToken(path, input.port)
    if (token !== undefined) return { ok: true, token }
  }
  return {
    ok: false,
    message:
      `no daemon token found for port ${input.port}: set RDV_DAEMON_TOKEN, or make sure a readable ` +
      `runtime.json with a matching "port" exists at one of: ${input.candidatePaths.join(", ")}`,
  }
}

/**
 * Production candidate locations. Neither requires any operator
 * configuration — a daemon and this service on the same machine as the same
 * user resolve automatically, which is the whole point (a restart that
 * regenerates the token must not require anyone to edit a file):
 *
 *   - `~/.agentproto/daemons/<port>.json` — the daemon's own central,
 *     workspace-independent registry, keyed by port specifically so
 *     "discover the daemon on this port" needs no path guessing at all
 *     (`agentproto-dir.ts`'s `writeDaemonRegistryEntry`: "the CLI can
 *     discover this daemon WITHOUT its workspace being registered").
 *   - `~/.agentproto/runtime.json` — the per-workspace snapshot, for the
 *     case where the daemon was started with `$HOME` itself as its
 *     workspace (the "arbitrary cwd" case that file format's own doc
 *     comment calls out). Verified by `port` like any other candidate, not
 *     trusted just because it's the fallback.
 */
export function defaultRuntimeCandidatePaths(port: number): readonly string[] {
  const base = join(homedir(), ".agentproto")
  return [join(base, "daemons", `${port}.json`), join(base, "runtime.json")]
}

/** The port half of "match by port, not path precedence" — pulled from
 *  `env.daemonUrl` so the caller never has to parse a URL itself. */
export function portFromDaemonUrl(daemonUrl: string): number {
  const url = new URL(daemonUrl)
  if (url.port !== "") return Number.parseInt(url.port, 10)
  return url.protocol === "https:" ? 443 : 80
}
