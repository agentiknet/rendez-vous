# Rehearsal log — two end-to-end runs, 2026-09-12

Followed `docs/DEMO.md` step by step, twice. Run 2 is the run that counts.

**No phone, no agentpush workspace.** Prod has no WhatsApp number, no
agentpush key, no inbound routes. Tiers 1/2 (WhatsApp/Telegram, both
`tier: "messenger"` here) were rehearsed via `POST /inbound/simulated`, plus
one signed `POST /inbound/agentpush` curl per run to prove the HMAC webhook
path. Tier 3 was rehearsed via curl against `GET /rooms/:code`,
`POST /rooms/:code/send`, and the artifact URL. **No real phone, WhatsApp
account, or agentpush infrastructure touched this rehearsal.** DEMO.md §5
(agentpush inbound routes) could not run at all — no `RDV_AGENTPUSH_URL`/`KEY`.

**Tunnel.** Per operator correction, both runs used a named cloudflared
tunnel (`rdv.clipgen.co`), not `--quick` — see setup below.

**Boot budget.** 4 allowed, **3 used** (prove-sandbox×2, one cold `new`).
Run 2's `new` reused the pre-warm box for free.

**Concurrent work.** `rdv-e2b-boot-fix` was editing `src/sandbox/boot.ts`
throughout; it landed as `0383a0f` (box `cwd` fix) then `321dbbc` (retries a
resumed sandbox's first turn) between Run 1 and Run 2. Neither touches the
room-service bugs found in Run 2 below.

## One-time setup: named tunnel

No `rendez-vous` tunnel existed. Created one, then hit two real bugs:

- **`cloudflared` name-resolution bug.** `cloudflared tunnel info
  rendez-vous` resolved to `postiz`'s id — `~/.cloudflared/config.yml` (an
  unrelated global default) silently overrides the positional tunnel-name
  argument on this cloudflared build (2026.6.0), for `info` **and** for
  `route dns`. The first `route dns rendez-vous rdv.clipgen.co` therefore
  CNAME'd `rdv.clipgen.co` at `postiz`'s tunnel, not ours. Fixed with
  `route dns --overwrite-dns <explicit-uuid> rdv.clipgen.co` — never pass
  the name to `route dns` on this box.
- **`scripts/tunnel.sh --named` printed a broken URL** —
  `RDV_PUBLIC_URL=https://hostname:`. The yml's ingress line is
  `  - hostname: value` (leading list dash), so `awk '{print $2}'` grabbed
  `hostname:` instead of the value. Fixed to `awk '{print $NF}'` — the only
  code change in this rehearsal, included in the commit.

Total setup: ~80s of actual cloudflared work, all inside Run 1's first 4 min.

## Run 1 (cold path — no pre-warm reuse)

| Step | Started (UTC) | Seconds |
| --- | --- | --- |
| `prove-sandbox.ts` pre-warm (1 boot) | 23:38:49 | 154 |
| tunnel up | 23:38:37 | ~1 |
| Alice `new`, signed webhook, **fresh boot** (no prewarm var) | 23:42:11 | 62.4 |
| artifact fetch #1 | 23:43:40 | 0.6 |
| Bob join (simulated, telegram) | 23:43:46 | 0.004 |
| fan-out: Alice msg → both replies logged | 23:43:52→23:44:02 | ~10.2 |
| artifact-update attempt 1 (naive prompt) | 23:44:12 | **failed** |
| artifact-update attempt 2 (corrected path) | 23:46:55→23:47:04 | ~9 |
| force-pause (direct daemon session kill) | 23:47:23 | <1 |
| wait | 23:47:23→23:47:51 | 20+ |
| Bob msg to "paused" room | 23:47:59 | 200 in 0.005s, **no resume** |
| `resume RDV-RXAR` fallback | 23:49:15 | **no-op**, "already active" |
| artifact fetch after box pause | 23:49:50 | 502 not found |
| stop service+tunnel | 23:49:58 | — |

Pre-warm box `i1n25v0ukznp4uc0jvpl7` (paused 23:41:23) was deliberately left
unused per the cold-path instruction; its survival to Run 2 was never
verified (see box-tracking note at the end).

