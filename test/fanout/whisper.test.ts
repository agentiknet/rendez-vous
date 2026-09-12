import assert from "node:assert/strict"
import { test } from "node:test"
import { parseWhisperSegments, renderWhisperForMember, resolveWhisperSegments } from "../../src/fanout/whisper.ts"
import type { Member } from "../../src/rooms/types.ts"

function member(id: string, displayName: string): Member {
  return {
    id,
    displayName,
    tier: "messenger",
    address: { provider: "whatsapp", source: "agentpush", contactRef: id },
    joinedAt: "2026-09-11T00:00:00.000Z",
  }
}

test("parseWhisperSegments: no whisper block is a single broadcast segment", () => {
  const segments = parseWhisperSegments("just a normal reply")
  assert.deepEqual(segments, [{ kind: "broadcast", text: "just a normal reply" }])
})

test("parseWhisperSegments: one whisper block splits broadcast/whisper/broadcast", () => {
  const text = ["Hello everyone.", "[[whisper to Alice]]", "just for you", "[[/whisper]]", "back to all."].join("\n")
  const segments = parseWhisperSegments(text)
  assert.deepEqual(segments, [
    { kind: "broadcast", text: "Hello everyone." },
    { kind: "whisper", targetName: "Alice", text: "just for you", announced: true },
    { kind: "broadcast", text: "back to all." },
  ])
})

test("parseWhisperSegments: multiple whisper blocks to different targets", () => {
  const text = [
    "[[whisper to Alice]]",
    "for alice",
    "[[/whisper]]",
    "middle",
    "[[whisper to Bob]]",
    "for bob",
    "[[/whisper]]",
  ].join("\n")
  const segments = parseWhisperSegments(text)
  assert.deepEqual(segments, [
    { kind: "whisper", targetName: "Alice", text: "for alice", announced: true },
    { kind: "broadcast", text: "middle" },
    { kind: "whisper", targetName: "Bob", text: "for bob", announced: true },
  ])
})

test("parseWhisperSegments: a malformed unclosed block folds back into broadcast text untouched", () => {
  const text = ["before", "[[whisper to Alice]]", "never closed", "still going"].join("\n")
  const segments = parseWhisperSegments(text)
  assert.deepEqual(segments, [{ kind: "broadcast", text }])
})

test("resolveWhisperSegments: an unmatched target falls back to broadcast with a visible note, content kept", () => {
  const text = ["[[whisper to Dave]]", "secret plan", "[[/whisper]]"].join("\n")
  const resolved = resolveWhisperSegments(text, [member("a1", "Alice")])
  assert.deepEqual(resolved, [
    { kind: "broadcast", text: "(whisper target not found: Dave)\nsecret plan" },
  ])
})

test("resolveWhisperSegments: matches a target case-insensitively", () => {
  const alice = member("a1", "Alice")
  const text = ["[[whisper to ALICE]]", "hi", "[[/whisper]]"].join("\n")
  const resolved = resolveWhisperSegments(text, [alice])
  assert.deepEqual(resolved, [{ kind: "whisper", target: alice, text: "hi", announced: true }])
})

test("renderWhisperForMember: the target sees the private prefix, others see only a marker", () => {
  const alice = member("a1", "Alice")
  const bob = member("b1", "Bob")
  const segments = resolveWhisperSegments(
    ["Hello all.", "[[whisper to Alice]]", "the actual private text", "[[/whisper]]", "bye."].join("\n"),
    [alice, bob],
  )

  assert.equal(
    renderWhisperForMember(segments, alice),
    "Hello all.\n(private) the actual private text\nbye.",
  )
  assert.equal(
    renderWhisperForMember(segments, bob),
    "Hello all.\n(the agent whispered to Alice)\nbye.",
  )
})

test("renderWhisperForMember: a reply with no whisper block renders identically for everyone", () => {
  const alice = member("a1", "Alice")
  const segments = resolveWhisperSegments("plain reply, nothing private", [alice])
  assert.equal(renderWhisperForMember(segments, alice), "plain reply, nothing private")
})

