/**
 * BRIEF 49 — the `react` and `reply` room tools, on the exact shape of
 * `send_file` (docs/SEND-FILE.md), standing on the BRIEF-48 identity
 * plumbing (docs/REACT-REPLY.md).
 *
 * The four constraints under test here:
 *
 * 1. ONE PASSAGE — a reaction and a reply cross `DeliveryEngine.attempt`
 *    like everything else (minted as records, drained, marked, retried),
 *    never a direct transport call from the tool.
 * 2. ABSENCE NEVER READS AS DELIVERY — the result says `accepted`, never
 *    `sent`; a handle that does not resolve mints nothing and sends
 *    nothing.
 * 3. RESOLUTION ≠ CAPABILITY — a mail handle resolves fine, but a reaction
 *    on mail is refused with its OWN named reason (`channel-cannot-react`),
 *    distinct from `unknown-message-handle`.
 * 4. REFUS, PAS DÉGRADATION — a refused reaction emits no text fallback,
 *    ever.
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import type { OutboundMessage, Transport } from "../../src/fanout/types.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import type { Delivery, Member } from "../../src/rooms/types.ts"
import { DeliveryEngine } from "../../src/service/delivery.ts"
import { MemberSender } from "../../src/service/member-send.ts"
import { roomAudienceToken, createMcpRoomHandler } from "../../src/service/mcp-room.ts"
import type { McpResponse } from "../../src/service/mcp-canvakit.ts"
import { env } from "../../src/env.ts"

const dirs: string[] = []
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

interface Event {
  op: "send" | "reaction" | "reply"
  memberId?: string
  text?: string
  providerId?: string
  emoji?: string
}

/** A push transport that can react and reply, and records every hand. */
function reactiveTransport() {
  const events: Event[] = []
  const transport: Transport & {
    sendReaction(member: Member, providerMessageId: string, emoji: string): Promise<string | void>
    sendReply(member: Member, text: string, replyToProviderMessageId: string): Promise<string | void>
  } = {
    async send(member: Member, message: OutboundMessage) {
      events.push({ op: "send", memberId: member.id, text: message.text })
    },
    async sendReaction(member: Member, providerMessageId: string, emoji: string) {
      events.push({ op: "reaction", memberId: member.id, providerId: providerMessageId, emoji })
    },
    async sendReply(member: Member, text: string, replyToProviderMessageId: string) {
      events.push({ op: "reply", memberId: member.id, text, providerId: replyToProviderMessageId })
      return "out-id-1"
    },
  }
  return { transport, events }
}

async function roomWithMembers(): Promise<{
  store: RoomStore
  code: string
  whatsapp: Member
  email: Member
}> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-react-reply-"))
  dirs.push(dir)
  const store = await RoomStore.open(dir)
  const created = await store.create()
  const whatsapp = await store.addMember(created.code, {
    displayName: "Bob",
    tier: "messenger",
    address: { provider: "whatsapp", source: created.code, contactRef: "ref-bob" },
  })
  const email = await store.addMember(created.code, {
    displayName: "Mail",
    tier: "email",
    address: { provider: "email", source: created.code, contactRef: "ref-mail" },
  })
  return { store, code: created.code, whatsapp, email }
}

function harnessFor(store: RoomStore, _code: string, transport: Transport) {
  const engine = new DeliveryEngine({ store, transport, autoDrain: true })
  const sender = new MemberSender({ store, transport, engine })
  return { engine, sender }
}

function mcpHarness(store: RoomStore, code: string, sender: MemberSender, engine: DeliveryEngine) {
  return createMcpRoomHandler({
    rooms: () => [store.get(code) ?? (() => { throw new Error("no room") })()],
    deliveries: engine,
    reactMessage: (c, handle, emoji) => sender.react(c, handle, emoji),
    replyToMessage: (c, handle, text) => sender.reply(c, handle, text),
  })
}

function deliveriesOf(store: RoomStore, code: string): readonly Delivery[] {
  return store.get(code)?.deliveries ?? []
}

function asResult(res: McpResponse): Record<string, unknown> {
  assert.equal(res.status, 200)
  assert.ok(res.body !== undefined)
  assert.ok("result" in res.body)
  const result = res.body.result as { content?: { text: string }[]; isError?: boolean }
  assert.equal(result.isError, false)
  assert.ok(Array.isArray(result.content) && result.content.length === 1)
  const first = result.content[0]
  assert.ok(first !== undefined)
  return JSON.parse(first.text) as Record<string, unknown>
}

function asErrorBody(res: McpResponse): { code: number; message: string } {
  assert.ok(res.body !== undefined)
  assert.ok("error" in res.body)
  return res.body.error
}

