# Daemon round trip — verified notes

Ground-truthed against a live daemon at `http://127.0.0.1:18790`, version
`0.20.0`, build `264c4c7a`. Verified by running `scripts/probe-daemon.ts` and
a set of `curl` probes against the routes it depends on, cross-checked
against `packages/runtime/src/http-server.ts` in the read-only agentproto
checkout. No token values appear below.

## Auth

The daemon runs in `bearer` mode. The bearer lives in
`/Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/.agentproto/runtime.json`,
field `token`. Read it with:

```
node -p 'require(".../.agentproto/runtime.json").token'
```

Pass it as `authorization: Bearer <token>` on every mutating `/sessions/*`
call. `GET /sessions/:id/events` and `.../events/stream` are read-only and
carry no auth gate (`http-server.ts` comment above the stream route: "Read-only
GET, no auth gate (same policy as /events)"), but the probe sends it anyway
since a future daemon config could require it.

In this repo, `RDV_DAEMON_TOKEN` is the only env var that carries it, read
exclusively by `src/env.ts` (`env.daemonToken`), per the "typed env module"
constraint. Never read `process.env` elsewhere.

## Route 1 — `GET /health`

Request: no body, no auth required.

Observed response:

```json
{
  "status": "ok",
  "workspace": "/Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio",
  "registered": ["driver"],
  "uptimeMs": 2308353,
  "startedAt": "2026-09-11T20:20:47.431Z",
  "version": "0.20.0",
  "build": { "sha": "264c4c7a", "builtAt": "2026-09-11T11:59:02.369Z", "source": "workspace" },
  "pid": 1076,
  "node": "/Volumes/.../node",
  "entry": "/Volumes/.../cli.mjs",
  "resumeSessionsOnBoot": true,
  "idleReapAfterMs": 7200000,
  "crashDetectIntervalMs": 30000,
  "restartSweepIntervalMs": 0,
  "turnStallAfterMs": 300000
}
```

The probe only reads `status`, `version`, `build.sha`.

## Route 2 — `POST /sessions/agent`

Spawns a long-running agent session (`http-server.ts:4013`, delegates to
`spawnAgentSession`). Requires the bearer.

Request body sent by the probe:

```json
{
  "adapter": "claude-code",
  "model": "claude-sonnet-5",
  "cwd": "<probe cwd>",
  "label": "rdv-probe",
  "prompt": "Reply with exactly the single word: pong",
  "dedupe": false
}
```

Response is `201` with the full session descriptor spread (`json(201, {
...result.descriptor, ... })`) — far richer than the two fields the probe
actually validates (`id`, `status`). Observed fields worth knowing about for
the fan-out executor:

```json
{
  "id": "sess_a54ac26f",
  "kind": "agent-cli",
  "workspaceSlug": "default",
  "command": "npx -y @agentclientprotocol/claude-agent-acp@0.75.1",
  "pid": 35145,
  "status": "running",
  "startedAt": "2026-09-11T21:00:22.340Z",
  "adapterSlug": "claude-code",
  "resumable": true,
  "adapterSessionId": "24cad7f7-...",
  "label": "rdv-probe-tool",
  "mcpServers": [{ "name": "agentproto", "transport": "http", "ref": "http://127.0.0.1:18790/mcp?callerSessionId=sess_a54ac26f" }],
  "model": "claude-sonnet-5",
  "eventsPath": "/Users/.../sessions/sess_a54ac26f/events.jsonl",
  "busy": true,
  "awaitingInput": false,
  "queuedPrompts": 0
}
```

Errors: `400` for `missing_adapter`/`invalid_body`, `404` for
`adapter_not_found`/`no_cwd`, `501` for orchestrator-related failures not
relevant here. The probe's `isSpawn` guard (`id`, `status` both strings) is
enough to keep going; it deliberately doesn't type the rest of the
descriptor since the probe doesn't use it.

## Route 3 — `GET /sessions/:id/events/stream?since=<seq>`

SSE. One `data:` frame per transcript record, replay-then-subscribe with no
gap and no duplicate (`deliverRecordsExactlyOnce`). `since=0` replays the
whole transcript from the start; a client that persisted the last `seq` it
saw can resume with `since=<that seq>` after a restart with no re-delivery.

Frames observed, in order, for a plain single-turn prompt with no tool use
(`sess_3ee58411`, prompt "Reply with exactly the single word: pong"):

```json
{"seq":1,"ts":"...","kind":"system-prompt","sessionId":"sess_3ee58411","text":"You are the supervisor..."}
{"seq":2,"ts":"...","kind":"user-prompt","sessionId":"sess_3ee58411","text":"Reply with exactly the single word: pong"}
{"seq":3,"ts":"...","kind":"available-commands","sessionId":"sess_3ee58411","commands":[...]}
{"seq":4,"ts":"...","kind":"usage_update","sessionId":"sess_3ee58411","size":200000,"used":30846}
{"seq":5,"ts":"...","kind":"text-delta","sessionId":"sess_3ee58411","text":"pong"}
{"seq":6,"ts":"...","kind":"usage_update","sessionId":"sess_3ee58411","size":200000,"used":30849}
{"seq":7,"ts":"...","kind":"usage_update","sessionId":"sess_3ee58411","size":1000000,"used":30849,"cost":{"amount":0.0545326,"currency":"USD"}}
{"seq":8,"ts":"...","kind":"turn-end","sessionId":"sess_3ee58411","reason":"completed"}
{"seq":9,"ts":"...","kind":"usage_snapshot","sessionId":"sess_3ee58411","model":"claude-sonnet-5","costUsd":0.0545326,"contextSize":1000000,"contextUsed":30849,"source":"adapter"}
```

For a prompt that invokes a tool (`sess_a54ac26f`, "Run `echo hi` using your
bash tool"), the extra kinds seen mid-turn:

```json
{"seq":5,"kind":"tool-call","toolCallId":"toolu_01PJ...","toolName":"Terminal","arguments":{}}
{"seq":6,"kind":"tool-call","toolCallId":"toolu_01PJ...","toolName":"echo hi","arguments":{"command":"echo hi","description":"Echo hi"},"isUpdate":true}
{"seq":8,"kind":"tool-result","toolCallId":"toolu_01PJ...","result":"hi","isError":false}
{"seq":9,"kind":"tool-call-record","tool":"echo hi","command":"echo hi","isError":false,"durationMs":1692}
```

Notes for R1 (fan-out — architecture §5.2):

- The reply text is the concatenation of every `text-delta.text` between a
  `user-prompt` and the next `turn-end`, exactly as the probe does. There is
  no single "final reply" record; `turn-end` itself carries no text, only
  `{sessionId, reason, ts, seq}` (plus optional `awaitingInput`, `label`,
  `question`, `empty` per the architecture doc's R1 note — not present on a
  plain completed turn).
  - `reason` values observed: `"completed"`. Other values (e.g. from an
    interrupted or errored turn) were not exercised by this probe.
  - `tool-call` fires twice per tool invocation in the observed case: once
    with the raw ACP tool name and empty `arguments` (the "started" event),
    once immediately after with `isUpdate: true` carrying the resolved
    arguments. A fan-out consumer that only cares about text should ignore
    `kind !== "text-delta" && kind !== "turn-end"` entirely; it never needs
    to special-case tool records.
  - `usage_update` and `usage_snapshot` fire on essentially every step and
    are noise for fan-out purposes.
- Cursor semantics: persist the `seq` of the last record you have durably
  handled (the probe calls this "cursor to persist"). Reconnecting with
  `?since=<that seq>` after a daemon or service restart replays everything
  after it, nothing before it, nothing twice.
- A 404 `{"error":"no_transcript"}` means the session id has no
  `events.jsonl` yet (never spawned, or already garbage collected).

`GET /sessions/:id/events?since=<seq>` (no `/stream`) is the same record
shape as a one-shot poll: `{sessionId, events, nextSeq, complete}`, capped at
an internal `limit` with `complete: false` if truncated. Same cursor
(`nextSeq`) semantics as the SSE `seq`. Useful for a first poll before
upgrading to SSE, but the probe only uses the stream route.

## Queue behaviour (R3, architecture §4.2 / §5.1)

Verified against a fresh session (`sess_3765c00f`) mid-turn on "Count slowly
from 1 to 30, one number per line."

1. **First queued prompt while busy**, `POST /sessions/:id/prompt?wait=false`
   with `{"prompt":"Queued message A","queue":true}`:

   ```
   HTTP 202
   {"ok":true,"id":"sess_3765c00f","queued":true,"pending":true,"queueId":"q_731a4748","queuePosition":1}
   ```

2. **Second queued prompt**, same shape, `{"prompt":"Queued message B","queue":true}`:

   ```
   HTTP 202
   {"ok":true,"id":"sess_3765c00f","queued":true,"pending":true,"queueId":"q_68acd570","queuePosition":2}
   ```

   `queuePosition` is 1-indexed and reflects FIFO order at the moment of
   admission (`registry.get(id).promptQueue.findIndex(...) + 1`).

3. **Third prompt, same session, still busy, `queue` omitted** (i.e. the
   built-in default path the router in §4.2/R3 warns about):

   ```
   HTTP 409
   {"error":"send_prompt_failed","message":"enqueuePrompt: session \"sess_3765c00f\" is mid-turn — wait for it to finish or cancel"}
   ```

This confirms R3 exactly as the architecture doc states it: the only
difference between "silently lost" and "durably queued" is one boolean,
`queue: true`, on the fire-and-forget (`?wait=false`) arm of
`POST /sessions/:id/prompt`. The blocking arm (`wait=true`, the default)
does not support `queue`/`force` at all — a blocking caller always gets the
same 409 mid-turn rejection with no way to opt in, per the comment in
`http-server.ts` above the `else` branch of the prompt route. Rendez-vous's
fan-in must always call with `?wait=false` and `queue: true`.

## Session teardown

**Correction (found during M4):** `DELETE /sessions/:id`
(`http-server.ts:5444`) → `registry.forget(id)` (`sessions.ts:7796`) →
`200 {"ok":true,"id":"<id>"}` if it existed, `404` otherwise. Bearer
required. But `forget` ONLY drops the daemon's bookkeeping row (it tears
down the transcript writer and removes the map entry) — it never calls the
live `agentSession.close()`. It does **not** terminate the underlying
process, and for a sandboxed session it does **not** pause or kill the
box. Using `DELETE` alone to "clean up" a throwaway session — which is
what the M1/M2 probe scripts in this repo did — leaks the underlying
process/sandbox; the daemon just stops tracking it.

The route that actually tears down is `POST /sessions/:id/kill`
(`http-server.ts:5394`) → `registry.kill(id)` (`sessions.ts:7415`) →
`200 {"ok":true,"sessionId":"<id>"}` if it was alive, `404` otherwise.
`kill` calls `agentSession.close()` (SIGTERM on a local child; for a
sandboxed session, `sandbox-agent-session-proxy.ts` closes the remote
session then pauses the box by default — `lifecycle.ts`'s
`resolveLifecyclePolicy`, pause unless the spec declares `destroy_on`).
**Use `POST /sessions/:id/kill`, not `DELETE`, to actually end a session** —
`src/daemon/client.ts`'s `DaemonClient.kill()` does this. See
`docs/UPSTREAM.md` #3 for a related gap: this pause-by-default path is
itself NOT reached on every failure mode of a sandboxed reconnect.

`GET /sessions` (no id) lists every known session with `id`, `status`,
`label` among other descriptor fields — useful to confirm a session is gone
from the registry, but note that alone doesn't prove the underlying
process/sandbox was torn down (see the correction above) — only that the
daemon stopped tracking it.

## Summary for the fan-out executor

- Reply assembly: buffer `text-delta.text` per session between `user-prompt`
  and `turn-end`; flush on `turn-end`.
- Cursor: persist `seq` of the last record consumed; resume with
  `?since=<seq>`.
- Ignore `usage_update`, `usage_snapshot`, `available-commands`,
  `system-prompt`, `tool-call`, `tool-result`, `tool-call-record` unless you
  specifically want tool activity in a tier-3 transcript view.
- Fan-in must use `POST /sessions/:id/prompt?wait=false` with
  `{"prompt": ..., "queue": true}` — never the default blocking route, never
  `wait=false` without `queue`.
