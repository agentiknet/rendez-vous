/**
 * Empirical experiment (architecture.md §9.3): what happens on OpenAI's
 * Agents API when a second input arrives on a session while its first turn
 * is still in progress? The public docs do not say. This script finds out
 * against the live API and prints a full, ordered transcript.
 *
 * Endpoints used, verified two ways: (1) fetching
 * https://developers.openai.com/api/docs/guides/agents-api/{quickstart,overview}
 * and https://developers.openai.com/api/reference/python/resources/beta on
 * 2026-09-12, and (2) reading the generated request code in the `openai` npm
 * package (v7.15.0, `resources/beta/agents/**​/*.js`, pulled via `npm pack`
 * into /tmp — not a project dependency). Both agree:
 *
 *   POST   /v1/agents                       create a reusable agent
 *   DELETE /v1/agents/{agent_id}             delete it
 *   POST   /v1/agents/sessions               create a session
 *   GET    /v1/agents/sessions/{id}          retrieve session state
 *   GET    /v1/agents/sessions/{id}/events   live SSE event stream
 *   POST   /v1/agents/sessions/{id}/events   submit input/cancel/tool-result
 *   DELETE /v1/agents/sessions/{id}          delete a session
 *
 * Every call needs `Authorization: Bearer $OPENAI_API_KEY` and
 * `OpenAI-Beta: agents=v1`. Confirmed live: `POST /v1/agents` with
 * `{"model":"gpt-6-astra"}` and with `{"model":"gpt-5.4-mini"}` both
 * returned 200; `gpt-5-mini`, `gpt-5-nano`, `gpt-4o-mini`, `o4-mini` and
 * `gpt-5.1-codex-mini` all came back `400 invalid_request_error` with
 * `"The '<model>' model is not supported by Managed Agents."`. This script
 * uses `gpt-5.4-mini`, the cheapest of the two that were accepted.
 *
 * The input-submission type system (`AgentSessionInputParam` in the npm
 * package's `.d.ts`) exposes exactly three event shapes: `message` (add
 * input, start a turn), `cancel` (cancel the active turn), and
 * `tool_result`. There is no boolean `queue` or `interrupt` flag anywhere in
 * the request shape — unlike agentproto's `queue: true`, the only lever
 * OpenAI exposes for "input arrives mid-turn" is which of these three event
 * types you send. This script tests the plain `message` case (does a second
 * message reject, queue, or merge?) and, as the closest documented
 * "interrupt", the `cancel` case.
 *
 * This is a standalone one-off probe, not part of the Rendez-vous service —
 * it reads OPENAI_API_KEY directly rather than through src/env.ts (out of
 * scope for this file; that module has no such field and isn't owned here).
 *
 * Run: `node scripts/experiment-openai-midturn.ts`
 */

const apiKeyRaw = process.env.OPENAI_API_KEY
if (apiKeyRaw === undefined || apiKeyRaw.trim().length === 0) {
  console.error("OPENAI_API_KEY is not set in this shell's environment. Cannot run the experiment.")
  process.exit(1)
}
const apiKey: string = apiKeyRaw

const BASE_URL = "https://api.openai.com/v1"
const MODEL = "gpt-5.4-mini"
const MAIN_TIMEOUT_MS = 75_000
const CANCEL_TIMEOUT_MS = 45_000
const SECOND_INPUT_DELAY_MS = 2_000

function authHeaders(extra: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "OpenAI-Beta": "agents=v1", ...extra }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key]
  return typeof v === "string" ? v : undefined
}

function recordField(rec: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = rec[key]
  return isRecord(v) ? v : undefined
}

interface RawResponse {
  readonly status: number
  readonly bodyText: string
}

async function postJson(path: string, body: unknown): Promise<RawResponse> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  })
  const bodyText = await res.text()
  return { status: res.status, bodyText }
}

async function getJson(path: string): Promise<RawResponse> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: authHeaders({}) })
  const bodyText = await res.text()
  return { status: res.status, bodyText }
}

