# Runbook — running Rendez-vous without a phone

Everything here is provable from a terminal, against a live agentproto
daemon, with no WhatsApp/Telegram/email account involved (build brief
constraint 7).

## 1. Environment

All knobs live in `src/env.ts`, read once at import as `env`. Nothing else
in the codebase reads `process.env` directly.

| Var | Default | Meaning |
| --- | --- | --- |
| `RDV_DAEMON_URL` | `http://127.0.0.1:18790` | Base URL of the agentproto daemon to drive. |
| `RDV_DAEMON_TOKEN` | unset | Bearer token, required if the daemon runs in `bearer` auth mode. |
| `RDV_DATA_DIR` | `.rdv` | Directory holding `rooms.json` (the room registry). |
| `RDV_PORT` | `8790` | Port the Rendez-vous HTTP service listens on. |
| `RDV_PUBLIC_URL` | `http://127.0.0.1:<RDV_PORT>` | Public origin used to mint join links. |
| `RDV_AGENT_ADAPTER` | `claude-code` | Adapter slug passed to `spawnAgent`. |
| `RDV_AGENT_MODEL` | `claude-sonnet-5` | Model id passed to `spawnAgent`. |
| `RDV_WHATSAPP_NUMBER` | unset | Digits only (leading `+` optional). Adds a `wa.me` join link when set. |
| `RDV_TELEGRAM_BOT` | unset | Bot username, leading `@` optional. Adds a `t.me` join link when set. |
| `RDV_SMS_NUMBER` | unset | Digits only (leading `+` optional). Adds an `sms:` join link when set (docs/AGENTPUSH.md §9.5). |
| `RDV_AGENTPUSH_URL` | unset | Base URL of the agentpush API this service calls directly for outbound sends. Also selects the transport in `serve` — unset means console-only. |
| `RDV_AGENTPUSH_KEY` | unset | Sent as `Authorization: Bearer <key>` to `RDV_AGENTPUSH_URL`. |
| `RDV_AGENTPUSH_WEBHOOK_SECRET` | unset | HMAC secret verifying `x-agentpush-signature` on `POST /inbound/agentpush`. Unset means unsigned requests are accepted — configure it in any internet-reachable environment. |
| `RDV_EMAIL_WEBHOOK_SECRET` | unset | HMAC secret verifying `x-agentpush-signature` on `POST /inbound/agentpush-mail` (docs/AGENTPUSH.md §8.4). Independent from `RDV_AGENTPUSH_WEBHOOK_SECRET` — the mail `inbound_route` is a separate row with its own `notify_secret`. |
| `RDV_BOOTER` | `local` | `e2b` picks `E2bBooter` (sandbox + artifact) in `serve`; anything else is `LocalBooter` (no sandbox, no artifact). |
| `RDV_ARTIFACT_APP_DIR` | `/home/user/apps/rdv-hello` | In-box path `E2bBooter` seeds and serves the artifact app from. |
| `RDV_ARTIFACT_PORT` | `3210` | In-box port the artifact app serves on. |
| `RDV_PREWARM_SANDBOX_ID` | unset | An already-paused e2b sandbox id to reuse for the next `new`, instead of a fresh boot. Consumed at most once — see §4. |
| `RDV_IDLE_SWEEP_SECONDS` | `60` | How often the idle-pause sweep runs. |
| `RDV_IDLE_PAUSE_MINUTES` | `20` | How long a room may sit with no activity before the sweep pauses it (R10). |

Every var is optional; unset ones fall back to the defaults above.

### Getting `RDV_DAEMON_TOKEN`

The bearer lives in the daemon's `runtime.json`, field `token`. Read it —
**never** paste the value itself anywhere, including here:

```
node -p 'require("<path-to-agentproto-workspace>/.agentproto/runtime.json").token'
```

Export it into your shell before running anything that talks to a
`bearer`-mode daemon:

```
export RDV_DAEMON_TOKEN="$(node -p 'require("<path>/.agentproto/runtime.json").token')"
```

