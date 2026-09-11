# Upstream findings — for the agentproto maintainers

Findings from building Rendez-vous, a host application that drives an
unmodified `agentproto/ts@264c4c7a` daemon over its public HTTP surface (no
fork, no vendored copy — see `docs/ARCHITECTURE.md` §3). Every claim below
was verified independently at its cited `file:line` in the read-only
checkout, not taken on faith from an earlier note. Nothing here has been
opened as a PR; per this project's build brief, these are documented for
the operator/maintainers to triage. Raw run logs and curl transcripts
backing the M4 entries live in `docs/UPSTREAM-LOGS.md` — this file is
self-contained without them.

## Summary

| # | Title | Severity | Status |
| --- | --- | --- | --- |
| 1 | `POST /sessions/:id/prompt` mid-turn loses a message without `queue:true`, and the daemon's own inbound router never passes it | High — silent data loss | Documented |
| 2 | `agentproto app serve` hardcodes the UI path, ignoring APP.md's `ui.path` that `app_install` honours | Medium — silent failure (URL never serves, no error anywhere) | Documented |
| 3 | e2b reconnect failure (MCP-connect step) doesn't pause the box on error, unlike sibling failure paths | Medium — cost leak risk | Documented |
| 4 | `POST /mcps/proxy/call` has no auth gate, unlike neighboring mutating routes | High — security | Documented |
| 5 | A spawn already in flight server-side keeps running after the requesting client disconnects | Low — operational/budgeting | Documented |

---

## 1. Mid-turn prompt loss without `queue: true`

**Summary.** `POST /sessions/:id/prompt?wait=false` on a busy session throws
a mid-turn rejection unless the caller passes `queue: true` — that part is
correct and by design. The problem is one level up: the daemon's own
built-in inbound message router never sets that flag, so any host that
routes provider webhooks through it (the shipped default) silently drops
one side of a two-people-talking-at-once race, with no error surfaced to
either sender.

**Anchors.**
- `packages/runtime/src/inbound-router.ts:92` —
  `await deps.enqueuePrompt(sessionId, msg.text)`, exactly two arguments:
  no `queue`, no `origin`, no way to opt in from this call site.
- `packages/runtime/src/sessions.ts:4815` — the throw itself:
  `` `${caller}: session "${id}" is mid-turn — wait for it to finish or cancel` ``.
- `packages/runtime/src/http-server.ts`'s prompt route (`~4410-4507`) —
  where `queue`/`force`/`interrupt` are parsed from the body and honoured
  ONLY on the `?wait=false` arm; the blocking arm has no opt-in at all.

**Repro.** `scripts/prove-queue.ts` in this repo: spawns a session with a
slow prompt, fans in two more messages with `queue: true` while it's busy
(both land, in order, as `202` with `queuePosition`), then repeats without
`queue` to get the exact `409`:
```
HTTP 409
{"error":"send_prompt_failed","message":"enqueuePrompt: session \"<id>\" is mid-turn — wait for it to finish or cancel"}
```
Full request/response bodies for both arms are in `docs/DAEMON-NOTES.md`
§"Queue behaviour".

**Impact.** Any consumer of the built-in inbound router (the shipped path
from a provider webhook to a session) loses a message whenever it arrives
while the session is mid-turn — exactly the "two humans typing at once"
case, with no retry, no queued state, no error delivered anywhere. Every
caller of that router path inherits this unless they route around it (as
this repo does, calling `?wait=false&queue=true` directly instead).

**Suggested fix.** `inbound-router.ts:92`'s `routeInto` should call
`enqueuePrompt(sessionId, msg.text, { queue: true, origin: ... })` instead
of the bare two-argument form — the queueing mechanism it needs already
exists and is exercised correctly elsewhere in the same codebase.

---

## 2. `agentproto app serve` ignores APP.md's `ui.path`

