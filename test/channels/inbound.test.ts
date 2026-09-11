import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { test } from "node:test"
import { MessageDedup, parseAgentpushWebhook } from "../../src/channels/agentpush/inbound.ts"

const SECRET = "test-webhook-secret"

function sign(rawBody: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`
}

function signedHeaders(rawBody: string, secret: string): Record<string, string> {
  return { "x-agentpush-signature": sign(rawBody, secret) }
}

test("valid signed whatsapp text becomes an envelope", () => {
  const body = JSON.stringify({
    channel: "whatsapp",
    from: "+15551234567",
    text: "hello from the field",
    messageId: "wamid.abc123",
    name: "Alice",
  })
  const result = parseAgentpushWebhook({
    rawBody: body,
    headers: signedHeaders(body, SECRET),
    secret: SECRET,
  })
  assert.deepEqual(result, {
    ok: true,
    envelope: {
      provider: "whatsapp",
      source: "whatsapp",
      contactRef: "+15551234567",
      displayName: "Alice",
      text: "hello from the field",
      messageId: "wamid.abc123",
    },
  })
})

test("valid signed telegram text becomes an envelope", () => {
  const body = JSON.stringify({
    channel: "telegram",
    from: "123456789",
    text: "ping from telegram",
    messageId: "tg-42",
  })
  const result = parseAgentpushWebhook({
    rawBody: body,
    headers: signedHeaders(body, SECRET),
    secret: SECRET,
  })
  assert.deepEqual(result, {
    ok: true,
    envelope: {
      provider: "telegram",
      source: "telegram",
      contactRef: "123456789",
      displayName: "123456789",
      text: "ping from telegram",
      messageId: "tg-42",
    },
  })
})

test("bad signature is rejected with 401", () => {
  const body = JSON.stringify({ channel: "whatsapp", from: "+1", text: "hi", messageId: "m1" })
  const result = parseAgentpushWebhook({
    rawBody: body,
    headers: { "x-agentpush-signature": "sha256=deadbeef" },
    secret: SECRET,
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.status, 401)
})

test("missing signature header is rejected with 401", () => {
  const body = JSON.stringify({ channel: "whatsapp", from: "+1", text: "hi", messageId: "m1" })
  const result = parseAgentpushWebhook({ rawBody: body, headers: {}, secret: SECRET })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.status, 401)
})

test("malformed JSON is rejected with 400", () => {
  const body = "{not json"
  const result = parseAgentpushWebhook({
    rawBody: body,
    headers: signedHeaders(body, SECRET),
    secret: SECRET,
  })
  assert.deepEqual(result, { ok: false, status: 400, reason: "invalid_json" })
})

test("a status callback with no text is ignored, not an error", () => {
  const body = JSON.stringify({ channel: "whatsapp", from: "+15551234567", status: "delivered", messageId: "m2" })
  const result = parseAgentpushWebhook({
    rawBody: body,
    headers: signedHeaders(body, SECRET),
    secret: SECRET,
  })
  assert.equal(result.ok, true)
  if (result.ok && "ignored" in result) assert.equal(result.ignored, "no_text")
})

test("a challenge handshake is ignored, not routed", () => {
  const body = JSON.stringify({ challenge: "abc123" })
  const result = parseAgentpushWebhook({
    rawBody: body,
    headers: signedHeaders(body, SECRET),
    secret: SECRET,
  })
  assert.equal(result.ok, true)
  if (result.ok && "ignored" in result) assert.equal(result.ignored, "challenge")
})

test("no secret configured accepts the webhook without a signature", () => {
  const body = JSON.stringify({ channel: "telegram", from: "5", text: "hi", messageId: "m3" })
  const result = parseAgentpushWebhook({ rawBody: body, headers: {}, secret: undefined })
  assert.equal(result.ok, true)
  if (result.ok && "envelope" in result) assert.equal(result.envelope.text, "hi")
})

test("an unsupported channel is rejected with 400", () => {
  const body = JSON.stringify({ channel: "slack", from: "u1", text: "hi", messageId: "m4" })
  const result = parseAgentpushWebhook({ rawBody: body, headers: {}, secret: undefined })
  assert.deepEqual(result, { ok: false, status: 400, reason: "unsupported_channel" })
})

test("a missing contact ref is rejected with 400", () => {
  const body = JSON.stringify({ channel: "whatsapp", text: "hi", messageId: "m5" })
  const result = parseAgentpushWebhook({ rawBody: body, headers: {}, secret: undefined })
  assert.deepEqual(result, { ok: false, status: 400, reason: "missing_contact_ref" })
})

test("a missing message id is rejected with 400", () => {
  const body = JSON.stringify({ channel: "whatsapp", from: "+1", text: "hi" })
  const result = parseAgentpushWebhook({ rawBody: body, headers: {}, secret: undefined })
  assert.deepEqual(result, { ok: false, status: 400, reason: "missing_message_id" })
})

test("MessageDedup returns false the first time and true on a repeat", () => {
  const dedup = new MessageDedup()
  assert.equal(dedup.seen("m1"), false)
  assert.equal(dedup.seen("m1"), true)
  assert.equal(dedup.seen("m2"), false)
})

test("MessageDedup evicts the oldest id once past capacity", () => {
  const dedup = new MessageDedup(2)
  assert.equal(dedup.seen("a"), false)
  assert.equal(dedup.seen("b"), false)
  assert.equal(dedup.seen("c"), false) // evicts "a"
  assert.equal(dedup.seen("a"), false) // re-accepted, no longer remembered
  assert.equal(dedup.seen("c"), true) // still remembered
})