## 2. Run the service

```
node src/cli.ts serve
```

Starts fan-out for every room already in `RDV_DATA_DIR` with a live
`sessionId`, then listens on `RDV_PORT`. `Ctrl-C` stops fan-out cleanly and exits.

### `GET /health`

```
curl -s http://127.0.0.1:8790/health
```

```json
{ "status": "ok", "rooms": 2, "daemon": { "status": "ok", "version": "0.20.0", "buildSha": "264c4c7a" } }
```

`daemon` is `"unreachable"` (a plain string, not an object) when the
agentproto daemon can't be reached.

### `POST /inbound/simulated`

The surface a no-phone simulator (or later, a real agentpush webhook
adapter) hits to inject an inbound message.

```
curl -s http://127.0.0.1:8790/inbound/simulated \
  -H 'content-type: application/json' \
  -d '{
    "provider": "whatsapp", "source": "agentpush", "contactRef": "+15550001111",
    "displayName": "Alice", "tier": "messenger", "text": "new"
  }'
```

Returns the `InboundOutcome` JSON (`{"kind":"created", "room": {...}, "member": {...}}`
for a `new`, `{"kind":"unknown-code"}` for a bad `join`/`resume`, etc.).

Commands, matched case-insensitively against `text`: `new` (creates a room),
`join <code>`, `resume <code>`, and `leave`. A member is bound to exactly one
room at a time. `join <code>` for someone already in a different room moves
them — removes them from the old room, adds them to the new one, and replies
`Moved from RDV-AAAA to RDV-BBBB.` (`{"kind":"moved", "from":"RDV-AAAA", ...}`).
`join <code>` on the room they're already in is a no-op that just replies
with the roster (`{"kind":"joined", ...}`). `leave` removes the sender from
their current room and replies `You left RDV-XXXX. Send \`new\` or \`join
RDV-XXXX\`.` (`{"kind":"left", ...}`) without touching the room's session —
it keeps running for whoever's left, and idle-pause (§3) reclaims it if that
was the last member. `leave` from a sender in no room replies with guidance
instead (`{"kind":"not-in-room"}`). The same move rule applies to the
room-web tier: `POST /rooms/:code/send` (below) registers/looks up its
member by display name only, so sending from a different room's page moves
that name there too.

### `GET /rooms/:code`

```
curl -s http://127.0.0.1:8790/rooms/RDV-7F3K
```
Returns the `Room` JSON, or `404 {"error":"not_found"}`.

### `GET /r/:code` — the room web view (tier 3)

A plain HTML page (no build step): live transcript on the left, the
artifact `<iframe>` on the right once one exists, roster and a send box.
The page talks only to this service — `GET /rooms/:code/stream?since=<seq>`
(SSE, re-emits the daemon transcript) and `POST /rooms/:code/send`
(`{"displayName","text"}`, registers a `room-web` member and fans in) —
never the daemon directly (R6, architecture.md §4.2). Unknown code → its
own 404 page.

**Try it in two steps:**
1. `curl -s -X POST http://127.0.0.1:8790/inbound/simulated -H 'content-type: application/json' -d '{"provider":"whatsapp","source":"agentpush","contactRef":"+1","displayName":"Alice","tier":"messenger","text":"new"}'` — note `room.code` in the reply (or run `node scripts/simulate-room.ts`, which prints a code directly).
2. Open `http://127.0.0.1:8790/r/<code>` in a browser.

The page header also shows the same join links and a scannable QR of the web
link, so a laptop tab can invite a phone too.

### `POST /inbound/agentpush`

The webhook agentpush calls on an inbound WhatsApp/Telegram message. Verifies
`x-agentpush-signature: sha256=<hex hmac-sha256 of the raw body>` against
`RDV_AGENTPUSH_WEBHOOK_SECRET` (skipped when unset — configure it in any
internet-reachable environment), dedupes by `messageId` (in-memory, one
instance per running server — a replay returns `{"deduped":true}`, not a
second turn), and maps to the same `handleInbound` every other tier goes
through, with `tier: "messenger"`.