**Summary.** `app_install` (`loadAppHandle`) reads an app's `ui.path`
frontmatter field to find its UI file — any relative path validates and
installs. `agentproto app serve`'s own CLI command reads no such field: it
hardcodes the UI directory as `<appDir>/.agentproto/ui/` and exits with an
error if nothing is there, regardless of what `ui.path` says. An app whose
UI lives anywhere else installs successfully and then never serves
anything — the daemon's own readiness probe correctly reports `ready:
false`, but nothing upstream of that treats install-success-plus-serve-
never-answering as an error worth surfacing loudly.

**Anchors.**
- `packages/app-kit/src/load-app.ts:251` — `resolveRef(dir, fm.ui.path)`,
  reading the frontmatter path.
- `packages/cli/src/app-serve.ts:1077-1078` — `const uiRoot = join(appDir,
  ".agentproto", "ui")`, hardcoded, no reference to `fm.ui.path` anywhere in
  this file.
- `packages/cli/src/app-serve.ts:1086-1089` — the resulting error:
  `` `agentproto app serve: ${appDir} has no UI to serve (missing ${uiRoot}).` ``.
- `packages/runtime/src/sandbox-app-serve.ts`'s `buildServeLaunchScript` —
  the detached launcher backgrounds the process and returns immediately
  (`nohup ... & echo $!`), so `command_execute`'s own exit code is `0` even
  when the backgrounded `app serve` process exits seconds later on this
  exact error — nothing at the launch step notices.

**Repro.** Install an app with `ui: { path: ui/index.html }` (UI at
`<dir>/ui/index.html`) via `app_install` — succeeds. Then
`agentproto app serve <dir>` (or `appServe` on `agent_start`) — the
detached process writes the "has no UI to serve" message + its own usage
text to `<dir>/.agentproto/app-serve.log` and exits; the readiness probe
times out (`ready: false`); the returned URL 502s at the provider edge
("The sandbox is running but port is not open" on e2b). Full transcript in
`docs/UPSTREAM-LOGS.md`.

**Impact.** Any agentproto app whose UI isn't already at the hardcoded
`.agentproto/ui/` path — which is legal per the schema and per
`app_install`'s own validation — silently fails to serve, with a URL that
looks valid and a descriptor that claims success. Discovered in this repo
only by reconnecting to a live box and reading its log file by hand.

**Suggested fix.** Either `app serve` should resolve the UI directory from
the installed app's own `ui.path` (consistent with `app_install`), or
`app_install` should reject/relocate a UI that isn't already at the
hardcoded path so the mismatch surfaces at install time instead of at
serve time.

---

## 3. e2b reconnect failure doesn't pause the box

**Summary.** A sandboxed spawn with `sandbox.reuse` set that fails during
the box's own `agent_start`/`startSandboxAppServe` steps gets cleaned up
(`host.stop()`) before the error returns. A failure one step earlier — the
MCP-transport connect inside `createSandboxAgentSessionHost`, which is what
`sandbox_reconnect_failed` most often reports — does not: the box is left
however `provider.connect()` left it (resumed, not paused), with no
daemon-side session tracking it.

**Anchors.**
- `packages/runtime/src/session-spawn.ts:3436-3465` — the `try/catch`
  around `createSandboxAgentSessionHost`; the `catch` (~3449) returns
  `{ ok: false, code: "sandbox_reconnect_failed", ... }` with no `host.stop()`
  or pause call, unlike the sibling catches around `host.start()` (~3496)
  and `startSandboxAppServe` failing (~3512), which both call
  `host.stop()`.
- `packages/sandbox-e2b/src/provider.ts:233-246` — `ensureDaemonHealthy`'s
  own failure path (a distinct, earlier step) IS covered: `provider.ts`'s
  `connect()`/`boot()` kill the box in their own `catch` when THIS step
  throws.
- `packages/sandbox/src/agent-session-host.ts:204` — where the uncovered
  MCP connect (`connectDaemonAgentSessionHost`,
  `packages/worktree/src/agent-session-host.ts:65-81`) happens, after
  `provider.connect()` already returned successfully.

**Repro.** Pause a sandboxed session (`POST /sessions/:id/kill`, default
lifecycle is pause — `packages/sandbox/src/lifecycle.ts`'s
`resolveLifecyclePolicy`), then immediately reconnect
(`sandbox.reuse: "<id>"`, no delay). Ground-truthed live in this repo: the
MCP connect step failed once with this exact shape (transcript in
`docs/UPSTREAM-LOGS.md`); the daemon's `sandbox_reconnect_failed` response
carried no indication the box had been left running.

**Impact.** A caller that treats `sandbox_reconnect_failed` as "nothing
happened, safe to retry with a fresh boot" can leak a running (billed) e2b
box with no daemon-side record of it — the only way to find it afterward is
the provider's own dashboard/CLI, not `agentproto sandbox list` if the
ledger entry itself is stale.

**Suggested fix.** Wrap the `createSandboxAgentSessionHost` call's failure
path with the same `host.stop()`-on-error contract its sibling catches
already have, OR have `provider.connect()` itself own cleanup on ANY
downstream failure in the same boot sequence, not just its own
`ensureDaemonHealthy` step.

---

## 4. `POST /mcps/proxy/call` has no auth gate

**Summary.** Unlike every neighboring mutating route in the same file,
`POST /mcps/proxy/call` — which invokes an arbitrary tool on any already-
imported MCP server, including one holding real third-party credentials —
calls neither `checkSessionsToken` nor any `authorize()`/rejection path
before executing. Anyone who can reach the daemon's HTTP port can drive any
imported MCP tool with zero token.

**Anchors.**
- `packages/runtime/src/http-server.ts:2371-2404` — the handler itself:
  parses `{ alias, toolName, args }` and calls
  `opts.mcpProxy.callTool(body.alias, body.toolName, body.args ?? {})`
  directly, no auth check anywhere in the block.
- Compare `packages/runtime/src/http-server.ts:2130`, `:2200`, `:2237` —
  the three `/workspaces*` mutating routes in the SAME file, each opening
  with `const gate = checkSessionsToken(req); if (gate !== "ok") { ... return }`
  before doing anything else.
- The sibling GET routes `/mcps/proxy/status` (`:2335`) and
  `/mcps/proxy/tools/:alias` (`:2356`) are also ungated, consistent with
  other read-only routes in this file — `/mcps/proxy/call` is the one that
  actually executes an action and is the only one of the three worth
  flagging.

**Repro.** `curl -X POST http://<daemon>:18790/mcps/proxy/call -d '{"alias":"<imported-alias>","toolName":"<tool>","args":{}}'` — no
`Authorization` header sent, no token required, same as the two read-only
neighbors above but for a route that has side effects.

