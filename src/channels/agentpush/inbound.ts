/**
 * Parses agentpush's webhook wire format and verifies its signature,
 * mirroring the ground-truthed "agentpush" dialect in the read-only
 * agentproto checkout — but consumed directly by this service instead of
 * the daemon's `POST /inbound/:slug` route, because that route has no
 * `queue:true` fan-in story (R3, docs/ARCHITECTURE.md §4.2). We are not
 * calling the daemon's inbound router at all; this module reimplements only
 * the parsing/verification half of it, field-for-field.
 *
 * Field mapping mirrors `normalizeAgentpush`
 * (packages/runtime/src/inbound-adapters.ts:148-187 in the agentproto
 * checkout): `envelope.channel` -> source, `envelope.from` -> contactRef,
 * `envelope.text` -> text, `envelope.messageId` -> providerMessageId, and a
 * string `envelope.challenge` is a webhook handshake, not a message.
 * Presence is checked in the same order as the ground truth (source, then
 * contactRef, then text) so a status callback that carries channel+from but
 * no text is "ignored" exactly like the daemon would report it, not a 400.
 *
 * Two deliberate deviations from the ground truth, both because our
 * `InboundEnvelope` is stricter than the daemon's `InboundMessage`:
 *   - `provider` must be `"whatsapp" | "telegram"` (the daemon's `source`
 *     field is an arbitrary string with no enum check at this layer) — an
 *     unrecognized `channel` value is a 400, not silently accepted.
 *   - `messageId` is required, not optional, because our own `MessageDedup`
 *     is the only redelivery protection in this service (the daemon's
 *     per-slug FIFO in inbound-endpoints.ts does not apply — that endpoint
 *     store belongs to the daemon's own `/inbound/:slug` route, which we do
 *     not use). A message without one is a 400, not silently un-deduped.
 *
 * Signature verification mirrors `verifyHmacHexHeader(input,
 * "x-agentpush-signature")` (inbound-adapters.ts:67-68, 451-479): header
 * `x-agentpush-signature: sha256=<hex hmac-sha256 of the raw body>`,
 * constant-time hex compare. Agentpush's HMAC scheme carries no timestamp,
 * so there is no replay window to enforce (unlike Slack's, which does) —
 * `now` is accepted for interface symmetry but unused for this provider.
 *
 * When `secret` is undefined, signature verification is skipped entirely.
 * The daemon's own webhook route falls back to its sessions bearer gate in
 * that case (http-server.ts:6612-6618) — this service has no equivalent
 * bearer gate for an externally-facing agentpush webhook, so an unset
 * secret really does mean "accept unsigned", not "gate some other way".
 * Configure `RDV_AGENTPUSH_WEBHOOK_SECRET` in any environment reachable
 * from the internet.
 *
 * Neither `envelope.channel`/`from`/`text`/`messageId` nor a display name
 * are documented anywhere as agentpush's real, public REST/webhook contract
 * in this checkout — only the shape the daemon's own parser expects. There
 * is no ground-truthed field for the sender's display name at all (the
 * daemon's `InboundMessage` drops it entirely), so this module tries a
 * `displayName`/`name`/`profileName`/`senderName` field in that order and
 * falls back to the contact ref itself. Flagged here rather than presented
 * as verified.
 */

import { createHmac, timingSafeEqual } from "node:crypto"

export interface InboundEnvelope {
  provider: "whatsapp" | "telegram"
  source: string
  contactRef: string
  displayName: string
  text: string
  messageId: string
}

export type WebhookResult =
  | { ok: true; envelope: InboundEnvelope }
  | { ok: true; ignored: string }
  | { ok: false; status: 400 | 401; reason: string }

export interface ParseAgentpushWebhookInput {
  rawBody: string
  headers: Record<string, string | undefined>
  secret: string | undefined
  now?: number
}

const MESSENGER_CHANNELS: readonly string[] = ["whatsapp", "telegram"]

