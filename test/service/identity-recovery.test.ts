import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { DaemonClient } from "../../src/daemon/client.ts"
import type { Delivery, Member } from "../../src/rooms/types.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import { LocalBooter } from "../../src/service/booter.ts"
import { createHttpServer } from "../../src/service/http.ts"
import { MediaStore } from "../../src/service/media-store.ts"
import { RoomService } from "../../src/service/room-service.ts"
import { MemoryTransport } from "../../src/service/transports.ts"
import { startExtendedFakeDaemon, type ExtendedFakeDaemon } from "./fake-daemon-extra.ts"

/** Mirrors `RECOVERY_LINK_TTL_MS` (src/service/room-service.ts). Spelled out
 *  here rather than imported so the whole file still LOADS on `main`, where
 *  the export does not exist — every test must fail on its own behaviour,
 *  not on one broken import line that hides which of them ran. */
const RECOVERY_LINK_TTL_MS = 15 * 60_000

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
  const dir = await mkdtemp(join(tmpdir(), "rdv-recovery-"))
  dirs.push(dir)
  return dir
}

interface RecoveryHarness {
  service: RoomService
  store: RoomStore
  transport: MemoryTransport
  daemon: ExtendedFakeDaemon
  baseUrl: string
  code: string
  sessionId: string
  alice: Member
  bob: Member
  webAlice: Member
  webDana: Member
  /** Advance or rewind the service's injected clock (millis). */
  setNow: (ms: number) => void
  nowMs: number
}

/** A room with two push members (Alice on WhatsApp, Bob on Telegram) and two
 *  room-web members: `Alice` — the locked-out web identity with an existing
 *  claim — and `Dana`, whom no push surface can back. */
async function recoveryHarness(): Promise<RecoveryHarness> {
  const dir = await freshDir()
  const daemon = await startExtendedFakeDaemon()
  daemons.push(daemon)
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })
  const transport = new MemoryTransport()
  const clock = { now: 1_700_000_000_000 }
  const service = new RoomService({
    store,
    client,
    booter,
    transport,
    daemon: { baseUrl: daemon.url, token: undefined },
    mediaStore: new MediaStore(await freshDir()),
    now: () => clock.now,
  })
  services.push(service)

  const created = await service.handleInbound({
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+15550001111" },
    displayName: "Alice",
    tier: "messenger",
    text: "new",
  })
  assert.equal(created.kind, "created")
  if (created.kind !== "created") throw new Error("unreachable")
  const code = created.room.code
  const sessionId = created.room.sessionId
  assert.ok(sessionId !== undefined)
  if (sessionId === undefined) throw new Error("unreachable")

  const readMember = (memberId: string): Member => {
    const member = store.get(code)?.members.find((candidate) => candidate.id === memberId)
    if (member === undefined) throw new Error(`member ${memberId} vanished`)
    return member
  }
  const alice = readMember(
    store.get(code)?.members.find((member) => member.address.provider === "whatsapp")?.id ?? "",
  )
  const bob = await store.addMember(code, {
    displayName: "Bob",
    tier: "messenger",
    address: { provider: "telegram", source: "agentpush", contactRef: "700" },
  })
  const webAlice = await store.addMember(code, {
    displayName: "Alice",
    tier: "room-web",
    address: { provider: "room-web", source: "room-web", contactRef: "alice" },
    claim: "the-old-web-secret",
  })
  const webDana = await store.addMember(code, {
    displayName: "Dana",
    tier: "room-web",
    address: { provider: "room-web", source: "room-web", contactRef: "dana" },
  })

  const server = createHttpServer(service)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!isAddressInfo(address)) throw new Error("failed to bind http server")
  const baseUrl = `http://127.0.0.1:${address.port}`
  servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })

  return {
    service,
    store,
    transport,
    daemon,
    baseUrl,
    code,
    sessionId,
    alice,
    bob,
    webAlice,
    webDana,
    nowMs: clock.now,
    setNow: (ms: number) => {
      clock.now = ms
    },
  }
}

function tokenOf(url: string): string {
  const parsed = new URL(url)
  const token = parsed.searchParams.get("recover")
  if (typeof token !== "string" || token.length === 0) throw new Error(`no recovery token in ${url}`)
  return token
}

async function postJson(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  const parsed: unknown = JSON.parse(text)
  return { status: res.status, body: isRecord(parsed) ? parsed : {} }
}

function deliveriesFor(store: RoomStore, code: string, memberId: string): Delivery[] {
  return (store.get(code)?.deliveries ?? []).filter((delivery) => delivery.memberId === memberId)
}

