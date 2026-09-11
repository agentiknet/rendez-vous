import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { DaemonClient } from "../../src/daemon/client.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import { LocalBooter } from "../../src/service/booter.ts"
import { createHttpServer } from "../../src/service/http.ts"
import { RoomService } from "../../src/service/room-service.ts"
import { MemoryTransport } from "../../src/service/transports.ts"
import { startExtendedFakeDaemon, type ExtendedFakeDaemon } from "./fake-daemon-extra.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const dirs: string[] = []
const daemons: ExtendedFakeDaemon[] = []
const services: RoomService[] = []
const servers: { close(): Promise<void> }[] = []

after(async () => {
  await Promise.all(servers.map((server) => server.close()))
  await Promise.all(services.map((service) => service.stop()))
  await Promise.all(daemons.map((daemon) => daemon.close()))
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-http-"))
  dirs.push(dir)
  return dir
}

async function freshDaemon(): Promise<ExtendedFakeDaemon> {
  const daemon = await startExtendedFakeDaemon()
  daemons.push(daemon)
  return daemon
}

function isAddressInfo(value: string | AddressInfo | null): value is AddressInfo {
  return value !== null && typeof value === "object"
}

async function listenOnRandomPort(service: RoomService): Promise<string> {
  const server = createHttpServer(service)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!isAddressInfo(address)) throw new Error("failed to bind http server")
  servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
  return `http://127.0.0.1:${address.port}`
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) throw new Error(`expected a JSON object, got: ${text}`)
  return parsed
}

test("GET /health reports ok, the room count, and the daemon's own health when it is reachable", async () => {
  const dir = await freshDir()
  const daemon = await freshDaemon()
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })
  const transport = new MemoryTransport()
  const service = new RoomService({ store, client, booter, transport })
  services.push(service)

  const created = await service.handleInbound({
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+1" },
    displayName: "Alice",
    tier: "messenger",
    text: "new",
  })
  assert.equal(created.kind, "created")

  const baseUrl = await listenOnRandomPort(service)
  const res = await fetch(`${baseUrl}/health`)
  assert.equal(res.status, 200)
  const body = await readJson(res)

  assert.equal(body.status, "ok")
  assert.equal(body.rooms, 1)
  assert.ok(isRecord(body.daemon))
  if (!isRecord(body.daemon)) return
  assert.equal(body.daemon.status, "ok")
})

test("GET /health reports the daemon as unreachable when it cannot be reached", async () => {
  const dir = await freshDir()
  // Not tracked in `daemons`: it is closed explicitly below, and `after()`
  // closing an already-closed server would fail the hook.
  const deadDaemon = await startExtendedFakeDaemon()
  const client = new DaemonClient({ baseUrl: deadDaemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: deadDaemon.url, token: undefined })
  await deadDaemon.close()

  const store = await RoomStore.open(dir)
  const transport = new MemoryTransport()
  const service = new RoomService({ store, client, booter, transport })
  services.push(service)

  const baseUrl = await listenOnRandomPort(service)
  const res = await fetch(`${baseUrl}/health`)
  assert.equal(res.status, 200)
  const body = await readJson(res)

  assert.equal(body.status, "ok")
  assert.equal(body.rooms, 0)
  assert.equal(body.daemon, "unreachable")
})
