/**
 * No-phone end-to-end proof (build brief constraint 7) against a REAL
 * agentproto daemon: two members share one room, talk over each other, and
 * the fan-out cursor survives a service restart without dropping or
 * re-sending anything.
 *
 * Needs RDV_DAEMON_TOKEN set in the environment (read it with
 * `node -p 'require("/Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/.agentproto/runtime.json").token'`
 * and export it — never print it).
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DaemonClient } from "../src/daemon/client.ts"
import { env } from "../src/env.ts"
import { RoomStore } from "../src/rooms/store.ts"
import type { Member } from "../src/rooms/types.ts"
import { LocalBooter } from "../src/service/booter.ts"
import { RoomService } from "../src/service/room-service.ts"
import { MemoryTransport } from "../src/service/transports.ts"

const TIMEOUT_MS = 180_000

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
  const client = new DaemonClient({ baseUrl: env.daemonUrl, token: env.daemonToken })
  let sessionId: string | undefined

  try {
    let store = await RoomStore.open(dir)
    const booter = new LocalBooter(client, { baseUrl: env.daemonUrl, token: env.daemonToken })
    let transport = new MemoryTransport()
    let service = new RoomService({ store, client, booter, transport })

    console.log("Alice sends: new")
    const created = await service.handleInbound(alice("new"))
    if (created.kind !== "created") throw new Error(`expected "created", got "${created.kind}"`)
    const code = created.room.code
    sessionId = created.room.sessionId
    console.log(`  → room ${code}, session ${sessionId ?? "(none)"}`)

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
    service = new RoomService({ store, client, booter, transport })
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
