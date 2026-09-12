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
| 1 | `POST /sessions/:id/prompt` mid-turn loses a message without `queue:true`, and both the daemon's own inbound router AND its primary agent-to-agent messaging tool (`agent_prompt`) never pass it | High — silent data loss, affects the primary agent-to-agent messaging tool, not only the inbound webhook router | Documented |
| 2 | `agentproto app serve` hardcodes the UI path, ignoring APP.md's `ui.path` that `app_install` honours | Medium — silent failure (URL never serves, no error anywhere) | Documented |
| 3 | e2b reconnect failure (MCP-connect step) doesn't pause the box on error, unlike sibling failure paths | Medium — cost leak risk | Documented |
| 4 | `POST /mcps/proxy/call` has no auth gate, unlike neighboring mutating routes | High — security | Documented |
| 5 | A spawn already in flight server-side keeps running after the requesting client disconnects | Low — operational/budgeting | Documented |
| 6 | Rendez-vous's own `E2bBooter` sent the HOST's `cwd` into the box's `agent_start`, not a path valid inside it | High — every e2b room boot 500'd | Fixed in this repo |
| 7 | A just-unpaused box's first turn can error near-instantly with no detail, invisible to the reconnect-retry contract | Medium — silent stall on resume | Documented |

---

## The pattern: plausible config, silent drop, no error anywhere

Three of the cases below read like three unrelated bugs — a missing flag, a
stale cursor, a filtered account id. They are the same class: a config or
piece of state that is completely reasonable in isolation, checked by
nothing, and the system routes around it without a stack trace, a non-2xx,
or a log line. The only symptom is a human noticing a reply never came back.

| Case | Plausible config | Silent drop |
| --- | --- | --- |
| Daemon prompt path (finding 1) | Caller omits `queue: true` on a mid-turn prompt | Both the built-in inbound router and the MCP `agent_prompt` tool never pass it either, so a mid-turn message is rejected with no error delivered to any sender |
| Resume cursor (`docs/REHEARSAL.md` finding 3, fixed in `b58de3d`) | Our fan-out reader keeps its cursor across a resume | A new session's stream renumbers from near 1; the reader waits at the old session's stale seq, so every reply after a resume vanishes |
| agentpush account-pinned inbound route | Route created with `provider_account_id` set, matching the per-account setup the provider UI encourages | `listEnabledMessagingRoutes` filters `provider_account_id IS NULL` (`packages/core/src/domain/inbound-route/repository.ts:335`, in the read-only agentpush checkout) — the route never fires; the comment above it says so: "account-pinned routes can't be honoured yet (Phase 3)" |

The hard part of multiplayer agents is not the model. It is that every one
of these fails quietly.

---

## 1. Mid-turn prompt loss without `queue: true`

**Summary.** `POST /sessions/:id/prompt?wait=false` on a busy session throws
a mid-turn rejection unless the caller passes `queue: true` — that part is
correct and by design. The problem is one level up: two of the daemon's own
built-in call sites never set that flag. The inbound message router is one
(a host routing provider webhooks through it silently drops one side of a
two-people-talking-at-once race, no error surfaced to either sender). The
MCP `agent_prompt` tool — the primary agent-to-agent messaging surface, not
a webhook edge case — is the other: an agent sending a follow-up turn to a
DIFFERENT, currently-busy session gets the request rejected outright, with
no queueing option offered at all (only `interrupt`, which cancels the
target's in-flight turn instead of waiting its turn — a different, much
more disruptive semantic). Unlike the inbound-router case, this one at
least surfaces as a visible tool error to the calling agent (`isError:
true`) rather than a true silent drop — but nothing about that response
queues or retries the prompt, so it's still lost unless the calling agent
notices the error and resends, which nothing prompts it to do.

**Anchors.**
- `packages/runtime/src/inbound-router.ts:92` —
  `await deps.enqueuePrompt(sessionId, msg.text)`, exactly two arguments:
  no `queue`, no `origin`, no way to opt in from this call site.
