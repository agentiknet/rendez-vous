# STATE — cold-start handoff

You are reading this because the previous supervisor session may be gone.
Assume no other context exists. You have full authority to continue. Read
this file, then `docs/DEMO.md`, then `docs/REHEARSAL.md`, then run
`bash scripts/sv.sh status` and `bash scripts/sv.sh boxes`.

Last updated: 2026-09-12 03:36 UTC (05:36 local; earlier "UTC" stamps in this
file's history ran about an hour ahead of real UTC — trust git commit times).
Repo: this directory, `main`, published private at
https://github.com/agentiknet/rendez-vous.

## SCOPE CLOSED by the operator at 03:11 UTC

The operator declared the night's work done: no new scope, no new executors,
no e2b boot (Jeremy re-proves resume on his phone), no outbound message to
anyone. Jeremy is awake and already has the morning report. The supervisor
had spawned four executors between 03:13 and 03:25 UTC before that brief
arrived; they were wound down as follows: rdv-deck-caption finished
(`2022217`); rdv-up-reconnect-pause finished (PR 1286); rdv-middleman was
stopped after steps i and ii landed green (`b793097`, `d258b13`) and its
uncommitted step-iii edit to `room-service.ts` was reverted; rdv-ask-panel
was stopped and its two uncommitted edits reverted. No executors are
running. The tree is clean and origin/main is in sync.

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
  `node src/cli.ts serve` on :8790, log at
  `/private/tmp/rdv-rehearsal/run3/service.log`. Named cloudflared tunnel
  `rendez-vous` → https://rdv.clipgen.co (config `~/.cloudflared/rendez-vous.yml`).
  Both are deliberately left RUNNING.
- SINCE 03:19 UTC the service runs from a PINNED DETACHED WORKTREE, not this
  working tree: `/private/tmp/rdv-serve/0af9580` (commit `0af9580`,
  `node_modules` symlinked to this repo's), with `RDV_DATA_DIR` and
  `RDV_MEDIA_DIR` pointed at THIS repo's `.rdv` and `.rdv/media`. Reason:
  `node src/cli.ts serve` loads source at start, and executors edit this tree
  concurrently, so a restart from here could load a half-edited file. Restart
  procedure (supervisor only): `git worktree add --detach /private/tmp/rdv-serve/<sha> <sha>`,
  symlink `node_modules`, then from that dir
  `set -a; source <repo>/.env.local; set +a; export RDV_DATA_DIR=<repo>/.rdv RDV_MEDIA_DIR=<repo>/.rdv/media`,
  kill the old pid (`pgrep -f "src/cli.ts serve"`), wait for :8790 to free,
  `nohup node src/cli.ts serve >> /private/tmp/rdv-rehearsal/run3/service.log 2>&1 &`,
  then check `/health` locally and at https://rdv.clipgen.co/health and that
  `/r/RDV-NG7F/state` still lists the members. Old worktrees:
  `git worktree remove /private/tmp/rdv-serve/<sha>` once nothing runs there.
- Rooms `RDV-NG7F` (members: Jeremy via telegram 6371794295, Bob via web,
  plus the synthetic "Exercise" contact) and `RDV-8WLG` are both PAUSED with
  no live session or box. The next message to either boots a FRESH box and
  spends one of the remaining boots.
- `.env.local` (gitignored, mode 600) holds the agentpush key, webhook secrets,
  bot name, public URL, booter and daemon token. Never print it.

## e2b boot budget and boxes (these bill)

- RULE: ONLY THE SUPERVISOR RESTARTS THE DEMO SERVICE. Two executors restarting
  `node src/cli.ts serve` concurrently collided twice tonight (EADDRINUSE, pid
  swaps, lost in-memory pending deliveries). Executors report "restart needed".
- Overnight budget: 10 fresh boots. Spent so far, as of 03:00 UTC: 1
  unattributed (`i5fln5g…`, 01:07, paused); 2 for waking RDV-NG7F after its box
  expired (a raced revive produced two sessions and two boxes at 01:45 and
  01:47; the orphan session `sess_13a08221` and box `i65mye…` were killed by
  the supervisor at 02:30; the room now runs on `icc84uy0qdas650d1sntl`,
  session `sess_1696a06c`); 1 for the box-liveness proof room RDV-8WLG
  (`i6s6gs…`, deleted by the proof) plus 1 for its restore box
  (`i3htjrl6af3yzfo95c93b`, paused 01:54 UTC); plus `iw1ylk7jshrtfj9bvsqw2`
  (01:48, unclaimed by any executor, an upstream test-gate box; KILLED 03:00 UTC).
  Operator's verified count at 03:11 UTC: 6 of 10 spent, 4 remain. One more
  box existed then that the operator did not count: `ieqlkzycc8b8qclxbl6kz`
  (template agentproto-workstation, started 02:42 UTC, no daemon session and
  no room references it, no executor was active then; PAUSED by the
  supervisor 03:14 UTC, expires on its own). A SECOND box of the same shape,
  `imves98ljrhxdwt73inzf` (agentproto-workstation, no metadata, 45-minute
  lifetime, started 03:24 UTC, no daemon session, no room, no boot in the
  service log), appeared while the upstream executor's agentproto gate was
  running with `env -u E2B_API_KEY`; PAUSED by the supervisor 03:39 UTC.
  `packages/sandbox-e2b/src/provider.ts` reads the key only from
  `process.env.E2B_API_KEY`, so the source of these two boxes is NOT
  established; the hypothesis is the agentproto test gate through some other
  path (`~/.e2b/config.json` holds a team API key). OPEN QUESTION for the
  operator: check e2b's dashboard for who created `imves98…` before running
  any agentproto gate again. If both were ours, 2 remain; plan the demo on 2.
  Zero boxes running at 03:39 UTC. The raced double revive is fixed by the
  per-room revive lock (`8a69856`) and the probe-then-reconnect race by
  `0af9580` (a not-found reconnect boots fresh inside the same locked call).
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
   RDV-NG7F on a reconnect, 13 s; and on a FRESH box in item 2b's live proof).
2. Room-scoped proxied artifact URL `GET /r/:code/artifact/*` — DONE (`5daab38`;
   members only ever see https://rdv.clipgen.co/r/<code>/artifact/, the raw
   box URL stays inside the service, 503 self-heal page when the box is down).
   The running service (restarted 03:19 UTC from `0af9580`) includes this,
   the deliverable flow, the polish fixes and both box-liveness fixes.
   2b. Box liveness as a second fact — DONE (`17e9061`): `isSandboxAlive` probes
   e2b (alive | paused | gone | unknown, unknown never treated as gone), used in
   `E2bBooter.resume` (boot fresh when gone) and the idle sweep (marks
   artifactReady false and pauses the room). Verified live: room created, box
   deleted via the e2b API, sweep marked it gone, next message revived on a
   fresh box with the artifact serving. FOLLOW-UPS DONE: per-room revive
   lock (`8a69856`, two concurrent triggers → one boot, proven by reverting
   the fix); reconnect-reports-not-found boots fresh in the same call
   (`0af9580`, regression test proven load-bearing the same way).
3. Deliverable flow: preview → member confirm → PDF via canvakit → send to
   Jeremy's messenger AND the connected mailbox, every send in the transcript,
   recipient allowlist enforced — CODE DONE (`46912d3`, `docs/DELIVERABLE.md`,
   commands `send pdf to <address>`, `confirm <token>`, `cancel <token>`).
   First real exercise through the room's own commands: DONE 01:53 UTC (email
   leg to jeremy@agentik.net sent and verified in the mailbox, message id
   1a0935074773122c, PDF 21913 bytes; allowlist refusal verified; `docs/REHEARSAL.md`).
   GAPS found: no address form to deliver to another member's messenger
   contact by ref (only self or an email), pending deliveries are in-memory
   and die on a service restart, and the resume probe raced the reconnect
   (double boot). Fixes LANDED: `9d70c1a` (pending deliveries persisted on
   the room record and swept on startup; `send pdf to <member name>` delivers
   to that member's own messenger contact; artifactReady gates in the fan-out
   reader and the http sanitize helper; `docs/DELIVERABLE.md` updated) and
   `0af9580` (probe race). Not yet re-exercised live after the restart.
   First real exercise: DONE 2026-09-12T01:53Z (docs/REHEARSAL.md, "Deliverable
   flow, first real exercise (through the flow)"), email verified yes
   (jeremy@agentik.net, message 1a0935074773122c, attachment byte-matched via
   mailbox_search), messenger status: skipped — no address form exists for a
   raw messenger contact ref via `send pdf to <address>` (gap recorded, not
   improvised). Also hit a real `E2bBooter.resume` box-liveness race and a
   second unplanned same-port service-process collision during the run.
4. Leave/switch — DONE (`cfb9aa5`).
5. Whisper, N addressed messages per turn — DONE (`741fe35`, `dc1b178`).
6. Middleman (agent solicits from each member, asks recorded in the room,
   never stalls) — SPEC DONE (`25f453b`, `docs/MIDDLEMAN.md`, architecture
   §2.5). BUILD PARTIAL, stopped by the operator's scope close: §7 step i
   (Ask record on Room, `b793097`) and step ii (`[[ask <name>]]` parser,
   open asks recorded, delivered to the target as a whisper, one-line marker
   to the rest, `d258b13`) are landed and green. Steps iii (answer tagging on
   fan-in, `skip`), iv (web "Outstanding" panel), v (nudge/proceed timers) and
   vi (opening-prompt additions) are NOT built. Until iii lands, an ask opens
   and is delivered but nothing closes it; the agent is not yet told about
   the syntax, so no asks are produced in the demo unless prompted.
7. Multimodal — SPEC DONE (`docs/MULTIMODAL.md`); INGRESS DONE (`b769180`):
   inbound voice and images become text plus a stored media ref before enqueue,
   attribution `[Name · channel · voice|image]`, served by `GET /r/:code/media/:id`;
   STT and vision providers are null tonight (unavailable lines carry the media
   ref); real providers plug in via env later. Middleman BUILD starts once
   rdv-box-liveness releases room-service.ts.
8. Deck — REBUILT as a pitch at `dbf938b` (13 pages: 9-slide arc problem /
   consequence / solution / it works / how / per-member credentials / work
   leaves the room / close, plus a 4-slide appendix). Both kits in `deck/out/`.
   FORMAT: re-rendered as 16:9 landscape slides at `87f4623` (both kits in
   `deck/out/`, `deck/rendez-vous.pdf` is the light kit).
   Slide 8's caption now says the flow ran end-to-end through the room's own
   commands (`2022217`, re-rendered, still 13 pages, 1440×810 pt). Both
   rendered kits are now TRACKED in git (`b255004`): `deck/out/rendez-vous-light.pdf`
   and `deck/out/rendez-vous-dark.pdf`, so they open from the repo on a phone.
8b. Room page shows the room — DONE (`26714b3`): `GET /r/:code/state` polled
   every 3 s, DOM patched, members with tier badges, agent busy/idle, proxied
   artifact link never dead.
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
    app serve ui.path fix — PR OPEN https://github.com/agentproto/ts/pull/1281;
    `/mcps/proxy/call` auth gate — PR OPEN https://github.com/agentproto/ts/pull/1277
    (also gated POST /mcps/imports and DELETE /mcps/imports/:id); reap orphaned boxes + `sandbox gc` — PR OPEN https://github.com/agentproto/ts/pull/1278
    (phase A found 52 dead sandboxed sessions; 6 boxes still live on e2b from them);
    sandbox liveness signal — PR OPEN https://github.com/agentproto/ts/pull/1279.
    reconnect failure leaving the box running (finding #3) — PR OPEN
    https://github.com/agentproto/ts/pull/1286 (worktree
    `_agentproto-worktrees/agentproto-ts/reconnect-pause`; the real defect was
    an unguarded teardown masking the connect error). Seven PRs open in all,
    verified with `gh pr list` at 03:33 UTC: 1273, 1274, 1277, 1278, 1279,
    1281, 1286. Finding #5 (spawn survives a client disconnect) is a
    caller-side design note; no PR planned. All upstream PR bodies state the
    e2b live e2e tests were skipped (key unset). No more upstream work.

12. Morning email to Jeremy (deck PDF, script, status body) to jeremy@agentik.net ONLY,
    by 02:20 UTC — DONE (executor rdv-morning-email, `sess_8cfaa0a7`, Sonnet).
    The only outbound email authorised overnight. Verify the attachment arrives.
    Morning email to Jeremy: SENT 2026-09-12T01:26:24Z, attachment verified: yes, method: manual

Demo status: run 3 on a real phone passed (attribution, fan-out, artifact
edit). Resume-after-pause is now demo-safe too — proven live 2026-09-12
07:54:11 UTC from Jeremy's phone: a real Telegram message into paused room
`RDV-NG7F` flipped it active, 3 inbound / 3 outbound counted by agentpush,
`cursor: 15` preserved, artifact ready on the proxy URL. Resume boots a
FRESH box by design (`0af9580`), so transcript continuity holds but the old
box's filesystem does not. See `docs/DEMO.md` §9.

## Executors running (session id, model, owns / fenced to)

- NONE. All executors are retired (scope closed by the operator, see top).
  Retired 03:13–03:36 UTC after verification: rdv-polish-gaps, rdv-room-page,
  rdv-up-app-serve-ui-path, rdv-up-sandbox-liveness, rdv-box-liveness (hit
  its Claude session limit mid-edit; the supervisor finished and committed
  its probe-race fix as `0af9580`), rdv-deck-caption, rdv-up-reconnect-pause,
  rdv-middleman, rdv-ask-panel.
- `sess_059b885d` was the live room's agent (now killed by the daemon; the
  room is paused and revives on the next message). Do not kill room agents.

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
   the member's thread carried a dead link. Fixed: proxied URL (`5daab38`),
   box liveness as its own fact (`17e9061`), artifactReady gates (`9d70c1a`).
   Plus the meta-class: agents escalate when a fact contradicts their model
   instead of re-reading the request (finding 8 addendum in `docs/UPSTREAM.md`).

## Blocked, and on whom

- Jeremy is awake (05:11 local) and has the morning report. Nothing further
  runs unattended.
- Morning items needing Jeremy: re-prove resume on a real phone; decide
  whether to re-enable route `9de0da85`; rotate the Telegram bot tokens that
  transited an executor transcript (see `docs/UPSTREAM.md` security note).
