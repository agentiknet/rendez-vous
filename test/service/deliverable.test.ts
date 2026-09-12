import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { AgentpushToolClient } from "../../src/channels/agentpush/tools-client.ts"
import { DaemonClient } from "../../src/daemon/client.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Address, Member, PendingDelivery, Room, Tier } from "../../src/rooms/types.ts"
import { LocalBooter } from "../../src/service/booter.ts"
import {
  DeliverableAwareTransport,
  DeliverableService,
  parseDeliverBlocks,
  parseDeliverableCommand,
  readDeliverBlockRequest,
  resolveDeliveryTargets,
} from "../../src/service/deliverable.ts"
import { MediaStore } from "../../src/service/media-store.ts"
import type { RenderedPdf } from "../../src/service/pdf-render.ts"
import { RoomService } from "../../src/service/room-service.ts"
import { MemoryTransport } from "../../src/service/transports.ts"
import { startFakeDaemon, type FakeDaemon } from "../daemon/fake-daemon.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// A local fake agentpush — same shape as test/channels/outbound.test.ts's
// fixture, kept independent (that file is another module's fixture, not a
// shared import, matching this codebase's existing per-file convention).
// ---------------------------------------------------------------------------

interface CapturedRequest {
  readonly path: string
  readonly body: unknown
}

interface FakeAgentpush {
  readonly url: string
  readonly requests: CapturedRequest[]
  respondOnce: (status: number, body: unknown) => void
  close: () => Promise<void>
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString("utf8")
  return text.length > 0 ? JSON.parse(text) : undefined
}

async function startFakeAgentpush(): Promise<FakeAgentpush> {
  const requests: CapturedRequest[] = []
  const queue: { status: number; body: unknown }[] = []

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const body = await readBody(req)
      requests.push({ path: req.url ?? "", body })
      const next = queue.shift() ?? { status: 200, body: { status: "sent", message_id: "msg_1" } }
      res.writeHead(next.status, { "content-type": "application/json" })
      res.end(JSON.stringify(next.body))
    })()
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("expected a bound TCP address")

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    respondOnce: (status: number, body: unknown) => queue.push({ status, body }),
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  }
}

// ---------------------------------------------------------------------------
// Harness plumbing.
// ---------------------------------------------------------------------------

const dirs: string[] = []
const daemons: FakeDaemon[] = []
const agentpushServers: FakeAgentpush[] = []
const services: RoomService[] = []

