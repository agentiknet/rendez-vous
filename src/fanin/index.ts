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

/**
 * Who a member wants the answer to reach.
 *
 * The agent has always been able to direct a reply at one person
 * (`[[whisper to …]]`, docs/WHISPER.md). The MEMBER had no say: every
 * message fanned in identically and every reply went to the whole room
 * unless the agent decided otherwise. In a room where people are on their
 * own phones, "answer just me" is the more common wish, not the exotic one.
 *
 * `"room"` is the default and stays the default — a shared agent that
 * quietly starts answering privately would break the one property the room
 * exists for.
 */
export type ReplyAudience = "room" | "sender-only"

export interface AudienceDirective {
  readonly audience: ReplyAudience
  /** The message with its directive prefix removed. */
  readonly text: string
  /** Whether the member actually typed a directive, as opposed to falling
   *  through to the default. Lets callers acknowledge `@all` explicitly
   *  without inventing a directive nobody wrote. */
  readonly explicit: boolean
}

/** Accepted at the START of a message only, case-insensitive, and must be
 *  followed by whitespace or end-of-message — so "@meeting at 5" and an
 *  email address mid-sentence are never swallowed as directives. French
 *  forms are included because the room's members type in both. */
const SENDER_ONLY_PREFIXES: readonly string[] = ["@me", "@moi", "/me", "/private", "/prive", "/privé", "@private"]
const ROOM_PREFIXES: readonly string[] = ["@all", "@tous", "/all", "/tous", "@room", "/room"]

function matchPrefix(trimmed: string, prefixes: readonly string[]): string | undefined {
  const lowered = trimmed.toLowerCase()
  for (const prefix of prefixes) {
    if (!lowered.startsWith(prefix)) continue
    const rest = trimmed.slice(prefix.length)
    if (rest.length === 0 || /^\s/.test(rest)) return rest.trim()
  }
  return undefined
}

export function parseAudienceDirective(raw: string): AudienceDirective {
  const trimmed = raw.trim()

  const senderOnly = matchPrefix(trimmed, SENDER_ONLY_PREFIXES)
  if (senderOnly !== undefined) return { audience: "sender-only", text: senderOnly, explicit: true }

  const room = matchPrefix(trimmed, ROOM_PREFIXES)
  if (room !== undefined) return { audience: "room", text: room, explicit: true }

  return { audience: "room", text: trimmed, explicit: false }
}

/** `· private` is the whole contract with the agent: the capability lines
 *  (src/service/booter.ts) tell it that a turn carrying that marker must be
 *  answered entirely inside a whisper block addressed to that member. The
 *  delivery itself is the EXISTING whisper path — deliberately not a second
 *  outbound route, which would be a second chance to drop a message
 *  silently (docs/MULTIMODAL.md, "one ingestion path stays the only path"). */
export function attributeText(sender: Sender, raw: string, audience: ReplyAudience = "room"): string {
  const marker = audience === "sender-only" ? " · private" : ""
  return `[${sender.displayName} · ${sender.tier}${marker}] ${raw}`
}

export async function fanIn(
  client: DaemonClient,
  sessionId: string,
  sender: Sender,
  raw: string,
): Promise<PromptResult> {
  const directive = parseAudienceDirective(raw)
  if (directive.text.length === 0) {
    // Covers a bare "@me" with nothing after it as well as a genuinely empty
    // message: there is no question to answer either way.
    return { ok: false, reason: "other", status: 0, message: "empty message, not sent" }
  }
  return client.prompt(sessionId, {
    prompt: attributeText(sender, directive.text, directive.audience),
    queue: true,
    origin: `rdv:${sender.id}`,
  })
}
