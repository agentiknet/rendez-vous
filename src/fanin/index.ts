/**
 * Attributed fan-in — architecture.md §5.1. Turns an inbound message plus
 * its sender into a `queue: true` prompt on the room's session, so a
 * message arriving mid-turn is durably queued instead of lost (R3).
 */

import type { DaemonClient, PromptResult } from "../daemon/client.ts"

export type Tier = "messenger" | "email" | "room-web"

/** Structural subset of M1's `Member` this module needs. */
export interface Sender {
  readonly id: string
  readonly displayName: string
  readonly tier: Tier
}

export function attributeText(sender: Sender, raw: string): string {
  return `[${sender.displayName} · ${sender.tier}] ${raw}`
}

export async function fanIn(
  client: DaemonClient,
  sessionId: string,
  sender: Sender,
  raw: string,
): Promise<PromptResult> {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return { ok: false, reason: "other", status: 0, message: "empty message, not sent" }
  }
  return client.prompt(sessionId, {
    prompt: attributeText(sender, trimmed),
    queue: true,
    origin: `rdv:${sender.id}`,
  })
}