async function deleteResource(path: string): Promise<RawResponse> {
  const res = await fetch(`${BASE_URL}${path}`, { method: "DELETE", headers: authHeaders({}) })
  const bodyText = await res.text()
  return { status: res.status, bodyText }
}

function parseId(raw: RawResponse, label: string): string {
  const parsed: unknown = JSON.parse(raw.bodyText)
  if (!isRecord(parsed)) throw new Error(`${label}: response body is not an object: ${raw.bodyText}`)
  const id = stringField(parsed, "id")
  if (id === undefined) throw new Error(`${label}: response has no string "id": ${raw.bodyText}`)
  return id
}

interface TimedEvent {
  readonly tMs: number
  readonly raw: Record<string, unknown>
}

/** Read one line-delimited SSE `data:` frame at a time from the body of a
 *  session's `GET .../events` stream, tagging each with an elapsed-ms
 *  timestamp relative to `t0`. Stops when the server closes the stream or
 *  `signal` aborts it. */
async function* readSse(path: string, t0: number, signal: AbortSignal): AsyncGenerator<TimedEvent> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: authHeaders({ Accept: "text/event-stream" }), signal })
  if (res.body === null) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let dataLines: string[] = []
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl = buffer.indexOf("\n")
      while (nl !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "")
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf("\n")
        if (line === "") {
          if (dataLines.length > 0) {
            const dataText = dataLines.join("\n")
            dataLines = []
            if (dataText !== "[DONE]") {
              const parsed: unknown = JSON.parse(dataText)
              if (isRecord(parsed)) yield { tMs: Date.now() - t0, raw: parsed }
            }
          }
          continue
        }
        if (line.startsWith(":")) continue
        const colon = line.indexOf(":")
        const field = colon === -1 ? line : line.slice(0, colon)
        if (field !== "data") continue
        const rawValue = colon === -1 ? "" : line.slice(colon + 1)
        dataLines.push(rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue)
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

async function collectEvents(path: string, t0: number, timeoutMs: number): Promise<TimedEvent[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const events: TimedEvent[] = []
  try {
    for await (const evt of readSse(path, t0, controller.signal)) {
      events.push(evt)
    }
  } catch (err) {
    if (!(err instanceof Error && err.name === "AbortError")) throw err
  } finally {
    clearTimeout(timeout)
  }
  return events
}

function describeEvent(evt: TimedEvent): string {
  const type = stringField(evt.raw, "type") ?? "?"
  const turnId = stringField(evt.raw, "turn_id")
  const delta = stringField(evt.raw, "delta")
  const turn = recordField(evt.raw, "turn")
  const turnStatus = turn !== undefined ? stringField(turn, "status") : undefined
  const parts = [`+${evt.tMs}ms`, type]
  if (turnId !== undefined) parts.push(`turn=${turnId}`)
  if (turnStatus !== undefined) parts.push(`turn.status=${turnStatus}`)
  if (delta !== undefined) parts.push(`delta=${JSON.stringify(delta)}`)
  return parts.join(" ")
}

function messageEvent(text: string): unknown {
  return {
    events: [
      {
        type: "agent.session.input.message",
        input: [{ role: "user", content: [{ type: "input_text", text }] }],
      },
    ],
  }
}

function cancelEvent(): unknown {
  return { events: [{ type: "agent.session.input.cancel" }] }
}

async function createAgent(): Promise<string> {
  const res = await postJson("/agents", {
    model: MODEL,
    instructions: "Follow the user's literal instructions. Do not use any tools.",
    reasoning: { effort: "low" },
  })
  console.log(`\n== POST /agents ==\nstatus: ${res.status}\nbody: ${res.bodyText}`)
  if (res.status < 200 || res.status >= 300) throw new Error("agent creation failed, stopping")
  return parseId(res, "create agent")
}

