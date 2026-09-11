# Competitive notes

## Mid-turn input on the Agents API

Empirical answer to architecture.md §9.3: what happens on OpenAI's Agents
API when a second input arrives on a session while a turn is already in
progress? The public docs don't say. Run live on 2026-09-12 against
`api.openai.com` with `scripts/experiment-openai-midturn.ts`
(`node scripts/experiment-openai-midturn.ts`), model `gpt-5.4-mini`
(reasoning effort `low`). Full raw run log kept locally, not committed
(contains no secrets, just verbose SSE deltas — omitted here for length).

### Endpoints used

Confirmed two ways: fetching
`https://developers.openai.com/api/docs/guides/agents-api/{quickstart,overview}`
and `https://developers.openai.com/api/reference/python/resources/beta`, and
reading the generated request code in the `openai` npm package (pulled via
`npm pack openai@7.15.0` into `/tmp`, not a project dependency — grepped
`resources/beta/agents/**/*.js` for the literal request paths). Both agree:

```
POST   /v1/agents                       create a reusable agent
DELETE /v1/agents/{agent_id}             delete it
POST   /v1/agents/sessions               create a session
GET    /v1/agents/sessions/{id}          retrieve session state
GET    /v1/agents/sessions/{id}/events   live SSE event stream
POST   /v1/agents/sessions/{id}/events   submit input/cancel/tool-result
DELETE /v1/agents/sessions/{id}          delete a session
```

Every call needs `Authorization: Bearer $OPENAI_API_KEY` and
`OpenAI-Beta: agents=v1`.

Two things had to be found by hitting the live API, not the docs:

