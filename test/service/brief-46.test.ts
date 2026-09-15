/**
 * BRIEF 46 — the tool path never probes, and a file-only reply reads as
 * silence. Four defects from REVIEW-45, falsified first, fixed here:
 *
 * - B46-D: an MCP `say` whose `[[attach …]]` names a file nothing serves
 *   must NOT go out confirmed. The engine probes the URL before the
 *   transport hand (the same rule the fanout path has always applied),
 *   the record goes to `failed`, the member gets the honest notice and
 *   the agent is corrected.
 * - B46-A: a tool `say` reduced to a single `[[attach …]]` marker must
 *   mint no empty-text `say` record and push no empty message.
 * - B46-B: an `attachment` record addressed to the member who started the
 *   turn IS a reply — a delivered file answers.
 * - B46-E: the boot replay of a `pending` attachment whose URL is dead
 *   must not read as `delivered/transport`.
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import type { OutboundMessage, Transport } from "../../src/fanout/types.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Member } from "../../src/rooms/types.ts"
import { DeliveryEngine } from "../../src/service/delivery.ts"
import { MemberSender } from "../../src/service/member-send.ts"
import { turnAnsweredNobody } from "../../src/service/post-turn-assertions.ts"
import type { OutboundAttachment } from "../../src/service/transports.ts"

const dirs: string[] = []
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

interface Event {
  op: "send" | "attachment"
  text?: string
  filename?: string
}

function recordingTransport() {
  const events: Event[] = []
  const transport: Transport & { sendAttachment(m: Member, a: OutboundAttachment): Promise<void> } = {
    async send(_member: Member, message: OutboundMessage) {
      events.push({ op: "send", text: message.text })
    },
    async sendAttachment(_member: Member, attachment: OutboundAttachment) {
      events.push({ op: "attachment", filename: attachment.filename })
    },
  }
  return { transport, events }
}

async function roomWith(): Promise<{ store: RoomStore; code: string; member: Member }> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-brief46-"))
  dirs.push(dir)
  const store = await RoomStore.open(dir)
  const created = await store.create()
  const member = await store.addMember(created.code, {
    displayName: "Bob",
    tier: "messenger",
    address: { provider: "whatsapp", source: "test", contactRef: "ref-bob" },
  })
  return { store, code: created.code, member }
}

const GONE_URL = "https://rdv.example.com/r/RDV-XXXX/artifact/gone.pdf"
const GONE: OutboundAttachment = {
  url: GONE_URL,
  filename: "gone.pdf",
  mimeType: "application/pdf",
  kind: "document",
  caption: undefined,
}

test("B46-A: a tool say reduced to [[attach …]] mints no empty-text say record and pushes no empty message", async () => {
  const { store, code, member } = await roomWith()
  const { transport, events } = recordingTransport()
  const engine = new DeliveryEngine({ store, transport, autoDrain: true })
  const sender = new MemberSender({ store, transport, engine })
  const { createMcpRoomHandler, roomAudienceToken } = await import("../../src/service/mcp-room.ts")
  const { env } = await import("../../src/env.ts")
  const handler = createMcpRoomHandler({
    rooms: () => [store.get(code)!],
    deliveries: engine,
    deliverAttachment: (c, memberId, attachment) => {
      assert.equal(memberId, member.id)
      return sender.sendAttachment(c, member, attachment)
    },
  })
  const auth = `Bearer ${roomAudienceToken(code, env.roomTokenSecret)}`
  const response = (await handler(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "say", arguments: { text: "[[attach plan.pdf]]" } },
    },
    auth,
  )) as { status: number; body: unknown }
  assert.equal(response.status, 200)
  const body = response.body as { result: { content: { text: string }[] } }
  const parsed = JSON.parse(body.result.content[0]!.text) as { accepted: { member_id: string; ok: boolean }[] }
  assert.deepEqual(parsed.accepted, [{ member_id: member.id, ok: true }])
  await engine.whenIdle()
  // The file exists (probe: true) — the attachment goes out, but NO text
  // record and NO empty provider message ride with it.
  assert.deepEqual(events, [{ op: "attachment", filename: "plan.pdf" }])
  const room = store.get(code)
  const sayRecords = (room?.deliveries ?? []).filter((d) => d.kind === "say")
  assert.equal(sayRecords.length, 0, "an attach-only tool say must mint no say record")
})

test("B46-D: the MCP say path probes the attachment URL — a dead file is never delivered and the agent is corrected", async () => {
  const { store, code, member } = await roomWith()
  const { transport, events } = recordingTransport()
  const corrections: string[] = []
  const engine = new DeliveryEngine({
    store,
    transport,
    autoDrain: true,
    probeUrl: () => Promise.resolve(false),
    reportFailure: async (c, correction) => {
      assert.equal(c, code)
      corrections.push(correction)
    },
  })
  const sender = new MemberSender({ store, transport, engine })
  const { createMcpRoomHandler, roomAudienceToken } = await import("../../src/service/mcp-room.ts")
  const { env } = await import("../../src/env.ts")
  const handler = createMcpRoomHandler({
    rooms: () => [store.get(code)!],
    deliveries: engine,
    deliverAttachment: (c, _memberId, attachment) => sender.sendAttachment(c, member, attachment),
  })
  const auth = `Bearer ${roomAudienceToken(code, env.roomTokenSecret)}`
  const response = (await handler(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "say", arguments: { text: "[[attach gone.pdf]]" } },
    },
    auth,
  )) as { status: number; body: unknown }
  assert.equal(response.status, 200)
  await engine.whenIdle()
  // No provider call carrying the dead file — only the honest notice to the
  // member (the same one-liner the fanout unservable path uses).
  assert.deepEqual(events.map((e) => e.op), ["send"])
  assert.ok(events[0]?.text?.includes("gone.pdf"))
  const room = store.get(code)
  const att = (room?.deliveries ?? []).find((d) => d.kind === "attachment")
  assert.equal(att?.status, "failed", "a file nothing serves must not read as delivered")
  // The member is told the file never went (the same one-liner the fanout
  // unservable path uses), minted as a system record and delivered.
  const notices = (room?.deliveries ?? []).filter(
    (d) => d.kind === "system" && d.memberId === member.id && d.text.includes("gone.pdf"),
  )
  assert.equal(notices.length, 1, "the member must get the honest one-liner")
  assert.ok(notices[0]?.status === "delivered")
  assert.equal(corrections.length, 1, "the agent must be corrected")
})

test("B46-B: an attachment record addressed to the trigger member counts as a reply", () => {
  const violated = turnAnsweredNobody("m1", [{ kind: "attachment", memberId: "m1" }])
  assert.equal(violated, false, "a delivered file is a reply")
})

test("B46-E: the boot replay of a pending attachment probes the URL — a dead file is failed, never delivered", async () => {
  const { store, code, member } = await roomWith()
  const { transport, events } = recordingTransport()
  let probes = 0
  const engine = new DeliveryEngine({
    store,
    transport,
    autoDrain: false,
    probeUrl: () => {
      probes += 1
      return Promise.resolve(false)
    },
  })
  await engine.accept(code, "attachment", "gone.pdf: " + GONE_URL, [member.id], undefined, GONE)
  await engine.drain(code)
  assert.ok(probes >= 1, "the replay must probe before the hand-off")
  // No attachment hand-off — but the member IS told the file never went.
  assert.deepEqual(events.map((e) => e.op), ["send"])
  assert.ok(events[0]?.text?.includes("gone.pdf"))
  const room = store.get(code)
  const record = (room?.deliveries ?? []).find((d) => d.kind === "attachment")
  assert.equal(record?.status, "failed")
  assert.equal(record?.confirmedBy, undefined, "nobody confirmed a dead file")
})
