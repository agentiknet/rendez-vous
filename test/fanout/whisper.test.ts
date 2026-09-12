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
    { kind: "whisper", targetName: "Alice", text: "just for you" },
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
    { kind: "whisper", targetName: "Alice", text: "for alice" },
    { kind: "broadcast", text: "middle" },
    { kind: "whisper", targetName: "Bob", text: "for bob" },
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
  assert.deepEqual(resolved, [{ kind: "whisper", target: alice, text: "hi" }])
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
