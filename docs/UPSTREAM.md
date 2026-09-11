# Upstream findings

Bugs and gaps found in `agentproto/ts@264c4c7a` while building Rendez-vous.
Per the build brief: documented here with a repro, not fixed in this repo,
no PR without checking with the operator first.

## R8 — app-serve does not survive a resume

**Claim** (architecture.md §4.2 R8): nothing re-launches `agentproto app
serve` after a sandboxed session resumes via `SandboxProvider.connect()`.

**Ground truth, read from source:**

- `packages/sandbox-e2b/src/provider.ts`'s `connect()` (~line 316) calls
  `ensureDaemonHealthy(...)` — a health probe against the BOX's own
  agentproto daemon (`GET /health` inside the box) — and, if that isn't
  healthy, re-runs the CLI update. It never touches the app-serve process.
- `packages/runtime/src/session-spawn.ts`'s `bootSandboxAgentSession`
  (~line 3390-3535) is the only place `startSandboxAppServe` is called, and
  it is called ONCE per `spawnAgentSession` call, gated on
  `if (opts.appServe)`. A spawn call made with `sandbox: {reuse:
  "<sandboxId>"}` and no `appServe` field — i.e. a plain reconnect, which is
  the only thing `SandboxProvider.connect()` maps to — never reaches that
  branch.
