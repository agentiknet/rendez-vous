/**
 * The AG-UI translation (BRIEF-04): a transport-free mapping from the
 * outbox's own vocabulary — `Delivery[]`, a cursor, a `pruned` gap marker —
 * to AG-UI's fixed event vocabulary (`RUN_STARTED`, `TEXT_MESSAGE_*`,
 * `STATE_SNAPSHOT`, `CUSTOM`, …). It is kept free of `node:http` and SSE
 * framing for the same reason `src/audience/contract.ts` is kept MCP-free:
 * so it is testable without a socket, and so a second transport (there will
 * be one) inherits these semantics instead of re-deriving them.
 *
 * No `@ag-ui/*` package is installed anywhere in this repo (checked, not
 * assumed — `package.json`, `node_modules`, and the `rdv-copilotkit-host/`
 * directory the brief warns off do not exist in this checkout). BRIEF-04
 * anticipates exactly this and calls for hand-rolling the small event
 * vocabulary this module actually emits, in `mcp-room.ts`'s style — no zod,
 * no new dependency. The shapes below are therefore this repo's own
 * understanding of the public AG-UI wire protocol, not a copy of an
 * installed type; where the protocol leaves a choice (D3: `forwardedProps`
 * vs `state`), the reasoning for the choice made is written at the call
 * site below, not asserted from a type checker that does not exist here.
 *
 * The semantics carried through are NOT re-decidable: they come from
 * `docs/OUTBOX.md`, by way of BRIEF-04's D1-D7. Each rule below cites the
 * decision it implements.
 */

import type { Delivery } from "../rooms/types.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// --- RunAgentInput, hand-rolled (D3) -----------------------------------

/** The roles AG-UI messages carry. Only `"user"` is ever read here (D6): the
 *  rest ride along in a client's `messages` array unread, because this
 *  endpoint answers with the outbox's own record of what the room said —
 *  it does not replay the room's history back out of the client's own
 *  message list. */
export type AguiRole = "developer" | "system" | "assistant" | "user" | "tool"

export interface AguiMessage {
  readonly id: string
  readonly role: AguiRole
  /** Absent on a historical message this endpoint does not model (e.g. one
   *  carrying tool calls instead of text) — never required, since only the
   *  LAST message is ever inspected (`newUserMessageText`). */
  readonly content?: string
}

/** The one shape this endpoint reads out of a POST body. `forwardedProps` is
 *  AG-UI's documented free-form escape hatch for application-specific data a
 *  frontend hands its agent — the resume cursor `since` rides there (D3),
 *  not in `state`: `state` is the agent's own mirrored state, snapshotted
 *  and delta'd FROM the agent's run, not a client-set input parameter on the
 *  way in. Using it for `since` would make the outbox cursor look like
 *  agent state a `STATE_DELTA` could legitimately overwrite, which it is
 *  not — it is the client's own assertion of where it is (`docs/OUTBOX.md`
 *  §3), exactly the shape `forwardedProps` exists for. */
export interface RunAgentInput {
  readonly threadId: string
  readonly runId: string
  readonly messages: readonly AguiMessage[]
  readonly forwardedProps?: Record<string, unknown>
}

function isAguiRole(value: unknown): value is AguiRole {
  return value === "developer" || value === "system" || value === "assistant" || value === "user" || value === "tool"
}

function isAguiMessage(value: unknown): value is AguiMessage {
  if (!isRecord(value)) return false
  return typeof value.id === "string" && isAguiRole(value.role) && (value.content === undefined || typeof value.content === "string")
}

/** Runtime validation of a raw POST body, in `isRecord`'s style (no zod).
 *  Error strings name no value, matching `handleRoomSend`'s `invalid_body`
 *  (mcp-room.ts's HARD RULE, generalised to this JSON route). */
export function parseRunAgentInput(body: unknown): { input: RunAgentInput } | { error: string } {
  if (!isRecord(body)) return { error: "invalid_body" }
  const { threadId, runId, messages, forwardedProps } = body
  if (typeof threadId !== "string" || threadId.length === 0) return { error: "invalid_body" }
  if (typeof runId !== "string" || runId.length === 0) return { error: "invalid_body" }
  if (!Array.isArray(messages) || !messages.every(isAguiMessage)) return { error: "invalid_body" }
  return {
    input: { threadId, runId, messages, ...(isRecord(forwardedProps) ? { forwardedProps } : {}) },
  }
}

/** D3: the client's cursor, with the SAME `sinceGiven` distinction the HTTP
 *  outbox route makes (`?since=` present vs absent). A first connection that
 *  omits `since` MUST NOT be told later that it lost something (§8) — that
 *  is what `sinceGiven: false` protects downstream, in `outboxToAguiEvents`
 *  by way of `outboxFor`. */
export function sinceFromInput(input: RunAgentInput): { since: number; sinceGiven: boolean } {
  const raw = input.forwardedProps?.since
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return { since: 0, sinceGiven: false }
  return { since: raw, sinceGiven: true }
}

/** D6: the client's new message, if this run carries one. A run whose last
 *  message is not a fresh `"user"` turn — including an empty `messages`
 *  array — is a pure reconnect: normal, and nothing is sent. Only the LAST
 *  message is ever inspected; this endpoint is not a chat-history replay,
 *  it is "did the client just say something new". */
export function newUserMessageText(input: RunAgentInput): string | undefined {
  const last = input.messages[input.messages.length - 1]
  if (last === undefined || last.role !== "user") return undefined
  const text = last.content?.trim()
  return text !== undefined && text.length > 0 ? text : undefined
}

// --- BaseEvent, hand-rolled (16 tagged objects in the full vocabulary; --
// --- only the arms this endpoint emits are modelled) --------------------

