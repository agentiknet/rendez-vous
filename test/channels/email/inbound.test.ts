import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { test } from "node:test"
import { parseEmailInbound } from "../../../src/channels/email/inbound.ts"

// Fixture shape is the real agentpush Gmail-poll notify payload
// (apps/worker/src/poll-inbound.ts:124-144, `buildNotifyPayload`, in the
// read-only agentpush checkout — see docs/AGENTPUSH.md §8), NOT the
// messaging tier's MessagingInboundEnvelope.

const SECRET = "test-mail-webhook-secret"

function sign(rawBody: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`
}

function signedHeaders(rawBody: string, secret: string): Record<string, string> {
  return { "x-agentpush-signature": sign(rawBody, secret) }
}

function mailEnvelope(message: Record<string, unknown>): string {
  return JSON.stringify({
    event: "inbound_mail",
    route: { name: "rendez-vous", dispatch_tag: "rendez-vous" },
    message,
    workspace_id: "acme",
  })
}

test("a bare From address becomes contactRef and displayName", () => {
  const body = mailEnvelope({
    message_id: "18d2f",
    from: "alice@example.com",
    subject: "hello",
    text: "just checking in",
    timestamp: "2026-09-12T00:00:00.000Z",
  })
  const result = parseEmailInbound({ rawBody: body, headers: signedHeaders(body, SECRET), secret: SECRET })
  assert.deepEqual(result, {
    ok: true,
    envelope: {
      provider: "email",
      source: "email",
      contactRef: "alice@example.com",
      displayName: "alice@example.com",
      text: "just checking in",
      messageId: "18d2f",
      roomCodeHint: undefined,
      media: [],
    },
  })
})

test("a display-name From address is parsed and the contact ref is lowercased", () => {
  const body = mailEnvelope({
    message_id: "18d2g",
    from: "Alice Example <Alice@Example.com>",
    subject: "hello",
    text: "hi there",
  })
  const result = parseEmailInbound({ rawBody: body, headers: {}, secret: undefined })
  assert.equal(result.ok, true)
  if (result.ok && "envelope" in result) {
    assert.equal(result.envelope.contactRef, "alice@example.com")
    assert.equal(result.envelope.displayName, "Alice Example")
  }
})

test("a quoted From address without a display name falls back to the address", () => {
  const body = mailEnvelope({ message_id: "m1", from: "<bob@example.com>", subject: "", text: "hi" })
  const result = parseEmailInbound({ rawBody: body, headers: {}, secret: undefined })
  assert.equal(result.ok, true)
  if (result.ok && "envelope" in result) {
    assert.equal(result.envelope.contactRef, "bob@example.com")
    assert.equal(result.envelope.displayName, "bob@example.com")
  }
})

test("quoted reply lines starting with > are stripped", () => {
  const body = mailEnvelope({
    message_id: "m2",
    from: "alice@example.com",
    subject: "re: room",
    text: "sounds good\n> previous message\n> more quoted text",
  })
  const result = parseEmailInbound({ rawBody: body, headers: {}, secret: undefined })
  assert.equal(result.ok, true)
  if (result.ok && "envelope" in result) assert.equal(result.envelope.text, "sounds good")
})

test("everything after an 'On ... wrote:' reply header is stripped", () => {
  const body = mailEnvelope({
    message_id: "m3",
    from: "alice@example.com",
    subject: "re: room",
    text: "sounds good\nOn Fri, Sep 12, 2026 at 1:00 PM Bob wrote:\nold content\nmore old content",
  })
  const result = parseEmailInbound({ rawBody: body, headers: {}, secret: undefined })
  assert.equal(result.ok, true)
  if (result.ok && "envelope" in result) assert.equal(result.envelope.text, "sounds good")
})

test("everything after a '-- ' signature delimiter is stripped", () => {
  const body = mailEnvelope({
    message_id: "m4",
    from: "alice@example.com",
    subject: "re: room",
    text: "sounds good\n-- \nAlice\nSent from my phone",
  })
  const result = parseEmailInbound({ rawBody: body, headers: {}, secret: undefined })
  assert.equal(result.ok, true)
  if (result.ok && "envelope" in result) assert.equal(result.envelope.text, "sounds good")
})

test("a message that is entirely quoted/signature content is ignored, not an error", () => {
  const body = mailEnvelope({
    message_id: "m5",
    from: "alice@example.com",
    subject: "re: room",
    text: "> only quoted content\n> nothing new",
  })
  const result = parseEmailInbound({ rawBody: body, headers: {}, secret: undefined })
  assert.equal(result.ok, true)
  if (result.ok && "ignored" in result) assert.equal(result.ignored, "no_text")
})

test("subject with a room code sets roomCodeHint", () => {
  const body = mailEnvelope({
    message_id: "m6",
    from: "alice@example.com",
    subject: "Re: Room RDV-7F3K needs a hand",
    text: "can you help",
  })
  const result = parseEmailInbound({ rawBody: body, headers: {}, secret: undefined })
  assert.equal(result.ok, true)
  if (result.ok && "envelope" in result) assert.equal(result.envelope.roomCodeHint, "RDV-7F3K")
})

test("subject without a room code leaves roomCodeHint undefined", () => {
  const body = mailEnvelope({
    message_id: "m7",
    from: "alice@example.com",
    subject: "just saying hi",
    text: "hello",
  })
  const result = parseEmailInbound({ rawBody: body, headers: {}, secret: undefined })
  assert.equal(result.ok, true)
  if (result.ok && "envelope" in result) assert.equal(result.envelope.roomCodeHint, undefined)
})

test("bad signature is rejected with 401", () => {
  const body = mailEnvelope({ message_id: "m8", from: "alice@example.com", subject: "", text: "hi" })
  const result = parseEmailInbound({
    rawBody: body,
    headers: { "x-agentpush-signature": "sha256=deadbeef" },
    secret: SECRET,
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.status, 401)
})

test("no secret configured accepts the webhook without a signature", () => {
  const body = mailEnvelope({ message_id: "m9", from: "alice@example.com", subject: "", text: "hi" })
  const result = parseEmailInbound({ rawBody: body, headers: {}, secret: undefined })
  assert.equal(result.ok, true)
})

test("a non-mail event is rejected with 400", () => {
  const body = JSON.stringify({ event: "something_else" })
  const result = parseEmailInbound({ rawBody: body, headers: {}, secret: undefined })
  assert.deepEqual(result, { ok: false, status: 400, reason: "not_inbound_mail" })
})

test("malformed JSON is rejected with 400", () => {
  const result = parseEmailInbound({ rawBody: "{not json", headers: {}, secret: undefined })
  assert.deepEqual(result, { ok: false, status: 400, reason: "invalid_json" })
})

test("a missing message_id is rejected with 400 — the dedup id", () => {
  const body = mailEnvelope({ from: "alice@example.com", subject: "", text: "hi" })
  const result = parseEmailInbound({ rawBody: body, headers: {}, secret: undefined })
  assert.deepEqual(result, { ok: false, status: 400, reason: "missing_message_id" })
})

test("a present message_id is returned verbatim as the dedup id", () => {
  const body = mailEnvelope({ message_id: "dedup-id-123", from: "alice@example.com", subject: "", text: "hi" })
  const result = parseEmailInbound({ rawBody: body, headers: {}, secret: undefined })
  assert.equal(result.ok, true)
  if (result.ok && "envelope" in result) assert.equal(result.envelope.messageId, "dedup-id-123")
})