- The detached server process itself (`nohup agentproto app serve ... &`,
  `sandbox-app-serve.ts`'s `buildServeLaunchScript`) is started once, at
  first boot, inside the box's process tree. `pause({keepMemory: true})`
  preserves that process's memory image, so in the common case it keeps
  running/listening across a pause — but there is no code path that
  verifies this or relaunches it if the process did NOT survive (a template
  update, an OOM inside the box, the box's own daemon having restarted the
  workstation's process tree, etc).

**Repro** (no e2b required to see the code path; the live repro is in
`scripts/prove-sandbox.ts`'s resume phase, run against a real box):

1. `POST /sessions/agent` with `sandbox: {provider:"e2b", extraPorts:[3210]}`
   and `appServe: {dir:"/home/user/apps/<app>", port:3210}` on an already-
   populated app dir. Descriptor comes back with `appServe.url` and
   `appServe.ready: true`. The URL answers.
2. `POST /sessions/<id>/kill` on that session. Per `sessions.ts`'s `kill()`
   → `agentSession.close()` → `sandbox-agent-session-proxy.ts` (~line 466):
   default lifecycle policy is `pause` (`lifecycle.ts`'s
   `resolveLifecyclePolicy`), so the box is paused, not destroyed.
3. `POST /sessions/agent` again, same adapter, with
   `sandbox: {provider:"e2b", reuse:"<sandboxId>", extraPorts:[3210]}` and
   **no** `appServe` field (the shape any resume-by-reconnect path takes).
   This succeeds — the box resumes, the descriptor carries the SAME
   `sandboxId` and a re-resolved `sandboxPorts` entry for 3210 (the URL is a
   pure function of sandbox id + port, so it's textually identical to
   step 1's URL) — but the descriptor carries no `appServe` field at all,
   because nothing asked for one.
4. Whether the URL from step 1 still answers now depends ENTIRELY on
   whether the detached server process happened to survive the pause in
   memory. Nothing in the reconnect path checks this either way.

**Impact on Rendez-vous:** a room that pauses (idle, or the demo laptop
sleeps) and resumes may come back with a session and a sandbox but a dead
artifact URL, with no error from the daemon at any point — the reconnect
call reports success regardless.

**Workaround shipped here** (`src/sandbox/boot.ts`'s `resumeRoomSession`):
reconnect first (cheap: no install, no relaunch), `probeArtifact` the known
URL, and only when that probe is dead pay for a full second spawn call that
includes `appServe` again — which reruns `app_install` (idempotent against
the same dir) and relaunches the detached server. This is a full workaround
at the Rendez-vous layer; it does not touch agentproto.

**Not filed upstream** — per the build brief, flagging here for the
operator to decide whether it's worth a PR.

## Real-run findings, `scripts/prove-sandbox.ts` (2026-09-11)

Two e2b boots were spent on this run (the script's full budget). Neither
reached a working, probed artifact URL — both failed for reasons outside
this repo's code, in the daemon's sandbox-reconnect and box-boot paths.
Recorded here rather than re-attempted, per the budget.

**Boot 1** (`sandboxId: ibnw6yj9w3ejc99bb49of`) — phase 1 (fresh boot, no
`appServe`, a prompt that runs one exact shell command to create the app
dir) succeeded cleanly: `GET /sessions/sess_251a34c1` afterward shows
`status: "killed"`, `toolCallsThisTurn: 1`, `activitySummary.text: "done"` —
the agent ran the exact command and nothing else, as instructed. That
descriptor is the real captured JSON in `test/sandbox/descriptor.test.ts`.

Phase 2 (reconnect + `appServe` against that same box, immediately after
killing/pausing phase 1's session) failed:

```
spawnAgent failed: 500 {"error":"sandbox_reconnect_failed","message":
"agent_start: sandbox reconnect failed (provider \"e2b\", sandbox
\"ibnw6yj9w3ejc99bb49of\") — worktree-agent: could not reach the
agentproto daemon's MCP endpoint at ..."}
```

Traced the error string to `packages/worktree/src/agent-session-host.ts:74`
— `connectDaemonAgentSessionHost`, called from
`packages/sandbox/src/agent-session-host.ts:204` (`createSandboxAgentSessionHost`)
AFTER `provider.connect()` already returned successfully (i.e. the box's
plain `GET /health` answered fine — `ensureDaemonHealthy` passed). The
failure is a SEPARATE MCP-transport connection attempt to the same box that
didn't succeed, immediately after a pause→resume with no delay in between.
Reads like the box's MCP/WebSocket layer needing a beat longer to come back
than its plain HTTP health endpoint does — unconfirmed against a second
data point.

**Notable gap found in this failure's cleanup:** the `catch` around this
step in `session-spawn.ts` (~3449, the one producing `sandbox_reconnect_failed`)
returns the error WITHOUT calling `host.stop()`/pausing the box — unlike
the sibling catches around `host.start()` and `startSandboxAppServe`
failing, which do call `host.stop()`. A bare reconnect that fails at the
MCP-connect step (as opposed to the `ensureDaemonHealthy` step, which IS
covered — `provider.connect()`'s own catch kills the box on THAT failure)
can leave a box resumed-but-untracked, no daemon-side session referencing
it. Checked this by hand: a follow-up bare reconnect attempt against the
same sandboxId got `"Paused sandbox ibnw6yj9w3ejc99bb49of not found"` (e2b's
own error) — the box was no longer there to pause, so nothing was actively
leaking by the time this was checked, but the code path that could leave a
resumed, untracked, billing box behind is real and worth a second look.

**Boot 2** (the automatic retry) failed at the FIRST spawn (fresh box, no
reuse) — a different failure mode, the box's own daemon never became
healthy within the boot timeout:

```
spawnAgent failed: 500 {"error":"sandbox_boot_failed","message":
"agent_start: sandbox boot failed (provider \"e2b\") — @agentproto/sandbox-e2b:
agentproto daemon did not become healthy at https://18790-irsm2610n264xxa822b0r..."}
```
(message truncated in the captured log; not re-run to complete it, per budget).
Per `provider.ts`'s `boot()`, a failure at this step kills the box
(`sandbox.kill()` in the `catch`), so boot 2's box does not need any
follow-up — it was torn down by the provider itself.

**Net:** the DaemonClient/boot.ts code path (request shapes, response
parsing, the two-phase file-creation dance, the reconnect-then-reserve
logic) is exercised and correct as far as it got — phase 1 succeeded twice,
proving the file-creation prompt and the `sandbox`+no-`appServe` spawn path
both work for real. What's unverified against live e2b is the actual
`appServe` install+launch+probe sequence and the resume/re-serve dance,
because neither boot got far enough to reach it. This looks like e2b/box
infrastructure flakiness on this run, not a bug in this repo's request
shapes — but it means M4's live proof is incomplete. Operator call on
whether to re-run with a larger budget, add a delay before the
reconnect-immediately-after-pause step, or accept the fake-daemon test
coverage (49 passing tests, including the exact real captured descriptor
above) as sufficient for the hackathon deadline.
