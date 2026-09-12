/**
 * Zero-cost live proof that a REAL agent (via a REAL agentproto daemon, but
 * with the LocalBooter — no e2b, no sandbox, no outbound sends) opens an
 * `[[ask …]]` block when a room member's message only makes sense as a
 * solicitation of one specific other member — and that the room routes it:
 * the ask is recorded on the room with `toMemberId` = the member id, the
 * asked member receives the ask text privately, and everyone else sees only
 * the one-line "waiting on" marker, never the ask contents.
 *
 * Needs RDV_DAEMON_TOKEN set in the environment (same recipe as
 * `scripts/simulate-room.ts` — read it via
 * `node -p 'require("/Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/.agentproto/runtime.json").token'`
 * and export it — never print it). RDV_BOOTER stays at its local default.
 *
 * Exits non-zero with a clear message if the agent produced no ask at all: a
 * silent pass when the feature did not fire is the exact failure class this
 * project documents, so this script must not be one.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DaemonClient } from "../src/daemon/client.ts"
import { isRecordKind } from "../src/daemon/records.ts"
import { env } from "../src/env.ts"
import { RoomStore } from "../src/rooms/store.ts"
import type { Member } from "../src/rooms/types.ts"
import { LocalBooter } from "../src/service/booter.ts"
import { RoomService } from "../src/service/room-service.ts"
import { MemoryTransport } from "../src/service/transports.ts"

const TURN_TIMEOUT_MS = 240_000

function julie(text: string): { address: Member["address"]; displayName: string; tier: Member["tier"]; text: string } {
  return {
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+15550002222" },
    displayName: "Julie",
    tier: "messenger",
    text,
  }
}

function tom(text: string): { address: Member["address"]; displayName: string; tier: Member["tier"]; text: string } {
  return {
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+15554447777" },
    displayName: "Tom",
    tier: "messenger",
    text,
  }
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for: ${label}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

function printSends(transport: MemoryTransport): void {
  for (const send of transport.sends) {
    console.log(`  → [${send.member.displayName}] ${send.message.text}`)
  }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-probe-ask-"))
  const daemonOpts = { baseUrl: env.daemonUrl, token: env.daemonToken }
  const client = new DaemonClient(daemonOpts)
  let sessionId: string | undefined
  let collector: AbortController | undefined
  let service: RoomService | undefined

  try {
    const store = await RoomStore.open(dir)
    const booter = new LocalBooter(client, daemonOpts)
    const transport = new MemoryTransport()
    service = new RoomService({ store, client, booter, transport, daemon: daemonOpts })

    console.log("Julie sends: new")
    const created = await service.handleInbound(julie("new"))
    if (created.kind !== "created") throw new Error(`expected "created", got "${created.kind}"`)
    const code = created.room.code
    sessionId = created.room.sessionId
    console.log(`  → room ${code}, session ${sessionId ?? "(none)"}`)

    console.log("Tom sends: join")
    const joined = await service.handleInbound(tom(`join ${code}`))
    if (joined.kind !== "joined") throw new Error(`expected "joined", got "${joined.kind}"`)

    const roomAfterJoin = store.get(code)
    if (roomAfterJoin === undefined) throw new Error("room vanished after join")
    const tomMember = roomAfterJoin.members.find((member) => member.displayName === "Tom")
    const julieMember = roomAfterJoin.members.find((member) => member.displayName === "Julie")
    if (tomMember === undefined || julieMember === undefined) throw new Error("members missing after join")

    // Baseline cursor: the opening-prompt turn has already flushed by now
    // (same reasoning as simulate-room.ts), so reading the event stream from
    // here captures ONLY the turn that answers Julie's message below.
    const baselineCursor = roomAfterJoin.cursor

    // Independent collector over the daemon's transcript (read-only, does not
    // touch the fan-out reader's cursor): accumulates text-deltas per turn and
    // keeps the last completed turn's raw text, so a human can see exactly
    // what the agent wrote — markers included, verbatim.
    collector = new AbortController()
    let lastTurnText: string | undefined
    let currentTurn = ""
    if (sessionId !== undefined) {
      void (async () => {
        for await (const record of client.events(sessionId, baselineCursor, collector.signal)) {
          if (isRecordKind(record, "text-delta")) {
            currentTurn += record.text
            continue
          }
          if (isRecordKind(record, "turn-end")) {
            if (currentTurn.length > 0) lastTurnText = currentTurn
            currentTurn = ""
          }
        }
      })().catch(() => undefined)
    }

    console.log("Julie sends the engineered message...")
    const sent = await service.handleInbound(
      julie(
        "I need the offsite budget approved today. But I'm missing the two things that decide it: " +
          "the venue photo and the final headcount. Those are Tom's — he has them, I never did. " +
          "Please get from Tom exactly what you need to build the budget plan, and while you wait for him, " +
          "draft the plan with placeholders so we can review its shape.",
      ),
    )
    if (sent.kind !== "message") throw new Error(`expected "message", got "${sent.kind}"`)

    try {
      await waitFor(
        () => {
          const room = store.get(code)
          return room !== undefined && (room.asks?.length ?? 0) > 0
        },
        TURN_TIMEOUT_MS,
        "the agent to open an ask (room.asks to gain an entry)",
      )
    } catch (error) {
      console.error("\n=== RAW AGENT TURN (no ask was opened) ===")
      console.log(lastTurnText ?? "(no agent turn text captured)")
      console.error("\nFAIL: the agent produced no [[ask]] — feature did not fire against a real agent.")
      process.exitCode = 1
      throw error
    }

    // The flush persists the cursor only after the sends, so cursor > baseline
    // means the ask-bearing turn's deliveries have landed in the transport.
    await waitFor(
      () => {
        const room = store.get(code)
        return room !== undefined && room.cursor > baselineCursor
      },
      30_000,
      "the fan-out flush of the ask turn to be persisted",
    )

    const room = store.get(code)
    if (room === undefined) throw new Error("room vanished")
    const asks = room.asks ?? []

    console.log("\n=== RAW AGENT TURN (verbatim) ===")
    console.log(lastTurnText ?? "(none)")

    console.log("\n=== ASKS ON THE ROOM ===")
    for (const ask of asks) {
      console.log(`  ${ask.id}: toMemberId=${ask.toMemberId} status=${ask.status} what=${JSON.stringify(ask.what)}`)
    }

    console.log("\n=== WHAT MEMORYTRANSPORT ACTUALLY DELIVERED ===")
    printSends(transport)

    let failed = false
    const openForTom = asks.some((ask) => ask.status === "open" && ask.toMemberId === tomMember.id)
    console.log(`\nassert ask open with toMemberId === Tom's member id (${tomMember.id}): ${openForTom ? "OK" : "FAIL"}`)
    if (!openForTom) failed = true

    const tomSends = transport.sends.filter((send) => send.member.id === tomMember.id)
    const julieSends = transport.sends.filter((send) => send.member.id === julieMember.id)
    // The fan-out renders a member's own ask as broadcast text plus a
    // "(the room is waiting on you)" line appended to it (reader.ts's
    // `renderTurnForMember`), so the marker is contained in the message, not
    // its prefix.
    const tomGotAsk = tomSends.some((send) => send.message.text.includes("(the room is waiting on you)"))
    console.log(`Tom received a private "(the room is waiting on you)" delivery: ${tomGotAsk ? "OK" : "FAIL"}`)
    if (!tomGotAsk) failed = true

    // `askMarkerForOthers` embeds the ask text in the one-line marker by
    // design (src/fanout/ask.ts), so what Julie must NOT receive is the
    // private "(the room is waiting on you)" wrapper — the marker alone is
    // the honest amount of reveal the type documents.
    const julieLeaked = julieSends.some((send) => send.message.text.includes("(the room is waiting on you)"))
    const julieSawMarker = julieSends.some((send) => send.message.text.includes("(waiting on Tom:"))
    console.log(`Julie saw the one-line "(waiting on Tom: …)" marker: ${julieSawMarker ? "OK" : "FAIL"}`)
    // NOT "Julie received none of the ask contents" — she receives all of
    // them, inside the marker, by design. Labelling this line that way (it
    // was, briefly) prints a reassuring sentence that the assertion below
    // does not actually check: exactly the shape of failure this project
    // exists to document. An ask reveals WHAT the room is waiting on; only a
    // whisper (`@me`, src/fanout/whisper.ts) hides its contents.
    console.log(`Julie did NOT get Tom's private "(the room is waiting on you)" wrapper: ${julieLeaked ? "FAIL" : "OK"}`)
    if (!julieSawMarker || julieLeaked) failed = true

    if (failed) {
      throw new Error("ask fired but one or more routing assertions failed")
    }
    console.log("\nPASS")
  } catch (error) {
    if (!(process.exitCode === 1)) {
      console.error("FAIL:", error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  } finally {
    collector?.abort()
    await service?.stop()
    if (sessionId !== undefined) {
      await client.kill(sessionId).catch(() => undefined)
    }
    await rm(dir, { recursive: true, force: true })
  }
}

main()
