/**
 * BRIEF-44 — the WhatsApp attachment that fails, and that nobody is told
 * about. Measured live 2026-09-14, room RDV-LJ6J: the agent sent one image
 * per surface; Telegram received both, WhatsApp received neither, and
 * rendez-vous recorded NOTHING — agentpush's own counters read `sent 6,
 * delivered 4, failed 2` while every record here said the room had served
 * the file. Two defects, both regression-tested here:
 *
 * 1. `sendAttachment` sent media by `url` for EVERY provider, contradicting
 *    `sendMedia`'s own verified branch in the same file: WhatsApp has no
 *    url-media path — it needs `upload_media` → `providerMediaId`.
 * 2. `deliverAttachment` called the transport DIRECTLY, never
 *    `DeliveryEngine.accept` — so an attachment minted no record and a file
 *    that never arrived was not recorded as anything: no status, no retry,
 *    no `lastError`, no report to anyone.
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import type { Transport } from "../../src/fanout/types.ts"
import { SendBlockedError } from "../../src/fanout/types.ts"
import { AgentpushTransport } from "../../src/channels/agentpush/outbound.ts"
import { isRecord } from "../../src/channels/json.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Delivery, Member } from "../../src/rooms/types.ts"
import { DeliveryEngine } from "../../src/service/delivery.ts"
import { MemberSender } from "../../src/service/member-send.ts"
import type { OutboundAttachment } from "../../src/service/transports.ts"

const dirs: string[] = []

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-brief44-"))
  dirs.push(dir)
  return dir
}

const ATTACHMENT: OutboundAttachment = {
  url: "https://rdv.example.com/r/RDV-7F3K/media/itinerary.pdf",
  filename: "itinerary.pdf",
  mimeType: "application/pdf",
  kind: "document",
  caption: "the plan",
}

/** A member straight from the store — a real `Member`, not a moulded literal. */
async function roomWith(provider: string): Promise<{ store: RoomStore; code: string; member: Member }> {
  const dir = await freshDir()
  const store = await RoomStore.open(dir)
  const created = await store.create()
  const member = await store.addMember(created.code, {
    displayName: "Bob",
    tier: "messenger",
    address: { provider, source: "test", contactRef: "ref-bob" },
  })
  return { store, code: created.code, member }
}

interface SeenCall {
  url: string
  body: string | undefined
}

/** One fetch stub for everything BRIEF-44's WhatsApp path touches: the
 *  attachment bytes at the public URL (fetch-then-upload) and the two
 *  agentpush tool endpoints. Records every call. */
function agentpushWithMedia(body: unknown): { transport: AgentpushTransport; calls: SeenCall[] } {
  const calls: SeenCall[] = []
  const transport = new AgentpushTransport({
    baseUrl: "https://agentpush.test",
    apiKey: "key",
    fetchImpl: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined })
      if (url === ATTACHMENT.url) {
        return new Response(Uint8Array.from([1, 2, 3, 4]), { status: 200 })
      }
      if (url === "https://agentpush.test/tools/upload_media") {
        return new Response(JSON.stringify({ media_id: "wa-media-1" }), { status: 200 })
      }
      if (url === "https://agentpush.test/tools/send_message") {
        return new Response(JSON.stringify(body), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    },
  })
  return { transport, calls }
}

function parsedBody(call: SeenCall | undefined): Record<string, unknown> | undefined {
  if (call === undefined || typeof call.body !== "string") return undefined
  const parsed: unknown = JSON.parse(call.body)
  return isRecord(parsed) ? parsed : undefined
}

function bodiesTo(calls: SeenCall[], tool: string): SeenCall[] {
  return calls.filter((call) => call.url === `https://agentpush.test/tools/${tool}`)
}

test("BRIEF-44 regression: a WhatsApp attachment uploads then sends by providerMediaId, never by url", async () => {
  const { member } = await roomWith("whatsapp")
  const { transport, calls } = agentpushWithMedia({ status: "sent", message_id: "msg_1" })
  await transport.sendAttachment(member, ATTACHMENT)

  const uploadBodies = bodiesTo(calls, "upload_media").map(parsedBody)
  assert.equal(uploadBodies.length, 1, "the file must be uploaded to WhatsApp before any send")
  const upload = uploadBodies[0]
  assert.ok(upload !== undefined)
  assert.equal(upload.channel, "whatsapp")
  assert.equal(upload.type, "document")
  assert.equal(upload.filename, "itinerary.pdf")
  assert.equal(upload.mimeType, "application/pdf")
  assert.equal(upload.data, Buffer.from([1, 2, 3, 4]).toString("base64"))

  const sendCalls = bodiesTo(calls, "send_message")
  assert.equal(sendCalls.length, 1, "one send_message, referencing the uploaded media")
  const content = parsedBody(sendCalls[0])?.content
  assert.ok(isRecord(content))
  const media = content.media
  assert.ok(Array.isArray(media) && isRecord(media[0]))
  assert.equal(media[0].providerMediaId, "wa-media-1", "WhatsApp media is sent by the uploaded providerMediaId")
  assert.equal(media[0].url, undefined, "WhatsApp is NEVER sent a url — that is the defect that ate the images")
})

