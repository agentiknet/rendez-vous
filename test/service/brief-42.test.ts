/**
 * BRIEF-42: agentpush refuses a send with `{status:"blocked",
 * blocked_reason:"session_expired"}` — HTTP 200, no throw — and the room
 * recorded the message as `status:"delivered", confirmedBy:"transport"`.
 * The transport must be able to say no (a typed refusal carrying the
 * provider's `blocked_reason` verbatim), and the engine's existing failure
 * path must run from it: the record ends `failed` with `lastError` set,
 * `confirmedBy` ABSENT, and the agent told. A permanent refusal is not
 * retried: agentpush's policy gate is deterministic, so the four extra
 * attempts could only replay the same refusal.
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import type { Transport } from "../../src/fanout/types.ts"
import { SendBlockedError } from "../../src/fanout/types.ts"
import { AgentpushTransport } from "../../src/channels/agentpush/outbound.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Delivery, Member } from "../../src/rooms/types.ts"
import { DeliveryEngine } from "../../src/service/delivery.ts"

const dirs: string[] = []

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-brief42-"))
  dirs.push(dir)
  return dir
}

async function roomWith(): Promise<{ store: RoomStore; code: string; bob: Member }> {
  const dir = await freshDir()
  const store = await RoomStore.open(dir)
  const created = await store.create()
  const bob = await store.addMember(created.code, {
    displayName: "Bob",
    tier: "messenger",
    address: { provider: "whatsapp", source: "test", contactRef: "ref-bob" },
  })
  return { store, code: created.code, bob }
}

const BLOCKED_BODY = { status: "blocked", blocked_reason: "session_expired", suggestion: "re-link the session" }

function agentpushWith(body: unknown): AgentpushTransport {
  return new AgentpushTransport({
    baseUrl: "https://agentpush.test",
    apiKey: "key",
    fetchImpl: (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch,
  })
}

function engine(
  store: RoomStore,
  transport: Transport,
  reportFailure?: (code: string, correction: string) => Promise<void>,
): DeliveryEngine {
  return new DeliveryEngine({
    store,
    transport,
    autoDrain: false,
    ...(reportFailure !== undefined ? { reportFailure } : {}),
  })
}

test("AgentpushTransport.send throws a SendBlockedError carrying blocked_reason verbatim", async () => {
  const transport = agentpushWith(BLOCKED_BODY)
  const member = {
    id: "m1",
    displayName: "Bob",
    tier: "messenger",
    address: { provider: "whatsapp", source: "test", contactRef: "wa-number" },
  } as Member
  await assert.rejects(
    transport.send(member, { text: "hello", artifactUrl: undefined }),
    (error: unknown) => error instanceof SendBlockedError && error.blockedReason === "session_expired",
  )
})

test("a blocked send is recorded failed — never delivered, reason verbatim, no retry", async () => {
  const { store, code, bob } = await roomWith()
  const corrections: string[] = []
  const transport = agentpushWith(BLOCKED_BODY)
  const delivery = engine(store, transport, async (_code, correction) => {
    corrections.push(correction)
  })
  await delivery.accept(code, "say", "the numbers", [bob.id])
  await delivery.drain(code)

  const record = (store.get(code)?.deliveries ?? []).find(
    (candidate): candidate is Delivery => candidate.memberId === bob.id && candidate.kind === "say",
  )
  assert.ok(record, "no say record for Bob")
  assert.equal(record.status, "failed")
  assert.equal(record.lastError, "session_expired")
  assert.equal("confirmedBy" in record ? record.confirmedBy : undefined, undefined)
  assert.equal(record.failures, 5)
  assert.equal(corrections.length, 1)
})

test("a permanent refusal is not retried — one send attempt, not five", async () => {
  const { store, code, bob } = await roomWith()
  let sends = 0
  const transport: Transport = {
    async send() {
      sends += 1
      throw new SendBlockedError("session_expired")
    },
  }
  const delivery = engine(store, transport)
  await delivery.accept(code, "say", "the numbers", [bob.id])
  await delivery.drain(code)
  await delivery.drain(code)

  assert.equal(sends, 1, `expected one attempt, saw ${sends}`)
  const record = (store.get(code)?.deliveries ?? []).find((candidate) => candidate.memberId === bob.id)
  assert.equal(record?.status, "failed")
  assert.equal(record?.lastError, "session_expired")
})

test("a blocked attachment says no — SendBlockedError with blocked_reason verbatim", async () => {
  const transport = agentpushWith(BLOCKED_BODY)
  const member = {
    id: "m1",
    displayName: "Bob",
    tier: "messenger",
    address: { provider: "whatsapp", source: "test", contactRef: "wa-number" },
  } as Member
  await assert.rejects(
    transport.sendAttachment(member, {
      url: "https://rdv.example.com/r/RDV-7F3K/media/doc1",
      filename: "numbers.pdf",
      mimeType: "application/pdf",
      kind: "document",
      caption: undefined,
    }),
    (error: unknown) => error instanceof SendBlockedError && error.blockedReason === "session_expired",
  )
})

test("a blocked media send says no too (telegram, public-URL path)", async () => {
  const transport = agentpushWith(BLOCKED_BODY)
  const member = {
    id: "m2",
    displayName: "Alice",
    tier: "messenger",
    address: { provider: "telegram", source: "test", contactRef: "tg-chat" },
  } as Member
  await assert.rejects(
    transport.sendMedia(member, Uint8Array.from([1, 2, 3]), "scan me", "https://rdv.example.com/r/RDV-7F3K/media/qr"),
    (error: unknown) => error instanceof SendBlockedError && error.blockedReason === "session_expired",
  )
})

test("a push member whose provider the messenger transport cannot name is a loud failure, not a no-op", async () => {
  const transport = agentpushWith({ status: "sent", message_id: "msg_1" })
  const member = {
    id: "m3",
    displayName: "Postie",
    tier: "messenger",
    delivery: { mode: "push", provider: "email", address: "postie@example.com" },
    address: { provider: "email", source: "test", contactRef: "postie@example.com" },
  } as unknown as Member
  await assert.rejects(transport.send(member, { text: "hello", artifactUrl: undefined }), /unrecognized push provider/)
  await assert.rejects(
    transport.sendMedia(member, Uint8Array.from([1]), "caption", undefined),
    /unrecognized push provider/,
  )
  await assert.rejects(
    transport.sendAttachment(member, {
      url: "https://rdv.example.com/m/doc1",
      filename: "doc.pdf",
      mimeType: "application/pdf",
      kind: "document",
      caption: undefined,
    }),
    /unrecognized push provider/,
  )
})

test("a blocked whisper never announces — the room is not told about a private exchange that did not happen", async () => {
  const dir = await freshDir()
  const store = await RoomStore.open(dir)
  const created = await store.create()
  const bob = await store.addMember(created.code, {
    displayName: "Bob",
    tier: "messenger",
    address: { provider: "whatsapp", source: "test", contactRef: "ref-bob" },
  })
  const claire = await store.addMember(created.code, {
    displayName: "Claire",
    tier: "room-web",
    address: { provider: "room-web", source: "test", contactRef: "ref-claire" },
  })
  const transport = agentpushWith(BLOCKED_BODY)
  const delivery = engine(store, transport)
  await delivery.accept(created.code, "whisper", "between us", [bob.id])
  await delivery.drain(created.code)

  const records = store.get(created.code)?.deliveries ?? []
  const whisper = records.find((candidate) => candidate.memberId === bob.id && candidate.kind === "whisper")
  assert.equal(whisper?.status, "failed")
  assert.equal(records.some((candidate) => candidate.kind === "system"), false, "an outsider notice fired for a blocked whisper")
  assert.equal(
    records.some((candidate) => candidate.memberId === claire.id),
    false,
  )
})
