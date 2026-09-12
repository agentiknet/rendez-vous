/**
 * No-phone end-to-end proof (build brief constraint 7) against a REAL
 * agentproto daemon: two members share one room, talk over each other, and
 * the fan-out cursor survives a service restart without dropping or
 * re-sending anything.
 *
 * Needs RDV_DAEMON_TOKEN set in the environment (read it with
 * `node -p 'require("/Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/.agentproto/runtime.json").token'`
 * and export it — never print it).
 *
 * With RDV_BOOTER=e2b, a third phase runs: ask the agent to edit the served
 * artifact page, force a pause, poll the daemon until it lands, send one
 * more message, and assert both that the room resumes with the same
 * artifact url AND that the pre-pause edit is still there (Rehearsal Run 2,
 * Finding 3 — fan-out after resume — and Finding 4 — the artifact re-seed
 * wiping edits). Run this with RDV_PREWARM_SANDBOX_ID set to an
 * already-paused, known-good box — reconnecting is free, a fresh boot is
 * not, and this script has no boot budget of its own.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DaemonClient } from "../src/daemon/client.ts"
import { env } from "../src/env.ts"
import { RoomStore } from "../src/rooms/store.ts"
import type { Member } from "../src/rooms/types.ts"
import { E2bBooter, LocalBooter, type SessionBooter } from "../src/service/booter.ts"
import { getSessionStatus } from "../src/service/daemon-extra.ts"
import { RoomService } from "../src/service/room-service.ts"
import { MemoryTransport } from "../src/service/transports.ts"

const TIMEOUT_MS = 180_000
const PAUSE_CONFIRM_TIMEOUT_MS = 60_000

function alice(text: string): { address: Member["address"]; displayName: string; tier: Member["tier"]; text: string } {
  return {
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+15550001111" },
    displayName: "Alice",
    tier: "messenger",
    text,
  }
}

function bob(text: string): { address: Member["address"]; displayName: string; tier: Member["tier"]; text: string } {
  return {
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+15559998888" },
    displayName: "Bob",
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

async function fetchArtifactText(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url)
    if (!res.ok) return undefined
    return await res.text()
  } catch {
    return undefined
  }
}

async function waitForArtifactText(
  url: string,
  predicate: (text: string) => boolean,
  timeoutMs: number,
  label: string,
): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const text = await fetchArtifactText(url)
    if (text !== undefined && predicate(text)) return text
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`timed out waiting for: ${label}`)
}

async function waitForSessionToStopRunning(
  daemonOpts: { baseUrl: string; token: string | undefined },
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const status = await getSessionStatus(daemonOpts, sessionId)
    if (status !== "running") return
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new Error(`timed out waiting for session ${sessionId} to stop running`)
}

function countFor(transport: MemoryTransport, displayName: string): number {
  return transport.sends.filter((send) => send.member.displayName === displayName).length
}

function printSends(transport: MemoryTransport): void {
  for (const send of transport.sends) {
    console.log(`  → [${send.member.displayName}] ${send.message.text}`)
  }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-simulate-"))
  const daemonOpts = { baseUrl: env.daemonUrl, token: env.daemonToken }
  const client = new DaemonClient(daemonOpts)
  let sessionId: string | undefined

  try {
    let store = await RoomStore.open(dir)
    const booter: SessionBooter = env.booter === "e2b" ? new E2bBooter(client, daemonOpts, store) : new LocalBooter(client, daemonOpts)
    if (env.booter === "e2b") {
      console.log(`e2b booter active, pre-warm sandbox: ${env.prewarmSandboxId ?? "(none — this WILL boot fresh)"}`)
    }
    let transport = new MemoryTransport()
    let service = new RoomService({ store, client, booter, transport, daemon: daemonOpts })

    console.log("Alice sends: new")
    const created = await service.handleInbound(alice("new"))
    if (created.kind !== "created") throw new Error(`expected "created", got "${created.kind}"`)
    const code = created.room.code
    sessionId = created.room.sessionId
    console.log(`  → room ${code}, session ${sessionId ?? "(none)"}, sandbox ${created.room.sandboxId ?? "(none)"}`)
    if (created.room.artifactUrl !== undefined) {
      console.log(`  → artifact ${created.room.artifactUrl} (ready: ${String(created.room.artifactReady)})`)
    }

    console.log(`Bob sends: join ${code}`)
    const joined = await service.handleInbound(bob(`join ${code}`))
    if (joined.kind !== "joined") throw new Error(`expected "joined", got "${joined.kind}"`)

    // Booting the session sends the opening prompt as a real turn, which
    // produces its own fan-out reply before Alice or Bob say anything — so
    // "two turns" is measured as growth from here, not an absolute count.
    const aliceBaseline = countFor(transport, "Alice")
    const bobBaseline = countFor(transport, "Bob")

    console.log("Alice and Bob talk over each other...")
    const alicePromise = service.handleInbound(alice("Say hello to everyone in one sentence"))
    const bobPromise = service.handleInbound(bob("Then say goodbye in one sentence"))
    await Promise.all([alicePromise, bobPromise])

    await waitFor(
      () => countFor(transport, "Alice") >= aliceBaseline + 2 && countFor(transport, "Bob") >= bobBaseline + 2,
      TIMEOUT_MS,
      "both members to receive two agent turns",
    )
    console.log("Delivered messages (first round):")
    printSends(transport)

    console.log("Simulating a service restart...")
    await service.stop()
    store = await RoomStore.open(dir)
    transport = new MemoryTransport()
    service = new RoomService({ store, client, booter, transport, daemon: daemonOpts })
    service.start()

    console.log("Bob sends: One more sentence please")
    await service.handleInbound(bob("One more sentence please"))
    await waitFor(
      () => countFor(transport, "Alice") >= 1 && countFor(transport, "Bob") >= 1,
      TIMEOUT_MS,
      "both members to receive exactly one new message after restart",
    )
    // Give any stray duplicate delivery a moment to show up before asserting none did.
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const aliceAfter = countFor(transport, "Alice")
    const bobAfter = countFor(transport, "Bob")
    if (aliceAfter !== 1 || bobAfter !== 1) {
      throw new Error(`expected exactly one new message each after restart, got Alice=${aliceAfter} Bob=${bobAfter}`)
    }
    console.log("Delivered messages (after restart):")
    printSends(transport)

    if (env.booter === "e2b") {
      const artifactBefore = store.get(code)?.artifactUrl
      if (artifactBefore === undefined) throw new Error("expected an artifact url before the e2b phase")
      const editMarker = `rdv-edit-marker-${code}`
      console.log("e2b phase: asking the agent to edit the artifact page before pausing...")
      await service.handleInbound(
        alice(
          `Edit your served page: set the <title> to "Rendez-vous live" and add the text ${editMarker} ` +
            "somewhere in the body. Reply with exactly one short line once done.",
        ),
      )
      await waitForArtifactText(
        artifactBefore,
        (html) => html.includes(editMarker),
        TIMEOUT_MS,
        "the artifact page to reflect the edit before pausing",
      )
      console.log(`  → confirmed edit landed (marker: ${editMarker})`)

      console.log("e2b phase: forcing a pause...")
      await service.pauseRoom(code)

      const pausedSessionId = sessionId
      if (pausedSessionId !== undefined) {
        await waitForSessionToStopRunning(daemonOpts, pausedSessionId, PAUSE_CONFIRM_TIMEOUT_MS)
      }
      const pausedRoom = store.get(code)
      if (pausedRoom?.state !== "paused") throw new Error(`expected room state "paused", got "${pausedRoom?.state}"`)
      console.log("  → confirmed paused")

      const e2bBaselineAlice = countFor(transport, "Alice")
      const e2bBaselineBob = countFor(transport, "Bob")
      console.log("Bob sends: one more message to a paused room")
      await service.handleInbound(bob("Are you still there after the pause?"))
      await waitFor(
        () => countFor(transport, "Alice") >= e2bBaselineAlice + 1 && countFor(transport, "Bob") >= e2bBaselineBob + 1,
        TIMEOUT_MS,
        "both members to receive a reply after the room auto-resumes",
      )

      const resumedRoom = store.get(code)
      sessionId = resumedRoom?.sessionId
      if (resumedRoom?.state !== "active") throw new Error(`expected room state "active" after resume, got "${resumedRoom?.state}"`)
      if (resumedRoom.artifactUrl !== artifactBefore) {
        throw new Error(`artifact url changed across pause/resume: ${artifactBefore} -> ${resumedRoom.artifactUrl}`)
      }
      console.log(`  → resumed, artifact url unchanged (${resumedRoom.artifactUrl ?? "(none)"})`)

      // Finding 4: the pre-pause artifact edit must survive the resume — a
      // re-seed that only writes when unseeded is what's under test here.
      const artifactAfterResume = await fetchArtifactText(resumedRoom.artifactUrl)
      if (artifactAfterResume === undefined || !artifactAfterResume.includes(editMarker)) {
        throw new Error("artifact edit did not survive the resume — the seed re-ran and wiped it")
      }
      console.log("  → confirmed the pre-pause artifact edit survived the resume")

      console.log("Delivered messages (e2b phase):")
      printSends(transport)
    }

    await service.stop()
    console.log("PASS")
  } catch (error) {
    console.error("FAIL:", error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  } finally {
    if (sessionId !== undefined) {
      await client.kill(sessionId).catch(() => undefined)
    }
    await rm(dir, { recursive: true, force: true })
  }
}

main()