### What broke, surprised, or needed a human

- **Ledger confirmed untrustworthy** (as DEMO.md warns): step 0's hardcoded
  ledger box `iysytdsb9grusftw4u9bw` came back `"Paused sandbox ... not
  found"` — expired despite being a real, previously-working box.
- **Naive artifact-edit prompt fails.** Asking the agent to edit
  `index.html` got *"No index.html file exists anywhere ... should I create
  a new one?"* — the real file is at
  `<appDir>/.agentproto/ui/index.html`. Needed a human to supply the exact
  path; the corrected retry succeeded in ~9s.
- **A direct daemon-level kill silently strands the room.** Killing a
  session via `POST /sessions/:id/kill` bypasses `RoomService.doPause`
  (which normally also sets `state: "paused"` and clears `sessionId`), so
  the store keeps believing `"active"` with a dead `sessionId`. Result,
  all observed live: a member's message gets `"Could not deliver your
  message: session_not_alive"` with **no retry, no auto-resume** (`handleMessage`
  only calls `doResume` when the store already says `"paused"`);
  `resume <code>` becomes a **permanent no-op** ("already active"); and the
  artifact URL 502s once the box is actually paused, with nothing to
  re-send the link — the exact box-replacement risk architecture.md §9.3b
  describes. This is specifically an *out-of-band*-kill gap: Run 2's
  idle-sweep pause (which does call `doPause`) recovers fine. Anything that
  kills a session without going through `RoomService` — crash, daemon
  restart, an operator's own recovery attempt — leaves the room lying about
  its own state with no self-healing path.

### Artifact verification

```
HTTP_STATUS:200 BYTES:9039 TIME:0.607437s
<title>Rendez-vous room artifact</title>
# after corrected edit:
<title>Rendez-vous live</title>  (page contains "hello from the room")
# after the box was paused by the direct kill:
{"sandboxId":"iey100qt7uu4jwon04uls","message":"The sandbox was not found","code":502}
```

## Run 2 (pre-warm within 10 min of use — the run that counts)

| Step | Started (UTC) | Seconds |
| --- | --- | --- |
| `prove-sandbox.ts` pre-warm (1 boot, 3rd of budget) | 23:51:33 | 195 |
| tunnel up (fixed script) | 23:54:54 | ~1 |
| Alice `new` — **reused pre-warm box**, 29s after it went paused | 23:55:17 | 12.8 |
| artifact fetch #1 | 23:55:37 | 0.2 |
| Bob join | 23:55:44 | 0.0025 |
| fan-out: Alice msg → both replies logged | 23:55:50→23:55:53 | ~3.2 |
| artifact-update (correct path up front) | 23:56:06→23:56:15 | ~9 |
| idle sweep pauses room (test-only 1 min window) | 23:57:24 | — |
| wait | 23:57:24→23:57:50 | 20 |
| Bob msg → auto-resume fires | 23:57:55→23:58:05 | 10.3 |
| artifact fetch after resume | ~23:58:1x | **200, edit reverted** |
| reply to the resume-triggering message | — | **never delivered** |
| kill final session, box paused | 00:03:22 | — |
| stop service+tunnel | 00:03:28 | — |

`RDV_IDLE_PAUSE_MINUTES=1`/`RDV_IDLE_SWEEP_SECONDS=15` (not the 20-min
default) were used deliberately so the documented idle-sweep→auto-resume
path could be exercised for real inside the rehearsal window — a rehearsal
artifact, not a proposed production value.

### What broke, surprised, or needed a human