function isMessengerChannel(value: string): value is "whatsapp" | "telegram" {
  return MESSENGER_CHANNELS.includes(value)
}

function lookupHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value
  }
  return undefined
}

function constantTimeHexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const aBuf = Buffer.from(a, "hex")
  const bBuf = Buffer.from(b, "hex")
  if (aBuf.length !== bBuf.length || aBuf.length === 0) return false
  return timingSafeEqual(aBuf, bBuf)
}

function verifySignature(
  rawBody: string,
  headers: Record<string, string | undefined>,
  secret: string,
): { ok: true } | { ok: false; reason: string } {
  const header = lookupHeader(headers, "x-agentpush-signature")
  if (header === undefined) return { ok: false, reason: "missing x-agentpush-signature" }

  const prefix = "sha256="
  if (!header.startsWith(prefix)) return { ok: false, reason: "bad x-agentpush-signature format" }

  const hex = header.slice(prefix.length)
  if (!/^[0-9a-fA-F]+$/.test(hex)) return { ok: false, reason: "bad x-agentpush-signature hex" }

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")
  if (!constantTimeHexEquals(expected, hex)) return { ok: false, reason: "bad x-agentpush-signature" }

  return { ok: true }
}

function getStringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  return typeof value === "string" ? value : undefined
}

function extractDisplayName(envelope: Record<string, unknown>, contactRef: string): string {
  return (
    getStringField(envelope, "displayName") ??
    getStringField(envelope, "name") ??
    getStringField(envelope, "profileName") ??
    getStringField(envelope, "senderName") ??
    contactRef
  )
}

export function parseAgentpushWebhook(input: ParseAgentpushWebhookInput): WebhookResult {
  if (input.secret !== undefined) {
    const verified = verifySignature(input.rawBody, input.headers, input.secret)
    if (!verified.ok) {
      return { ok: false, status: 401, reason: verified.reason }
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(input.rawBody)
  } catch {
    return { ok: false, status: 400, reason: "invalid_json" }
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, status: 400, reason: "invalid_json" }
  }

  const envelope = parsed as Record<string, unknown>

  const challenge = getStringField(envelope, "challenge")
  if (challenge !== undefined) {
    return { ok: true, ignored: "challenge" }
  }

  const channel = getStringField(envelope, "channel")
  if (channel === undefined) {
    return { ok: false, status: 400, reason: "missing_source" }
  }
  if (!isMessengerChannel(channel)) {
    return { ok: false, status: 400, reason: "unsupported_channel" }
  }

  const contactRef = getStringField(envelope, "from")
  if (contactRef === undefined) {
    return { ok: false, status: 400, reason: "missing_contact_ref" }
  }

  const text = getStringField(envelope, "text")
  if (text === undefined) {
    return { ok: true, ignored: "no_text" }
  }

  const messageId = getStringField(envelope, "messageId")
  if (messageId === undefined) {
    return { ok: false, status: 400, reason: "missing_message_id" }
  }

  return {
    ok: true,
    envelope: {
      provider: channel,
      source: channel,
      contactRef,
      displayName: extractDisplayName(envelope, contactRef),
      text,
      messageId,
    },
  }
}

/** Bounded FIFO dedup, mirroring the per-slug seen-id cap in
 *  inbound-endpoints.ts:67-68 (there: 500 per slug). `seen` returns true on
 *  a repeat messageId — the caller should drop the message, not route it
 *  again — and false the first time, after which the id is remembered. */
export class MessageDedup {
  private readonly capacity: number
  private readonly order: string[] = []
  private readonly ids = new Set<string>()

  constructor(capacity = 500) {
    this.capacity = capacity
  }

  seen(messageId: string): boolean {
    if (this.ids.has(messageId)) return true

    this.ids.add(messageId)
    this.order.push(messageId)
    if (this.order.length > this.capacity) {
      const oldest = this.order.shift()
      if (oldest !== undefined) this.ids.delete(oldest)
    }
    return false
  }
}
