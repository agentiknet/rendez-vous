import assert from "node:assert/strict"
import { test } from "node:test"
import { isRecordKind, parseTranscriptRecord } from "../../src/daemon/records.ts"

test("parseTranscriptRecord parses a user-prompt record", () => {
  const record = parseTranscriptRecord(
    '{"seq":2,"ts":"2026-09-11T20:59:53.713Z","kind":"user-prompt","sessionId":"sess_x","text":"hello"}',
  )
  assert.ok(record !== undefined)
  assert.equal(record.kind, "user-prompt")
  assert.equal(record.seq, 2)
  assert.equal(record.sessionId, "sess_x")
  assert.ok(isRecordKind(record, "user-prompt"))
  assert.equal(record.text, "hello")
})

test("parseTranscriptRecord parses a text-delta record", () => {
  const record = parseTranscriptRecord('{"seq":5,"kind":"text-delta","sessionId":"sess_x","text":"pong"}')
  assert.ok(record !== undefined)
  assert.ok(isRecordKind(record, "text-delta"))
  assert.equal(record.text, "pong")
})

test("parseTranscriptRecord parses a turn-end record with only required fields", () => {
  const record = parseTranscriptRecord('{"seq":8,"kind":"turn-end","sessionId":"sess_x","reason":"completed"}')
  assert.ok(record !== undefined)
  assert.ok(isRecordKind(record, "turn-end"))
  assert.equal(record.reason, "completed")
  assert.equal(record.awaitingInput, undefined)
})

test("parseTranscriptRecord parses a turn-end record with optional fields", () => {
  const record = parseTranscriptRecord(
    '{"seq":8,"kind":"turn-end","reason":"awaiting-input","awaitingInput":true,"label":"clarify","question":"which one?"}',
  )
  assert.ok(record !== undefined)
  assert.ok(isRecordKind(record, "turn-end"))
  assert.equal(record.awaitingInput, true)
  assert.equal(record.label, "clarify")
  assert.equal(record.question, "which one?")
})

test("parseTranscriptRecord parses a tool-call record, including the isUpdate arm", () => {
  const started = parseTranscriptRecord(
    '{"seq":5,"kind":"tool-call","toolCallId":"toolu_1","toolName":"Terminal","arguments":{}}',
  )
  assert.ok(started !== undefined)
  assert.ok(isRecordKind(started, "tool-call"))
  assert.equal(started.toolCallId, "toolu_1")
  assert.equal(started.isUpdate, undefined)

  const updated = parseTranscriptRecord(
    '{"seq":6,"kind":"tool-call","toolCallId":"toolu_1","toolName":"echo hi","arguments":{"command":"echo hi"},"isUpdate":true}',
  )
  assert.ok(updated !== undefined)
  assert.ok(isRecordKind(updated, "tool-call"))
  assert.equal(updated.isUpdate, true)
  assert.equal(updated.arguments.command, "echo hi")
})

test("parseTranscriptRecord parses a tool-result record", () => {
  const record = parseTranscriptRecord('{"seq":8,"kind":"tool-result","toolCallId":"toolu_1","result":"hi","isError":false}')
  assert.ok(record !== undefined)
  assert.ok(isRecordKind(record, "tool-result"))
  assert.equal(record.result, "hi")
  assert.equal(record.isError, false)
})

test("parseTranscriptRecord falls back to OtherRecord for unmodelled kinds", () => {
  const record = parseTranscriptRecord('{"seq":4,"kind":"usage_update","sessionId":"sess_x","size":200000,"used":30846}')
  assert.ok(record !== undefined)
  assert.equal(record.kind, "usage_update")
  assert.equal(record.seq, 4)
  assert.ok(!isRecordKind(record, "text-delta"))
})

test("parseTranscriptRecord returns undefined for non-object JSON", () => {
  assert.equal(parseTranscriptRecord("42"), undefined)
  assert.equal(parseTranscriptRecord("[1,2,3]"), undefined)
  assert.equal(parseTranscriptRecord('"just a string"'), undefined)
})

test("parseTranscriptRecord returns undefined when kind or seq is missing", () => {
  assert.equal(parseTranscriptRecord('{"kind":"text-delta","text":"hi"}'), undefined)
  assert.equal(parseTranscriptRecord('{"seq":1,"text":"hi"}'), undefined)
})

test("parseTranscriptRecord returns undefined when a known kind is missing its required field", () => {
  assert.equal(parseTranscriptRecord('{"seq":1,"kind":"text-delta"}'), undefined)
  assert.equal(parseTranscriptRecord('{"seq":1,"kind":"turn-end"}'), undefined)
  assert.equal(parseTranscriptRecord('{"seq":1,"kind":"tool-call","toolCallId":"x"}'), undefined)
})

test("isRecordKind narrows OtherRecord out of the union", () => {
  const record = parseTranscriptRecord('{"seq":1,"kind":"mystery-kind"}')
  assert.ok(record !== undefined)
  assert.ok(!isRecordKind(record, "turn-end"))
  assert.ok(!isRecordKind(record, "text-delta"))
})