- **Auto-resume itself worked** when the room was paused the *documented*
  way (idle sweep → `doPause`). Bob's message correctly triggered
  `doResume`, which reconnected the **same** `sandboxId`
  (`i5dlwxgv0eea9csomeizd` — the box itself survived, confirming
  architecture.md §3's "URL is a pure function of sandbox id and port"),
  got a new `sessionId`, and returned "resumed" within ~10.3s.
- **But the artifact edit did not survive the resume.** Title reverted to
  "Rendez-vous room artifact"; "hello from the room" vanished. Root cause,
  read from code: `resumeRoomSession` re-seeds the app directory via
  `setupCommands` on every reconnect (docs/ARTIFACT.md: "re-seeding
  idempotently on every reconnect") — idempotent means safe-to-repeat, not
  content-preserving, so it overwrites whatever the agent last wrote.
  **Any in-session artifact customization is wiped by the exact mechanism
  meant to keep the room alive.** Not called out anywhere in
  architecture.md/ARTIFACT.md/UPSTREAM.md before this rehearsal.
- **Second, independent bug: fan-out stops after any resume that mints a
  new `sessionId`.** The reply to "Are you still there after the pause?"
  never reached either member, though the daemon's own transcript for the
  new session shows the turn completed (`seq=12 text-delta`, `seq=15
  turn-end reason=completed`, read directly off
  `GET /sessions/<id>/events/stream?since=0`). Root cause: `doResume`
  (`src/service/room-service.ts`) updates `sessionId`/`sandboxId`/
  `artifactUrl`/`state` but **never resets `cursor`**. The fan-out reader
  then opens the new session's stream at `since=41` — a seq number from the
  *previous* session — and the new session's own numbering restarts near 1,
  so nothing is delivered until it organically produces 41+ events, which
  may never happen. Reproduced across three consecutive resume cycles
  (`sess_5ce5e5f0`→`sess_7d67d10b`→`sess_7359a86e`); `cursor` stayed frozen
  at `41` throughout. This is Rendez-vous's own bug, independent of the two
  upstream commits that landed mid-rehearsal. Stopped chasing it further
  once root-caused, to avoid burning more model cost. **Suggested fix (not
  applied):** `doResume` should reset `cursor` to `0` in the same
  `store.update` call that swaps in the new `sessionId`.

### Artifact verification

```
HTTP_STATUS:200 BYTES:9039 TIME:0.198322s
<title>Rendez-vous room artifact</title>
# after corrected edit, before the pause:
<title>Rendez-vous live</title>  (page contains "hello from the room")
# after idle-sweep pause + auto-resume (same sandboxId, box survived):
HTTP_STATUS:200
<title>Rendez-vous room artifact</title>   ← reverted, edit lost
```

### Run 2 verdict

**Would this survive the venue as is? No.**

The happy path is solid: ~13s reused-box `new`, <4s fan-out, <10s artifact
edits, and the box itself survives a pause. But recovery — the exact moment
a demo needs the room to *not* fall over — has two confirmed, reproducible
failures plus one silent regression:

1. **Fan-out breaks after any resume that mints a new session** (the
   `cursor` bug). Any pause — idle sweep, a daemon hiccup, a manual
   recovery attempt — means the next reply silently vanishes for every
   member, with no error anywhere. Top risk: invisible until someone
   notices nobody replied.
2. **Any session death that bypasses `RoomService.doPause` permanently
   strands the room** (Run 1): no auto-resume, `resume <code>` becomes a
   no-op, the artifact link 502s. A crash, daemon restart, or an operator's
   own direct recovery attempt (exactly what an operator under stage
   pressure might try) triggers this.
3. **Artifact edits do not survive a resume** — re-seeding wipes them. If
   the on-stage argument customizes the page and the room pauses even once
   before the demo ends, the visible "artifact changes while they argue"
   proof reverts to the template with no warning.

None needed a fresh e2b boot to surface — all three are `RoomService`/fan-out
logic bugs, cheap to fix, unfixed as of this rehearsal.

## Boot budget, boxes, final state

| # | What | Box | Paused at |
| --- | --- | --- | --- |
| 1 | Run 1 pre-warm | `i1n25v0ukznp4uc0jvpl7` | 23:41:23 (unused after; survival unverified) |
| 2 | Run 1 cold `new` | `iey100qt7uu4jwon04uls` | 23:47:23 (paused by kill; later confirmed dead, 502) |
| 3 | Run 2 pre-warm, reused by Run 2 `new` | `i5dlwxgv0eea9csomeizd` | **00:03:22 — final good box, left paused** |

4th boot budget held in reserve for Run 3 (below) — confirmed via
`GET https://api.e2b.dev/sandboxes?state=running` right after Run 2 that
`i5dlwxgv0eea9csomeizd` no longer appears. The e2b API has no way to list
*paused* boxes at all (an unfiltered `GET /sandboxes` also returns
running-only) — a paused box's survival can only be checked by trying to
reconnect, which is why box #3's fate for Run 3 couldn't be pre-verified.

Two other boxes (`ieiezgxwhmmky6y3gh0nl`, `i22hnlgr5cj0wesd6x2as`) ran
throughout Runs 1–2 — the concurrent `rdv-e2b-boot-fix` work, not this
rehearsal's; left untouched. Both tunnel processes and both `serve`
processes from Runs 1–2 were stopped explicitly at the end of their runs;
confirmed via `ps -p <pid>` returning no match.

## Run 3 — real Telegram + web: COMPLETED live

Live infra, not simulated: the provisioning executor wrote `.env.local`
(gitignored, confirmed present) and created the agentpush inbound routes
pointing at `rdv.clipgen.co`. Started with `set -a; source .env.local; set
+a; node src/cli.ts serve` at 00:09:42Z, named tunnel up at 00:09:29Z, health
confirmed through `rdv.clipgen.co` with `transport: agentpush
(whatsapp/telegram/sms) + email + console fallback`. Polled for the first
inbound for 15 minutes (00:10:48Z–00:26:02Z) with nothing yet — then, after
this write-up was already drafted as "waiting," **the operator's real `new`
landed at 00:27:15.982Z**, real Telegram contact `6371794295`.

| Step | Time (UTC) | Seconds |
| --- | --- | --- |
| Alice `new` on real Telegram → room created | 00:27:15.982 | — |
| Cold boot (no pre-warm; 4th and final budget boot) → session+artifact ready | → 00:28:42.451 | 86.5 |
| artifact fetch #1 | 00:28:4x | 200, 9039 bytes, `<title>Rendez-vous room artifact</title>` |
| Bob joins via `POST /rooms/RDV-NG7F/send` (room-web) | 00:29:03 | — |
| attribution confirmed in SSE: `[Bob · room-web] ...` and later `[6371794295 · messenger] ...` | 00:29:03–00:31:56 | — |
| operator drives a real multi-turn conversation (asked what the agent is, whether it's sandboxed, has MCP, has mail — all answered correctly) | 00:29–00:32 | — |
| operator asks the agent to find and edit the artifact; agent explores with `ls`/`find` **on its own** (no path hint needed this time) and edits `index.html` | 00:30:29–00:31:02 | ~33 |
| artifact fetch confirms the live edit | 00:32:38 | 200, contains `<p><em>Test edit applied.</em></p>` |

### What broke, surprised, or needed a human

- **This time the agent found the artifact file without a path hint.**
  Unlike Runs 1–2 (where a bare "edit index.html" made the agent claim no
  such file existed), here the operator asked more open-endedly ("can you
  update the webpage?" → agent asked which one → operator replied "Rendez-vous
  room artifact" → agent ran `ls`/`find` itself and located
  `/home/user/apps/rdv-hello/.agentproto/ui/index.html` unaided. Suggests the
  Run 1/2 failure was prompt-phrasing-sensitive, not a hard blocker — worth
  keeping in mind for the on-stage phrasing ("update the room's page", not
  "edit index.html").
- **Real Telegram members show up with their numeric contact id as
  `displayName`**, not a friendly name (`"6371794295"` throughout the
  transcript) — agentpush's Telegram inbound doesn't appear to pass a
  display name through in this payload shape. Cosmetic, but worth knowing
  before pointing a room's transcript at an audience: introduce yourself in
  the first message if a name matters on screen.
- **The `node src/cli.ts serve` process was silently replaced mid-run.**
  Noticed at 00:34: the PID recorded at start (bash wrapper) was gone;
  a *different*, freshly-started `node src/cli.ts serve` (PID 84514,
  started 00:32:17Z, `PPID=1`, same repo `cwd`) now owned port 8790.
  Fan-out and the room store were unaffected — `.rdv/rooms.json` is
  disk-persisted and the new process picked the same file back up with no
  gap or duplicate delivery (cursor kept advancing correctly, 113→121). Root
  cause not confirmed — most likely explanation is the concurrent
  `rdv-e2b-boot-fix` work also running `node src/cli.ts serve` from the same
  checkout (same default `.rdv` data dir, same port) and colliding with this
  one. Not investigated further to avoid disrupting the live operator
  session. **Risk worth flagging: two people running this service from the
  same checkout without a distinct `RDV_DATA_DIR`/port can silently swap
  which process is answering.**
- Confirms the fan-out send call gives no success log — `service.log`
  never printed a `send_message`/200 line for the real Telegram replies;
  absence of a `[channels/agentpush] ... failed/blocked/error` line was the
  only signal available from here. The operator's own phone is the actual
  proof; not independently confirmed by this session beyond that inference.

### Artifact verification

```
$ curl -s https://3210-i7jos61ixgkcfrekmi1vl.e2b.app
HTTP_STATUS:200 BYTES:9039
<title>Rendez-vous room artifact</title>

# after the operator's real edit request, confirmed live:
$ curl -s https://3210-i7jos61ixgkcfrekmi1vl.e2b.app | grep -i "test edit applied"
    <p><em>Test edit applied.</em></p>
```

### Current state — left running, deliberately

As of this write-up the room (`RDV-NG7F`), its session, its e2b box
(`i7jos61ixgkcfrekmi1vl`), the named tunnel, and the service are all **left
running** — a real human is mid-session; tearing any of it down now would
cut off the operator's own live use, not just a rehearsal artifact. This is
a deliberate deviation from the "leave nothing running" rule that governed
Runs 1–2 (which were pure rehearsal); flagged explicitly rather than
assumed. Boot budget: 4 of 4 used by this point; a 5th was later authorised,
scoped only to the resume-after-kill check below if the box turns out to be
gone rather than merely paused.

**Note:** between the write-up above and the continuation below, the
supervisor restarted the service on `b58de3d` ("Fix resume cursor, stranded
rooms, artifact re-seed and the edit path") at 00:33Z — this is the process
swap noted earlier as an unexplained anomaly; it's now explained, not a
mystery. The fan-out cursor bug and the stranded-room bug this rehearsal
found in Run 2 should therefore behave differently from here on; the
resume-after-kill check below is the first real test of that fix on a live
room.

## Run 3 continuation — two members at once, fan-out, resume-after-kill

Re-scoped by the supervisor: `new` is already observed and closed (above).
This continuation covers only what hadn't been exercised yet on the same
room (`RDV-NG7F`, session `sess_5a592b25`, box `i7jos61ixgkcfrekmi1vl`) — no
new room, no fresh boot unless the resume check needs one.

| # | Check | Needs Jeremy's hands | Executor-driven |
| --- | --- | --- | --- |
| 1 | Two members at once, visible attribution | **One Telegram message**, any time after Bob's web message below | Bob's message via `POST /rooms/RDV-NG7F/send`; read both attribution badges from `GET /rooms/RDV-NG7F/stream` |
| 2 | Fan-out reaching both | (same message as #1) | Confirm the agent's reply after Jeremy's message appears in the web transcript AND check `service.log` for the Telegram `send_message` call/status |
| 3 | Resume-after-kill | **One Telegram message**, sent ~20s after the executor's kill | Kill `sess_5a592b25` via `POST /sessions/:id/kill` with the daemon bearer; wait 20s; on Jeremy's message, record the "Resuming room" notice (if any), time to reply, whether the artifact URL is unchanged and still serves pre-kill content, and whether the reply reaches both members |

### Steps 1 & 2 — DONE: two members at once, attribution confirmed, fan-out confirmed in the web transcript

Posted at 00:39:49.958Z via `POST /rooms/RDV-NG7F/send`:
```
[Bob · room-web] Bob here on the laptop room view — Jeremy, send one
message from Telegram now so we can see both of us in the transcript at
once.
```
Reply, confirmed via SSE (`seq 199`, turn-end `seq 202` at 00:39:55.850Z):
*"Noted — standing by while Jeremy sends that from Telegram."* Attribution
badge confirmed exactly as `[Bob · room-web]` in the raw event.

Jeremy's Telegram message landed at 00:42:18.973Z, attribution confirmed via
SSE exactly as `[6371794295 · messenger]` (`seq 204`): *"noted what ?"*.
Reply at `seq 206`, turn-end `seq 209` (00:42:22.083Z, ~3.1s later):
*"Just acknowledging Bob's request for you to send a Telegram message so
you both show up in the transcript together — no action needed from me
there."* Both attribution badges confirmed distinct and correct in the same
stream — step 1 done.

Step 2 (fan-out reaching both): the reply above **is confirmed in the web
transcript** (it's the same SSE stream the web view consumes) **and
operator-confirmed on Telegram** — Jeremy confirmed on his phone, at
~2026-09-12T00:45Z, that the fan-out replies arrived. `service.log` itself
still recorded nothing beyond its own two startup banners for the entire
window (00:32Z onward), despite this and several earlier real turns — that
gap is a real finding on its own (the currently-running process, PID 84514
at the time, started by the supervisor's restart at 00:32:17Z, stopped
writing anything to its own log file past its startup banner, console
output included), but delivery itself is now operator-confirmed, not just
inferred from silence.

### Step 3 — resume-after-kill: FAILED, root cause identified

Pre-kill artifact baseline captured at 00:43:42Z: 200, 9078 bytes, title
"Rendez-vous room artifact", contains "Test edit applied" (the earlier live
edit, confirmed intact).

Killed `sess_5a592b25` via `POST /sessions/:id/kill` with the daemon bearer
at 00:43:49Z (200, `{"ok":true,"sessionId":"sess_5a592b25"}`). Daemon-side
session status immediately after: `killed`. Room store immediately after:
still `state: "active"`, `sessionId: "sess_5a592b25"` unchanged — same
stale-belief pattern as Run 1. Waited 20s (to 00:44:18Z); store still
unchanged at that point.

**Then Jeremy sent his one Telegram message and got back, verbatim:**
```
Could not deliver your message: sessionnotalive
```
No "Resuming room" notice, no retry, no reply reaching either member —
confirmed by the supervisor relaying what Jeremy's phone showed; I could
not independently time-stamp the exact moment (the message never produced
a `user-prompt` event in the session's own SSE stream — consistent with the
send failing before ever reaching the daemon's prompt queue, at the
`RoomService` layer, not the daemon's).

**Root cause, reported by the fix executor and consistent with reading the
current code:** `handleMessage` and `handleResume`
(`src/service/room-service.ts`) both now call `reviveIfSessionDied`, which
uses `isSessionAlive` (`src/service/daemon-extra.ts`) to decide whether the
stored `sessionId` needs reviving before use. `isSessionAlive` treats any
`200` response from `GET /sessions/:id` as "alive" without checking the
descriptor's own `status` field — so a `killed` session with a `200`
descriptor is misreported as alive, `reviveIfSessionDied` does nothing, and
the message is sent straight at a dead session, which then fails with the
message above. **Note the wording discrepancy**: Run 1's equivalent failure
(same underlying scenario, before this liveness check existed) read
`session_not_alive` (with underscores, the internal error code surfacing
directly); this run's message reads `sessionnotalive` (no underscores) —
recorded exactly as relayed, not normalized, since the exact source of that
specific string wasn't independently verified by this session.

**What this confirms, precisely:** it failed **loudly** — the member was
told plainly that delivery failed, nothing was silently swallowed — but
the *recovery* half (detecting the dead session and reviving it before
trying to use it) does not work yet, despite `b58de3d`'s intent to fix
exactly this. A fix executor was already on it as of this writing, expected
to restart the service on port 8790 again once landed. **Artifact
unchanged/still-serving and reply-reaching-both were not testable** — the
message never got far enough to matter for either.