after(async () => {
  await Promise.all(services.map((service) => service.stop()))
  await Promise.all(daemons.map((daemon) => daemon.close()))
  await Promise.all(agentpushServers.map((server) => server.close()))
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshDir(prefix = "rdv-deliverable-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function freshDaemon(): Promise<FakeDaemon> {
  const daemon = await startFakeDaemon()
  daemons.push(daemon)
  return daemon
}

async function freshAgentpush(): Promise<FakeAgentpush> {
  const server = await startFakeAgentpush()
  agentpushServers.push(server)
  return server
}

let renderCalls = 0

function fakeRenderPdf(pages = 2): (html: string, title: string, outPath: string) => Promise<RenderedPdf> {
  return async (_html, _title, outPath) => {
    renderCalls += 1
    await writeFile(outPath, Buffer.from(`%PDF-1.4 fake page count ${pages}`))
    return { path: outPath, bytes: 32, pages, renderMs: 1 }
  }
}

async function buildDeliverable(opts?: {
  daemon?: FakeDaemon
  agentpushUrl?: string
  now?: () => number
  expiryMs?: number
  pages?: number
  store?: RoomStore
  deliveryAllowlist?: readonly string[]
}): Promise<{ deliverable: DeliverableService; client: DaemonClient; daemon: FakeDaemon; mediaStore: MediaStore }> {
  const daemon = opts?.daemon ?? (await freshDaemon())
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const mediaStore = new MediaStore(await freshDir("rdv-media-"))
  const deliverable = new DeliverableService({
    mediaStore,
    client,
    agentpush: opts?.agentpushUrl !== undefined ? new AgentpushToolClient({ baseUrl: opts.agentpushUrl, apiKey: "apk_test" }) : undefined,
    publicUrl: "https://rdv.example.com",
    fetchHtml: async () => "<!doctype html><html><body><h1>the artifact</h1></body></html>",
    renderPdf: fakeRenderPdf(opts?.pages),
    ...(opts?.store !== undefined ? { store: opts.store } : {}),
    ...(opts?.deliveryAllowlist !== undefined ? { deliveryAllowlist: opts.deliveryAllowlist } : {}),
    ...(opts?.now !== undefined ? { now: opts.now } : {}),
    ...(opts?.expiryMs !== undefined ? { expiryMs: opts.expiryMs } : {}),
  })
  return { deliverable, client, daemon, mediaStore }
}

function room(overrides: Partial<Room> = {}): Room {
  const now = new Date().toISOString()
  return {
    code: "RDV-TEST",
    sessionId: "sess_test",
    sandboxId: undefined,
    artifactUrl: "https://artifact.example.com",
    artifactReady: true,
    members: [],
    createdAt: now,
    updatedAt: now,
    cursor: 0,
    lastActivityAt: now,
    state: "active",
    ...overrides,
  }
}

function member(overrides: Partial<Member> = {}): Member {
  return {
    id: "mem_jeremy",
    displayName: "Jeremy",
    tier: "messenger",
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+15550001111" },
    joinedAt: new Date().toISOString(),
    ...overrides,
  }
}

function promptTexts(daemon: FakeDaemon, sessionId: string): string[] {
  return daemon.requestsReceived
    .filter((r) => r.path === `/sessions/${sessionId}/prompt`)
    .map((r) => (isRecord(r.body) && typeof r.body.prompt === "string" ? r.body.prompt : ""))
}

function fail(reason: string): never {
  throw new Error(reason)
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

// ---------------------------------------------------------------------------
// Pure parsers.
// ---------------------------------------------------------------------------

test("parseDeliverBlocks finds a well-formed block and captures its raw span and fields", () => {
  const text = ["Sure, here it is.", "[[deliver]]", "to: alice@client.com", "subject: Q3 deck", "artifact: pdf", "[[/deliver]]", "Anything else?"].join(
    "\n",
  )
  const blocks = parseDeliverBlocks(text)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.fields.get("to"), "alice@client.com")
  assert.equal(blocks[0]?.fields.get("subject"), "Q3 deck")
  assert.equal(blocks[0]?.fields.get("artifact"), "pdf")
  assert.ok(blocks[0]?.raw.startsWith("[[deliver]]"))
  assert.ok(blocks[0]?.raw.endsWith("[[/deliver]]"))
  assert.ok(text.includes(blocks[0]?.raw ?? "\0"), "raw must be an exact substring of the original text")
})

test("parseDeliverBlocks stops scanning at an unmatched opening delimiter, finding nothing", () => {
  const text = "before\n[[deliver]]\nto: alice@client.com\nno closing delimiter here"
  assert.deepEqual(parseDeliverBlocks(text), [])
})

test("readDeliverBlockRequest rejects a missing to and an unsupported artifact", () => {
  const missing = readDeliverBlockRequest(new Map([["subject", "x"]]))
  assert.ok("error" in missing)

  const badArtifact = readDeliverBlockRequest(new Map([["to", "a@b.com"], ["artifact", "png"]]))
  assert.ok("error" in badArtifact)

  const ok = readDeliverBlockRequest(new Map([["to", "a@b.com"]]))
  assert.ok(!("error" in ok))
  if ("error" in ok) return
  assert.equal(ok.to, "a@b.com")
  assert.equal(ok.subject, "Rendez-vous deliverable")
})

test("parseDeliverableCommand recognizes send/confirm/cancel, case-insensitively, and rejects everything else", () => {
  assert.deepEqual(parseDeliverableCommand("send pdf to me"), { kind: "send", to: "me" })
  assert.deepEqual(parseDeliverableCommand("SEND PDF TO alice@client.com"), { kind: "send", to: "alice@client.com" })
  assert.deepEqual(parseDeliverableCommand("confirm pdf-7f3k"), { kind: "confirm", token: "PDF-7F3K" })
  assert.deepEqual(parseDeliverableCommand("cancel PDF-7F3K"), { kind: "cancel", token: "PDF-7F3K" })
  assert.equal(parseDeliverableCommand("what is the plan?"), undefined)
})

test("resolveDeliveryTargets: messenger self resolves to the requester's own address, or fails for a non-messenger requester", () => {
  const r = room({ members: [member()] })
  const messenger = member()
  const resolved = resolveDeliveryTargets(r, "messenger self", messenger)
  assert.deepEqual(resolved, [{ kind: "messenger", member: messenger }])

  const webMember = member({ tier: "room-web", address: { provider: "room-web", source: "room-web", contactRef: "jeremy" } })
  const failed = resolveDeliveryTargets(r, "me", webMember)
  assert.ok(!Array.isArray(failed))
})

test("resolveDeliveryTargets: messenger self with no requester (the agent's own block) resolves to every messenger member", () => {
  const messenger = member()
  const web = member({ id: "mem_web", tier: "room-web", address: { provider: "room-web", source: "room-web", contactRef: "chloe" } })
  const r = room({ members: [messenger, web] })
  const resolved = resolveDeliveryTargets(r, "messenger self", undefined)
  assert.deepEqual(resolved, [{ kind: "messenger", member: messenger }])
})

test("resolveDeliveryTargets: a bare email address resolves to an email target; anything else is an error", () => {
  const r = room()
  assert.deepEqual(resolveDeliveryTargets(r, "alice@client.com", undefined), [{ kind: "email", address: "alice@client.com" }])
  const bad = resolveDeliveryTargets(r, "not an address", undefined)
  assert.ok(!Array.isArray(bad))
})

test("resolveDeliveryTargets: a member's display name resolves to their own address — messenger contact, or contact ref as mail", () => {
  const alice = member({ id: "mem_alice", displayName: "Alice" })
  const bobMail = member({
    id: "mem_bob",
    displayName: "Bob",
    tier: "email",
    address: { provider: "agentpush", source: "mail", contactRef: "bob@example.com" },
  })
  const r = room({ members: [alice, bobMail] })

  assert.deepEqual(resolveDeliveryTargets(r, "Alice", undefined), [{ kind: "messenger", member: alice }])
  assert.deepEqual(resolveDeliveryTargets(r, "bob", undefined), [{ kind: "email", address: "bob@example.com" }])
  // Case-insensitive, and a member's name beats the "not a valid target" fallback.
  assert.deepEqual(resolveDeliveryTargets(r, "  ALICE  ", undefined), [{ kind: "messenger", member: alice }])
})

test("resolveDeliveryTargets: a room-web member's name is refused (no deliverable address), a non-member name is refused, an ambiguous name is refused with a visible line", () => {
  const web = member({ id: "mem_web", displayName: "Chloe", tier: "room-web", address: { provider: "room-web", source: "room-web", contactRef: "chloe" } })
  const refused = resolveDeliveryTargets(room({ members: [web] }), "Chloe", undefined)
  assert.ok(!Array.isArray(refused))
  assert.match(refused.error, /no messenger or email address/)

  const nonMember = resolveDeliveryTargets(room({ members: [member()] }), "Mallory", undefined)
  assert.ok(!Array.isArray(nonMember))
  assert.match(nonMember.error, /no member named "Mallory"/)

  const chris = member({ id: "mem_1", displayName: "Chris" })
  const chris2 = member({ id: "mem_2", displayName: "Chris", address: { provider: "whatsapp", source: "agentpush", contactRef: "+299" } })
  const ambiguous = resolveDeliveryTargets(room({ members: [chris, chris2] }), "Chris", undefined)
  assert.ok(!Array.isArray(ambiguous))
  assert.match(ambiguous.error, /matches 2 members/)
})

// ---------------------------------------------------------------------------
// The state machine: request -> preview, confirm -> send, cancel -> nothing,
// expiry -> say so. Driven directly against DeliverableService (no RoomService
// in the loop here), against a fake daemon (for the transcript audit note)
// and a fake agentpush (for the actual send).
// ---------------------------------------------------------------------------

test("requestFromCommand posts a preview with a token and does not send anything", async () => {
  const agentpush = await freshAgentpush()
  const { deliverable, daemon } = await buildDeliverable({ agentpushUrl: agentpush.url })
  const r = room({ members: [member()] })

  const outcome = await deliverable.requestFromCommand(r, member(), "me")
  assert.ok(outcome.ok)
  if (!outcome.ok) return
  assert.match(outcome.previewText, /Pages: 2/)
  assert.match(outcome.previewText, /PDF: https:\/\/rdv\.example\.com\/r\/RDV-TEST\/media\//)
  const tokenMatch = /confirm `?confirm (PDF-[A-Z0-9]{4})`?/.exec(outcome.previewText) ?? /confirm (PDF-[A-Z0-9]{4})/.exec(outcome.previewText)
  assert.ok(tokenMatch, outcome.previewText)

  assert.equal(agentpush.requests.length, 0, "a request must never itself send anything")

  const notes = promptTexts(daemon, "sess_test")
  assert.equal(notes.length, 1)
  assert.match(notes[0] ?? "", /Jeremy requested a delivery/)
})

test("confirm sends via upload_media then send_message for a messenger target, and records who asked/confirmed/sent in the transcript", async () => {
  const agentpush = await freshAgentpush()
  const { deliverable, daemon } = await buildDeliverable({ agentpushUrl: agentpush.url })
  const requester = member()
  const confirmer = member({ id: "mem_bob", displayName: "Bob" })
  const r = room({ members: [requester, confirmer] })

  const requested = await deliverable.requestFromCommand(r, requester, "me")
  assert.ok(requested.ok)
  if (!requested.ok) return
  const token = /confirm (PDF-[A-Z0-9]{4})/.exec(requested.previewText)?.[1]
  assert.ok(token)
  if (token === undefined) return

  agentpush.respondOnce(201, { media_id: "media_abc" })
  agentpush.respondOnce(200, { status: "sent", message_id: "wamid.123" })

  const confirmed = await deliverable.confirm(r, confirmer, token)
  assert.equal(confirmed.kind, "sent");
  if (confirmed.kind !== "sent") return
  assert.match(confirmed.resultText, /Bob/)
  assert.match(confirmed.resultText, /whatsapp/)
  assert.match(confirmed.resultText, /wamid\.123/)

  assert.equal(agentpush.requests.length, 2)
  const upload = agentpush.requests[0]
  assert.ok(upload)
  assert.equal(upload.path, "/tools/upload_media")
  assert.ok(isRecord(upload.body))
  if (isRecord(upload.body)) {
    assert.equal(upload.body.channel, "whatsapp")
    assert.equal(upload.body.type, "document")
    assert.equal(upload.body.mimeType, "application/pdf")
  }
  const send = agentpush.requests[1]
  assert.ok(send)
  assert.equal(send.path, "/tools/send_message")
  assert.ok(isRecord(send.body))
  if (isRecord(send.body) && isRecord(send.body.to)) {
    assert.equal(send.body.to.channel, "whatsapp")
    assert.equal(send.body.to.address, "+15550001111")
  }

  const notes = promptTexts(daemon, "sess_test")
  assert.equal(notes.length, 2)
  assert.match(notes[0] ?? "", /Jeremy requested a delivery/)
  assert.match(notes[1] ?? "", /Bob confirmed delivery/)
  assert.match(notes[1] ?? "", /wamid\.123/)

  assert.equal(deliverable.peek(r.code, token), undefined, "a confirmed token must not be reusable")
})

test("confirm sends channel: mail with subject and the PDF as media for an external (non-member) email address", async () => {
  const agentpush = await freshAgentpush()
  const { deliverable, daemon } = await buildDeliverable({ agentpushUrl: agentpush.url })
  const requester = member()
  const r = room({ members: [requester] })

  const requested = await deliverable.requestFromCommand(r, requester, "alice@client.com")
  assert.ok(requested.ok)
  if (!requested.ok) return
  const token = /confirm (PDF-[A-Z0-9]{4})/.exec(requested.previewText)?.[1]
  assert.ok(token)
  if (token === undefined) return

  agentpush.respondOnce(200, { status: "sent", message_id: "gmail-msg-1" })

  const confirmed = await deliverable.confirm(r, requester, token)
  assert.equal(confirmed.kind, "sent")

  assert.equal(agentpush.requests.length, 1, "mail media never needs a separate upload_media call")
  const send = agentpush.requests[0]
  assert.ok(send)
  assert.equal(send.path, "/tools/send_message")
  assert.ok(isRecord(send.body))
  if (isRecord(send.body) && isRecord(send.body.to) && isRecord(send.body.content)) {
    assert.equal(send.body.to.channel, "mail")
    assert.equal(send.body.to.address, "alice@client.com")
    assert.equal(typeof send.body.content.subject, "string")
    const media = send.body.content.media
    assert.ok(Array.isArray(media) && media.length === 1)
    const item = media?.[0]
    assert.ok(isRecord(item))
    if (isRecord(item)) {
      assert.equal(item.type, "document")
      assert.equal(item.providerMediaId, undefined, "mail rejects providerMediaId — must use a url or inline data")
      assert.equal(typeof item.url, "string")
    }
  }

  const notes = promptTexts(daemon, "sess_test")
  assert.match(notes[1] ?? "", /alice@client\.com/)
  assert.match(notes[1] ?? "", /gmail-msg-1/)
})

test("cancel discards the pending delivery, sends nothing, and records who cancelled", async () => {
  const agentpush = await freshAgentpush()
  const { deliverable, daemon } = await buildDeliverable({ agentpushUrl: agentpush.url })
  const requester = member()
  const r = room({ members: [requester] })

  const requested = await deliverable.requestFromCommand(r, requester, "me")
  assert.ok(requested.ok)
  if (!requested.ok) return
  const token = /confirm (PDF-[A-Z0-9]{4})/.exec(requested.previewText)?.[1]
  assert.ok(token)
  if (token === undefined) return

  const cancelled = await deliverable.cancel(r, requester, token)
  assert.equal(cancelled.kind, "cancelled")
  assert.equal(agentpush.requests.length, 0)

  const again = await deliverable.confirm(r, requester, token)
  assert.equal(again.kind, "not-found")
  assert.equal(agentpush.requests.length, 0)

  const notes = promptTexts(daemon, "sess_test")
  assert.match(notes[1] ?? "", /cancelled delivery/)
})

test("a pending delivery expires after 30 minutes and confirming it afterwards sends nothing", async () => {
  let clock = 0
  const { deliverable } = await buildDeliverable({ now: () => clock })
  const requester = member()
  const r = room({ members: [requester] })

  const requested = await deliverable.requestFromCommand(r, requester, "me")
  assert.ok(requested.ok)
  if (!requested.ok) return
  const token = /confirm (PDF-[A-Z0-9]{4})/.exec(requested.previewText)?.[1]
  assert.ok(token)
  if (token === undefined) return

  clock = 30 * 60_000 + 1
  const outcome = await deliverable.confirm(r, requester, token)
  assert.equal(outcome.kind, "expired")
  assert.equal(deliverable.peek(r.code, token), undefined)
})

// ---------------------------------------------------------------------------
// The delivery allowlist (docs/STATE.md hard limit): a resolved address not
// on it is refused at request time, before any render and before a token
// even exists to confirm.
// ---------------------------------------------------------------------------

test("a target not on the delivery allowlist is refused before rendering; an allowlisted member address passes", async () => {
  const agentpush = await freshAgentpush()
  const before = renderCalls
  const { deliverable, daemon } = await buildDeliverable({
    agentpushUrl: agentpush.url,
    deliveryAllowlist: ["jeremy@agentik.net", "+15550001111"],
  })
  const requester = member()
  const r = room({ members: [requester] })

  const refused = await deliverable.requestFromCommand(r, requester, "nobody@example.com")
  assert.ok(!refused.ok)
  if (refused.ok) return
  assert.match(refused.error, /not on the delivery allowlist/)
  assert.equal(renderCalls, before, "a refused target must never render")
  assert.equal(agentpush.requests.length, 0)
  assert.match(promptTexts(daemon, "sess_test")[0] ?? "", /refused: not on the delivery allowlist/)

  // The resolved address of a member by name is checked the same way.
  const refusedName = await deliverable.requestFromCommand(r, requester, "Mallory")
  assert.ok(!refusedName.ok)

  const allowed = await deliverable.requestFromCommand(r, requester, "me")
  assert.ok(allowed.ok, allowed.ok ? "" : allowed.error)
})

// ---------------------------------------------------------------------------
// Persistence (the restart finding): pending deliveries live on the room
// record, so a fresh service over the reopened store can still confirm —
// and expired leftovers are swept with the usual transcript line.
// ---------------------------------------------------------------------------

function pendingFixture(memberOfRoom: Member, token: string, expiresAt: number): PendingDelivery {  return {
    token,
    requestedBy: "Jeremy",
    target: { kind: "messenger", member: memberOfRoom },
    subject: "Room RDV-TEST deliverable",
    mediaId: "00000000-0000-4000-8000-000000000001",
    pageCount: 1,
    createdAt: expiresAt - 30 * 60_000,
    expiresAt,
  }
}

async function persistedRoom(dir: string): Promise<{ store: RoomStore; code: string; requester: Member; confirmer: Member }> {
  const store = await RoomStore.open(dir)
  const created = await store.create()
  const requester = await store.addMember(created.code, {
    displayName: "Jeremy",
    tier: "messenger",
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+15550001111" },
  })
  const confirmer = await store.addMember(created.code, {
    displayName: "Bob",
    tier: "messenger",
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+15550002222" },
  })
  await store.update(created.code, { sessionId: "sess_test", artifactUrl: "https://artifact.example.com" })
  const room = store.get(created.code)
  if (room === undefined) throw new Error("unreachable")
  return { store, code: room.code, requester, confirmer }
}

test("a pending delivery survives a service restart: request, reopen the store in a new service, confirm works", async () => {
  const agentpush = await freshAgentpush()
  const dir = await freshDir("rdv-persist-")
  const { store, code, requester, confirmer } = await persistedRoom(dir)
  const { deliverable } = await buildDeliverable({ agentpushUrl: agentpush.url, store, pages: 1 })

  const requested = await deliverable.requestFromCommand(store.get(code) ?? fail(`room ${code} vanished`), requester, "me")
  assert.ok(requested.ok)
  if (!requested.ok) return
  const token = /confirm (PDF-[A-Z0-9]{4})/.exec(requested.previewText)?.[1]
  assert.ok(token)
  if (token === undefined) return

  const persisted = store.get(code)?.pendingDeliveries
  assert.equal(persisted?.length, 1, "the request must be written through to the room record")
  assert.equal(persisted?.[0]?.token, token)
  assert.equal(persisted?.[0]?.target.kind, "messenger")

  // A genuinely new store AND a genuinely new service — the in-memory map is
  // empty, so confirm proves it hydrated the pending back from the room
  // record. The MediaStore index is also empty (fresh dir), exercising the
  // confirm-time re-render fallback against the room's artifactUrl.
  const reopened = await RoomStore.open(dir)
  assert.equal(reopened.get(code)?.pendingDeliveries?.[0]?.token, token)
  const { deliverable: revived, daemon: revivedDaemon } = await buildDeliverable({ agentpushUrl: agentpush.url, store: reopened, pages: 1 })
  assert.notEqual(revived.peek(code, token), undefined, "the restarted service must know the pending token")

  agentpush.respondOnce(200, { media_id: "media_restart" })
  agentpush.respondOnce(200, { status: "sent", message_id: "restart-msg-1" })
  const confirmed = await revived.confirm(reopened.get(code) ?? fail(`room ${code} vanished`), confirmer, token)
  assert.equal(confirmed.kind, "sent")
  if (confirmed.kind !== "sent") return
  assert.match(confirmed.resultText, /restart-msg-1/)

  await waitFor(() => (reopened.get(code)?.pendingDeliveries ?? []).length === 0)
  assert.match(promptTexts(revivedDaemon, "sess_test").join("\n"), /Bob confirmed delivery/)
})

test("pending deliveries expired before the restart are swept on startup with the usual transcript line, live ones survive", async () => {
  const dir = await freshDir("rdv-sweep-")
  const { store, code, requester } = await persistedRoom(dir)
  const clock = 1_000_000
  await store.update(code, {
    pendingDeliveries: [
      pendingFixture(requester, "PDF-DEAD", clock - 1),
      pendingFixture(requester, "PDF-LIVE", clock + 30 * 60_000),
    ],
  })

  const { deliverable, daemon } = await buildDeliverable({ store, now: () => clock })
  await waitFor(() => (store.get(code)?.pendingDeliveries ?? []).length === 1)

  const kept = store.get(code)?.pendingDeliveries?.[0]
  assert.equal(kept?.token, "PDF-LIVE")
  assert.notEqual(deliverable.peek(code, "PDF-LIVE"), undefined, "a live pending must be confirmable after the restart")
  assert.equal(deliverable.peek(code, "PDF-DEAD"), undefined, "an expired pending must never become confirmable again")
  await waitFor(() => promptTexts(daemon, "sess_test").some((text) => text.includes("PDF-DEAD")))
  assert.match(promptTexts(daemon, "sess_test").join("\n"), /Delivery PDF-DEAD \("Room RDV-TEST deliverable"\) expired before anyone confirmed it\./)
})

// ---------------------------------------------------------------------------
// The agent's own `[[deliver]]` block, via the Transport decorator — proves
// this module never needs to touch src/fanout to intercept agent-authored
// text, and that the N-members-per-flush call pattern still renders/stores
// exactly once.
// ---------------------------------------------------------------------------

test("DeliverableAwareTransport strips a [[deliver]] block into the same preview text for every member, rendering only once", async () => {
  const before = renderCalls
  const { deliverable } = await buildDeliverable()
  const dir = await freshDir("rdv-store-")
  const store = await RoomStore.open(dir)
  const created = await store.create()
  const alice = await store.addMember(created.code, member())
  const bob = await store.addMember(created.code, member({ id: "mem_bob", displayName: "Bob", address: { provider: "telegram", source: "agentpush", contactRef: "999" } }))
  await store.update(created.code, { sessionId: "sess_test", artifactUrl: "https://artifact.example.com" })

  const inner = new MemoryTransport()
  const wrapped = new DeliverableAwareTransport(inner, deliverable, store)

  const text = ["Here you go.", "[[deliver]]", "to: messenger self", "subject: Report", "[[/deliver]]", "Let me know."].join("\n")
  // Concurrent, not sequential — mirrors how `RoomFanout.flush` actually
  // calls this (`Promise.allSettled(room.members.map(...))`), which is what
  // the dedupe in `DeliverableAwareTransport` depends on (see its doc
  // comment): awaiting each send in turn would let the first call's work
  // finish and clear the in-flight entry before the second even starts.
  await Promise.all([wrapped.send(alice, { text, artifactUrl: undefined }), wrapped.send(bob, { text, artifactUrl: undefined })])

  assert.equal(inner.sends.length, 2)
  const aliceText = inner.sends.find((s) => s.member.displayName === "Jeremy")?.message.text ?? ""
  const bobText = inner.sends.find((s) => s.member.displayName === "Bob")?.message.text ?? ""
  assert.ok(aliceText.includes("Here you go."))
  assert.ok(aliceText.includes("Let me know."))
  assert.ok(!aliceText.includes("[[deliver]]"))
  assert.equal(aliceText, bobText, "every member sees the same preview text")

  assert.equal(renderCalls, before + 1, "the deliver block must be rendered exactly once despite two member sends")
})

// ---------------------------------------------------------------------------
// The confirm gate is a routing property of RoomService, not something
// DeliverableService enforces itself — proven end to end: a stranger's
// message never resolves to a Member, so it never reaches `confirm` at all.
// ---------------------------------------------------------------------------

function alice(text: string): { address: Address; displayName: string; tier: Tier; text: string } {
  return {
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+15550001111" },
    displayName: "Jeremy",
    tier: "messenger",
    text,
  }
}

function mallory(text: string): { address: Address; displayName: string; tier: Tier; text: string } {
  return {
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+19998887777" },
    displayName: "Mallory",
    tier: "messenger",
    text,
  }
}

test("a non-member cannot confirm a pending delivery — their message never resolves to a room member", async () => {
  const dir = await freshDir("rdv-roomsvc-")
  const daemon = await freshDaemon()
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })
  const transport = new MemoryTransport()
  const { deliverable, mediaStore } = await buildDeliverable({ daemon })
  const service = new RoomService({
    store,
    client,
    booter,
    transport,
    daemon: { baseUrl: daemon.url, token: undefined },
    mediaStore,
    deliverable,
  })
  services.push(service)

  const created = await service.handleInbound(alice("new"))
  assert.ok(created.kind === "created")
  if (created.kind !== "created") return
  // LocalBooter has no artifact concept (R9) — give the room one so
  // `requestFromCommand` has something to render, matching the docs/DELIVERABLE.md
  // precondition rather than exercising the separate "no artifact yet" failure path.
  await store.update(created.room.code, { artifactUrl: "https://artifact.example.com" })

  await service.handleInbound(alice("send pdf to me"))
  const previewText = transport.sends[transport.sends.length - 1]?.message.text ?? ""
  const token = /confirm (PDF-[A-Z0-9]{4})/.exec(previewText)?.[1]
  assert.ok(token, previewText)
  if (token === undefined) return

  const outcome = await service.handleInbound(mallory(`confirm ${token}`))
  assert.equal(outcome.kind, "unknown-sender")
  assert.equal(deliverable.peek(created.room.code, token) !== undefined, true, "a stranger's confirm attempt must not consume the pending delivery")
})
