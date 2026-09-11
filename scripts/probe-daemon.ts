/**
 * Daemon probe: the minimum round trip Rendez-vous depends on.
 *
 *   1. GET  /health
 *   2. POST /sessions/agent            → throwaway session with an opening prompt
 *   3. GET  /sessions/:id/events/stream?since=0
 *      accumulate `text-delta`, stop at the first `turn-end`
 *
 * Run: `pnpm probe:daemon`. Needs RDV_DAEMON_TOKEN (see docs/DAEMON-NOTES.md).
 */

import { DaemonClient } from "../src/daemon/client.ts"
import { isRecordKind } from "../src/daemon/records.ts"
import { env } from "../src/env.ts"

async function main(): Promise<void> {
  const client = new DaemonClient({ baseUrl: env.daemonUrl, token: env.daemonToken })

  const health = await client.health()
  console.log(`health: ${health.status} version=${health.version} build=${health.buildSha ?? "?"}`)

  const spawned = await client.spawnAgent({
    adapter: env.agentAdapter,
    model: env.agentModel,
    cwd: process.cwd(),
    label: "rdv-probe",
    prompt: "Reply with exactly the single word: pong",
  })
  console.log(`spawned: ${spawned.id} status=${spawned.status}`)

  let reply = ""
  let lastSeq = 0
  const kinds = new Map<string, number>()
  try {
    for await (const record of client.events(spawned.id, 0)) {
      lastSeq = record.seq
      kinds.set(record.kind, (kinds.get(record.kind) ?? 0) + 1)
      if (isRecordKind(record, "text-delta")) reply += record.text
      if (isRecordKind(record, "turn-end")) {
        console.log(`turn-end: reason=${record.reason} seq=${record.seq}`)
        break
      }
    }
  } finally {
    await client.kill(spawned.id)
  }
  console.log(`kinds seen: ${[...kinds].map(([k, n]) => `${k}×${n}`).join(", ")}`)
  console.log(`cursor to persist: ${lastSeq}`)
  console.log(`reply: ${JSON.stringify(reply.trim())}`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