// --- the sender-level unit: resolution, capability, the one passage ---

test("a reaction goes to a member on a capable channel, with the provider id resolved from the handle", async () => {
  const { store, code, whatsapp } = await roomWithMembers()
  const { transport, events } = reactiveTransport()
  const { sender } = harnessFor(store, code, transport)
  const ref = await store.recordMessageRef(code, {
    memberId: whatsapp.id,
    direction: "inbound",
    channel: "whatsapp",
    providerId: "wamid.ABC123",
  })

  const outcome = await sender.react(code, ref.handle, "👍")

  assert.equal(outcome.kind, "accepted")
  // The provider id carried to the transport is the one the handle
  // resolved to — never a guess from (member, recency).
  assert.deepEqual(events, [{ op: "reaction", memberId: whatsapp.id, providerId: "wamid.ABC123", emoji: "👍" }])
  // The reaction crossed `attempt`: one minted record, drained to
  // `delivered` with a transport confirmation — never a direct call.
  const records = deliveriesOf(store, code)
  assert.equal(records.length, 1)
  const record = records[0]
  assert.ok(record !== undefined)
  assert.equal(record.kind, "reaction")
  assert.equal(record.memberId, whatsapp.id)
  assert.equal(record.reactsTo, "wamid.ABC123")
  assert.equal(record.status, "delivered")
  assert.equal(record.confirmedBy, "transport")
})

test("a reply arrives threaded on a channel that knows how, and the member receives it", async () => {
  const { store, code, whatsapp } = await roomWithMembers()
  const { transport, events } = reactiveTransport()
  const { sender } = harnessFor(store, code, transport)
  const ref = await store.recordMessageRef(code, {
    memberId: whatsapp.id,
    direction: "inbound",
    channel: "whatsapp",
    providerId: "wamid.IN-9",
  })

  const outcome = await sender.reply(code, ref.handle, "Here is the answer")

  assert.equal(outcome.kind, "accepted")
  assert.deepEqual(events, [{ op: "reply", memberId: whatsapp.id, text: "Here is the answer", providerId: "wamid.IN-9" }])
  const record = deliveriesOf(store, code)[0]
  assert.ok(record !== undefined)
  assert.equal(record.kind, "reply")
  assert.equal(record.text, "Here is the answer")
  assert.equal(record.reactsTo, "wamid.IN-9")
  assert.equal(record.status, "delivered")
  assert.equal(record.confirmedBy, "transport")
  // The provider confirmed the reply with a message id of its own: it is
  // captured as a citable outbound ref, not dropped.
  const tail = store.messageRefsOf(code)
  assert.ok(tail.some((candidate) => candidate.direction === "outbound" && candidate.providerId === "out-id-1"))
})

test("an unknown handle is a named failure: no send, no minted record", async () => {
  const { store, code } = await roomWithMembers()
  const { transport, events } = reactiveTransport()
  const { sender } = harnessFor(store, code, transport)

  const outcome = await sender.react(code, "m999", "👍")

  assert.equal(outcome.kind, "unknown-handle")
  assert.deepEqual(events, [])
  assert.equal(deliveriesOf(store, code).length, 0)
})

test("an expired handle (>24h) is the same named failure: no send, no minted record", async () => {
  const { store, code, whatsapp } = await roomWithMembers()
  const { transport, events } = reactiveTransport()
  const { sender } = harnessFor(store, code, transport)
  const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
  const ref = await store.recordMessageRef(
    code,
    { memberId: whatsapp.id, direction: "inbound", channel: "whatsapp", providerId: "wamid.OLD" },
    stale,
  )

  const outcome = await sender.react(code, ref.handle, "👍")

  assert.equal(outcome.kind, "unknown-handle")
  assert.deepEqual(events, [])
  assert.equal(deliveriesOf(store, code).length, 0)
})

test("a handle of ANOTHER room is the same named failure: no send, no minted record", async () => {
  const { store, code, whatsapp } = await roomWithMembers()
  const other = await store.create()
  const foreign = await store.recordMessageRef(other.code, {
    memberId: whatsapp.id,
    direction: "inbound",
    channel: "whatsapp",
    providerId: "wamid.OTHER-ROOM",
  })
  const { transport, events } = reactiveTransport()
  const { sender } = harnessFor(store, code, transport)

  const outcome = await sender.react(code, foreign.handle, "👍")

  assert.equal(outcome.kind, "unknown-handle")
  assert.deepEqual(events, [])
  assert.equal(deliveriesOf(store, code).length, 0)
})

