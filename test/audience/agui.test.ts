import assert from "node:assert/strict"
import { test } from "node:test"
import {
  GAP_EVENT_NAME,
  KIND_EVENT_NAME,
  newUserMessageText,
  outboxToAguiEvents,
  parseRunAgentInput,
  sinceFromInput,
  type AguiEvent,
  type OutboxRunFrame,
  type RunAgentInput,
} from "../../src/audience/agui.ts"
import type { Delivery } from "../../src/rooms/types.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function delivery(id: string, text: string, kind: Delivery["kind"] = "say"): Delivery {
  return {
    id,
    memberId: "m1",
    kind,
    text,
    status: "pending",
    failures: 0,
    lastError: undefined,
    createdAt: "2026-09-13T10:00:00.000Z",
    deliveredAt: undefined,
  }
}

function frame(overrides: Partial<OutboxRunFrame>): OutboxRunFrame {
  return { since: 0, cursor: 0, pruned: false, lowWater: undefined, deliveries: [], ...overrides }
}

function types(events: readonly AguiEvent[]): string[] {
  return events.map((event) => event.type)
}

// --- outboxToAguiEvents: ordering, kind survival, RUN_STARTED/FINISHED ----

test("outboxToAguiEvents brackets every run with RUN_STARTED first and RUN_FINISHED last, threadId/runId echoed", () => {
  const events = outboxToAguiEvents("t1", "r1", frame({}))
  assert.equal(events[0]?.type, "RUN_STARTED")
  assert.deepEqual(events[0], { type: "RUN_STARTED", threadId: "t1", runId: "r1" })
  assert.equal(events[events.length - 1]?.type, "RUN_FINISHED")
  assert.deepEqual(events[events.length - 1], { type: "RUN_FINISHED", threadId: "t1", runId: "r1" })
})

test("a pruned:true run emits the gap CUSTOM event strictly before the first TEXT_MESSAGE_START (D2)", () => {
  const events = outboxToAguiEvents(
    "t1",
    "r1",
    frame({ pruned: true, since: 2, cursor: 9, lowWater: 4, deliveries: [delivery("d5", "hello")] }),
  )
  const gapIndex = events.findIndex((event) => event.type === "CUSTOM" && event.name === GAP_EVENT_NAME)
  const firstTextStart = events.findIndex((event) => event.type === "TEXT_MESSAGE_START")
  assert.ok(gapIndex !== -1, "the gap event must be present")
  assert.ok(firstTextStart !== -1, "there must be a text message in this fixture")
  assert.ok(gapIndex < firstTextStart, "the gap must be emitted before any transcript content")

  const gap = events[gapIndex]
  assert.ok(gap?.type === "CUSTOM")
  if (gap?.type === "CUSTOM") {
    assert.deepEqual(gap.value, { since: 2, cursor: 9, lowWater: 4 })
  }
})

test("a pruned:false run emits NO gap event at all — absence of the CUSTOM event IS the false answer (§8, both directions)", () => {
  const events = outboxToAguiEvents("t1", "r1", frame({ pruned: false, deliveries: [delivery("d1", "hi")] }))
  assert.ok(
    !events.some((event) => event.type === "CUSTOM" && event.name === GAP_EVENT_NAME),
    "pruned:false must never be reassured with a reassurance event",
  )
})

test("Delivery.kind survives translation for all three values via a CUSTOM event keyed by messageId, immediately before TEXT_MESSAGE_START (D5)", () => {
  const deliveries = [delivery("d1", "a say", "say"), delivery("d2", "a whisper", "whisper"), delivery("d3", "a system notice", "system")]
  const events = outboxToAguiEvents("t1", "r1", frame({ deliveries }))

  for (const d of deliveries) {
    const kindIndex = events.findIndex(
      (event) => event.type === "CUSTOM" && event.name === KIND_EVENT_NAME && isRecord(event.value) && event.value.messageId === d.id,
    )
    const startIndex = events.findIndex((event) => event.type === "TEXT_MESSAGE_START" && event.messageId === d.id)
    assert.ok(kindIndex !== -1, `expected a kind CUSTOM event for ${d.id}`)
    assert.ok(startIndex !== -1, `expected a TEXT_MESSAGE_START for ${d.id}`)
    assert.equal(kindIndex, startIndex - 1, "the kind event rides immediately before TEXT_MESSAGE_START")
    const kindEvent = events[kindIndex]
    assert.ok(kindEvent?.type === "CUSTOM")
    if (kindEvent?.type === "CUSTOM") assert.deepEqual(kindEvent.value, { messageId: d.id, kind: d.kind })
  }

  // whisper must not render identically to say: both map to the same
  // TEXT_MESSAGE_START role, so the CUSTOM event is the ONLY place the two
  // are told apart — the exact demo-day bug this whole thread exists to fix.
  const sayStart = events.find((event) => event.type === "TEXT_MESSAGE_START" && event.messageId === "d1")
  const whisperStart = events.find((event) => event.type === "TEXT_MESSAGE_START" && event.messageId === "d2")
  assert.ok(sayStart?.type === "TEXT_MESSAGE_START" && whisperStart?.type === "TEXT_MESSAGE_START")
  if (sayStart?.type === "TEXT_MESSAGE_START" && whisperStart?.type === "TEXT_MESSAGE_START") {
    assert.equal(sayStart.role, whisperStart.role, "say and whisper share a role — kind is what tells them apart")
  }

  // system is NOT silently folded into say: it gets its own role.
  const systemStart = events.find((event) => event.type === "TEXT_MESSAGE_START" && event.messageId === "d3")
  assert.ok(systemStart?.type === "TEXT_MESSAGE_START")
  if (systemStart?.type === "TEXT_MESSAGE_START") assert.equal(systemStart.role, "system")
})