/** A `type: "none"` (no sandbox) session rejects creation with no `input`
 *  ("conversation-only sessions currently require initial input") — found
 *  live, not documented anywhere fetched above. So the first turn's input
 *  has to ride along on session creation itself, not a separate `events`
 *  call; creating with `stream: false` still returns as soon as the turn is
 *  accepted (session status `in_progress`), so timing the second input off
 *  of this call's return is still precise. */
async function createSession(agentId: string, initialInput: string): Promise<string> {
  const res = await postJson("/agents/sessions", {
    agent_id: agentId,
    environment: { type: "none" },
    input: initialInput,
    stream: false,
  })
  console.log(`\n== POST /agents/sessions ==\nstatus: ${res.status}\nbody: ${res.bodyText}`)
  if (res.status < 200 || res.status >= 300) throw new Error("session creation failed, stopping")
  return parseId(res, "create session")
}

async function runMidTurnMessageExperiment(agentId: string): Promise<void> {
  console.log("\n\n########## EXPERIMENT 1: second `message` input while a turn is in progress ##########")
  const sessionId = await createSession(agentId, "Count slowly from 1 to 60, one number per line, no tools.")
  const t0 = Date.now()

  const collectPromise = collectEvents(`/agents/sessions/${sessionId}/events`, t0, MAIN_TIMEOUT_MS)

  await sleep(SECOND_INPUT_DELAY_MS)

  const second = await postJson(
    `/agents/sessions/${sessionId}/events`,
    messageEvent("Second message: reply with the single word pong"),
  )
  console.log(`\n[+${Date.now() - t0}ms] SECOND input (message, sent mid-turn) — raw response verbatim:`)
  console.log(`  status: ${second.status}`)
  console.log(`  body: ${second.bodyText}`)

  const events = await collectPromise
  console.log(`\n-- ordered event stream (${events.length} events) --`)
  for (const evt of events) console.log(describeEvent(evt))

  const finalState = await getJson(`/agents/sessions/${sessionId}`)
  console.log(`\n-- GET /agents/sessions/${sessionId} (final state) --`)
  console.log(`status: ${finalState.status}\nbody: ${finalState.bodyText}`)

  const del = await deleteResource(`/agents/sessions/${sessionId}`)
  console.log(`\n-- DELETE /agents/sessions/${sessionId} --\nstatus: ${del.status}\nbody: ${del.bodyText}`)
}

async function runCancelExperiment(agentId: string): Promise<void> {
  console.log("\n\n########## EXPERIMENT 2: `cancel` input while a turn is in progress (closest documented interrupt) ##########")
  const sessionId = await createSession(agentId, "Count slowly from 1 to 30, one number per line, no tools.")
  const t0 = Date.now()

  const collectPromise = collectEvents(`/agents/sessions/${sessionId}/events`, t0, CANCEL_TIMEOUT_MS)

  await sleep(SECOND_INPUT_DELAY_MS)

  const cancel = await postJson(`/agents/sessions/${sessionId}/events`, cancelEvent())
  console.log(`\n[+${Date.now() - t0}ms] CANCEL input (sent mid-turn) — raw response verbatim:`)
  console.log(`  status: ${cancel.status}`)
  console.log(`  body: ${cancel.bodyText}`)

  const tAfterCancel = Date.now() - t0
  const followUp = await postJson(`/agents/sessions/${sessionId}/events`, messageEvent("Reply with the single word pong"))
  console.log(`\n[+${Date.now() - t0}ms] follow-up message sent immediately after cancel (cancel took ${Date.now() - t0 - tAfterCancel}ms to post) — raw response verbatim:`)
  console.log(`  status: ${followUp.status}`)
  console.log(`  body: ${followUp.bodyText}`)

  const events = await collectPromise
  console.log(`\n-- ordered event stream (${events.length} events) --`)
  for (const evt of events) console.log(describeEvent(evt))

  const finalState = await getJson(`/agents/sessions/${sessionId}`)
  console.log(`\n-- GET /agents/sessions/${sessionId} (final state) --`)
  console.log(`status: ${finalState.status}\nbody: ${finalState.bodyText}`)

  const del = await deleteResource(`/agents/sessions/${sessionId}`)
  console.log(`\n-- DELETE /agents/sessions/${sessionId} --\nstatus: ${del.status}\nbody: ${del.bodyText}`)
}

