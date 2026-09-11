/**
 * Real-agentpush proof of the M5 channel: send one text message through the
 * ground-truthed `POST /tools/send_message` contract (docs/AGENTPUSH.md §1)
 * and confirm agentpush actually accepted it.
 *
 * Needs a deployed agentpush instance and a minted workspace key — this repo
 * has neither discoverable on this machine (no agentpush process listening
 * on any port, no ~/.agentpush or ~/.config/agentpush, no matching env vars
 * — see docs/AGENTPUSH.md §7). Per the milestone's instructions, this script
 * does not attempt a send unless all three required values are present; it
 * reports exactly what's missing instead.
 *
 * Run: RDV_AGENTPUSH_URL=... RDV_AGENTPUSH_KEY=... RDV_TEST_RECIPIENT=+1... \
 *   node scripts/prove-agentpush.ts
 */

import { env } from "../src/env.ts"

const TEST_CHANNEL = "whatsapp"

async function main(): Promise<void> {
  const recipient = process.env.RDV_TEST_RECIPIENT

  const missing: string[] = []
  if (env.agentpushUrl === undefined) missing.push("RDV_AGENTPUSH_URL")
  if (env.agentpushKey === undefined) missing.push("RDV_AGENTPUSH_KEY")
  if (!recipient) missing.push("RDV_TEST_RECIPIENT")

  if (missing.length > 0) {
    console.log(`skipped: missing ${missing.join(", ")} — see docs/AGENTPUSH.md §7 for what each must be.`)
    return
  }

  const body = JSON.stringify({
    to: { channel: TEST_CHANNEL, address: recipient },
    content: { text: "Rendez-vous agentpush channel proof — if you can read this, send_message works." },
  })

  console.log(`POST ${env.agentpushUrl}/tools/send_message (channel=${TEST_CHANNEL}, to=${recipient})`)
  const res = await fetch(`${env.agentpushUrl}/tools/send_message`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.agentpushKey}` },
    body,
  })

  const text = await res.text()
  console.log(`HTTP ${res.status}: ${text}`)

  if (!res.ok) {
    console.error("FAIL: non-2xx from agentpush.")
    process.exitCode = 1
    return
  }

  const parsed: unknown = JSON.parse(text)
  const status = typeof parsed === "object" && parsed !== null && "status" in parsed ? (parsed as { status: unknown }).status : undefined
  if (status === "blocked" || status === "failed") {
    console.error(`FAIL: agentpush did not send — status=${String(status)}`)
    process.exitCode = 1
    return
  }

  console.log("PASS: agentpush accepted the send.")
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
