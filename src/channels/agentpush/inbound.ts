/**
 * Parses agentpush's real inbound notify webhook and verifies its
 * signature. Ground-truthed against the read-only checkout at
 * /Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/projects/agentpush
 * (never edited) — see docs/AGENTPUSH.md §3 for the full contract with
 * file:line citations. Replaces the M5 version, which invented a
 * `{channel, from, text, messageId, challenge}` dialect modeled on
 * agentproto's own (unrelated) "agentpush" inbound adapter. The real wire
 * contract is different in several load-bearing ways, corrected here:
 *
 *   - The envelope is `MessagingInboundEnvelope` v1 — `{version, workspaceId,
 *     channel, providerAccountId?, from, conversationId, messageId, text,
 *     media?}` (packages/core/src/domain/inbound-route/messaging.ts:40-50).
 *     `channel`/`from`/`messageId` map the same way M5 guessed
 *     (channel -> provider/source, from -> contactRef, messageId ->
 *     dedup id), but `text` is ALWAYS a present key, defaulting to `""` for
 *     a media-only message (messaging.ts:79) — never an absent key. An
 *     empty string is the "ignored, no text" case; a genuinely missing
 *     `text` key is a malformed payload we don't recognize, not a status
 *     callback.
 *   - There is no `challenge`/handshake concept on this webhook at all —
 *     route creation is one authenticated API call the operator makes
 *     directly against agentpush, not a receiver-side verification ping.
 *     M5's `challenge` branch modeled a Meta/Slack-style flow this product
 *     doesn't have here; removed.
 *   - There is no display-name field anywhere in the real envelope —
 *     `ReceivedMessage` has no name-shaped field and the envelope builder
 *     never reads one (packages/core/src/ports/messaging.ts:167-178,
 *     inbound-route/messaging.ts:65-82). M5 guessed at
 *     `name`/`profileName`/`senderName` fallbacks that do not exist;
 *     `displayName` is always the contact ref (`from`) itself now.
 *   - `version` is validated: it is always `1` today, and the docs
 *     explicitly distinguish additive fields within v1 (tolerate) from a
 *     version bump (a contract change we haven't ground-truthed) — a
 *     present-but-unrecognized `version` is a 400, not a silent parse.
 *
 * Signature verification is UNCHANGED from M5, now with real citations
 * instead of an inferred one that happened to match: `X-Agentpush-Signature:
 * sha256=<hex HMAC-SHA256(notify_secret, rawBody)>`, computed over the exact
 * raw JSON bytes on the wire (packages/sdk/src/push.ts:504-531, the actual
 * dispatcher). No timestamp/nonce rides in the scheme, confirmed by reading
 * the signer itself — there is no replay window to enforce for this
 * provider. `now` is accepted for interface symmetry but unused.
 *
 * When `secret` is undefined, verification is skipped — matches an
 * `inbound_route` created with no `notify_secret` (docs/AGENTPUSH.md §3),
 * which agentpush itself sends unsigned.
 *
 * Deviation kept from M5, still deliberate: `provider` is narrowed to
 * `"whatsapp" | "telegram" | "sms"` even though the real envelope's
 * `channel` is an unrestricted string across agentpush's whole provider set
 * (`discord`, `slack`, `mail`, …) — Rendez-vous only supports these three
 * messenger-tier channels today, so any other channel is a 400
 * (`unsupported_channel`), not a silently-accepted arbitrary source. `"sms"`
 * (M11, Twilio, docs/AGENTPUSH.md §9) flows through the identical
 * `MessagingInboundEnvelope`/notify path as WhatsApp/Telegram — no separate
 * parsing needed, just accepting the channel value.
 * `messageId` is still required (400 `missing_message_id` if absent),
 * matching the real type's guarantee (`ReceivedMessage.id` is always a
 * non-empty string) but re-checked defensively since an external payload is
 * not a compile-time guarantee — our `MessageDedup` is the only redelivery
 * guard on our side of an at-least-once webhook (docs/AGENTPUSH.md §3,
 * "Delivery semantics").
 *
 * `provider` is widened to include `"email"` and `InboundEnvelope` carries a
 * `roomCodeHint` field so `src/channels/email/inbound.ts` (M10) can reuse
 * this same envelope/result shape for the mail tier's entirely different
 * wire contract (docs/AGENTPUSH.md §8) — messenger envelopes always set
 * `roomCodeHint: undefined` since a WhatsApp/Telegram message has no subject
 * line to parse one from.
 */

