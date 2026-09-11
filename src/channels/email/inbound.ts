/**
 * Parses agentpush's real inbound-mail notify webhook.
 *
 * Ground-truthed against the read-only checkout at
 * /Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/projects/agentpush
 * (never edited) — see docs/AGENTPUSH.md §8 for the full contract. This is
 * NOT the same wire shape as the messaging tier's `MessagingInboundEnvelope`
 * (src/channels/agentpush/inbound.ts) — Gmail inbound flows through a
 * separate, poll-driven dispatch engine
 * (apps/worker/src/poll-inbound.ts:124-144, `buildNotifyPayload`) that
 * builds its own envelope:
 *
 *   { event: "inbound_mail",
 *     route: { name, dispatch_tag },
 *     message: { message_id, from, subject, text, timestamp },
 *     workspace_id }
 *
 * Still signed with the identical `X-Agentpush-Signature` HMAC scheme
 * (packages/sdk/src/push.ts:504-531) — both paths dispatch through the same
 * `push.dispatch()`, sharing `buildInboundNotifyRequest`
 * (packages/core/src/domain/inbound-route/evaluate.ts:94-111). agentpush
 * itself tells the two payload shapes apart structurally, not by a shared
 * discriminant field (`notifyKindForPayload`, evaluate.ts:113-123) — this
 * parser does the same: reject anything whose `event` isn't
 * `"inbound_mail"`, rather than assume the caller only ever routes mail
 * payloads here.
 *
 * `message.from` is always a BARE email address against real agentpush —
 * Gmail's provider strips any display name before this payload is built
 * (packages/messaging/src/providers/gmail/provider.ts:512-514,
 * `extractEmail(decodeRfc2047(...))`). There is no display-name field
 * anywhere in this envelope today, the same story as the messaging tier
 * (docs/AGENTPUSH.md §3). This parser still accepts an RFC 5322
 * `"Display Name <addr>"` form defensively — dead code against real
 * agentpush today, but costs nothing and matches a future/alternate mail
 * connector that does carry one.
 *
 * `message.text` is the raw MIME plain-text part, verbatim — Gmail's
 * `findPlainText` applies no quote/signature stripping
 * (packages/messaging/src/providers/gmail/provider.ts:518). That stripping
 * happens here, with the conservative heuristic this milestone specifies:
 * drop lines starting with `>`, and drop a line matching `/^On .* wrote:$/`
 * or `/^-- $/` and everything after it.
 *
 * `roomCodeHint` is a Rendez-vous-only addition with no agentpush
 * counterpart: if the subject contains something that normalizes to a room
 * code (`normalizeCode`, src/rooms/code.ts), it's surfaced for the caller to
 * act on — this parser never routes on it itself.
 */

import { normalizeCode } from "../../rooms/code.ts"
import type { InboundEnvelope, WebhookResult } from "../agentpush/inbound.ts"
import { verifyAgentpushSignature } from "../agentpush/signature.ts"
import { getStringField, isRecord } from "../json.ts"

export interface ParseEmailInboundInput {
  rawBody: string
  headers: Record<string, string | undefined>
  secret: string | undefined
  now?: number
}

const ROOM_CODE_PATTERN = /RDV-?[A-Z0-9]{4}/i

function extractRoomCodeHint(subject: string): string | undefined {
  const match = ROOM_CODE_PATTERN.exec(subject)
  if (!match) return undefined
  return normalizeCode(match[0])
}

/** `"Display Name <addr>"` or a bare `"addr"`. Real agentpush only ever
 *  sends the bare form (see module doc comment) — the named form is
 *  accepted defensively for a future connector. */
function parseFromHeader(raw: string): { address: string; displayName: string } {
  const trimmed = raw.trim()
  const match = /^(.*)<([^<>]+)>$/.exec(trimmed)
  if (!match) {
    return { address: trimmed, displayName: trimmed }
  }
  const address = match[2]?.trim() ?? trimmed
  const name = match[1]?.trim().replace(/^["']|["']$/g, "") ?? ""
  return { address, displayName: name.length > 0 ? name : address }
}

/** Drop quoted-reply lines (`>`) and everything from a reply-header or
 *  signature delimiter onward. Conservative on purpose — false negatives
 *  (leftover quote noise) are far less harmful than false positives
 *  (silently eating real content). */
function stripQuotedAndSignature(text: string): string {
  const kept: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (/^On .* wrote:$/.test(line)) break
    if (/^-- $/.test(line)) break
    if (line.startsWith(">")) continue
    kept.push(line)
  }
  return kept.join("\n").trim()
}

export function parseEmailInbound(input: ParseEmailInboundInput): WebhookResult {
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

  if (parsed.event !== "inbound_mail") {
    return { ok: false, status: 400, reason: "not_inbound_mail" }
  }

  const message = parsed.message
  if (!isRecord(message)) {
    return { ok: false, status: 400, reason: "missing_message" }
  }

  const from = getStringField(message, "from")
  if (from === undefined) {
    return { ok: false, status: 400, reason: "missing_contact_ref" }
  }

  const messageId = getStringField(message, "message_id")
  if (messageId === undefined) {
    return { ok: false, status: 400, reason: "missing_message_id" }
  }

  const rawText = getStringField(message, "text")
  if (rawText === undefined) {
    return { ok: false, status: 400, reason: "missing_text" }
  }

  const text = stripQuotedAndSignature(rawText)
  if (text.length === 0) {
    return { ok: true, ignored: "no_text" }
  }

  const { address, displayName } = parseFromHeader(from)
  const subject = getStringField(message, "subject") ?? ""

  const envelope: InboundEnvelope = {
    provider: "email",
    source: "email",
    contactRef: address.toLowerCase(),
    displayName,
    text,
    messageId,
    roomCodeHint: extractRoomCodeHint(subject),
  }

  return { ok: true, envelope }
}