// 1. A member with a push surface asks in words -> the link reaches THAT
//    surface only. The recipient is the assertion, not that something sent.
test("BRIEF-23: a push member's recovery request delivers one one-time link to that member's own surface and to nobody else", async () => {
  const h = await recoveryHarness()
  const before = h.transport.sends.length

  const outcome = await h.service.requestIdentityRecovery(h.code, h.alice.id)
  assert.equal(outcome.kind, "sent")
  if (outcome.kind !== "sent") return

  const fresh = h.transport.sends.slice(before)
  assert.equal(fresh.length, 1, "exactly one message — not a broadcast")
  const only = fresh[0]
  assert.ok(only !== undefined)
  if (only === undefined) return
  assert.equal(only.member.id, h.alice.id, "the requesting push member is the recipient")
  assert.equal(only.member.address.provider, "whatsapp")
  assert.ok(only.message.text.includes("recover="), "the link is in the message")
  assert.ok(!fresh.some((send) => send.member.id === h.bob.id), "the other push member receives nothing")

  // And not to the room-web identity either: its outbox is empty of the link.
  assert.equal(deliveriesFor(h.store, h.code, h.webAlice.id).length, 0)

  const links = h.store.get(h.code)?.recoveries ?? []
  assert.equal(links.length, 1)
  assert.equal(links[0]?.usedAt, undefined, "a freshly issued link is not burned")
})

// 2. Opening the link installs the claim; a subsequent send from that origin
//    succeeds. Assert the SEND, not that a handler ran.
test("BRIEF-23: redeeming the link restores the existing claim, and a send presenting it reaches the room", async () => {
  const h = await recoveryHarness()
  const outcome = await h.service.requestIdentityRecovery(h.code, h.alice.id)
  assert.equal(outcome.kind, "sent")
  if (outcome.kind !== "sent") return
  const token = tokenOf(outcome.url)

  const redeemed = await postJson(h.baseUrl, `/rooms/${h.code}/recover`, { token, displayName: "Alice" })
  assert.equal(redeemed.status, 200)
  assert.equal(redeemed.body.displayName, "Alice")
  assert.equal(redeemed.body.claim, "the-old-web-secret", "recovery restores the member's existing claim")
  assert.equal(redeemed.body.memberId, h.webAlice.id, "the SAME member is restored, never removed and recreated (docs/OUTBOX.md §7.1)")

  const claim = typeof redeemed.body.claim === "string" ? redeemed.body.claim : ""
  const claimed = await postJson(h.baseUrl, `/rooms/${h.code}/claim`, { displayName: "Alice", claim })
  assert.equal(claimed.status, 200)
  const memberToken = claimed.body.memberToken
  assert.equal(typeof memberToken, "string")

  const sent = await postJson(h.baseUrl, `/rooms/${h.code}/send`, {
    displayName: "Alice",
    text: "back at last",
    claim,
  })
  assert.equal(sent.status, 200)
  const prompts = h.daemon.requestsReceived.filter((request) => request.path === `/sessions/${h.sessionId}/prompt`)
  assert.equal(prompts.length, 1, "the send actually reached the room's session")
})

// 3. Single-use is the property: the second redemption must be refused.
test("BRIEF-23: the link is refused the second time", async () => {
  const h = await recoveryHarness()
  const outcome = await h.service.requestIdentityRecovery(h.code, h.alice.id)
  assert.equal(outcome.kind, "sent")
  if (outcome.kind !== "sent") return
  const token = tokenOf(outcome.url)

  const first = await postJson(h.baseUrl, `/rooms/${h.code}/recover`, { token, displayName: "Alice" })
  assert.equal(first.status, 200)

  const second = await postJson(h.baseUrl, `/rooms/${h.code}/recover`, { token, displayName: "Alice" })
  assert.equal(second.status, 409)
  assert.equal(second.body.error, "invalid_token")
})

// 4. The window, both arms: a link past its expiry is refused, a fresh one
//    issued at that same moment works.
test("BRIEF-23: the link is refused after its window, and a fresh one issued then still works (both arms)", async () => {
  const h = await recoveryHarness()
  const issued = await h.service.requestIdentityRecovery(h.code, h.alice.id)
  assert.equal(issued.kind, "sent")
  if (issued.kind !== "sent") return

  h.setNow(h.nowMs + RECOVERY_LINK_TTL_MS + 1)
  const expired = await postJson(h.baseUrl, `/rooms/${h.code}/recover`, {
    token: tokenOf(issued.url),
    displayName: "Alice",
  })
  assert.equal(expired.status, 409)
  assert.equal(expired.body.error, "expired_token")

  const fresh = await h.service.requestIdentityRecovery(h.code, h.alice.id)
  assert.equal(fresh.kind, "sent")
  if (fresh.kind !== "sent") return
  const redeemed = await postJson(h.baseUrl, `/rooms/${h.code}/recover`, {
    token: tokenOf(fresh.url),
    displayName: "Alice",
  })
  assert.equal(redeemed.status, 200, "the same moment issues a link that is still live")
})