Simulate a signed call locally:
```
BODY='{"channel":"whatsapp","from":"+15550001111","text":"new","messageId":"msg-1","displayName":"Alice"}'
SECRET=dev-secret   # must match RDV_AGENTPUSH_WEBHOOK_SECRET the service was started with
SIG="sha256=$(node -e 'const c=require("crypto");process.stdout.write(c.createHmac("sha256",process.argv[1]).update(process.argv[2]).digest("hex"))' "$SECRET" "$BODY")"
curl -s -X POST http://127.0.0.1:8790/inbound/agentpush \
  -H "content-type: application/json" -H "x-agentpush-signature: $SIG" -d "$BODY"
```
A bad or missing signature (when a secret is configured) returns `401`.

### `POST /inbound/agentpush-mail`

The webhook agentpush's Gmail poll worker calls on an inbound mail message
(docs/AGENTPUSH.md §8.2), a different envelope than the messenger webhook
above but the same `X-Agentpush-Signature` HMAC scheme, verified against
`RDV_EMAIL_WEBHOOK_SECRET`. Dedupes by `message_id` on the same
`MessageDedup` instance the messenger webhook shares. When the subject line
carries a room code (`RDV-XXXX`) and the sender isn't yet a member of any
room, an implicit `join <code>` runs first, then the message text fans in as
a tier-2 turn — so a first mail from a room's own reply address, sent
without having already joined on another tier, still lands in the room.

Simulate a signed call locally:
```
BODY='{"event":"inbound_mail","route":{"name":"rendez-vous-mail","dispatch_tag":"rendez-vous-mail"},"message":{"message_id":"mail-1","from":"alice@example.com","subject":"Re: Room RDV-7F3K update","text":"count me in"},"workspace_id":"acme"}'
SECRET=dev-mail-secret   # must match RDV_EMAIL_WEBHOOK_SECRET the service was started with
SIG="sha256=$(node -e 'const c=require("crypto");process.stdout.write(c.createHmac("sha256",process.argv[1]).update(process.argv[2]).digest("hex"))' "$SECRET" "$BODY")"
curl -s -X POST http://127.0.0.1:8790/inbound/agentpush-mail \
  -H "content-type: application/json" -H "x-agentpush-signature: $SIG" -d "$BODY"
```
A bad or missing signature (when a secret is configured) returns `401`.

## 3. e2b: sandbox, artifact, and idle pause (M4/R8/R10)

Set `RDV_BOOTER=e2b` to pick `E2bBooter`: `new` boots an e2b sandbox with the
artifact app served on `RDV_ARTIFACT_PORT`, and the room's `artifactUrl`/
`artifactReady` come from that boot. `resume`/an inbound message to a
paused room reconnects the box and re-probes the artifact URL, re-serving
only if it's actually dead (R8 — a resume alone never relaunches
`app serve`).

**Idle pause (R10):** every `RDV_IDLE_SWEEP_SECONDS`, any active room whose
`lastActivityAt` is older than `RDV_IDLE_PAUSE_MINUTES` gets its session
killed (which pauses the e2b box) and marked `state: "paused"`. The next
message from a known member — or an explicit `resume <code>` — reconnects
it automatically, telling the sender "Resuming room, one moment…" first.
`resume <code>` on a room that's still active is a no-op status reply, not
a reboot.

**Recovery from an out-of-band kill:** idle-pause isn't the only way a
session dies — a daemon-side `agent_kill`, a crash, or a daemon restart ends
it without ever running Rendez-vous's own pause path, leaving the room
`state: "active"` pointing at a session the daemon no longer runs. This is
now detected on the very next message to that room (a plain fan-in or an
explicit `resume <code>` alike) and revived the same way as an idle pause:
the sender sees "Resuming room, one moment…" and the room comes back active
on a fresh session.

