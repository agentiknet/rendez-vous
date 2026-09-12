/**
 * Session recap — what a resumed room needs so the agent is not starting
 * from nothing.
 *
 * A resume boots a FRESH agent session (`E2bBooter.resume`): the prior
 * session's context does not carry over, and until this module existed
 * nothing replayed it either. The room came back, greeted everyone, and had
 * no idea what had been discussed — with no error anywhere, because from
 * every machine's point of view the resume had succeeded (found live on a
 * real phone, 2026-09-12).
 *
 * The fix is deliberately the cheap one: read the OLD session's transcript
 * from the daemon and fold a compact recap into the new session's opening
 * prompt. No second prompt turn (which the fan-out would deliver to members
 * as if the agent had said it), no new storage, no summarisation model in
 * the path. The prior `sessionId` is still on the `Room` when
 * `performResume` runs — it is only overwritten afterwards — so there is
 * nothing to persist either.
 *
 * Three properties this must hold, in order of how badly they bite:
 *
 * 1. **It must never block a resume.** A recap is a nice-to-have; the room
 *    coming back is not. Every failure path here returns `undefined` and the
 *    caller proceeds with a resume that simply says the history is gone.
 * 2. **It must be time-bounded.** `DaemonClient.events` is an SSE stream
 *    that replays the backlog and then STAYS OPEN waiting for live records.
 *    Iterating it to completion on a dead session would hang the resume
 *    forever. Everything here runs under a hard budget.
 * 3. **It must be size-bounded.** A long room would otherwise push a
 *    multi-megabyte prompt into the new session. We keep the most recent
 *    slice, because that is the part someone resuming actually needs.
 */

import { isRecordKind, type TranscriptRecord } from "../daemon/records.ts"

/** Structurally `DaemonClient`'s transcript half — injectable so tests can
 *  hand records back without a daemon or a real SSE stream. */
export interface RecapSource {
  events(sessionId: string, since: number, signal?: AbortSignal): AsyncIterable<TranscriptRecord>
}

export interface BuildRecapOptions {
  /** Hard ceiling on the whole read. The backlog of a room-sized session
   *  arrives in well under a second; this exists so a stream that never
   *  closes cannot stall the resume. */
  readonly budgetMs?: number
  /** Stop reading after this many records regardless of the clock. */
  readonly maxRecords?: number
  /** Keep at most this many characters, taken from the END — the recent
   *  turns are the ones worth carrying. */
  readonly maxChars?: number
}

const DEFAULT_BUDGET_MS = 4_000
const DEFAULT_MAX_RECORDS = 2_000
const DEFAULT_MAX_CHARS = 6_000

/** Fan-in already prefixes every member message with `[Name · tier]`, so a
 *  replayed user-prompt keeps its attribution for free — the recap shows who
 *  asked for what, not just what was asked. */
function formatTurns(turns: readonly string[], maxChars: number): string | undefined {
  if (turns.length === 0) return undefined
  const joined = turns.join("\n")
  if (joined.length <= maxChars) return joined
  const clipped = joined.slice(joined.length - maxChars)
  // Never start mid-line: find the first newline so the recap opens on a
  // whole turn rather than half a sentence.
  const firstBreak = clipped.indexOf("\n")
  const body = firstBreak === -1 ? clipped : clipped.slice(firstBreak + 1)
  return `[…earlier turns omitted…]\n${body}`
}

/**
 * Read `sessionId`'s transcript and render it as plain turns.
 *
 * Returns `undefined` when there is nothing worth replaying, or when
 * anything at all goes wrong — an unreachable daemon, a session the daemon
 * has already forgotten, a stream that errors mid-read. A resume with no
 * recap is a working resume; a resume that threw is not.
 */
export async function buildSessionRecap(
  source: RecapSource,
  sessionId: string,
  options: BuildRecapOptions = {},
): Promise<string | undefined> {
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS

  const turns: string[] = []
  let assistant = ""
  let seen = 0

  const flushAssistant = (): void => {
    const text = assistant.trim()
    assistant = ""
    if (text.length > 0) turns.push(`Agent: ${text}`)
  }

  // The budget is enforced HERE, by racing each `next()`, rather than by
  // handing the source an AbortSignal and trusting it. Passing the signal is
  // still worth doing — the real `DaemonClient` forwards it to `fetch` and
  // tears the socket down — but a source that ignores it must not be able to
  // hang a resume forever. The first version of this function relied on the
  // signal alone and deadlocked the test suite on a generator that ignored
  // it; a resume is exactly where that failure would have been worst.
  const deadline = Date.now() + budgetMs
  const iterator = source.events(sessionId, 0, AbortSignal.timeout(budgetMs))[Symbol.asyncIterator]()

  try {
    while (seen < maxRecords) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break

      let timer: ReturnType<typeof setTimeout> | undefined
      const expiry = new Promise<"expired">((resolve) => {
        timer = setTimeout(() => resolve("expired"), remaining)
      })
      let step: IteratorResult<TranscriptRecord> | "expired"
      try {
        step = await Promise.race([iterator.next(), expiry])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }

      if (step === "expired" || step.done === true) break
      const record = step.value
      seen += 1

      if (isRecordKind(record, "user-prompt")) {
        flushAssistant()
        const text = record.text.trim()
        if (text.length > 0) turns.push(text)
      } else if (isRecordKind(record, "text-delta")) {
        assistant += record.text
      } else if (isRecordKind(record, "turn-end")) {
        flushAssistant()
      }
      // Thoughts, tool calls and tool results are deliberately skipped: the
      // recap is what was SAID in the room, not how the agent got there.
    }
  } catch {
    // An unreachable daemon, a forgotten session, a stream that errored
    // mid-read: whatever we collected before it is still good and still used
    // below. A resume that loses the history works; one that throws does not.
  } finally {
    // Let the source release its socket when we stopped early.
    void iterator.return?.(undefined)
  }
  flushAssistant()

  return formatTurns(turns, maxChars)
}