export interface RunStartedEvent {
  readonly type: "RUN_STARTED"
  readonly threadId: string
  readonly runId: string
}

export interface RunFinishedEvent {
  readonly type: "RUN_FINISHED"
  readonly threadId: string
  readonly runId: string
}

/** Out of scope's opposite number: emitted whenever a run cannot finish
 *  cleanly, so a stream that stops is never read as a stream that
 *  succeeded (BRIEF-04: "a stream that ends quietly is absence reading as
 *  delivery"). */
export interface RunErrorEvent {
  readonly type: "RUN_ERROR"
  readonly message: string
}

/** D5: no `kind` slot — see `KIND_EVENT_NAME` below for where it rides
 *  instead. `role` is `"system"` for a `Delivery.kind === "system"` record
 *  (the room's own voice) and `"assistant"` for `"say"`/`"whisper"` (the
 *  agent's), which is a second, native signal alongside the CUSTOM event —
 *  not a replacement for it, since `"say"` and `"whisper"` still collapse
 *  to the same role and only the CUSTOM event tells them apart. */
export interface TextMessageStartEvent {
  readonly type: "TEXT_MESSAGE_START"
  readonly messageId: string
  readonly role: "assistant" | "system"
}

export interface TextMessageContentEvent {
  readonly type: "TEXT_MESSAGE_CONTENT"
  readonly messageId: string
  readonly delta: string
}

export interface TextMessageEndEvent {
  readonly type: "TEXT_MESSAGE_END"
  readonly messageId: string
}

/** D3: the honest slot for the cursor a reconnecting client needs to
 *  present next. Carries the ROOM's `deliverySeq` snapshot (`OutboxPayload.
 *  cursor`), not "the highest id we just sent" — same field the JSON/SSE
 *  outbox readings expose today, so a client reading either surface sees
 *  the same number. */
export interface StateSnapshotEvent {
  readonly type: "STATE_SNAPSHOT"
  readonly snapshot: { readonly cursor: number }
}

/** AG-UI's only extension point, used twice below (D2's gap, D5's kind) —
 *  each with an explicit `name` so a generic AG-UI client that does not
 *  know either one can safely ignore both rather than misrender them as
 *  agent prose. */
export interface CustomEvent {
  readonly type: "CUSTOM"
  readonly name: string
  readonly value: unknown
}

export type AguiEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | StateSnapshotEvent
  | CustomEvent

export function runErrorEvent(message: string): RunErrorEvent {
  return { type: "RUN_ERROR", message }
}

/** D2: fired before the first `TEXT_MESSAGE_START` in the same run, never
 *  after — a client that renders the transcript first and learns of the gap
 *  second has already told a human "this is everything" (docs/OUTBOX.md
 *  §8). */
export const GAP_EVENT_NAME = "rdv.outbox.gap"

/** D5: `Delivery.kind`, keyed by the same `messageId` the following
 *  `TEXT_MESSAGE_START` uses, emitted immediately before it — the fallback
 *  BRIEF-04 prescribes for when the event carrying the text has no field of
 *  its own for the distinction. */
export const KIND_EVENT_NAME = "rdv.outbox.kind"

/** What `outboxToAguiEvents` needs: the SAME fields `outboxFor` already
 *  computed (D1) — this function derives nothing from `Room` or `Member`
 *  itself, so there is no second place to get the gap marker, the
 *  retention floor, or the per-member filter wrong. `lowWater` is passed
 *  through separately because `OutboxPayload` does not carry it; it is
 *  display-only here (the gap event's payload), never consulted to decide
 *  `pruned` — that decision is `outboxFor`'s alone. */
export interface OutboxRunFrame {
  readonly since: number
  readonly cursor: number
  readonly pruned: boolean
  readonly lowWater: number | undefined
  readonly deliveries: readonly Delivery[]
}

/** The translation itself (D1-D5): `RUN_STARTED`, the gap (if any) strictly
 *  before any message, one `CUSTOM` + `TEXT_MESSAGE_START/CONTENT/END`
 *  triple per delivery (kind first, D5), a `STATE_SNAPSHOT` carrying the
 *  cursor a reconnect should present (D3), and `RUN_FINISHED`. Pure: no
 *  `RUN_ERROR` is ever produced here — a translation of already-fetched
 *  records cannot fail, and `RUN_ERROR` is for the handler's own fallible
 *  steps (parsing the body, routing the inbound send) that happen around
 *  this call, not inside it. */
export function outboxToAguiEvents(threadId: string, runId: string, frame: OutboxRunFrame): readonly AguiEvent[] {
  const events: AguiEvent[] = [{ type: "RUN_STARTED", threadId, runId }]

  if (frame.pruned) {
    events.push({
      type: "CUSTOM",
      name: GAP_EVENT_NAME,
      value: { since: frame.since, cursor: frame.cursor, lowWater: frame.lowWater },
    })
  }
  // `pruned: false` is NEVER emitted as a reassurance event (docs/OUTBOX.md
  // §8): the absence of the CUSTOM event above IS the "false" answer.

  for (const delivery of frame.deliveries) {
    events.push({ type: "CUSTOM", name: KIND_EVENT_NAME, value: { messageId: delivery.id, kind: delivery.kind } })
    events.push({
      type: "TEXT_MESSAGE_START",
      messageId: delivery.id,
      role: delivery.kind === "system" ? "system" : "assistant",
    })
    events.push({ type: "TEXT_MESSAGE_CONTENT", messageId: delivery.id, delta: delivery.text })
    events.push({ type: "TEXT_MESSAGE_END", messageId: delivery.id })
  }

  events.push({ type: "STATE_SNAPSHOT", snapshot: { cursor: frame.cursor } })
  events.push({ type: "RUN_FINISHED", threadId, runId })
  return events
}
