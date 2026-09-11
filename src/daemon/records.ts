/**
 * Transcript record shapes, ground-truthed in docs/DAEMON-NOTES.md against a
 * live daemon's `events.jsonl` / SSE stream. `kind` discriminates; any kind
 * not explicitly modelled here still parses as `OtherRecord` rather than
 * being dropped, since new record kinds are expected to show up over time.
 */

interface BaseRecord {
  readonly seq: number
  readonly sessionId?: string
  readonly ts?: string
}

export interface UserPromptRecord extends BaseRecord {
  readonly kind: "user-prompt"
  readonly text: string
}

export interface TextDeltaRecord extends BaseRecord {
  readonly kind: "text-delta"
  readonly text: string
}

export interface ThoughtRecord extends BaseRecord {
  readonly kind: "thought"
  readonly text: string
}

export interface ToolCallRecord extends BaseRecord {
  readonly kind: "tool-call"
  readonly toolCallId: string
  readonly toolName: string
  readonly arguments: Record<string, unknown>
  readonly isUpdate?: boolean
}

export interface ToolResultRecord extends BaseRecord {
  readonly kind: "tool-result"
  readonly toolCallId: string
  readonly result: unknown
  readonly isError: boolean
}

export interface TurnEndRecord extends BaseRecord {
  readonly kind: "turn-end"
  readonly reason: string
  readonly awaitingInput?: boolean
  readonly label?: string
  readonly question?: string
  readonly empty?: boolean
}

/** Anything not modelled above — still carries `kind` and `seq` so a
 *  cursor-tracking consumer can skip it without losing its place. */
export interface OtherRecord extends BaseRecord {
  readonly kind: string
}

export type TranscriptRecord =
  | UserPromptRecord
  | TextDeltaRecord
  | ThoughtRecord
  | ToolCallRecord
  | ToolResultRecord
  | TurnEndRecord
  | OtherRecord

/**
 * `record.kind === "text-delta"` alone does NOT narrow away `OtherRecord`
 * (its `kind: string` is still assignable-compatible with the literal under
 * `===` control-flow narrowing), so callers would still need a cast to read
 * `.text`/`.reason`/etc. This checks the same equality but narrows via
 * `Extract`, which uses assignability instead — `OtherRecord` correctly
 * drops out because `string` is not assignable to a specific literal kind. */
export function isRecordKind<K extends TranscriptRecord["kind"]>(
  record: TranscriptRecord,
  kind: K,
): record is Extract<TranscriptRecord, { kind: K }> {
  return record.kind === kind
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key]
  return typeof v === "string" ? v : undefined
}

function numberField(rec: Record<string, unknown>, key: string): number | undefined {
  const v = rec[key]
  return typeof v === "number" ? v : undefined
}

function booleanField(rec: Record<string, unknown>, key: string): boolean | undefined {
  const v = rec[key]
  return typeof v === "boolean" ? v : undefined
}

function recordField(rec: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = rec[key]
  return isRecord(v) ? v : undefined
}

/** Parse one SSE `data:` payload (or one `events.jsonl` line) into a
 *  `TranscriptRecord`. Returns `undefined` for JSON that isn't a record, or
 *  a known `kind` whose required fields don't match the shape we've
 *  ground-truthed — the caller should skip it, not fail the stream. */
export function parseTranscriptRecord(raw: string): TranscriptRecord | undefined {
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed)) return undefined
  const kind = stringField(parsed, "kind")
  const seq = numberField(parsed, "seq")
  if (kind === undefined || seq === undefined) return undefined
  const sessionId = stringField(parsed, "sessionId")
  const ts = stringField(parsed, "ts")
  const base = {
    seq,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(ts !== undefined ? { ts } : {}),
  }

  switch (kind) {
    case "user-prompt":
    case "text-delta":
    case "thought": {
      const text = stringField(parsed, "text")
      if (text === undefined) return undefined
      return { ...base, kind, text }
    }
    case "tool-call": {
      const toolCallId = stringField(parsed, "toolCallId")
      const toolName = stringField(parsed, "toolName")
      const args = recordField(parsed, "arguments")
      if (toolCallId === undefined || toolName === undefined || args === undefined) return undefined
      const isUpdate = booleanField(parsed, "isUpdate")
      return {
        ...base,
        kind,
        toolCallId,
        toolName,
        arguments: args,
        ...(isUpdate !== undefined ? { isUpdate } : {}),
      }
    }
    case "tool-result": {
      const toolCallId = stringField(parsed, "toolCallId")
      const isError = booleanField(parsed, "isError")
      if (toolCallId === undefined || isError === undefined) return undefined
      return { ...base, kind, toolCallId, result: parsed.result, isError }
    }
    case "turn-end": {
      const reason = stringField(parsed, "reason")
      if (reason === undefined) return undefined
      const awaitingInput = booleanField(parsed, "awaitingInput")
      const label = stringField(parsed, "label")
      const question = stringField(parsed, "question")
      const empty = booleanField(parsed, "empty")
      return {
        ...base,
        kind,
        reason,
        ...(awaitingInput !== undefined ? { awaitingInput } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(question !== undefined ? { question } : {}),
        ...(empty !== undefined ? { empty } : {}),
      }
    }
    default:
      return { ...base, kind }
  }
}
