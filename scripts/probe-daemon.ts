/**
 * Daemon probe: the minimum round trip Rendez-vous depends on.
 *
 *   1. GET  /health
 *   2. POST /sessions/agent            → throwaway session with an opening prompt
 *   3. GET  /sessions/:id/events/stream?since=0
 *      accumulate `text-delta`, stop at the first `turn-end`
 *
 * Run: `pnpm probe:daemon`. Needs RDV_DAEMON_TOKEN (see docs/DAEMON-NOTES.md).
 * Native fetch, native SSE parsing over a ReadableStream, no dependencies.
 */

import { env } from "../src/env.ts"

interface HealthResponse {
  readonly status: string
  readonly version: string
  readonly build?: { readonly sha?: string }
}

interface SpawnResponse {
  readonly id: string
  readonly status: string
}

interface DaemonError {
  readonly error: string
  readonly message?: string
}

/** The subset of transcript record fields the room layer reads. */
interface TranscriptRecord {
  readonly seq: number
  readonly kind: string
  readonly text?: string
  readonly reason?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isDaemonError(value: unknown): value is DaemonError {
  if (!isRecord(value) || typeof value.error !== "string") return false
  return value.message === undefined || typeof value.message === "string"
}

function parseTranscriptRecord(raw: string): TranscriptRecord | undefined {
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed)) return undefined
  const seq = parsed.seq
  const kind = parsed.kind
  if (typeof seq !== "number" || typeof kind !== "string") return undefined
  const text = parsed.text
  const reason = parsed.reason
  return {
    seq,
    kind,
    ...(typeof text === "string" ? { text } : {}),
    ...(typeof reason === "string" ? { reason } : {}),
  }
}

function authHeaders(): Record<string, string> {
  return env.daemonToken ? { authorization: `Bearer ${env.daemonToken}` } : {}
}

async function readJson<T>(res: Response, guard: (value: unknown) => value is T): Promise<T> {
  const body: unknown = await res.json()
  if (!res.ok) {
    const err = isDaemonError(body) ? body : undefined
    throw new Error(`${res.status} ${err?.error ?? "unknown"}: ${err?.message ?? JSON.stringify(body)}`)
  }
  if (!guard(body)) throw new Error(`unexpected response shape: ${JSON.stringify(body).slice(0, 200)}`)
  return body
}

function isHealth(value: unknown): value is HealthResponse {
  return isRecord(value) && typeof value.status === "string" && typeof value.version === "string"
}

function isSpawn(value: unknown): value is SpawnResponse {
  return isRecord(value) && typeof value.id === "string" && typeof value.status === "string"
}

/**
 * Iterate `data:` frames of an SSE body. Handles multi-line `data:` fields,
 * ignores comments (`: keep-alive`) and other field names. Ends when the
 * server closes or the caller breaks out of the loop (which cancels the
 * reader and closes the socket).
 */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let dataLines: string[] = []
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl = buffer.indexOf("\n")
      while (nl !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "")
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf("\n")
        if (line === "") {
          if (dataLines.length > 0) {
            yield dataLines.join("\n")
            dataLines = []
          }
          continue
        }
        if (line.startsWith(":")) continue
        const colon = line.indexOf(":")
        const field = colon === -1 ? line : line.slice(0, colon)
        if (field !== "data") continue
        const rawValue = colon === -1 ? "" : line.slice(colon + 1)
        dataLines.push(rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue)
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

async function main(): Promise<void> {
  const health = await readJson(await fetch(`${env.daemonUrl}/health`), isHealth)
  console.log(`health: ${health.status} version=${health.version} build=${health.build?.sha ?? "?"}`)

  const spawned = await readJson(
    await fetch(`${env.daemonUrl}/sessions/agent`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        adapter: env.agentAdapter,
        model: env.agentModel,
        cwd: process.cwd(),
        label: "rdv-probe",
        prompt: "Reply with exactly the single word: pong",
        dedupe: false,
      }),
    }),
    isSpawn,
  )
  console.log(`spawned: ${spawned.id} status=${spawned.status}`)

  const stream = await fetch(`${env.daemonUrl}/sessions/${spawned.id}/events/stream?since=0`, {
    headers: { accept: "text/event-stream", ...authHeaders() },
  })
  if (!stream.ok || stream.body === null) {
    throw new Error(`events/stream failed: ${stream.status}`)
  }

  let reply = ""
  let lastSeq = 0
  const kinds = new Map<string, number>()
  for await (const data of sseData(stream.body)) {
    const record = parseTranscriptRecord(data)
    if (record === undefined) continue
    lastSeq = record.seq
    kinds.set(record.kind, (kinds.get(record.kind) ?? 0) + 1)
    if (record.kind === "text-delta" && record.text !== undefined) reply += record.text
    if (record.kind === "turn-end") {
      console.log(`turn-end: reason=${record.reason ?? "?"} seq=${record.seq}`)
      break
    }
  }
  console.log(`kinds seen: ${[...kinds].map(([k, n]) => `${k}×${n}`).join(", ")}`)
  console.log(`cursor to persist: ${lastSeq}`)
  console.log(`reply: ${JSON.stringify(reply.trim())}`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
