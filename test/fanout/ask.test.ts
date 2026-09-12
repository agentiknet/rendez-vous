import assert from "node:assert/strict"
import { test } from "node:test"
import { askMarkerForOthers, askTextForTarget, parseAskSegments, resolveAskSegments } from "../../src/fanout/ask.ts"
import type { Member } from "../../src/rooms/types.ts"

function member(id: string, displayName: string): Member {
  return {
    id,
    displayName,
    tier: "messenger",
    address: { provider: "whatsapp", source: "agentpush", contactRef: id },
    joinedAt: "2026-09-12T00:00:00.000Z",
  }
}

test("parseAskSegments: no ask block is a single broadcast segment", () => {
  const segments = parseAskSegments("just a normal reply")
  assert.deepEqual(segments, [{ kind: "broadcast", text: "just a normal reply" }])
})

test("parseAskSegments: one ask block splits broadcast/ask/broadcast", () => {
  const text = ["Collecting pieces.", "[[ask Alice]]", "send me the product shot", "[[/ask]]", "thanks both."].join("\n")
  const segments = parseAskSegments(text)
  assert.deepEqual(segments, [
    { kind: "broadcast", text: "Collecting pieces." },
    { kind: "ask", targetName: "Alice", text: "send me the product shot" },
    { kind: "broadcast", text: "thanks both." },
  ])
})

test("parseAskSegments: multiple ask blocks in one turn", () => {
  const text = [
    "[[ask Alice]]",
    "the product shot",
    "[[/ask]]",
    "and",
    "[[ask Bob]]",
    "the one-line positioning",
    "[[/ask]]",
  ].join("\n")
  const segments = parseAskSegments(text)
  assert.deepEqual(segments, [
    { kind: "ask", targetName: "Alice", text: "the product shot" },
    { kind: "broadcast", text: "and" },
    { kind: "ask", targetName: "Bob", text: "the one-line positioning" },
  ])
})

test("parseAskSegments: a malformed unclosed ask block folds back into broadcast text untouched", () => {
  const text = ["before", "[[ask Alice]]", "never closed", "still going"].join("\n")
  const segments = parseAskSegments(text)
  assert.deepEqual(segments, [{ kind: "broadcast", text }])
})

test("resolveAskSegments: an unmatched name falls back to broadcast with a visible note, content kept", () => {
  const text = ["[[ask Dave]]", "the thing", "[[/ask]]"].join("\n")
  const resolved = resolveAskSegments(text, [member("a1", "Alice")])
  assert.deepEqual(resolved, [{ kind: "broadcast", text: "(ask target not found: Dave)\nthe thing" }])
})

test("resolveAskSegments: matches a target case-insensitively", () => {
  const alice = member("a1", "Alice")
  const resolved = resolveAskSegments(["[[ask ALICE]]", "the shot", "[[/ask]]"].join("\n"), [alice])
  assert.deepEqual(resolved, [{ kind: "ask", target: alice, text: "the shot" }])
})

test("target and other-member renderings: the waiting-on-you prefix and the one-line marker", () => {
  const alice = member("a1", "Alice")
  assert.equal(askTextForTarget("send me the product shot"), "(the room is waiting on you) send me the product shot")
  assert.equal(askMarkerForOthers(alice, "the product shot"), "(waiting on Alice: the product shot)")
})