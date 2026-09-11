/**
 * agentpush's notify signature scheme — identical for every notify payload
 * shape it dispatches (messaging and mail alike), since both paths sign
 * through the same `push.dispatch()` (packages/sdk/src/push.ts:504-531 in
 * the read-only agentpush checkout; see docs/AGENTPUSH.md §3 and §8).
 * `X-Agentpush-Signature: sha256=<hex HMAC-SHA256(notify_secret, rawBody)>`,
 * computed over the exact raw JSON bytes on the wire. No timestamp/nonce
 * rides in the scheme — there is no replay window to enforce.
 */

import { createHmac, timingSafeEqual } from "node:crypto"

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

export function verifyAgentpushSignature(
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
