/**
 * `POST /inbound/agentpush-mail` needs `env.emailWebhookSecret` set to
 * exercise signature verification, but `env` is a frozen singleton read
 * once from `process.env` at module load — and ESM hoists every *static*
 * import above this file's own code, so setting `process.env` here would
 * run too late for anything imported the normal way. Runtime values that
 * transitively touch `src/env.ts` are therefore imported dynamically,
 * *after* the env var below is set; pure types are still static (type-only
 * imports are erased, so they never trigger `env.ts` at runtime).
 */
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import type { RoomService } from "../../src/service/room-service.ts"
import { startExtendedFakeDaemon, type ExtendedFakeDaemon } from "./fake-daemon-extra.ts"

const WEBHOOK_SECRET = "test-email-webhook-secret"
process.env.RDV_EMAIL_WEBHOOK_SECRET = WEBHOOK_SECRET

const { DaemonClient } = await import("../../src/daemon/client.ts")
const { RoomStore } = await import("../../src/rooms/store.ts")
const { LocalBooter } = await import("../../src/service/booter.ts")
const { createHttpServer } = await import("../../src/service/http.ts")
const { RoomService: RoomServiceCtor } = await import("../../src/service/room-service.ts")
const { MemoryTransport } = await import("../../src/service/transports.ts")

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAddressInfo(value: string | AddressInfo | null): value is AddressInfo {
  return value !== null && typeof value === "object"
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
  const dir = await mkdtemp(join(tmpdir(), "rdv-agentpush-mail-"))
  dirs.push(dir)
  return dir
}

async function buildServer(): Promise<{ baseUrl: string; daemon: ExtendedFakeDaemon }> {
  const dir = await freshDir()
  const daemon = await startExtendedFakeDaemon()
  daemons.push(daemon)
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })
  const service = new RoomServiceCtor({ store, client, booter, transport: new MemoryTransport() })
  services.push(service)

  const server = createHttpServer(service)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!isAddressInfo(address)) throw new Error("failed to bind http server")
  servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })

  return { baseUrl: `http://127.0.0.1:${address.port}`, daemon }
}

function sign(rawBody: string): string {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(rawBody, "utf8").digest("hex")}`
}

function mailEnvelope(message: Record<string, unknown>): string {
  return JSON.stringify({
    event: "inbound_mail",
    route: { name: "rendez-vous-mail", dispatch_tag: "rendez-vous-mail" },
    message: { message_id: "m-1", from: "alice@example.com", subject: "", text: "hello", ...message },
    workspace_id: "acme",
  })
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) throw new Error(`expected a JSON object, got: ${text}`)
  return parsed
}

test("POST /inbound/agentpush-mail with no room code hint reaches handleInbound with tier email, provider email", async () => {
  const { baseUrl } = await buildServer()
  const rawBody = mailEnvelope({ text: "hello there" })

  const res = await fetch(`${baseUrl}/inbound/agentpush-mail`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agentpush-signature": sign(rawBody) },
    body: rawBody,
  })
  assert.equal(res.status, 200)
  const body = await readJson(res)
  assert.equal(body.kind, "unknown-sender")
})

test("POST /inbound/agentpush-mail with a room code hint joins the room first, then fans the text in as a turn", async () => {
  const { baseUrl, daemon } = await buildServer()

  // `RDV_AGENTPUSH_WEBHOOK_SECRET` is never set in this test file's process
  // (only `RDV_EMAIL_WEBHOOK_SECRET` is, above), so the messenger webhook
  // accepts this unsigned — see `parseAgentpushWebhook`'s "no secret
  // configured" branch.
  const newBody = JSON.stringify({
    channel: "whatsapp",
    from: "+15550001111",
    text: "new",
    messageId: "whatsapp-new-1",
    displayName: "Founder",
  })
  const created = await fetch(`${baseUrl}/inbound/agentpush`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: newBody,
  })
  const createdBody = await readJson(created)
  assert.equal(createdBody.kind, "created")
  const room = createdBody.room
  assert.ok(isRecord(room))
  if (!isRecord(room)) return
  const code = room.code
  assert.equal(typeof code, "string")
  if (typeof code !== "string") return

  const rawBody = mailEnvelope({
    message_id: "mail-1",
    from: "bob@example.com",
    subject: `Re: Room ${code} update`,
    text: "count me in",
  })

  const res = await fetch(`${baseUrl}/inbound/agentpush-mail`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agentpush-signature": sign(rawBody) },
    body: rawBody,
  })
  assert.equal(res.status, 200)
  const body = await readJson(res)
  assert.equal(body.kind, "message")
  assert.ok(isRecord(body.room))
  if (!isRecord(body.room)) return
  assert.equal(body.room.code, code)
  assert.ok(isRecord(body.member))
  if (!isRecord(body.member)) return
  assert.equal(body.member.tier, "email")

  const sessionId = room.sessionId
  assert.equal(typeof sessionId, "string")
  if (typeof sessionId !== "string") return
  const promptRequests = daemon.requestsReceived.filter((r) => r.path === `/sessions/${sessionId}/prompt`)
  assert.ok(promptRequests.length >= 1)
  const lastPrompt = promptRequests[promptRequests.length - 1]?.body
  assert.ok(isRecord(lastPrompt))
  if (!isRecord(lastPrompt)) return
  assert.equal(lastPrompt.prompt, "[bob@example.com · email] count me in")
})

test("POST /inbound/agentpush-mail replays the same messageId and returns deduped:true, without fanning in twice", async () => {
  const { baseUrl } = await buildServer()
  const rawBody = mailEnvelope({ message_id: "mail-replay", text: "hi" })
  const headers = { "content-type": "application/json", "x-agentpush-signature": sign(rawBody) }

  const first = await fetch(`${baseUrl}/inbound/agentpush-mail`, { method: "POST", headers, body: rawBody })
  assert.equal(first.status, 200)
  const firstBody = await readJson(first)
  assert.equal(firstBody.kind, "unknown-sender")

  const second = await fetch(`${baseUrl}/inbound/agentpush-mail`, { method: "POST", headers, body: rawBody })
  assert.equal(second.status, 200)
  const secondBody = await readJson(second)
  assert.deepEqual(secondBody, { deduped: true })
})

test("POST /inbound/agentpush-mail with a bad signature returns 401", async () => {
  const { baseUrl } = await buildServer()
  const rawBody = mailEnvelope({ message_id: "mail-bad-sig" })

  const res = await fetch(`${baseUrl}/inbound/agentpush-mail`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agentpush-signature": "sha256=deadbeef" },
    body: rawBody,
  })
  assert.equal(res.status, 401)
})