// 5. The test that matters most: a different member cannot use the link to
//    become themselves. Without it the link is a room code with a nicer name.
test("BRIEF-23: a different member opening someone else's link is refused, and the link is not spent by the attempt", async () => {
  const h = await recoveryHarness()
  const outcome = await h.service.requestIdentityRecovery(h.code, h.alice.id)
  assert.equal(outcome.kind, "sent")
  if (outcome.kind !== "sent") return
  const token = tokenOf(outcome.url)

  const stolen = await postJson(h.baseUrl, `/rooms/${h.code}/recover`, { token, displayName: "Bob" })
  assert.equal(stolen.status, 409)
  assert.equal(stolen.body.error, "wrong_member")

  // The refusal did not burn it: the name it was issued for still works.
  const rightful = await postJson(h.baseUrl, `/rooms/${h.code}/recover`, { token, displayName: "Alice" })
  assert.equal(rightful.status, 200)
})

// 6. A genuine conflict is unchanged: a name held by someone else is refused
//    with brief 21's conflict message, and no link is issued.
test("BRIEF-23: requesting recovery of a name someone else holds refuses with brief 21's conflict message and issues no link", async () => {
  const h = await recoveryHarness()
  const claimAttempt = await postJson(h.baseUrl, `/rooms/${h.code}/claim`, { displayName: "Alice" })
  assert.equal(claimAttempt.status, 409)
  assert.equal(claimAttempt.body.error, "name_claimed")
  const conflictMessage = claimAttempt.body.message

  const before = h.transport.sends.length
  const outcome = await h.service.requestIdentityRecovery(h.code, h.bob.id, "Alice")
  assert.equal(outcome.kind, "conflict")
  if (outcome.kind !== "conflict") return
  assert.equal(outcome.message, conflictMessage, "the same sentence the claim path gives")

  const fresh = h.transport.sends.slice(before)
  assert.ok(fresh.every((send) => !send.message.text.includes("recover=")), "no link is handed out")
  assert.equal((h.store.get(h.code)?.recoveries ?? []).length, 0, "no recovery link was minted")
})

// 7. A room-web-only member has nothing to prove against: an honest sentence,
//    not silence and not a link.
test("BRIEF-23: a room-web-only member is told there is no way to prove them, with no link issued", async () => {
  const h = await recoveryHarness()
  const outcome = await h.service.requestIdentityRecovery(h.code, h.webDana.id)
  assert.equal(outcome.kind, "no-surface")

  assert.equal((h.store.get(h.code)?.recoveries ?? []).length, 0, "no link is minted for a member with no push surface")
  const records = deliveriesFor(h.store, h.code, h.webDana.id)
  assert.equal(records.length, 1, "the refusal is said, not silent")
  const text = records[0]?.text ?? ""
  assert.ok(text.toLowerCase().includes("no way to prove"), `the honest sentence is absent: ${text}`)
  assert.ok(!text.includes("recover="), "and it is not a link")
})

// 8. The capability must not ride the public projection: the room JSON and
//    the page's embedded INITIAL_ROOM are handed to ANY caller/spectator, and
//    an unspent token there hands the identity away.
test("BRIEF-23: a live recovery token never appears in the public room JSON or the page HTML", async () => {
  const h = await recoveryHarness()
  const outcome = await h.service.requestIdentityRecovery(h.code, h.alice.id)
  assert.equal(outcome.kind, "sent")
  if (outcome.kind !== "sent") return
  const token = tokenOf(outcome.url)

  // Positive arm first: the token really is live in the store, so the
  // absence assertions below are not passing against an empty capability.
  assert.equal((h.store.get(h.code)?.recoveries ?? []).length, 1)

  const publicRoom = await fetch(`${h.baseUrl}/rooms/${h.code}`)
  const publicText = await publicRoom.text()
  assert.ok(!publicText.includes(token), "the room JSON leaks the recovery token")

  const page = await fetch(`${h.baseUrl}/r/${h.code}`)
  const html = await page.text()
  assert.ok(!html.includes(token), "the spectator page embeds the recovery token")
})