test("each delivery becomes a full TEXT_MESSAGE_START/_CONTENT/_END triple carrying its text, in order", () => {
  const events = outboxToAguiEvents("t1", "r1", frame({ deliveries: [delivery("d1", "hello there")] }))
  const triple = events.filter((event) => ("messageId" in event && event.messageId === "d1") || (event.type === "CUSTOM" && event.name === KIND_EVENT_NAME))
  assert.deepEqual(types(triple.slice(1)), ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"])
  const content = events.find((event) => event.type === "TEXT_MESSAGE_CONTENT")
  assert.ok(content?.type === "TEXT_MESSAGE_CONTENT")
  if (content?.type === "TEXT_MESSAGE_CONTENT") assert.equal(content.delta, "hello there")
})

test("STATE_SNAPSHOT carries the room's cursor on every run, so a reconnecting client has something to present next (D3)", () => {
  const events = outboxToAguiEvents("t1", "r1", frame({ cursor: 42 }))
  const snapshot = events.find((event) => event.type === "STATE_SNAPSHOT")
  assert.ok(snapshot?.type === "STATE_SNAPSHOT")
  if (snapshot?.type === "STATE_SNAPSHOT") assert.deepEqual(snapshot.snapshot, { cursor: 42 })
})

test("deliveries in a run never carry another member's record — outboxToAguiEvents only ever sees what it is handed", () => {
  // The translator has no member concept at all: it trusts the caller
  // (outboxFor, D1) to have already scoped `deliveries`. This pins that it
  // does not, itself, widen the set back out — every messageId in the
  // output traces to a delivery in the input, nothing invented or merged.
  const deliveries = [delivery("d1", "mine"), delivery("d2", "also mine")]
  const events = outboxToAguiEvents("t1", "r1", frame({ deliveries }))
  const messageIds = new Set(
    events.filter((event): event is Extract<AguiEvent, { messageId: string }> => "messageId" in event).map((event) => event.messageId),
  )
  assert.deepEqual([...messageIds].sort(), ["d1", "d2"])
})

// --- sinceFromInput: the sinceGiven distinction (D3) -----------------------

function runInput(overrides: Partial<RunAgentInput>): RunAgentInput {
  return { threadId: "t1", runId: "r1", messages: [], ...overrides }
}

test("sinceFromInput reads `since` from forwardedProps and marks it given", () => {
  assert.deepEqual(sinceFromInput(runInput({ forwardedProps: { since: 7 } })), { since: 7, sinceGiven: true })
})

test("sinceFromInput treats an omitted, non-numeric, or negative `since` as NOT given — 0, not 'no opinion' (docs/OUTBOX.md §3/§8)", () => {
  assert.deepEqual(sinceFromInput(runInput({})), { since: 0, sinceGiven: false })
  assert.deepEqual(sinceFromInput(runInput({ forwardedProps: {} })), { since: 0, sinceGiven: false })
  assert.deepEqual(sinceFromInput(runInput({ forwardedProps: { since: "3" } })), { since: 0, sinceGiven: false })
  assert.deepEqual(sinceFromInput(runInput({ forwardedProps: { since: -1 } })), { since: 0, sinceGiven: false })
})

// --- newUserMessageText: D6's "pure reconnect is normal" -------------------

test("newUserMessageText returns the last message's text when it is a fresh user turn", () => {
  assert.equal(
    newUserMessageText(runInput({ messages: [{ id: "1", role: "assistant", content: "hi" }, { id: "2", role: "user", content: "hello" }] })),
    "hello",
  )
})

test("newUserMessageText returns undefined for a pure reconnect: no messages, or the last message is not a user turn", () => {
  assert.equal(newUserMessageText(runInput({ messages: [] })), undefined)
  assert.equal(newUserMessageText(runInput({ messages: [{ id: "1", role: "assistant", content: "hi" }] })), undefined)
  assert.equal(newUserMessageText(runInput({ messages: [{ id: "1", role: "user", content: "   " }] })), undefined, "whitespace-only is not a message")
})

// --- parseRunAgentInput: hand-rolled validation, no zod --------------------

test("parseRunAgentInput accepts a minimal valid body and rejects a malformed one without naming any value", () => {
  const ok = parseRunAgentInput({ threadId: "t1", runId: "r1", messages: [] })
  assert.ok("input" in ok)

  for (const bad of [undefined, null, "nope", {}, { threadId: "t1" }, { threadId: "t1", runId: "r1", messages: "nope" }, { threadId: "t1", runId: "r1", messages: [{ id: "1", role: "bogus" }] }]) {
    const result = parseRunAgentInput(bad)
    assert.ok("error" in result, `expected an error for ${JSON.stringify(bad)}`)
  }
})

test("parseRunAgentInput keeps an object forwardedProps and drops a non-object one", () => {
  const withProps = parseRunAgentInput({ threadId: "t1", runId: "r1", messages: [], forwardedProps: { since: 3 } })
  assert.ok("input" in withProps)
  if ("input" in withProps) assert.deepEqual(withProps.input.forwardedProps, { since: 3 })

  const withoutProps = parseRunAgentInput({ threadId: "t1", runId: "r1", messages: [], forwardedProps: "nope" })
  assert.ok("input" in withoutProps)
  if ("input" in withoutProps) assert.equal(withoutProps.input.forwardedProps, undefined)
})
