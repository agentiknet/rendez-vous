# Rendez-vous

**One shared room. One agent. Everyone from the app they already have.**

Your AI lives in your pocket. Your colleague's lives in theirs. The two never
meet, so you become the relay: screenshotting one chat to paste into the
other, forwarding half a context, losing the thread.

Rendez-vous removes the relay. It is one room where several people, and
several AI agents, talk to a single agent in a single conversation, each from
the messaging app already open on their phone: Telegram, WhatsApp, SMS,
email. Nothing to install. Joining is one message.

```
new               create a room backed by YOUR machine's agent harness
new sb            create a room backed by its own cloud sandbox
join RDV-7F3K     enter a room, from whatever you are holding
resume RDV-7F3K   come back tomorrow, with state intact
leave             move on
```

## Watch it in 2 minutes

[![Rendez-vous demo](https://img.youtube.com/vi/F7HrLF0r80U/hqdefault.jpg)](https://www.youtube.com/watch?v=F7HrLF0r80U)

The room is the product. One agent seeing every thread at once can do what a
chatbot in one person's pocket cannot: spot the conflict between two people
who never talk to each other, name it in front of both, and arbitrate until
they converge. It also keeps secrets: a whisper reaches one member, and the
rest of the room is told only that a whisper happened.

## What a room gives you

- **Attributed fan-in.** Every message arrives tagged with who sent it and
  from which surface. Two people typing at once both land, in order.
- **Tier-aware fan-out.** Every turn is rendered per surface: Telegram gets
  text, the web gets the full transcript. A voice note arrives as a
  transcription. Images and voice go in; voice notes and files go out
  (OpenAI).
- **Whispers and asks.** The agent decides who sees what. It can also solicit:
  `[[ask Alice]]` opens a private request that reaches Alice alone and never
  stalls the room.
- **A real workplace.** A sandbox room boots its own e2b machine: a real
  terminal, real Codex agent sessions, real files, and a stable public URL
  for the live artifact. The agent renders the deliverable PDF (canvakit) and
  puts the site online; everyone opens the same link.
- **Your own machine, optionally.** A local room runs the agent on the host
  harness instead: no box, no artifact, your files, your credentials. Each
  room records its mode at creation and keeps it across resumes.
- **A shared screen.** The web view is a CopilotKit host: the browser joins
  as a real member through the same claim endpoint, the chatbox drives the
  agent over AG-UI, and MCP Apps panels (`room_view`, `render_artifact`)
  render the live document inside the conversation.
- **Deliverables with a gate.** Preview, member confirmation, then the PDF
  ships, under an operator allowlist.

## How it is built

The durable-session-plus-sandbox layer is a commodity now (OpenAI's Agents API
shipped 2026-09-10 with nine sandbox partners behind it, and every one of them
is single-principal: one key, one developer, one session). The uncontested
ground is the room around it. That is what this project builds:

- **agentpush** (ours, open source) unifies messaging so Telegram, WhatsApp,
  SMS and email sit behind one attributed API.
- **agentproto** (ours, open source, used unmodified from npm, no fork, no
  vendoring) orchestrates each room's agent session and its sandbox. The
  service drives it over its public HTTP surface only.
- A per-room MCP mount carries the room tools (`say`, `whisper`, `roster`,
  `room_view`, `render_artifact`) with the room's own credential.
- e2b machines, Cloudflare Tunnel for the public URL, OpenAI for voice and
  vision, OpenRouter for coding models (Codex `gpt-5.6-terra` runs the room
  agents).

**1,049 green tests.** Seven pull requests shipped upstream to agentproto
during the hackathon, plus one fix to agentpush. We measured our own claims
and wrote up what failed.

## Run it

Everything: `docs/RUNBOOK.md`. Morning-of checklist: `docs/DEMO.md`. Env names
live in `src/env.ts`; values stay in the gitignored `.env.local`, never
printed anywhere.

```
scripts/tunnel.sh --named rendez-vous     # rdv.clipgen.co → :8790; then export RDV_PUBLIC_URL
set -a; source .env.local; set +a         # RDV_DAEMON_URL, RDV_DAEMON_TOKEN, RDV_AGENTPUSH_URL, E2B_API_KEY, ...
node src/cli.ts serve                     # the service on :8790
```

No phone needed, the whole loop in one simulator run:

```
node scripts/simulate-room.ts             # fan-in, queueing, resume, fan-out, artifact
```

The room web host (CopilotKit, AG-UI, MCP Apps) runs as its small Next app;
see `../rdv-copilotkit-host` and its `REPORT.md`.

## What was proven, and how

| Claim | Evidence |
| --- | --- |
| Rooms: `new` / `join` / `resume` / `leave`, durable codes, one room per member, mode kept per room | `docs/RUNBOOK.md`, `docs/DEMO-LOCAL-ET-SANDBOX.md` |
| Attributed fan-in that never drops a message | `docs/RUNBOOK.md` (`prove-queue.ts`), `docs/REHEARSAL.md` Run 3 |
| Tier-aware fan-out, real Telegram phone plus the web view on one session | `docs/REHEARSAL.md` Run 3, `docs/DEMO.md` |
| Whisper protocol, one turn, N addressed messages, per-member views | `docs/WHISPER.md` |
| Sandbox boot, live artifact edits, room-scoped URL that survives box replacement without leaking the raw URL | `docs/REHEARSAL.md`, `docs/ARCHITECTURE.md` §9.3b |
| Codex in the box | `docs/CODEX-TERRA-FLIP.md`: the first flip failed at the auth gate, we measured why, shipped the credential seed, and rooms now run Codex `gpt-5.6-terra` |
| Pause and revive on a fresh box | observed live in rehearsal; hard daemon-kill recovery stays marked NOT demo-safe |

Still spec-only: the phase 2 credential model, pairing each member's own
daemon so a tool call runs under that member's credentials
(`docs/ARCHITECTURE.md` §9.3).

## The silent-failure class

Five findings, one pattern, all met while building this: a plausible config,
checked by nothing, routed around with no error anywhere. The only symptom is
a human noticing a reply never came. Full write-up in `docs/UPSTREAM.md`.

1. A mid-turn prompt without `queue: true` is rejected and lost; the daemon's
   own inbound router and `agent_prompt` never pass the flag.
2. A fan-out cursor carried across a resume waits at a stale sequence; every
   reply after a resume vanished. Fixed `b58de3d`.
3. An agent asked for a capability the workspace already brokers
   (`mcp_import` blind to brokers) confidently proposes rebuilding it from
   zero.
4. A liveness check that tests only existence reads a killed session as alive
   and `resume` reports success while doing nothing. Fixed `4e73786`.
5. A dead box's raw artifact URL outlives the box in a member's thread: the
   room still advertised a link that now 502s.

## Upstream

Fixes we shipped as visible PRs, not borrowed credit:

- https://github.com/agentproto/ts/pull/1273 : session liveness signal
- https://github.com/agentproto/ts/pull/1274 : `agent_prompt` queue-by-default
- https://github.com/agentproto/ts/pull/1277 : auth gate for `/mcps/proxy/call`

More open items in `docs/UPSTREAM.md`.

## Honesty notes

- The agent runtime is our own open-source project (agentproto, on npm),
  consumed unmodified as a dependency; the hackathon build is the room layer
  on top, and every line of that is new.
- OpenAI's relationship to e2b is a launch partnership in the Agents API
  sandbox lineup, not an acquisition. Say the true thing on stage.
