/**
 * Session recap — src/service/recap.ts.
 *
 * The properties under test are the ones that decide whether a resume is
 * honest: it must replay what was SAID, it must never block a resume, and
 * when it has nothing it must return nothing rather than something
 * plausible.
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import { buildSessionRecap, type RecapSource } from "../../src/service/recap.ts"
import type { TranscriptRecord } from "../../src/daemon/records.ts"

/** A source that yields a fixed script and then ends, like a daemon
 *  replaying a dead session's backlog. */
function scripted(records: readonly TranscriptRecord[]): RecapSource {
  return {
    // eslint-disable-next-line require-yield
    async *events(): AsyncIterable<TranscriptRecord> {
      for (const record of records) yield record
    },
  }
}

let seq = 0
const userPrompt = (text: string): TranscriptRecord => ({ kind: "user-prompt", seq: (seq += 1), text })
const delta = (text: string): TranscriptRecord => ({ kind: "text-delta", seq: (seq += 1), text })
const turnEnd = (): TranscriptRecord => ({ kind: "turn-end", seq: (seq += 1), reason: "done" })

test("replays member turns and agent replies in order, keeping attribution", async () => {
  const recap = await buildSessionRecap(
    scripted([
      userPrompt("[Alice · messenger] build me a landing page"),
      delta("On it — "),
      delta("starting with the hero."),
      turnEnd(),
      userPrompt("[Bob · room-web] make the hero green"),
      delta("Green it is."),
      turnEnd(),
    ]),
    "sess_old",
  )

  assert.ok(recap !== undefined)
  assert.equal(
    recap,
    [
      "[Alice · messenger] build me a landing page",
      "Agent: On it — starting with the hero.",
      "[Bob · room-web] make the hero green",
      "Agent: Green it is.",
    ].join("\n"),
  )
})

test("text-delta fragments are joined into one agent turn, not one line each", async () => {
  const recap = await buildSessionRecap(scripted([userPrompt("hi"), delta("a"), delta("b"), delta("c"), turnEnd()]), "s")

  assert.equal(recap, "hi\nAgent: abc")
})

test("a trailing agent turn with no turn-end is still flushed", async () => {
  // The last turn of a killed session often has no turn-end record at all.
  const recap = await buildSessionRecap(scripted([userPrompt("hi"), delta("half a thought")]), "s")

  assert.equal(recap, "hi\nAgent: half a thought")
})

test("thoughts and tool calls are left out — the recap is what was said in the room", async () => {
  const recap = await buildSessionRecap(
    scripted([
      userPrompt("[Alice · messenger] ship it"),
      { kind: "thought", seq: 900, text: "the user seems impatient" },
      { kind: "tool-call", seq: 901, toolCallId: "t1", toolName: "write_file", arguments: { path: "/x" } },
      { kind: "tool-result", seq: 902, toolCallId: "t1", result: "ok", isError: false },
      delta("Shipped."),
      turnEnd(),
    ]),
    "s",
  )

  assert.ok(recap !== undefined)
  assert.ok(!recap.includes("impatient"), "internal reasoning must not be replayed into the room's recap")
  assert.ok(!recap.includes("write_file"), "tool mechanics are not conversation")
  assert.equal(recap, "[Alice · messenger] ship it\nAgent: Shipped.")
})

test("an empty session recaps to undefined, not to an empty-looking transcript", async () => {
  // The caller branches on undefined to tell the agent the history is gone.
  // An empty string here would produce a resume prompt quoting nothing while
  // claiming the transcript survived — the exact confabulation we fixed.
  assert.equal(await buildSessionRecap(scripted([]), "s"), undefined)
  assert.equal(await buildSessionRecap(scripted([turnEnd()]), "s"), undefined)
})

test("a source that throws yields undefined — a recap must never break a resume", async () => {
  const broken: RecapSource = {
    async *events(): AsyncIterable<TranscriptRecord> {
      throw new Error("daemon unreachable")
    },
  }

  assert.equal(await buildSessionRecap(broken, "s"), undefined)
})

test("a source that throws PART WAY keeps what it already read", async () => {
  const partial: RecapSource = {
    async *events(): AsyncIterable<TranscriptRecord> {
      yield userPrompt("[Alice · messenger] first thing")
      yield delta("got it")
      throw new Error("stream died")
    },
  }

  const recap = await buildSessionRecap(partial, "s")
  assert.ok(recap !== undefined, "a partial transcript beats no transcript")
  assert.match(recap, /first thing/)
  assert.match(recap, /Agent: got it/)
})

test("a stream that never ends is cut off by the budget instead of hanging the resume", async () => {
  // This is the shape of the real bug the budget exists for: the daemon's
  // SSE stream replays the backlog and then STAYS OPEN for live records.
  const neverEnds: RecapSource = {
    async *events(): AsyncIterable<TranscriptRecord> {
      yield userPrompt("[Alice · messenger] hello")
      yield delta("hi back")
      yield turnEnd()
      await new Promise(() => {}) // never resolves
    },
  }

  const startedAt = Date.now()
  const recap = await buildSessionRecap(neverEnds, "s", { budgetMs: 250 })
  const elapsed = Date.now() - startedAt

  assert.ok(elapsed < 3_000, `should have given up near the budget, took ${elapsed}ms`)
  assert.ok(recap !== undefined, "whatever arrived before the cutoff is still worth replaying")
  assert.match(recap, /hello/)
  assert.match(recap, /Agent: hi back/)
})

test("maxRecords stops the read even when the stream keeps producing", async () => {
  const flood: RecapSource = {
    async *events(): AsyncIterable<TranscriptRecord> {
      for (let i = 0; i < 10_000; i += 1) yield userPrompt(`turn ${i}`)
    },
  }

  const recap = await buildSessionRecap(flood, "s", { maxRecords: 5, maxChars: 10_000 })
  assert.ok(recap !== undefined)
  assert.equal(recap.split("\n").length, 5)
})

test("an over-long recap keeps the END and marks what it dropped", async () => {
  const many: TranscriptRecord[] = []
  for (let i = 0; i < 200; i += 1) many.push(userPrompt(`[Alice · messenger] message number ${i}`))

  const recap = await buildSessionRecap(scripted(many), "s", { maxChars: 300 })

  assert.ok(recap !== undefined)
  assert.ok(recap.length <= 340, `should be near the cap, was ${recap.length}`)
  assert.match(recap, /earlier turns omitted/, "the clip must be visible, not silent")
  assert.match(recap, /message number 199/, "the most recent turn is the one that must survive")
  assert.ok(!recap.includes("message number 0\n"), "the oldest turns are the ones dropped")
})

test("the clipped recap never opens mid-line", async () => {
  const many: TranscriptRecord[] = []
  for (let i = 0; i < 50; i += 1) many.push(userPrompt(`[Alice · messenger] a reasonably long message number ${i}`))

  const recap = await buildSessionRecap(scripted(many), "s", { maxChars: 200 })

  assert.ok(recap !== undefined)
  const lines = recap.split("\n").slice(1) // skip the omission marker
  for (const line of lines) {
    assert.match(line, /^(\[Alice · messenger\]|Agent:)/, `line should start at a turn boundary: ${line}`)
  }
})