**Impact.** Any MCP server a daemon operator has imported (agentpush,
anything else) is reachable and callable by anyone who can reach the
daemon's HTTP port, with none of the credential the import itself is meant
to gate. Same class of gap as `docs/ARCHITECTURE.md`'s R6 (no
multi-principal scoping on the daemon surface), but sharper here — it
doesn't even need a paired-laptop bearer, just network reachability.
Investigated and written up in full in this repo's `docs/AGENTPUSH.md` §6
(ranking direct-REST vs. this proxy for outbound messaging); re-verified
independently at the anchor above before including it here.

**Suggested fix.** Add the same `checkSessionsToken`/`authorize()` gate its
three `/workspaces*` neighbors already have to `POST /mcps/proxy/call` (and
arguably to the two GET routes, for consistency, though they're lower
stakes).

---

## 5. A disconnected client can't cancel a spawn already in flight

**Summary.** `spawnAgentSession` runs entirely server-side inside the
daemon process; nothing about it is tied to the requesting HTTP client
staying connected. A client that decides "stop, don't spawn any more"
(e.g. a boot-budget guard) and kills its own process cannot cancel a
request already sent — the daemon keeps executing it to completion
regardless.

**Repro.** Ground-truthed live in this repo (`docs/UPSTREAM-LOGS.md`,
"second live attempt"): killing the local `node` process (`kill -9`) right
as it decided to retry with a fresh boot still let that boot complete
server-side, one box over the caller's intended budget.

**Impact.** Any client-side request budget (boot count, cost cap, rate
limit) enforced by "don't send the next request" has a race window: once a
request is sent, no client-side action can stop it from completing and its
side effects (an e2b box, in this case) from existing. Not a bug in the
strict sense — this is normal request/response semantics — but worth
knowing before building budget enforcement that assumes a client kill is
sufficient.

**Suggested fix.** None expected from agentproto; this is a caller-side
design note; a hard budget needs a server-side cap (or a pre-flight check
before the request that would exceed it goes out), not a client-side kill
after the fact.
