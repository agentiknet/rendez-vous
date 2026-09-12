# Rendez-vous

**A shared, persistent agent sandbox that several people drive at once, each
from the surface they already live in.**

Alice on WhatsApp. Bob on email. Chloé on her laptop. One room, one agent, one
artifact, three fidelities.

```
new              → RDV-7F3K + join QR + live artifact URL
join RDV-7F3K    → you are in the room, on whatever you are holding
resume RDV-7F3K  → tomorrow, with state intact
```

The durable agent session plus sandbox is now a commodity — OpenAI shipped the
Agents API on 2026-09-10 with nine sandbox partners behind it, and every one of
them is single-principal: one key, one developer, one session. The uncontested
ground is not the sandbox. It is **the room around it**: several humans, several
surfaces, one live agent state. Rendez-vous is a host service that drives an
**unmodified** agentproto daemon over its public HTTP surface — no fork, no
vendoring — and adds the room registry, attributed fan-in, tier-aware fan-out,
and the room web view. See `docs/ARCHITECTURE.md` (§1–§2.5) for the whole
argument.

## Built and observed

| What | Proven by |
| --- | --- |
| Room registry: `new` / `join` / `resume` / `leave`, durable codes, one room per member, move between rooms | `docs/RUNBOOK.md` §2 |
| Attributed fan-in that never drops a message (`queue: true`; two people typing at once both land, in order) | `docs/RUNBOOK.md` §4 (`prove-queue.ts`), `docs/REHEARSAL.md` Run 3 |
| Tier-aware fan-out: every turn reaches every member, rendered per tier (Telegram text, web full transcript) | `docs/REHEARSAL.md` Run 3 |
| e2b sandbox boot with the deterministic artifact app, edit observed live on the artifact | `docs/REHEARSAL.md` Run 2 / Run 3 |
| Room-scoped proxied artifact URL (`/r/:code/artifact/`, stable across box replacement, never leaks the raw e2b URL) | `docs/RUNBOOK.md` §3, `docs/ARCHITECTURE.md` §9.3b |
| Real Telegram (a real phone, run 3) plus the room web view at the same time — two real surfaces, one session | `docs/DEMO.md`, `docs/REHEARSAL.md` Run 3 |
| Leave / switch rooms | `docs/RUNBOOK.md` §2 |
| Whispers: one turn, N addressed messages, per-member views | `docs/WHISPER.md` |
| Deliverable flow: preview → member confirm → PDF rendered via canvakit → send, with an operator allowlist | `docs/DELIVERABLE.md` |
| Out-of-band kill recovery — **not yet re-proven on a phone** after the liveness fix; marked NOT demo-safe until then | `docs/DEMO.md` §9, `docs/REHEARSAL.md` Run 3 continuation |

## Specced, not built

- **The middleman** — the agent solicits from each member (`[[ask Alice]]`),
  asks recorded in the room record, never stalls the room. `docs/MIDDLEMAN.md`.
- **Multimodal** — media normalized to text + a durable media ref at ingress,
  before anything is enqueued. Spec done (`docs/MULTIMODAL.md`); ingress
  implementation in progress.
- **Phase 2 credential model** — pair the box back to each member's own daemon
  so a tool call runs under that member's credentials; per-member, no shared
  secrets. `docs/ARCHITECTURE.md` §9.3.

## The silent-failure class

Five findings, one pattern: a plausible config, checked by nothing, routed
around with no error anywhere — the only symptom is a human noticing a reply
never came. Full write-up in `docs/UPSTREAM.md`.

1. A mid-turn prompt without `queue: true` is rejected and lost; the daemon's
   own inbound router and `agent_prompt` never pass the flag.
2. A fan-out cursor carried across a resume waits at a stale sequence; every
   reply after a resume vanished. Fixed `b58de3d`.
3. An agent asked for a capability the workspace already brokers
   (`mcp_import` blind to brokers) confidently proposes rebuilding it from zero.
4. A liveness check that tests only existence reads a killed session as alive
   and `resume` reports success while doing nothing. Fixed `4e73786`.
5. A dead box's raw artifact URL outlives the box in a member's thread — the
   room still advertised a link that now 502s.

And the codex verdict in one line: the "second brain is one parameter" claim
does **not** hold as stated — a fresh box has no codex credentials, and the
tested boot failed at the auth gate (`docs/CODEX-FLIP.md`).

## Run it

Detail: `docs/RUNBOOK.md` (everything) and `docs/DEMO.md` (the morning-of
checklist). Env variables live in `src/env.ts`; names only — values are in the
gitignored `.env.local`, never printed anywhere.

```
scripts/tunnel.sh --named rendez-vous     # rdv.clipgen.co → :8790; then export RDV_PUBLIC_URL
set -a; source .env.local; set +a         # RDV_DAEMON_URL, RDV_DAEMON_TOKEN, RDV_AGENTPUSH_URL,
                                          # RDV_AGENTPUSH_KEY, RDV_AGENTPUSH_WEBHOOK_SECRET,
                                          # RDV_EMAIL_WEBHOOK_SECRET, RDV_BOOTER, E2B_API_KEY, ...
node src/cli.ts serve                     # the service on :8790
```

Simulator (no phone needed):

```
node scripts/simulate-room.ts             # full no-phone proof: fan-in, queue, resume, fan-out
curl -s -X POST http://127.0.0.1:8790/inbound/simulated -H 'content-type: application/json' \
  -d '{"provider":"telegram","source":"agentpush","contactRef":"+x","displayName":"Alice","tier":"messenger","text":"new"}'
```

## Upstream

We found real gaps in our own runtime and shipped fixes as visible PRs, not
borrowed credit:

- https://github.com/agentproto/ts/pull/1273 — session liveness signal
- https://github.com/agentproto/ts/pull/1274 — `agent_prompt` queue-by-default
- https://github.com/agentproto/ts/pull/1277 — auth gate for `/mcps/proxy/call`

More open items are tracked in `docs/UPSTREAM.md`.

## Honesty notes

- The agent runtime is our own open-source project (agentproto, on npm),
  consumed unmodified as a dependency; the hackathon build is the room layer on
  top, and every line of that is new.
- OpenAI's relationship to e2b is a **launch partnership** in the Agents API
  sandbox lineup — not an acquisition. Say the true thing on stage.
