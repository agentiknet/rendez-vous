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

### `GET /rooms/:code`

```
curl -s http://127.0.0.1:8790/rooms/RDV-7F3K
```
Returns the `Room` JSON, or `404 {"error":"not_found"}`.

## 3. Proof scripts

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