- **Model gate.** `POST /v1/agents` with `gpt-5-mini`, `gpt-5-nano`,
  `gpt-4o-mini`, `o4-mini`, and `gpt-5.1-codex-mini` all returned
  `400 invalid_request_error`, `"The '<model>' model is not supported by
  Managed Agents."` Only `gpt-6-astra` (the doc's own example) and
  `gpt-5.4-mini` were accepted. `gpt-5.4-mini` is the cheapest model this
  API will run at all, and is what the experiment uses.
- **No idle-then-inject on a sandboxless session.** `POST
  /v1/agents/sessions` with `environment: {type: "none"}` and no `input`
  rejects with `400`, `"conversation-only sessions currently require
  initial input"`. The first turn's input has to ride along on session
  creation; you cannot create an idle `type: "none"` session and inject the
  first message afterward via `events.create`.
- The input-submission type system (`AgentSessionInputParam`, from the npm
  package's `.d.ts`) exposes exactly three event shapes: `message` (add
  input, start a turn), `cancel` (cancel the active turn), and
  `tool_result`. There is no boolean `queue` or `interrupt` flag anywhere —
  unlike agentproto's `queue: true`, the only lever for "input arrives
  mid-turn" is which event type you send and, as it turns out, which turn
  number the session is on.

### Experiment 1 — second `message` during the session's first (initial) turn

Session created with `input: "Count slowly from 1 to 60, one number per
line, no tools."` (this is turn 1, riding along on session creation).
2.8s later, while turn 1 was still streaming, sent a second `message` event
to the same session.

Raw request:
```
POST /v1/agents/sessions/{id}/events
{"events":[{"type":"agent.session.input.message","input":[{"role":"user","content":[{"type":"input_text","text":"Second message: reply with the single word pong"}]}]}]}
```

Raw response, verbatim:
```
status: 409
{
  "error": {
    "type": "conflict_error",
    "code": "conflict_error",
    "message": "session initial input is still pending",
    "param": null
  }
}
```

Ordered event stream (132 raw events, output deltas collapsed for
readability — the type/turn sequence below is complete and unedited):

```
+6294ms agent.session.turn.created       turn=T1 status=queued
+6433ms agent.session.turn.item.added    turn=T1
+7228ms agent.session.in_progress
+7352ms agent.session.turn.in_progress   turn=T1 status=in_progress
+7352ms agent.session.turn.item.added/done, content_part.added   turn=T1
+7353..7524ms  60× output_text.delta ("1".."60")   turn=T1
+7524ms agent.session.turn.output_text.done / content_part.done / item.done   turn=T1
+8292ms agent.session.turn.completed     turn=T1 status=completed
+8543ms agent.session.idle
```

The second message never appears anywhere in the stream — it was rejected
at the HTTP layer before it became a session event. Turn 1 ran to
completion untouched. Final session state: `idle`, `usage.total_tokens:
5200`.

### Experiment 2 — `cancel` during the first turn (closest documented "interrupt")

Same setup, but the mid-turn input was `{"type":"agent.session.input.cancel"}`
instead of a message.

Raw response, verbatim:
```
status: 202
(empty body)
```

`202` — accepted, unlike the message case. But the event stream shows the
turn ran to completion anyway (all 30 numbers streamed, `turn.completed`
at +7506ms). The cancel was sent at +2463ms, before `turn.created` even
appeared in the stream (+4314ms) — i.e. before the turn had materialized
server-side, since the first turn spends a few seconds in the "initial
input pending" setup phase before actually starting. The cancel was
accepted but had no observable effect on this run; whether `cancel` would
actually interrupt a turn that has already started producing output is not
established by this test and would need a slower/longer turn to probe
cleanly. Immediately after cancel, a follow-up message got the same `409
"session initial input is still pending"` as experiment 1.

### Experiment 3 — second `message` during a NON-initial (second) turn

To rule out "session initial input is still pending" being a red herring
specific to session creation, this session's first turn (`"Reply with
exactly the single word: ready"`) was allowed to finish (session back to
`idle`), then a second turn was started via `events.create` ("Count slowly
from 1 to 40..."), and a third message ("reply with the single word pong")
was sent ~2s later, while turn 2 was in progress.

Raw response to the probe input, verbatim:
```
status: 202
(empty body)
```

Ordered event stream (189 raw events, deltas collapsed):

```
+5019ms  agent.session.turn.created   turn=T2 status=queued
+7037ms  agent.session.in_progress
+7357ms  reasoning_summary_part.added / 40× reasoning_summary_text.delta / .done   turn=T2
+7528ms  item.added, content_part.added
+7528..7529ms  40× output_text.delta ("1".."40")   turn=T2
+7529ms  output_text.done / content_part.done / item.done
+7530ms  agent.session.turn.completed   turn=T2 status=completed
+7775ms  agent.session.idle
+9809ms  agent.session.turn.created   turn=T3 status=queued        ← the probe's turn
+11676ms agent.session.in_progress
+12130ms agent.session.turn.in_progress   turn=T3
+12130ms  output_text.delta "pong"
+12130ms  output_text.done / content_part.done / item.done
+13992ms agent.session.turn.completed   turn=T3 status=completed
+14388ms agent.session.idle
```

The probe input was accepted (`202`), was **not** merged into turn 2's
output (turn 2 completed with only the count 1–40, nothing else), and
produced its own distinct turn (`T3`, a new `turn_id`) that started only
after turn 2 finished and answered exactly what the probe asked ("pong").
That is: durably queued and dispatched in order, once the current turn
frees up.

### Conclusion

On OpenAI's Agents API, what happens to a second input sent while a turn is
in progress **depends on which turn it is**: input arriving while the
session's very first turn is in progress is rejected outright with `409
conflict_error` ("session initial input is still pending"), a side effect
of a `type: "none"` session requiring its initial input at creation time
and treating that whole window as a single atomic unit; input arriving
while any subsequent, ordinary turn is in progress is accepted (`202`) and
silently queued as a new turn, dispatched immediately after the current one
completes, never merged and never lost. Neither behavior is documented
anywhere in the public docs or the SDK's type definitions — both had to be
found empirically, and they are inconsistent with each other for what looks
from the outside like the same call (`events.create` with a `message`
event) hitting the same session state (`status: "in_progress"`).

Compared to agentproto: `POST /sessions/:id/prompt?wait=false` mid-turn
rejects with `409 "is mid-turn"` unless the caller passes `queue: true`, in
which case it always returns `202` and durably queues regardless of turn
number (docs/DAEMON-NOTES.md, "Queue behaviour"). OpenAI has no equivalent
opt-in flag — the queuing behavior Rendez-vous depends on only shows up by
accident, on turns 2 and later, and is absent on turn 1.