test("a member whose channel cannot react is refused DISTINCTLY — no record, no text fallback", async () => {
  const { store, code, email } = await roomWithMembers()
  // The mail handle RESOLVES fine — resolution ≠ capability.
  const ref = await store.recordMessageRef(code, {
    memberId: email.id,
    direction: "inbound",
    channel: "email",
    providerId: "msg-mail-1",
  })
  const { transport, events } = reactiveTransport()
  const { sender } = harnessFor(store, code, transport)

  const outcome = await sender.react(code, ref.handle, "👍")

  assert.equal(outcome.kind, "channel-cannot-react")
  assert.ok(outcome.kind === "channel-cannot-react")
  assert.equal(outcome.channel, "email")
  // Distinct from the unknown-handle case, and nothing was emitted: no
  // reaction, no text degradation, no record.
  assert.deepEqual(events, [])
  assert.equal(deliveriesOf(store, code).length, 0)
})

test("a member whose channel cannot reply is refused the same distinct way", async () => {
  const { store, code } = await roomWithMembers()
  // sms CANNOT reply (Twilio capabilities.replies: false) — the refusal
  // check needs a channel that fails BOTH capabilities, unlike email which
  // can reply but cannot react.
  const sms = await store.addMember(code, {
    displayName: "Sms",
    tier: "messenger",
    address: { provider: "sms", source: code, contactRef: "ref-sms" },
  })
  const smsRef = await store.recordMessageRef(code, {
    memberId: sms.id,
    direction: "inbound",
    channel: "sms",
    providerId: "SM0001",
  })
  const { transport, events } = reactiveTransport()
  const { sender } = harnessFor(store, code, transport)

  const replyOutcome = await sender.reply(code, smsRef.handle, "hi")
  assert.equal(replyOutcome.kind, "channel-cannot-react")
  assert.ok(replyOutcome.kind === "channel-cannot-react")
  assert.equal(replyOutcome.channel, "sms")
  assert.deepEqual(events, [])
  assert.equal(deliveriesOf(store, code).length, 0)
})

test("emoji \"\" removes a reaction: still a reaction hand, still the resolved provider id", async () => {
  const { store, code, whatsapp } = await roomWithMembers()
  const { transport, events } = reactiveTransport()
  const { sender } = harnessFor(store, code, transport)
  const ref = await store.recordMessageRef(code, {
    memberId: whatsapp.id,
    direction: "inbound",
    channel: "whatsapp",
    providerId: "wamid.REMOVE-1",
  })

  const outcome = await sender.react(code, ref.handle, "")

  assert.equal(outcome.kind, "accepted")
  assert.deepEqual(events, [{ op: "reaction", memberId: whatsapp.id, providerId: "wamid.REMOVE-1", emoji: "" }])
})

test("a member whose message resolved but who has left the room is refused namedly, no mint", async () => {
  const { store, code, whatsapp } = await roomWithMembers()
  const ref = await store.recordMessageRef(code, {
    memberId: whatsapp.id,
    direction: "inbound",
    channel: "whatsapp",
    providerId: "wamid.LEFT",
  })
  await store.removeMember(code, whatsapp.id)
  const { transport, events } = reactiveTransport()
  const { sender } = harnessFor(store, code, transport)

  const outcome = await sender.react(code, ref.handle, "👍")

  assert.equal(outcome.kind, "member-not-in-room")
  assert.deepEqual(events, [])
  assert.equal(deliveriesOf(store, code).length, 0)
})

// --- the tool surface: MCP envelope over the same sender ---

function authFor(code: string): string {
  return `Bearer ${roomAudienceToken(code, env.roomTokenSecret)}`
}

test("the react tool result: accepted, recipients, and the pre-agreed vocabulary — never `sent`", async () => {
  const { store, code, whatsapp } = await roomWithMembers()
  const { transport } = reactiveTransport()
  const { sender, engine } = harnessFor(store, code, transport)
  const ref = await store.recordMessageRef(code, {
    memberId: whatsapp.id,
    direction: "inbound",
    channel: "whatsapp",
    providerId: "wamid.TOOL-1",
  })
  const handler = mcpHarness(store, code, sender, engine)

  const res = await handler(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "react", arguments: { handle: ref.handle, emoji: "🔥" } } },
    authFor(code),
  )
  const payload = asResult(res)

  assert.equal(payload.accepted, true)
  assert.ok("sent" in payload === false)
  assert.deepEqual(payload.recipients, [{ member_id: whatsapp.id, ok: true }])
  assert.equal(payload.handle, ref.handle)
})

