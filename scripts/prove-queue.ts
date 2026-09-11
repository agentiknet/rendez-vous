/**
 * Real-daemon proof of M2 (architecture.md §5.1, build-brief.md M2): a
 * message that arrives while the agent is busy is durably queued and
 * dispatched in order, never lost (R3).
 *
 * Spawns a throwaway session with a slow prompt, immediately fans in two
 * messages from two different senders while it is busy, then reads the
 * transcript until the third `turn-end` and asserts the `user-prompt`
 * records landed in submission order: the slow prompt, then Alice's
 * attributed text, then Bob's.
 *
 * Run: `RDV_DAEMON_TOKEN=$(...) node scripts/prove-queue.ts`
 */

import { DaemonClient } from "../src/daemon/client.ts"
import { isRecordKind } from "../src/daemon/records.ts"
import { env } from "../src/env.ts"
import { fanIn, type Sender } from "../src/fanin/index.ts"

const alice: Sender = { id: "prove-alice", displayName: "Alice", tier: "messenger" }
const bob: Sender = { id: "prove-bob", displayName: "Bob", tier: "messenger" }

const TIMEOUT_MS = 180_000

async function main(): Promise<void> {
  const client = new DaemonClient({ baseUrl: env.daemonUrl, token: env.daemonToken })

  const spawned = await client.spawnAgent({
    adapter: env.agentAdapter,
    model: env.agentModel,
    cwd: process.cwd(),
    label: "rdv-prove-queue",
    prompt: "Count slowly from 1 to 30, one number per line, do not use any tool.",
  })
  console.log(`spawned: ${spawned.id} status=${spawned.status}`)

  try {
    const aliceResult = await fanIn(client, spawned.id, alice, "hello from alice")
    const bobResult = await fanIn(client, spawned.id, bob, "hello from bob")
    console.log(`alice fanIn: ${JSON.stringify(aliceResult)}`)
    console.log(`bob fanIn: ${JSON.stringify(bobResult)}`)

    if (!aliceResult.ok || !aliceResult.queued) {
      throw new Error(`expected alice's message to land in the queue while busy, got ${JSON.stringify(aliceResult)}`)
    }
    if (!bobResult.ok || !bobResult.queued) {
      throw new Error(`expected bob's message to land in the queue while busy, got ${JSON.stringify(bobResult)}`)
    }
    if (aliceResult.queuePosition >= bobResult.queuePosition) {
      throw new Error(
        `expected alice (queued first) to have a lower queuePosition than bob, got alice=${aliceResult.queuePosition} bob=${bobResult.queuePosition}`,
      )
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const userPrompts: string[] = []
    let turnEnds = 0
    try {
      for await (const record of client.events(spawned.id, 0, controller.signal)) {
        if (isRecordKind(record, "user-prompt")) userPrompts.push(record.text)
        if (isRecordKind(record, "turn-end")) {
          turnEnds += 1
          if (turnEnds >= 3) break
        }
      }
    } finally {
      clearTimeout(timeout)
    }

    console.log("user-prompt records observed, in order:")
    for (const [i, text] of userPrompts.entries()) console.log(`  ${i}: ${JSON.stringify(text)}`)

    const [first, second, third] = userPrompts
    const inOrder =
      userPrompts.length === 3 &&
      first !== undefined &&
      !first.startsWith("[") &&
      second === "[Alice · messenger] hello from alice" &&
      third === "[Bob · messenger] hello from bob"

    if (inOrder) {
      console.log("PASS: count prompt, then Alice, then Bob, each as its own turn, in order.")
    } else {
      console.log("FAIL: user-prompt records did not land in the expected order.")
      process.exitCode = 1
    }
  } finally {
    await client.kill(spawned.id)
    console.log(`killed: ${spawned.id}`)
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