**Pre-warming for a demo:** boot budget is the scarce resource (each fresh
e2b boot costs real time and money; reconnecting to a paused box is free).
The morning of the demo:
```
node scripts/prove-sandbox.ts
```
This proves the boot/artifact/resume round trip end to end and leaves its
final box **paused** — copy the sandbox id it prints into
`RDV_PREWARM_SANDBOX_ID`. The next room created with `new` reuses that box
instead of paying for a fresh boot. It's consumed at most once: as soon as
any room records that id as its own `sandboxId`, later rooms boot fresh
sandboxes of their own — surviving a service restart for free, since that
recording lives in the room store, not in memory.

**Cost protection on a failed reuse (docs/UPSTREAM.md #3):** if a spawn
against a KNOWN `reuse` sandboxId fails (a fresh boot has no id to act on —
nothing leaks there beyond what the daemon already pauses on its own),
`bootRoomSession`/`resumeRoomSession` (`src/sandbox/boot.ts`) best-effort
DELETE that box directly against e2b's own API — the daemon exposes no HTTP
route to act on a bare sandboxId with no live session. This needs
`E2B_API_KEY` (e2b's own credential, set in the environment the Rendez-vous
process runs in — not one of the `RDV_*` vars above) to do anything; if it's
unset, the failure is logged and the box is left as-is (check
`agentproto sandbox list` and e2b's own dashboard by hand). Unit-tested via
dependency injection (`killOrphanSandbox` on both functions) against the
fake daemon — no real e2b calls happen in `pnpm test`.

## 4. Proof scripts

All three need `RDV_DAEMON_TOKEN` exported (§1) and a reachable daemon at
`RDV_DAEMON_URL`. Each prints `PASS`/its own success line and exits
non-zero on failure.

### `pnpm probe:daemon` (`scripts/probe-daemon.ts`)

Proves the minimum round trip: `GET /health`, spawn a throwaway session with
a one-word prompt, read the SSE transcript to the first `turn-end`. Prints
`health: ...`, `spawned: <id> status=running`, `turn-end: reason=completed
seq=N`, the record kinds seen, the cursor to persist, and the reply text.
Kills the session in a `finally`.

### `node scripts/prove-queue.ts`

Proves R3 (architecture.md §4.2): a message that arrives while the agent is
busy is durably queued, never lost. Spawns a session with a slow prompt,
fans in two messages from two different senders while it's still busy,
reads the transcript to the third `turn-end`, and asserts the `user-prompt`
records landed in order — the slow prompt, then Alice's attributed text,
then Bob's. Prints each `user-prompt` seen, then `PASS: count prompt, then
Alice, then Bob, each as its own turn, in order.` or a `FAIL:` line.

### `node scripts/simulate-room.ts`

The full no-phone proof: `RoomService` wired to `LocalBooter` and a
`MemoryTransport`, driven in-process against the real daemon. Alice sends
`new`, Bob sends `join <code>`, both send messages at once (proving
`queue:true`), the service is torn down and a fresh one reopens the same
room store and resumes fan-out from the persisted cursor (proving no drop,
no re-delivery), then Bob sends one more message. Prints every delivered
message per recipient for both rounds, then `PASS` (or `FAIL: <reason>` and
exit 1). Kills the spawned session in a `finally`.

With `RDV_BOOTER=e2b`, a third phase runs: Alice first asks the agent to
edit the served artifact page (a unique marker string), and the script polls
the artifact URL until that edit is live. Then `service.pauseRoom(code)`
forces a pause, the script polls `GET /sessions/:id` until the daemon
confirms it, then Bob sends one more message and the script asserts the room
resumes, the artifact URL is unchanged, both members receive the reply
(Rehearsal Run 2, Finding 3 — the fan-out cursor reset), and the artifact
still carries the pre-pause edit (Finding 4 — the re-seed no longer wipes it).
Run this phase with a pre-warmed box so it costs no fresh boot:
```
RDV_BOOTER=e2b RDV_PREWARM_SANDBOX_ID=<id from §3> node scripts/simulate-room.ts
```