// --- [[to X]]: the ordinary answer to one person ------------------------
// Broadcast used to be the default, so two people asking unrelated things
// each received BOTH answers in full, on a phone. Naming someone inside a
// message everyone gets is legibility, not addressing.

function webMember(id: string, displayName: string): Member {
  return {
    id,
    displayName,
    tier: "room-web",
    address: { provider: "room-web", source: "room-web", contactRef: id },
    joinedAt: "2026-09-11T00:00:00.000Z",
  }
}

test("parseWhisperSegments: [[to X]] parses as an UNannounced target block", () => {
  const text = ["[[to Alice]]", "your half only", "[[/to]]"].join("\n")
  assert.deepEqual(parseWhisperSegments(text), [
    { kind: "whisper", targetName: "Alice", text: "your half only", announced: false },
  ])
})

test("a direct reply reaches its target with no (private) prefix — it is a normal answer, not a secret", () => {
  const alice = member("a1", "Alice")
  const segments = resolveWhisperSegments(["[[to Alice]]", "the hotel is booked", "[[/to]]"].join("\n"), [alice])
  assert.equal(renderWhisperForMember(segments, alice), "the hotel is booked")
})

test("a direct reply is INVISIBLE to the other phones — not even a marker", () => {
  const alice = member("a1", "Alice")
  const bob = member("b1", "Bob")
  const segments = resolveWhisperSegments(["[[to Alice]]", "the hotel is booked", "[[/to]]"].join("\n"), [alice, bob])
  assert.equal(renderWhisperForMember(segments, bob), "", "Bob's phone must not buzz for Alice's answer")
})

test("two people, two blocks, one turn: each gets only their own part", () => {
  const alice = member("a1", "Alice")
  const bob = member("b1", "Bob")
  const segments = resolveWhisperSegments(
    ["[[to Alice]]", "yours", "[[/to]]", "[[to Bob]]", "his", "[[/to]]"].join("\n"),
    [alice, bob],
  )
  assert.equal(renderWhisperForMember(segments, alice), "yours")
  assert.equal(renderWhisperForMember(segments, bob), "his")
})

test("a broadcast alongside a direct reply still reaches everyone", () => {
  const alice = member("a1", "Alice")
  const bob = member("b1", "Bob")
  const segments = resolveWhisperSegments(
    ["Going with the 1500 option.", "[[to Alice]]", "your flight moved", "[[/to]]"].join("\n"),
    [alice, bob],
  )
  assert.equal(renderWhisperForMember(segments, alice), "Going with the 1500 option.\nyour flight moved")
  assert.equal(renderWhisperForMember(segments, bob), "Going with the 1500 option.")
})

test("the room WEB page keeps every direct reply, labelled — it is the shared transcript and the projected screen", () => {
  const alice = member("a1", "Alice")
  const screen = webMember("w1", "Screen")
  const segments = resolveWhisperSegments(["[[to Alice]]", "your flight moved", "[[/to]]"].join("\n"), [alice, screen])
  assert.equal(renderWhisperForMember(segments, screen), "→ Alice: your flight moved")
})

test("a whisper stays announced on the web page too: confidential content is never shown there", () => {
  const alice = member("a1", "Alice")
  const screen = webMember("w1", "Screen")
  const segments = resolveWhisperSegments(
    ["[[whisper to Alice]]", "between us", "[[/whisper]]"].join("\n"),
    [alice, screen],
  )
  assert.equal(renderWhisperForMember(segments, screen), "(the agent whispered to Alice)")
})

test("an unclosed [[to]] block is folded back into broadcast, losing nothing", () => {
  const text = ["Hello.", "[[to Alice]]", "never closed"].join("\n")
  assert.deepEqual(parseWhisperSegments(text), [{ kind: "broadcast", text }])
})
