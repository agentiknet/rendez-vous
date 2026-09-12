# STATE — cold-start handoff

You are reading this because the previous supervisor session may be gone.
Assume no other context exists. You have full authority to continue. Read
this file, then `docs/DEMO.md`, then `docs/REHEARSAL.md`, then run
`bash scripts/sv.sh status` and `bash scripts/sv.sh boxes`.

Last updated: 2026-09-12 02:16 UTC (04:16 local). Repo: this directory,
`main`, published private at https://github.com/agentiknet/rendez-vous.

## Hard limits (verbatim from the operator; never work around them)

- NO outbound message or email to ANY real third party. The deliverable flow
  is exercised ONLY against Jeremy's own Telegram contact `6371794295`
  (provider telegram) or the connected mailbox `jeremy@agentik.net`. Never a
  "client", a sample recipient, or any other address. An autonomous agent
  emailing a stranger overnight is the one unrecoverable mistake available.
- No prod DB writes, no DDL, no deploys, no changes to agentpush inbound
  routes. Route `9de0da85-d6a2-4a80-8fc2-7206ebc3dfd6` ("telegram to
  responder") was disabled by the operator: LEAVE IT DISABLED, leave every
  other route as it is.
- No destructive git operations, no force pushes. The agentproto checkout at
  `/Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/projects/agentproto/ts`
  is read-only reference; upstream fixes go in separate git worktrees under
  `/Volumes/SSDExternalMacStudio/Code/_agentproto-worktrees/agentik-studio/`.
- No spend outside the e2b boot budget (below).
- If unsupervised and unsure: keep executing the frozen order, never park,
  never contact anyone outside the room, leave the tree clean and committed.

## How to operate

- Supervisor stays on Fable/Opus; executors are GLM 5.3 flash by default:
  adapter `opencode`, model `openrouter/z-ai/glm-5.3-flash`. Use
  `claude-sonnet-5` on `claude-code` only for session-lifecycle or fan-out
  correctness work. The orchestrator caps live children at 8.
- Spawn over HTTP (the MCP tool is capped the same way):
  `POST http://127.0.0.1:18790/sessions/agent` with the bearer from
  `node -p 'require("/Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/.agentproto/runtime.json").token'`
  and body `{adapter, model, role:"executor", label, cwd, prompt, parentSessionId:"<your id>", dedupe:false, allowSharedCwd:true}`.
- Talk to busy executors with `bash scripts/sv.sh send <label> [--front] <text>`;
  read them with `sv.sh out`, `sv.sh queue`, `sv.sh status`. Retire finished
  ones with `POST /sessions/<id>/kill`.
- Executors commit ONLY by explicit pathspec after `git status`; never
  `git add -A`; no AI attribution in commits or PR bodies. Beware: `git commit -- <file>`
  and `git add <file>` take the WHOLE working-tree file, including another
  executor's uncommitted edits to it; check `git show --stat HEAD` after every commit.
- Drive the room without a phone: `POST https://rdv.clipgen.co/inbound/simulated`
  with `{provider, source, contactRef, displayName, tier, text}` using a
  synthetic contact. Use the real contactRef only when delivery to the phone
  is the point.
- Verify every executor's work yourself: `bash scripts/sv.sh verify`.
- PUSH after every landed executor: `git push origin main`, then confirm with
  `git fetch origin && git rev-list --count origin/main..HEAD` printing 0. The
  push command exiting 0 is not confirmation. Origin was 19 commits behind at
  01:55 UTC before this rule; a dead laptop would have lost the night.

## Live infrastructure right now

- agentproto daemon: http://127.0.0.1:18790 (0.20.0). Rendez-vous service:
  `node src/cli.ts serve` on :8790 with `.env.local` sourced, log at
  `/private/tmp/rdv-rehearsal/run3/service.log`. Named cloudflared tunnel
  `rendez-vous` → https://rdv.clipgen.co (config `~/.cloudflared/rendez-vous.yml`).
  Both are deliberately left RUNNING.
- Live room `RDV-NG7F`, session `sess_059b885d`, box `i7jos61ixgkcfrekmi1vl`,
  members: Jeremy (telegram 6371794295) and Bob (web). Jeremy may use it.
- `.env.local` (gitignored, mode 600) holds the agentpush key, webhook secrets,
  bot name, public URL, booter and daemon token. Never print it.

## e2b boot budget and boxes (these bill)

- Overnight budget: 10 fresh boots. Spent: 1 (an unattributed box
  `i5fln5g688isw18enzov9` appeared at 01:07 UTC with no owning session; no
  executor transcript claims it; PAUSED by the supervisor at 01:30 UTC and
  counted as spent). Remaining: 9.
- Boxes e2b currently lists (state filter is unreliable; treat all as
  billable): `i7jos61ixgkcfrekmi1vl` (the live room; keep),
  `i70vb4teaxca9r1id1c4p` (from the boot-fix work, 00:34; PAUSED by the supervisor at 01:17 UTC, will expire on its own),
  `i5fln5g688isw18enzov9` (unattributed, 01:07; PAUSED 01:30 UTC).
- UNBUDGETED BOXES, root cause found 02:12 UTC: the agentproto full test gate
  (`pnpm test` in the agentproto/ts worktrees) runs real e2b end-to-end tests
  whenever `E2B_API_KEY` is set; upstream executors ran it repeatedly and their
  timeouts left five boxes running (started 01:31 to 01:42 UTC), none in our
  ledger. All five were killed via the e2b API at 02:12 UTC. RULE: run any
  agentproto gate with `env -u E2B_API_KEY pnpm test`.
- The live room's box `i7jos61ixgkcfrekmi1vl` EXPIRED on e2b around 02:00 UTC;
  the room store shows RDV-NG7F paused with no session; the next message boots a
  fresh box (rdv-flow-exercise is doing this; count that boot).
- Pause: `POST https://api.e2b.dev/sandboxes/<id>/pause` with header
  `X-API-Key: $E2B_API_KEY`. Paused boxes expire on e2b's side within about an
  hour; the local ledger (`agentproto sandbox list`) is NOT trustworthy.

## Frozen build order and where we are

1. Liveness/resume fix, re-proven live — DONE (`4e73786`; revived room
   RDV-NG7F on a reconnect, 13 s). Re-proof on a FRESH box: not yet done;
   folded into item 2b's live proof.
2. Room-scoped proxied artifact URL `GET /r/:code/artifact/*` — DONE (`5daab38`;
   members only ever see https://rdv.clipgen.co/r/<code>/artifact/, the raw
   box URL stays inside the service, 503 self-heal page when the box is down).
   NOTE: the running service on :8790 predates this commit; restart it
   (`set -a; source .env.local; set +a; nohup node src/cli.ts serve >> /private/tmp/rdv-rehearsal/run3/service.log 2>&1 &`)
   once the deliverable-flow and box-liveness commits land, so all three go live together.
   2b. Box liveness as a second fact (probe e2b; never advertise a dead box's
   URL; restore on a fresh box) — IN PROGRESS (executor rdv-box-liveness,
   `sess_9726365f`, Sonnet; will spend 1 boot on its live proof).
3. Deliverable flow: preview → member confirm → PDF via canvakit → send to
   Jeremy's messenger AND the connected mailbox, every send in the transcript,
   recipient allowlist enforced — CODE DONE (`46912d3`, `docs/DELIVERABLE.md`,
   commands `send pdf to <address>`, `confirm <token>`, `cancel <token>`).
   First real exercise against Jeremy's own contact and mailbox: IN PROGRESS
   (executor rdv-flow-exercise). The demo service was restarted on `46912d3`
   at 01:38 UTC (pid 85899), so the proxy URL and the flow are live.
4. Leave/switch — DONE (`cfb9aa5`).
5. Whisper, N addressed messages per turn — DONE (`741fe35`, `dc1b178`).
6. Middleman (agent solicits from each member, asks recorded in the room,
   never stalls) — SPEC DONE (`25f453b`, `docs/MIDDLEMAN.md`, architecture
   §2.5); build after item 3.
7. Multimodal — SPEC DONE (`docs/MULTIMODAL.md`); INGRESS IMPLEMENTATION IN
   PROGRESS (executor rdv-multimodal-ingress, `sess_b3541f0a`, GLM): media
   becomes text plus a stored media ref before enqueue, null STT/vision
   providers tonight. Middleman BUILD starts once rdv-box-liveness releases
   room-service.ts.
8. Deck — DONE and current at `58da294` (13 pages, `deck/rendez-vous.pdf`,
   includes the deliverable beat, the codex verdict and the "why a room" slide).
9. Repo publish — DONE (private); README rewritten for the morning (`e7a2af8`).
   Push after every landing and verify zero ahead.
10. Codex flip — DONE: the one-parameter claim does NOT hold; the boot failed
    at the auth gate (`docs/CODEX-FLIP.md`, architecture §9.3).
11. Upstream agentproto PRs, each in its own worktree with a regression test
    that reproduces the out-of-band failure — IN PROGRESS:
    agent_prompt queue-by-default — PR OPEN https://github.com/agentproto/ts/pull/1274;
    session liveness signal — PR OPEN https://github.com/agentproto/ts/pull/1273
    (note: agentproto/ts is its own nested git repo; worktrees live under
    `/Volumes/SSDExternalMacStudio/Code/_agentproto-worktrees/agentproto-ts/`);
    app serve ui.path fix (rdv-up-app-serve-ui-path);
    `/mcps/proxy/call` auth gate — PR OPEN https://github.com/agentproto/ts/pull/1277
    (also gated POST /mcps/imports and DELETE /mcps/imports/:id); reap orphaned boxes + `sandbox gc` — PR OPEN https://github.com/agentproto/ts/pull/1278
    (phase A found 52 dead sandboxed sessions; 6 boxes still live on e2b from them), sandbox liveness signal (rdv-up-sandbox-liveness). NOT STARTED: the remaining docs/UPSTREAM.md items
    (app-serve ui.path, reconnect not pausing, spawn surviving disconnect).

12. Morning email to Jeremy (deck PDF, script, status body) to jeremy@agentik.net ONLY,
    by 02:20 UTC — DONE (executor rdv-morning-email, `sess_8cfaa0a7`, Sonnet).
    The only outbound email authorised overnight. Verify the attachment arrives.
    Morning email to Jeremy: SENT 2026-09-12T01:26:24Z, attachment verified: yes, method: manual

Demo status: run 3 on a real phone passed (attribution, fan-out, artifact
edit). Resume-after-kill is marked NOT demo-safe in `docs/DEMO.md` until
re-proven on a phone after `4e73786`.

## Executors running (session id, model, owns / fenced to)

- `sess_1114ae10` rdv-up-sandbox-liveness, GLM: worktree `wt/sandbox-liveness` (upstream PR).
- `sess_8d869128` rdv-flow-exercise, sonnet: drives the first real deliverable send to
  Jeremy's own contact and mailbox via the simulated inbound route; edits only
  docs/REHEARSAL.md, docs/STATE.md and `.env.local` (allowlist line).
- `sess_d233dc3a` rdv-up-app-serve-ui-path, GLM: worktree `wt/app-serve-ui-path` (upstream PR).
- `sess_b3541f0a` rdv-multimodal-ingress, GLM: `src/channels/media-ingress.ts`, channel
  inbound parsers, the two webhook handlers and media route in `http.ts`, `media-store.ts`,
  additive `src/env.ts`, their tests, the status section of `docs/MULTIMODAL.md`.
- `sess_9726365f` rdv-box-liveness, sonnet: `src/service/box-liveness.ts`,
  `room-service.ts`, `booter.ts`, `src/sandbox/boot.ts`, their tests, one
  RUNBOOK section. Fenced from fanout, web, http.ts, artifact-proxy, deliverable.
- `sess_059b885d` is the live room's agent, not an executor. Do not kill it.

## The silent-failure class (the deck's argument; do not lose these)

1. `queue: true` missing on the daemon prompt path: a mid-turn message is
   rejected and lost; the inbound router and MCP `agent_prompt` never pass it.
2. Resume cursor: the fan-out reader waited on a new session's stream at a
   stale sequence; every reply after a resume vanished. Fixed `b58de3d`.
3. Account-pinned agentpush routes never fire (`provider_account_id IS NULL`
   filter); catch-all routes match every channel.
4. Broker-blind planning: the agent proposed building a Gmail OAuth client
   while the workspace already brokered Gmail.
5. Liveness by existence: `GET /sessions/:id` is 200 for a killed session, so
   `res.ok` reported alive for a corpse and `resume` reported success while
   doing nothing. Fixed `4e73786`.
6. Dead artifact URL: the e2b box expired, the room still advertised its URL,
   the member's thread carried a dead link. Fix in progress (item 2, 2b).
   Plus the meta-class: agents escalate when a fact contradicts their model
   instead of re-reading the request (finding 8 addendum in `docs/UPSTREAM.md`).

## Blocked, and on whom

- Nothing is blocked on a human tonight. Jeremy is away until morning; the
  operator checks in periodically.
- Morning items needing Jeremy: re-prove resume on a real phone; decide
  whether to re-enable route `9de0da85`; rotate the Telegram bot tokens that
  transited an executor transcript (see `docs/UPSTREAM.md` security note).
