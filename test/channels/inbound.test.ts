import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { test } from "node:test"
import { MessageDedup, parseAgentpushWebhook } from "../../src/channels/agentpush/inbound.ts"

const SECRET = "test-webhook-secret"

// Fixture shape is the real MessagingInboundEnvelope v1 (ground-truthed at
// packages/core/src/domain/inbound-route/messaging.ts:40-50 in the
// read-only agentpush checkout — see docs/AGENTPUSH.md §3), not a guessed
// dialect.

function sign(rawBody: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`
}

function signedHeaders(rawBody: string, secret: string): Record<string, string> {
  return { "x-agentpush-signature": sign(rawBody, secret) }
}

test("valid signed whatsapp text becomes an envelope", () => {
  const body = JSON.stringify({
    version: 1,
    workspaceId: "acme",
    channel: "whatsapp",
    providerAccountId: "pa_7f3c",
    from: "+15551234567",
    conversationId: "+15551234567",
    messageId: "wamid.abc123",
    text: "hello from the field",
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
      displayName: "+15551234567",
      text: "hello from the field",
      messageId: "wamid.abc123",
      roomCodeHint: undefined,
    },
  })
})

test("valid signed telegram text becomes an envelope", () => {
  const body = JSON.stringify({
    version: 1,
    workspaceId: "acme",
    channel: "telegram",
    from: "123456789",
    conversationId: "123456789",
    messageId: "tg-42",
    text: "ping from telegram",
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
      roomCodeHint: undefined,
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

test("an unrecognized envelope version is rejected with 400", () => {
  const body = JSON.stringify({ version: 2, channel: "whatsapp", from: "+1", text: "hi", messageId: "m1" })
  const result = parseAgentpushWebhook({ rawBody: body, headers: {}, secret: undefined })
  assert.deepEqual(result, { ok: false, status: 400, reason: "unsupported_envelope_version" })
})

test("a media-only message (empty text) is ignored, not an error", () => {
  // Real envelope always carries a `text` key, defaulting to "" for a
  // media-only inbound (messaging.ts:79) — never an absent key.
  const body = JSON.stringify({
    channel: "whatsapp",
    from: "+15551234567",
    messageId: "m2",
    text: "",
    media: [{ type: "image", url: "https://example.com/photo.jpg" }],
  })
  const result = parseAgentpushWebhook({
    rawBody: body,
    headers: signedHeaders(body, SECRET),
    secret: SECRET,
  })
  assert.equal(result.ok, true)
  if (result.ok && "ignored" in result) assert.equal(result.ignored, "no_text")
})

test("a genuinely missing text key is a 400, not ignored", () => {
  const body = JSON.stringify({ channel: "whatsapp", from: "+1", messageId: "m2b" })
  const result = parseAgentpushWebhook({ rawBody: body, headers: {}, secret: undefined })
  assert.deepEqual(result, { ok: false, status: 400, reason: "missing_text" })
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

test("displayName always falls back to the contact ref — the real envelope has no name field", () => {
  const body = JSON.stringify({ channel: "whatsapp", from: "+15551234567", text: "hi", messageId: "m6" })
  const result = parseAgentpushWebhook({ rawBody: body, headers: {}, secret: undefined })
  assert.equal(result.ok, true)
  if (result.ok && "envelope" in result) assert.equal(result.envelope.displayName, "+15551234567")
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