test("BRIEF-44 does-not-regress: a Telegram attachment still sends by url, with no upload", async () => {
  const { member } = await roomWith("telegram")
  const { transport, calls } = agentpushWithMedia({ status: "sent", message_id: "msg_1" })
  await transport.sendAttachment(member, ATTACHMENT)

  assert.equal(bodiesTo(calls, "upload_media").length, 0, "Telegram has no buffer-upload path; none is attempted")
  const sendCalls = bodiesTo(calls, "send_message")
  assert.equal(sendCalls.length, 1)
  const content = parsedBody(sendCalls[0])?.content
  assert.ok(isRecord(content))
  const media = content.media
  assert.ok(Array.isArray(media) && isRecord(media[0]))
  assert.equal(media[0].url, ATTACHMENT.url, "the public url IS Telegram's only media path")
  assert.equal(media[0].providerMediaId, undefined)
  assert.equal(media[0].filename, "itinerary.pdf")
  assert.equal(media[0].mimeType, "application/pdf")
})

test("BRIEF-44 regression: an attachment the transport refuses is a failed record, and the member gets words", async () => {
  const { store, code, member } = await roomWith("whatsapp")
  const corrections: string[] = []
  const attachmentSends: OutboundAttachment[] = []
  const textSends: string[] = []
  const transport: Transport & { sendAttachment(member: Member, attachment: OutboundAttachment): Promise<void> } = {
    async send(_member, message) {
      textSends.push(message.text)
    },
    async sendAttachment(_member, attachment) {
      attachmentSends.push(attachment)
      throw new SendBlockedError("session_expired")
    },
  }
  const engine = new DeliveryEngine({
    store,
    transport,
    autoDrain: false,
    reportFailure: async (_code, correction) => {
      corrections.push(correction)
    },
  })
  const sender = new MemberSender({ store, transport, engine })

  await sender.sendAttachment(code, member, ATTACHMENT)
  // The member's own apology is minted as a system record during the failed
  // attachment's drain; one more drain settles it (the notice is a record too).
  await engine.drain(code)

  const record = (store.get(code)?.deliveries ?? []).find(
    (candidate): candidate is Delivery => candidate.memberId === member.id && candidate.kind === "attachment",
  )
  assert.ok(record, "a refused attachment must mint a delivery record — silence is the defect")
  assert.equal(record.status, "failed")
  assert.equal(record.lastError, "session_expired", "the provider's reason, verbatim")
  assert.equal("confirmedBy" in record ? record.confirmedBy : undefined, undefined, "nobody confirmed anything")
  assert.equal(record.failures, 5, "a blocked refusal is permanent — straight to the cap")
  assert.equal(attachmentSends.length, 1, "one attempt, not five")

  assert.equal(corrections.length, 1, "the agent is told, as BRIEF-42 does for text")
  assert.ok(corrections[0]?.includes("session_expired"), "the agent gets the provider's reason verbatim")
  assert.ok(corrections[0]?.includes(member.id))

  assert.ok(
    textSends.some((text) => text.includes("not actually sent") && text.includes("itinerary.pdf")),
    "the member receives words: the file did not arrive",
  )
})

test("BRIEF-44: a successful attachment is recorded delivered", async () => {
  const { store, code, member } = await roomWith("whatsapp")
  const attachmentSends: OutboundAttachment[] = []
  const textSends: string[] = []
  const transport: Transport & { sendAttachment(member: Member, attachment: OutboundAttachment): Promise<void> } = {
    async send(_member, message) {
      textSends.push(message.text)
    },
    async sendAttachment(_member, attachment) {
      attachmentSends.push(attachment)
    },
  }
  const engine = new DeliveryEngine({ store, transport, autoDrain: false })
  const sender = new MemberSender({ store, transport, engine })

  await sender.sendAttachment(code, member, ATTACHMENT)

  const record = (store.get(code)?.deliveries ?? []).find(
    (candidate) => candidate.memberId === member.id && candidate.kind === "attachment",
  )
  assert.ok(record, "the attachment mints a record")
  assert.equal(record?.status, "delivered")
  assert.equal(record?.confirmedBy, "transport")
  assert.equal(attachmentSends.length, 1)
  assert.equal(attachmentSends[0]?.filename, "itinerary.pdf")
  assert.equal(textSends.length, 0, "no fallback text when the real attachment send succeeded")
})

test("BRIEF-44: SMS still degrades to the fallback text — the URL spelled out, no media", async () => {
  const { member } = await roomWith("sms")
  const { transport, calls } = agentpushWithMedia({ status: "sent", message_id: "msg_1" })
  await transport.sendAttachment(member, ATTACHMENT)

  assert.equal(bodiesTo(calls, "upload_media").length, 0, "Twilio has no upload path at all")
  const sendCalls = bodiesTo(calls, "send_message")
  assert.equal(sendCalls.length, 1)
  const content = parsedBody(sendCalls[0])?.content
  assert.ok(isRecord(content))
  assert.equal(content.text, "the plan\nitinerary.pdf: https://rdv.example.com/r/RDV-7F3K/media/itinerary.pdf")
  assert.equal(content.media, undefined, "no media key for a channel with no media")
})