import { isRecord, getStringField } from "../json.ts"
import { verifyAgentpushSignature } from "./signature.ts"

export interface InboundMediaItem {
  /** Free-string media type off the real envelope — `"image"`, `"audio"`,
   *  `"voice"`, … (docs/AGENTPUSH.md §3). Kinded later by
   *  `kindForMediaType` (src/channels/media-ingress.ts), not here. */
  readonly type: string
  readonly url: string
  readonly mimeType: string
  /** As sent by the provider, when present — used for an early oversize
   *  rejection before the bytes are fetched. Not trusted beyond that. */
  readonly size: number | undefined
}

export interface InboundEnvelope {
  provider: "whatsapp" | "telegram" | "sms" | "email"
  source: string
  contactRef: string
  displayName: string
  text: string
  messageId: string
  roomCodeHint: string | undefined
  /** Additive field of the real v1 envelope (docs/AGENTPUSH.md §3,
   *  `media: [{ type, url, mimeType, size }]`). Always present, empty when
   *  the payload carried none or only malformed entries — malformed entries
   *  (missing `type`/`url`, non-array `media`) are skipped here and, when
   *  that empties the whole array, an empty-text message falls back to the
   *  "ignored" path rather than fanning in a phantom media line. */
  media: readonly InboundMediaItem[]
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

const ENVELOPE_VERSION = 1
const MESSENGER_CHANNELS: readonly string[] = ["whatsapp", "telegram", "sms"]

function isMessengerChannel(value: string): value is "whatsapp" | "telegram" | "sms" {
  return MESSENGER_CHANNELS.includes(value)
}

/** Parse the additive `media` array (docs/AGENTPUSH.md §3:
 *  `[{ type, url, mimeType, size }]`). Entries missing `type` or `url` are
 *  unfetchable and unfetchable is unnormalizable, so they're dropped — an
 *  entry without a URL cannot even produce a failure line naming a real
 *  source. */
function parseMedia(value: unknown): readonly InboundMediaItem[] {
  if (!Array.isArray(value)) return []
  const items: InboundMediaItem[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const type = getStringField(entry, "type")
    const url = getStringField(entry, "url")
    if (type === undefined || url === undefined) continue
    const sizeRaw = entry["size"]
    items.push({
      type,
      url,
      mimeType: getStringField(entry, "mimeType") ?? "application/octet-stream",
      size: typeof sizeRaw === "number" && Number.isFinite(sizeRaw) && sizeRaw >= 0 ? sizeRaw : undefined,
    })
  }
  return items
}

export function parseAgentpushWebhook(input: ParseAgentpushWebhookInput): WebhookResult {
  if (input.secret !== undefined) {
    const verified = verifyAgentpushSignature(input.rawBody, input.headers, input.secret)
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

  if (!isRecord(parsed)) {
    return { ok: false, status: 400, reason: "invalid_json" }
  }

  const envelope = parsed
  const version = envelope.version
  if (version !== undefined && version !== ENVELOPE_VERSION) {
    return { ok: false, status: 400, reason: "unsupported_envelope_version" }
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

  const messageId = getStringField(envelope, "messageId")
  if (messageId === undefined) {
    return { ok: false, status: 400, reason: "missing_message_id" }
  }

  const text = getStringField(envelope, "text")
  if (text === undefined) {
    return { ok: false, status: 400, reason: "missing_text" }
  }
  const media = parseMedia(envelope.media)
  if (text.length === 0 && media.length === 0) {
    return { ok: true, ignored: "no_text" }
  }

  return {
    ok: true,
    envelope: {
      provider: channel,
      source: channel,
      contactRef,
      displayName: contactRef,
      text,
      messageId,
      roomCodeHint: undefined,
      media,
    },
  }
}

/** Bounded FIFO dedup on `messageId` — agentpush's notify delivery is
 *  documented at-least-once (docs/AGENTPUSH.md §3, "Delivery semantics"):
 *  a durable notify row is retried on failure, so redelivery is expected,
 *  not exceptional. `seen` returns true on a repeat messageId — the caller
 *  should drop the message, not route it again — and false the first time,
 *  after which the id is remembered. */
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