- `packages/runtime/src/agent-tools.ts:1157-1160` — the `agent_prompt` tool
  handler: `await registry.enqueuePrompt(sessionId, input.prompt, {
  interrupt: input.interrupt, ...(promptSource ? { source: ... } : {}) })` —
  `interrupt` is the only opt-in field this tool exposes; there is no
  `queue`. The comment immediately above (`:1140-1149`) confirms this is
  deliberate ("a session already mid-turn... surfaces here as a real tool
  error instead of a lying `{queued: true}`"), but deliberate-and-visible is
  still not the same as deliverable — the caller still has no way to ask for
  "queue it" short of dropping to the raw HTTP route below.
- `packages/runtime/src/sessions.ts:4815` — the throw both call sites
  ultimately hit: `` `${caller}: session "${id}" is mid-turn — wait for it
  to finish or cancel` ``.
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
§"Queue behaviour". The `agent_prompt` case observed live (operator report,
two drops in one session): an agent calls `agent_prompt` on a sibling/child
session that's still mid-turn from a prior instruction; the tool call
returns `isError: true` with the exact `sessions.ts:4815` message above,
and the intended follow-up instruction never reaches the target session
unless the calling agent explicitly retries it.

**Impact.** Any consumer of the built-in inbound router (the shipped path
from a provider webhook to a session) loses a message whenever it arrives
while the session is mid-turn — exactly the "two humans typing at once"
case, with no retry, no queued state, no error delivered anywhere. Every
caller of that router path inherits this unless they route around it (as
this repo does, calling `?wait=false&queue=true` directly instead). Beyond
the webhook path, `agent_prompt` — the tool every multi-agent supervision
flow uses to drive a child/sibling session — has the identical gap: a
supervisor that fires a follow-up instruction at a session it doesn't know
is still busy loses that instruction, has to notice the tool error, and
has to know to retry (nothing about the error message suggests a fix).

**Workaround (today, from this repo or any other caller).** Bypass
`agent_prompt` for the busy-target case and call the daemon's own HTTP
route directly: `POST /sessions/:id/prompt?wait=false` with
`{"prompt": ..., "queue": true}` — the exact pattern this repo's own
`DaemonClient.prompt` (`src/daemon/client.ts`) already uses for fan-in, per
`docs/DAEMON-NOTES.md`'s "Queue behaviour" section. There is no equivalent
MCP-tool-level workaround; the queueing mechanism only exists on the raw
HTTP surface today.

**Suggested fix.** `inbound-router.ts:92`'s `routeInto` should call
`enqueuePrompt(sessionId, msg.text, { queue: true, origin: ... })` instead
of the bare two-argument form — the queueing mechanism it needs already
exists and is exercised correctly elsewhere in the same codebase.
`agent_prompt` needs the same fix at a different call site: either default
to `queue: true` when `interrupt` isn't set (so "wait your turn" becomes
the default instead of an immediate rejection), or add an explicit `queue`
input field mirroring the HTTP route's, so a caller that wants today's
fail-fast behavior can still opt into it instead of losing that choice
entirely.

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

---

## 6. Rendez-vous's own bug: the box's `agent_start` needs an in-box `cwd`, not the host's

**Summary.** Not an agentproto bug — a bug in this repo, written up here
because the failure mode is worth recording for whoever debugs the next one.
`E2bBooter` (`src/service/booter.ts`) passed `cwd: process.cwd()` (this
host's own repo checkout, e.g.
`/Volumes/.../experiments/hackatons/rendez-vous`) into `bootRoomSession`/
`resumeRoomSession`. That `cwd` rides `POST /sessions/agent` straight through
to the BOX's own `agent_start` (`session-spawn.ts`'s
`bootSandboxAgentSession` passes it verbatim to `host.start({ cwd, ... })` —
see its own comment at the call site, `session-spawn.ts:2718-2726`: "a
genuinely remote box (e2b) needs its own filesystem story... forwarding it is
still strictly better than omitting it: the box's OWN `agent_start` needs
SOME cwd to resolve, and a bad path fails no worse than no path at all" — a
documented, accepted gap, not a bug on agentproto's side). A host-side path
does not exist inside the box: the box's own `spawn(execBin, execArgs, {cwd})`
(`define-agent-cli.ts:500`) fails ENOENT, which that file's own error path
disambiguates (`:538`, `cwdMissing = isEnoent && !existsSync(cwd)`) into
`` agent-cli 'claude-code': failed to spawn '<bin> <args>': spawn <bin> ENOENT\ncwd '<path>' does not exist — Node reports a missing working directory with this same ENOENT... `` —
wrapped by `bootSandboxAgentSession`'s catch (`:3496-3505`) into
`agent_start: the sandbox's own agent_start failed for adapter "claude-code" — ...`,
then by `DaemonClient.spawnAgent` into `spawnAgent failed: 500 {...}`.

