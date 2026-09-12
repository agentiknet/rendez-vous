/**
 * One-off morning-email send (docs/STATE.md item 12): the deck PDF, the
 * speaker script, and a status digest to Jeremy's own connected mailbox.
 *
 * The deliverable flow (src/service/deliverable.ts) exists and is wired
 * into RoomService, but only inside the live `node src/cli.ts serve`
 * process — restarting that process to pick it up would disturb the live
 * room (docs/STATE.md: "Live room RDV-NG7F ... Jeremy may use it") and this
 * executor is fenced away from src/service/http.ts and room-service.ts. So
 * this sends by hand, straight through the same ground-truthed contract
 * `EmailTransport`/`DeliverableService` already use (docs/AGENTPUSH.md §8).
 *
 * `content.media[].providerMediaId` (the `upload_media` two-call flow) is
 * REJECTED on the `mail` channel — verified directly against agentpush's
 * `send-message.ts` tool description ("providerMediaId n'a pas de sens sur
 * mail et est rejeté avec une erreur"), and `deliverable.ts`'s own send path
 * confirms it (mail never calls `upload_media`, only WhatsApp does). Mail
 * attachments instead go inline as `content.media[].data` (base64) — the
 * exact path `send-message.ts` documents for "a local file with nowhere
 * public to host it", which is what a freshly-rendered deck PDF is here.
 *
 * Run: set -a; source .env.local; set +a; node scripts/send-deck-email.ts
 */

import { readFile } from "node:fs/promises"
import { env } from "../src/env.ts"
import { AgentpushToolClient, isSendMessageResult } from "../src/channels/agentpush/tools-client.ts"

const RECIPIENT = "jeremy@agentik.net"
const SUBJECT = "Rendez-vous: deck, script and status for the morning"
const DECK_PDF_PATH = "deck/out/rendez-vous-light.pdf"
const SCRIPT_MD_PATH = "deck/SCRIPT.md"

const BODY = `Morning status — Rendez-vous

DEMO-READY (Run 3, real Telegram + web room, on a real phone):
- Real Telegram + web room live end to end
- Attribution ([name · tier] badges) confirmed distinct for both members
- Fan-out — replies reaching both Telegram and the web view
- Artifact edit — agent found and edited the room's live page unaided
- Leave/switch — moving a member between rooms
- Whispers — addressed messages, N per turn

NOT READY:
- Resume-after-kill: fails loudly and correctly (no silent drop), but the
  actual revive doesn't fire yet — re-proof on a real phone still pending
- Deliverable flow (PDF preview -> confirm -> send) and box liveness
  (probing e2b so a dead box's URL is never advertised) — both still
  landing overnight, not yet run live

Codex verdict, one line: the "one parameter" swap does not hold as stated —
it failed at the auth gate (no codex login in a fresh box), so the
credential model is the real remaining work, not the adapter swap.

Decisions needed from you:
1. Re-enable inbound route 9de0da85 ("telegram to responder") after the
   demo window, or leave it disabled?
2. Rotate the Telegram bot tokens — they transited an executor transcript
   overnight.
3. Which overnight upstream agentproto PRs to merge (agent_prompt
   queue-by-default, session liveness signal, /mcps/proxy/call auth gate,
   reap orphaned boxes).

Repo: https://github.com/agentiknet/rendez-vous
Room: https://rdv.clipgen.co/r/RDV-NG7F

Deck (light) and the speaker script are attached.
---
`

async function main(): Promise<void> {
  if (env.agentpushUrl === undefined || env.agentpushKey === undefined) {
    console.error("Missing RDV_AGENTPUSH_URL/RDV_AGENTPUSH_KEY — source .env.local first.")
    process.exitCode = 1
    return
  }

  const [pdf, scriptMd] = await Promise.all([readFile(DECK_PDF_PATH), readFile(SCRIPT_MD_PATH, "utf8")])

  const client = new AgentpushToolClient({ baseUrl: env.agentpushUrl, apiKey: env.agentpushKey })

  const result = await client.call("jeremy-morning-email", "send_message", {
    to: { channel: "mail", address: RECIPIENT },
    content: {
      subject: SUBJECT,
      text: BODY,
      media: [
        { type: "document", data: pdf.toString("base64"), filename: "rendez-vous-deck.pdf", mimeType: "application/pdf" },
        { type: "document", data: Buffer.from(scriptMd, "utf8").toString("base64"), filename: "SCRIPT.md", mimeType: "text/markdown" },
      ],
    },
  })

  if (isSendMessageResult(result)) {
    console.log(JSON.stringify(result))
    if (result.status === "failed" || result.status === "blocked") process.exitCode = 1
  } else {
    console.error("send_message: no usable response from agentpush")
    process.exitCode = 1
  }
}

main()