test("the react tool reports an unknown handle namedly (HTTP 200, isError false), mints nothing", async () => {
  const { store, code } = await roomWithMembers()
  const { transport, events } = reactiveTransport()
  const { sender, engine } = harnessFor(store, code, transport)
  const handler = mcpHarness(store, code, sender, engine)

  const res = await handler(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "react", arguments: { handle: "m42", emoji: "👍" } } },
    authFor(code),
  )
  const payload = asResult(res)

  assert.equal(payload.accepted, false)
  assert.equal(payload.reason, "unknown-message-handle")
  assert.deepEqual(events, [])
  assert.equal(deliveriesOf(store, code).length, 0)
})

test("the react tool reports an incapable channel DISTINCTLY from an unknown handle", async () => {
  const { store, code, email } = await roomWithMembers()
  const ref = await store.recordMessageRef(code, {
    memberId: email.id,
    direction: "inbound",
    channel: "email",
    providerId: "msg-mail-3",
  })
  const { transport, events } = reactiveTransport()
  const { sender, engine } = harnessFor(store, code, transport)
  const handler = mcpHarness(store, code, sender, engine)

  const res = await handler(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "react", arguments: { handle: ref.handle, emoji: "👍" } } },
    authFor(code),
  )
  const payload = asResult(res)

  assert.equal(payload.accepted, false)
  assert.equal(payload.reason, "channel-cannot-react")
  assert.notEqual(payload.reason, "unknown-message-handle")
  assert.deepEqual(events, [])
  assert.equal(deliveriesOf(store, code).length, 0)
})

test("the reply tool threads through the same path and reports accepted", async () => {
  const { store, code, whatsapp } = await roomWithMembers()
  const { transport, events } = reactiveTransport()
  const { sender, engine } = harnessFor(store, code, transport)
  const ref = await store.recordMessageRef(code, {
    memberId: whatsapp.id,
    direction: "inbound",
    channel: "whatsapp",
    providerId: "wamid.TOOL-R",
  })
  const handler = mcpHarness(store, code, sender, engine)

  const res = await handler(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "reply", arguments: { handle: ref.handle, text: "voilà" } } },
    authFor(code),
  )
  const payload = asResult(res)

  assert.equal(payload.accepted, true)
  assert.deepEqual(payload.recipients, [{ member_id: whatsapp.id, ok: true }])
  assert.deepEqual(events, [{ op: "reply", memberId: whatsapp.id, text: "voilà", providerId: "wamid.TOOL-R" }])
})

test("react/reply without their required arguments are invalid requests, before anything resolves", async () => {
  const { store, code } = await roomWithMembers()
  const { transport } = reactiveTransport()
  const { sender, engine } = harnessFor(store, code, transport)
  const handler = mcpHarness(store, code, sender, engine)
  const auth = authFor(code)

  const noHandle = await handler(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "react", arguments: { emoji: "👍" } } },
    auth,
  )
  assert.ok(asErrorBody(noHandle).message.length > 0)
  const noEmoji = await handler(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "react", arguments: { handle: "m1" } } },
    auth,
  )
  assert.ok(asErrorBody(noEmoji).message.length > 0)
  const emptyReply = await handler(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "reply", arguments: { handle: "m1", text: "  " } } },
    auth,
  )
  assert.ok(asErrorBody(emptyReply).message.length > 0)
})

test("react/reply are advertised only when wired, and stay unknown otherwise", async () => {
  const { store, code } = await roomWithMembers()
  const unwired = createMcpRoomHandler({ rooms: () => [store.get(code) ?? (() => { throw new Error("no room") })()] })
  const listed = await unwired({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, authFor(code))
  assert.ok(listed.body !== undefined && "result" in listed.body)
  const names = (listed.body.result as { tools: { name: string }[] }).tools.map((tool) => tool.name)
  assert.ok(!names.includes("react"))
  assert.ok(!names.includes("reply"))

  const called = await unwired(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "react", arguments: { handle: "m1", emoji: "👍" } } },
    authFor(code),
  )
  assert.ok(asErrorBody(called).message.length > 0)
})

test("the wired tools/list advertises react and reply", async () => {
  const { store, code } = await roomWithMembers()
  const { transport } = reactiveTransport()
  const { sender, engine } = harnessFor(store, code, transport)
  const handler = mcpHarness(store, code, sender, engine)
  const listed = await handler({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, authFor(code))
  assert.ok(listed.body !== undefined && "result" in listed.body)
  const names = (listed.body.result as { tools: { name: string }[] }).tools.map((tool) => tool.name)
  assert.ok(names.includes("react"))
  assert.ok(names.includes("reply"))
})