**Repro.** Ground-truthed live in this repo (2026-09-11 session): every
`new` room under `RDV_BOOTER=e2b` 500'd with exactly that message chain; the
sandbox ledger's `cwd` field on the two dead entries
(`i86kacltf9lzeso7maeua`, `iysytdsb9grusftw4u9bw`) recorded the host repo
path, confirming what was actually sent. `scripts/prove-sandbox.ts` never hit
this because it always used its own `BOX_CWD = "/home/user"` constant, never
`process.cwd()` — the two code paths silently diverged on exactly this
field.

**Fix (this repo).** `E2bBooter.boot`/`resume` now pass a fixed
`BOX_CWD = "/home/user"` (matching `scripts/prove-sandbox.ts`) instead of
`process.cwd()`. `LocalBooter` correctly keeps `process.cwd()` — it runs
directly on this host, where that path is real.

**Note for agentproto.** Given the call site's own comment already
acknowledges "a bad path fails no worse than no path at all" as the accepted
trade-off, no change is being requested — but a caller-side hint (e.g.
rejecting an `agent_start.sandbox` request whose `cwd` isn't `/`-rooted
against a documented in-box convention, or defaulting a sandboxed spawn's
`cwd` to the box's home directory when the caller passes none) would have
turned this into a 400 instead of an opaque `agent-cli` ENOENT three layers
of wrapping deep.

---

## 7. A just-unpaused box's first turn can fail near-instantly, invisible to the reconnect-retry contract

**Summary.** `sandbox_reconnect_failed` (finding #3, `isRetryableReconnectError`
in `src/sandbox/boot.ts`) covers a SPAWN that fails outright when a box's MCP
layer isn't warmed up yet. Ground-truthed live in this repo
(2026-09-11 23:08 UTC): a DIFFERENT shape of the same underlying race —
the spawn itself succeeds (`201`, a real session descriptor,
`sandboxPorts` present, `remote: true`) and the reconnect-retry logic never
fires because there is nothing to retry, but the very first TURN sent along
with that spawn (`resumeRoomSession`'s resume prompt) ends
`{"kind":"turn-end","reason":"error"}` within ~400ms, with zero
`text-delta`s and no error text anywhere in the transcript
(`events.jsonl`) or the descriptor (`lastTurnReason: "error"`, no message
field). A same-sandboxId reconnect moments later, same prompt, succeeded
cleanly — confirming this is transient (the box's own agent-cli/network
stack needing a beat after coming off pause), not a bad prompt or a bad
`cwd`.

**Anchors.** `packages/runtime/src/session-spawn.ts:3483-3495` — the box's
own `agent_start` (`host.start`) succeeding is the ONLY thing
`bootSandboxAgentSession` checks; nothing observes whether the FIRST turn
that rides along with that same spawn (the `prompt` field on
`POST /sessions/agent`) actually completed. The daemon's own transcript
schema records `turn-end.reason` but, at least for `reason: "error"`, no
accompanying message — compare `reason: "completed"`, which also carries no
text but at least reflects success.

**Impact.** A caller (like `E2bBooter.resume`) that treats a `201` spawn
response as "the room is back" has no signal that the opening/resume turn
it sent along with that spawn silently failed — the member who sent the
message that triggered the auto-resume waits forever for a reply that will
never come, with nothing in the HTTP response to say so. Ground-truthed via
`scripts/simulate-room.ts`'s e2b phase: the script's own
`waitFor(... "both members to receive a reply after the room auto-resumes")`
timed out for exactly this reason.

**Suggested fix.** Either surface turn outcome on the spawn response itself
(e.g. `firstTurn: { reason: "error" }` alongside the `201` body) so a caller
can retry the PROMPT without a second full spawn, or have the daemon retry
the first turn internally once before giving up, the same way
`ensureDaemonHealthy` already retries the box's own health probe on boot.
Caller-side mitigation in the meantime: `resumeRoomSession` reconnects
cleanly but this class of failure needs a turn-level retry, not a
spawn-level one — out of scope for this fix; tracked here for whoever picks
it up next.