function parseStatus(raw: RawResponse): string | undefined {
  const parsed: unknown = JSON.parse(raw.bodyText)
  return isRecord(parsed) ? stringField(parsed, "status") : undefined
}

async function waitForIdle(sessionId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await getJson(`/agents/sessions/${sessionId}`)
    if (parseStatus(state) === "idle") return
    await sleep(300)
  }
  throw new Error(`session ${sessionId} did not reach idle within ${timeoutMs}ms`)
}

/** Experiment 1 tests input arriving during the FIRST turn, which OpenAI
 *  rejects with the specific message "session initial input is still
 *  pending" — worded around session creation, not turn-in-progress in
 *  general. This experiment disambiguates: it lets turn 1 finish, starts a
 *  SECOND turn via `events.create` (not session creation), and fires the
 *  probe input mid-turn-2, to see whether the same rejection (and wording)
 *  holds for an ordinary, non-initial turn. */
async function runSecondTurnMidTurnExperiment(agentId: string): Promise<void> {
  console.log("\n\n########## EXPERIMENT 3: second `message` input while a NON-initial turn is in progress ##########")
  const sessionId = await createSession(agentId, "Reply with exactly the single word: ready")
  await waitForIdle(sessionId, 30_000)
  console.log(`\nsession ${sessionId} is idle after turn 1, starting turn 2`)

  const t0 = Date.now()
  const collectPromise = collectEvents(`/agents/sessions/${sessionId}/events`, t0, MAIN_TIMEOUT_MS)
  await sleep(500)

  const turn2 = await postJson(
    `/agents/sessions/${sessionId}/events`,
    messageEvent("Count slowly from 1 to 40, one number per line, no tools."),
  )
  console.log(`\n[+${Date.now() - t0}ms] turn-2 input (message)`)
  console.log(`  status: ${turn2.status}`)
  console.log(`  body: ${turn2.bodyText}`)

  await sleep(SECOND_INPUT_DELAY_MS)

  const probe = await postJson(
    `/agents/sessions/${sessionId}/events`,
    messageEvent("Third message: reply with the single word pong"),
  )
  console.log(`\n[+${Date.now() - t0}ms] PROBE input (message, sent mid-turn-2) — raw response verbatim:`)
  console.log(`  status: ${probe.status}`)
  console.log(`  body: ${probe.bodyText}`)

  const events = await collectPromise
  console.log(`\n-- ordered event stream (${events.length} events) --`)
  for (const evt of events) console.log(describeEvent(evt))

  const finalState = await getJson(`/agents/sessions/${sessionId}`)
  console.log(`\n-- GET /agents/sessions/${sessionId} (final state) --`)
  console.log(`status: ${finalState.status}\nbody: ${finalState.bodyText}`)

  const del = await deleteResource(`/agents/sessions/${sessionId}`)
  console.log(`\n-- DELETE /agents/sessions/${sessionId} --\nstatus: ${del.status}\nbody: ${del.bodyText}`)
}

async function main(): Promise<void> {
  const agentId = await createAgent()
  try {
    await runMidTurnMessageExperiment(agentId)
    await runCancelExperiment(agentId)
    await runSecondTurnMidTurnExperiment(agentId)
  } finally {
    const del = await deleteResource(`/agents/${agentId}`)
    console.log(`\n-- DELETE /agents/${agentId} --\nstatus: ${del.status}\nbody: ${del.bodyText}`)
  }
}

main().catch((err: unknown) => {
  console.error("\nEXPERIMENT FAILED:", err instanceof Error ? err.stack ?? err.message : String(err))
  process.exitCode = 1
})
