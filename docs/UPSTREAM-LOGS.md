# Upstream findings — raw run logs

Detailed, chronological run narratives behind `docs/UPSTREAM.md`. Kept
separate so the maintainer-facing doc stays short; nothing here is needed
to understand or reproduce a finding — `docs/UPSTREAM.md` is self-contained
for that. This is the "show your work" backing material.

## M4 first live attempt (2026-09-11) — R8 and the reconnect-cleanup gap

Two e2b boots (`ibnw6yj9w3ejc99bb49of`, then a retry). Boot 1's phase 1
(fresh boot, no `appServe`, a prompt running one exact shell command to
create the app dir) succeeded: `GET /sessions/sess_251a34c1` afterward
showed `status: "killed"`, `toolCallsThisTurn: 1`,
`activitySummary.text: "done"` — real captured descriptor now in
`test/sandbox/descriptor.test.ts`.

Phase 2 (reconnect + `appServe` on that box, immediately after
killing/pausing phase 1's session) failed:

```
spawnAgent failed: 500 {"error":"sandbox_reconnect_failed","message":
"agent_start: sandbox reconnect failed (provider \"e2b\", sandbox
\"ibnw6yj9w3ejc99bb49of\") — worktree-agent: could not reach the
agentproto daemon's MCP endpoint at ..."}
```

Traced to `packages/worktree/src/agent-session-host.ts:74`
(`connectDaemonAgentSessionHost`), called from
`packages/sandbox/src/agent-session-host.ts:204`
(`createSandboxAgentSessionHost`) AFTER `provider.connect()` already
returned successfully — a separate MCP-transport connect attempt, right
after a pause→resume with zero delay in between. Un-repeated against a
second data point in this run (the second live attempt below never hit it
again, because it never paused before reconnecting).

Checked the cleanup by hand: a follow-up bare reconnect attempt against the
same sandboxId got `"Paused sandbox ibnw6yj9w3ejc99bb49of not found"`
(e2b's own error) — gone by TTL/GC, nothing left running at that point.

Boot 2 (automatic retry) failed at the very first spawn — a different
failure mode entirely:

```
spawnAgent failed: 500 {"error":"sandbox_boot_failed","message":
"agent_start: sandbox boot failed (provider \"e2b\") — @agentproto/sandbox-e2b:
agentproto daemon did not become healthy at https://18790-irsm2610n264xxa822b0r..."}
```

(message truncated in the captured log). Per `provider.ts`'s `boot()`, a
failure at this step kills the box in its own `catch`, so no follow-up
cleanup was needed for boot 2's box.

## M4 amendment, second live attempt (2026-09-12) — the real root cause

New budget: 3 fresh boots, reconnects free. `resumeRoomSession` gained a
built-in retry (4 attempts, 10s apart) for `sandbox_reconnect_failed`.

Step 0 (free): `ibnw6yj9w3ejc99bb49of` was gone — `"Paused sandbox ... not
found"`, as expected.

Step 1, boots 1–3: fresh boot, phase-1 session left ALIVE, phase-2
`reuse`+`appServe` on that still-booted (never paused) box. Reuse itself
worked every time, first try, no `sandbox_reconnect_failed` at all
(unsurprising — nothing had paused). But all three boots hit the identical
symptom: `appServe.ready: false`, and fetching the URL returned e2b's own
edge error:

```json
{"sandboxId":"<id>","message":"The sandbox is running but port is not open","port":3210,"code":502}
```

Process note: stopping the script via `kill -9` on the local `node`
process does NOT cancel a spawn already in flight server-side — a 4th box
(`isdcltsb8oxiyq7plv8ga`) got created despite the kill signal, landing one
over the stated 3-boot budget for that run. Caught via
`agentproto sandbox list --json` and paused by hand.

Isolated the cause by hand, for free: reconnected to a paused box
(`iysytdsb9grusftw4u9bw`) whose phase-1 session had been dead for minutes,
re-ran the same `appServe` sequence — `artifactReady: false` again,
identical 502. Ruled out concurrency.

Found the actual cause by reconnecting once more and having the agent
`cat` `<appDir>/.agentproto/app-serve.log`:

```
agentproto app serve: /home/user/apps/rdv-hello has no UI to serve (missing /home/user/apps/rdv-hello/.agentproto/ui).
```

— finding #2 in `docs/UPSTREAM.md`. Fixed and verified live with two more
free reconnects on the same box (no new boot): `artifactReady: true`,
`probeArtifact` → `alive`, direct `fetch` → `200` with the real
`window.McpApp` bridge HTML. Then proved the full pause→wait 20s→resume
cycle on that same, now-working box: reconnected, found the artifact still
alive (no re-serve needed), final session killed, box left paused.

Boots used that round: 4 of a 3 budget (the `kill -9` race above). All
boxes from both sessions confirmed `paused` in the ledger afterward — none
left running.

## M4 amendment, deterministic install (2026-09-12) — clean first try

Ranked `setupCommands`-based deterministic seeding over the two-spawn
approach (see `docs/ARTIFACT.md`) and rebuilt `bootRoomSession`/
`resumeRoomSession` around it. Live run:

```
step 0: ledger box came back — sessionId=sess_79559c5c sandboxId=iysytdsb9grusftw4u9bw
step 1: first spawn — sessionId=sess_049b952e sandboxId=i86kacltf9lzeso7maeua artifactReady=true
step 1: probe (fresh boot) = alive; fetch status=200
step 1: live-reuse spawn — sessionId=sess_9956f297 sandboxId=i86kacltf9lzeso7maeua artifactReady=true
step 1: probe after killing the first session = alive
boots used: 1/3
step 2: probe before resume (box paused) = alive
step 2: resumed — artifactReady not re-served, still alive
PASS: sandbox i86kacltf9lzeso7maeua left paused for pre-warm.
```

One boot, no retries anywhere — `artifactReady: true` on the very first
call, both fresh and on reuse-against-a-live-box. Final paused sandboxes
after this run: `i86kacltf9lzeso7maeua` (this run, working) and
`iysytdsb9grusftw4u9bw` (prior run, also working) — both confirmed `paused`
in `agentproto sandbox list --json`, nothing left running/billing across
either session.
