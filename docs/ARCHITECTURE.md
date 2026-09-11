# Rendez-vous — architecture

**A shared, persistent agent sandbox that several people drive at once, each
from the surface they already live in.** Alice on WhatsApp, Bob on email,
Chloé on her laptop. One room, one agent, one artifact, three fidelities.

Status: concept locked, ground-truthed against `agentproto/ts@264c4c7a` (main).
Every claim below carries a `file:line` anchor or is marked as to-build.

---

## 1. The bet

### 1.1 What the market did this week

OpenAI shipped the **Agents API** on 2026-09-10 (public beta). Its primitives
are Agent, **Environment** (sandbox), **Session** (durable), Events/Items.
Sessions auto-compact. Sandboxes run OpenAI-hosted, self-hosted via
`codex exec-server` over an outbound WebSocket, or on one of nine partners —
Blaxel, Cloudflare, Daytona, DigitalOcean, **E2B**, Modal, Oracle, Runloop,
Vercel.

**Correction to the premise:** E2B was **not acquired**. It is a launch
partner in the Agents SDK sandbox lineup. Do not say "OpenAI bought E2B" on
stage — a judge will know, and it costs the whole pitch its credibility. The
true and stronger statement is below.

### 1.2 Their surface, concretely

From the beta reference, so we argue against the real thing:

```
client.beta.agents.sessions.create(
    agent       = { "model": "gpt-6-astra", "instructions": ... },
    environment = { "type": "openai_hosted" },   # or self-hosted, or "none"
    input       = ...,
    stream      = True,
)
```

- **Sessions** are durable. "Continue or steer" is a documented verb: send
  another task to the same session, or guide the agent during its current
  turn.
- **Artifacts are first-class**:
  `GET /agents/sessions/{session_id}/artifacts/{artifact_id}/content`, plus
  list, retrieve and delete.
- **Environment templates**: `POST /agents/environments/templates/{id}` — a
  reusable configuration that provisions a fresh environment per session.
- Streamed events like `agent.session.turn.completed`.
- Billed at model rates plus standard container rates. US-only data, no Zero
  Data Retention.

Two things are worth taking seriously here. Their **artifact** is a download
endpoint; ours is a live served URL that changes while people argue about it,
which is the better demo but the weaker file story. Their **environment
template** is a good idea we should copy: a room spec that provisions a fresh
sandbox per room.

### 1.3 The gap, stated precisely

The durable-agent-session-plus-sandbox is now a commodity. Nine vendors sell
it; OpenAI now sells it behind one API call.

**Every one of them is single-principal.** One API key, one developer, one
session. The Agents API documentation describes no multi-user or
collaboration feature. Its multi-agent story is task decomposition into
subagents, which is more robots and still one human.

Sharper still: their documentation does not specify what happens when input
arrives **while a turn is already in progress**. The whole surface is written
for one caller who waits their turn. That unanswered question is precisely the
one Rendez-vous is built around, and the agentproto stack answers it with a
persisted prompt queue (§3).

So the uncontested ground is not the sandbox. It is **the room around it**:
several *humans*, several *surfaces*, one *live agent state*.

That is Rendez-vous, and it is a protocol primitive, not a feature.

### 1.4 Challenge fit

The brief asks for an agent that belongs somewhere new and is meaningfully
more useful *because* of that context. Our answer:

1. It lives in the thread where the two people were already arguing about the
   deliverable.
2. Neither of them installs anything or shares a login. The room meets each
   person at the fidelity their device allows.
3. The artifact is a URL that changes while they argue.

Point 3 is the demo. Points 1 and 2 are the primitive.

---

## 2. The primitive: Room

```
Room {
  code         RDV-7F3K          durable handle, the thing humans type
  sessionId    <agentproto id>   the one agent turn-loop
  sandboxId    <e2b id>          the one filesystem + the one served URL
  members      Member[]          many humans, many surfaces
  artifactUrl  https://...       stable public URL of the served app
}

Member {
  displayName  "Alice"
  tier         messenger | email | room-web
  address      { provider, source, contactRef }   how to reach them back
  joinedAt
}
```

Three invariants define the primitive, and all three are things the current
stack does *not* have:

- **Fan-in with attribution.** Any member's message becomes a turn in the one
  session, tagged with who sent it, and never dropped because the agent was
  busy.
- **Fan-out by tier.** Every agent turn reaches every member, rendered at the
  fidelity their surface supports.
- **Durability by code.** The room outlives the sandbox, the daemon restart,
  and the conversation. `resume RDV-7F3K` works tomorrow.

### 2.1 Presence tiers (the fidelity ladder)

| Tier | Surface | Sends | Receives | Latency |
| --- | --- | --- | --- | --- |
| 1 | WhatsApp / Telegram | plain text turns | final reply + artifact URL, terse | seconds |
| 2 | Email | reply-to-thread turns | per-turn digest + artifact link | minutes |
| 3 | Laptop web room | turns, permission answers | full transcript: thoughts, tool calls, live artifact iframe | live |

Same room. Same agent. Three levels of presence. This ladder is the demo's
narrative spine and the clearest expression of "belongs somewhere new".

### 2.2 Why rendezvous is not this primitive

The agentproto rendezvous broker is a deliberately dumb two-socket byte
splice (`packages/rendezvous/src/server.ts:4-8`). It matches exactly one
`side=daemon` to one `side=client` on a shared token and refuses a third
socket on that token (`server.ts:212-218`, close code 4409 `tokenInUse`).

**But the limit is per-token, not per-daemon.** There is no cap anywhere on
concurrent offers: `offers` is an unbounded Map (`pairing-registry.ts:243`),
each offer starts its own independent connection loop keyed `offer:<token>`
(`pairing-registry.ts:462`), and `channels` is an unbounded Set of live E2E
channels (`pairing-registry.ts:247`).

So the answer to "can there be multiple rendezvous on one sandbox" is **yes**:
mint N offers, splice N laptops, all to the same daemon and therefore the same
sandbox. Rendezvous is the *transport for one tier-3 peer*. Room is the
*membership layer above it*. Keep the name; scope the dependency.

---

## 3. The decisive finding: no fork required

Rendez-vous is a **host application that drives an unmodified agentproto
daemon over its public HTTP surface.** It is a separate repo consuming
published `@agentproto/*` packages. We do not fork, vendor, or patch.

This is possible because of three routes that already do exactly what a room
layer needs:

**Fan-in without loss.** `POST /sessions/:id/prompt?wait=false` honours
`queue`, `force` and `queueId`, and stamps `origin: "user"`
(`http-server.ts:4453`). A queued prompt is appended to a persisted FIFO on the
descriptor and resolves immediately with **no admission check**
(`sessions.ts:6847-6859`), draining on the next turn end via
`dispatchQueuedPrompt` (`sessions.ts:5897`). Two humans talking at once is
therefore a solved problem at the daemon level — as long as the caller opts
in.

**Fan-out source.** `GET /sessions/:id/events/stream?since=<seq>` is SSE over
the same records appended to `events.jsonl`, with a gap-free, dupe-free
replay-then-subscribe handoff (`deliverRecordsExactlyOnce`,
`http-server.ts:3200-3231`). Subscribers are an unbounded Set per session
(`transcript-writer.ts:565-578`). A late joiner replays from `since=0`.

**Sandbox plus artifact.** `agent_start` with `sandbox` + `appServe` boots an
e2b box, installs the app, launches `agentproto app serve` detached, and
returns a public URL resolved from the provider edge
(`sandbox-app-serve.ts:340-410`). Pause keeps memory
(`sandbox-e2b/src/provider.ts:280-282`), `connect()` resumes it
(`provider.ts:321-325`), and the URL is a pure function of sandbox id and port
(`provider.ts:274-276`), so it is stable across a pause.

Everything Rendez-vous adds sits above those three lines.

---

## 4. What exists vs what we build

### 4.1 Green — exists, use as is

| Capability | Where | Note |
| --- | --- | --- |
| Many contacts → one session | `transmitter-bindings.ts:50-51` | `sessionId` is a value field, never keyed or indexed. No uniqueness constraint blocks N:1 today. |
| Inbound webhook per provider | `inbound-endpoints.ts:21-35`, `inbound-adapters.ts:11-26` | agentpush, telegram, whatsapp, slack, generic, native. HMAC verified, dedup by provider message id. |
| Single routing seam | `inbound-router.ts:84` | The one place a message maps to a session. Both ingress paths funnel through it. |
| Queued prompt, persisted | `sessions.ts:691-712`, `:6847` | `QueuedPrompt` already carries `source` and `origin`. Survives daemon restart. |
| Live transcript SSE + replay | `http-server.ts:3200`, `:5108` | Unlimited concurrent subscribers, exactly-once handoff. |
| Sandbox boot / pause / resume | `sandbox-e2b/src/provider.ts:249-340` | `pause({keepMemory:true})`, `connect()` re-arms a 45 min timeout. |
| Public artifact URL | `sandbox-app-serve.ts:340-410` | e2b only. Default port 3210. |
| Durable sandbox ledger | `sandbox-ledger.ts:42-55` | id, provider, state, createdAt, label, cwd, originSessionId, expiresAt. Our room registry can key off it. |
| N concurrent laptop pairings | `pairing-registry.ts:243-247`, `:462` | No per-daemon cap. Per-token only. |
| Outbound send + media | `outbound-adapters.ts:54-71` | agentpush and native telegram. WhatsApp via agentpush. |

### 4.2 Red — must be built

These are the gaps. Each is small; together they are the product.

**R1. Fan-out does not exist.** `SendOutboundInput.contactRef` is a scalar
(`outbound-adapters.ts:38-44`); no caller loops it. Nothing observes an agent
reply and sends it anywhere: `session:turn-end` carries
`{sessionId, awaitingInput, label, ts, question?, reason?, empty?}` and
**not the reply text** (`session-event-bus.ts:102-129`). Today a message only
reaches a human because the agent itself chose to call `transmit_message`.
→ Build: subscribe to the SSE stream, accumulate `text-delta` between
`turn-end` boundaries, send to every member.

**R2. Sender identity never reaches the turn.** The router calls
`enqueuePrompt(sessionId, msg.text)` with two arguments
(`inbound-router.ts:92`) — no `source`, no `origin`, no prefix. The agent
cannot tell Alice from Bob.
→ Build: prefix the text with `[Alice · whatsapp]` and pass `origin`.

**R3. Inbound mid-turn is silently LOST.** This is the critical one. Because
the router passes no `queue: true`, a message arriving while the agent is busy
hits `validateAgentTurn`, which throws `session "<id>" is mid-turn`
(`sessions.ts:4814`). The router's promise rejects and the HTTP handler
propagates. **Two humans typing at once loses one of them** on the built-in
path.
→ Build: our room service posts with `queue: true`, sidestepping the seam
entirely. Worth an upstream PR to agentproto regardless.

**R4. No reverse index session → members.** You would need
`list().filter(b => b.sessionId === id)`, and `list()` is exposed by no MCP
tool or HTTP route.
→ Build: our own room store owns membership. Do not try to reuse
transmitter-bindings for the roster.

**R5. No room concept at all.** No code, no join, no roster, no resume-by-code.
→ Build: the room registry, a small persisted JSON store, plus `new` / `join`
/ `resume` command parsing.

**R6. No multi-principal auth. One daemon has exactly one owner.** Auth is a
single per-boot bearer with two modes, `none` or `bearer`
(`http-server.ts:526-532`). A paired laptop gets the **entire** daemon HTTP
surface with the owner bearer injected (`tunnel-serve.ts:62-67`) and
`authorize: req => req`, which allows everything (`tunnel-serve.ts:167-169`).
`PairingRecord` has no scope, role, or ACL (`pairing-registry.ts:73-90`); the
only control is all-or-nothing `pair_revoke`. `OrchestratorScope`
(`orchestrator-gateway.ts:108-146`) is the only narrowing primitive and it
applies to spawned agent sessions, never to a human client.
→ Build: the room web view (tier 3a) is served by **our** service, which holds
the daemon bearer and exposes only room-scoped operations. Guests never touch
the daemon. Native pairing (tier 3b) stays an owner-only power feature, and we
say so honestly on stage.

**R7. Permission approvals have no approver identity.** `PendingPermission`
has no `claimedBy` (`sessions.ts:2415`), `PermissionRespondInput` has no actor
field (`sessions.ts:2455`), the resolved transcript record stores only
`{toolCallId, decision, optionId}` (`transcript-writer.ts:459-466`), and the
whole inbox is in-memory and lost on daemon restart (`sessions.ts:3728`).
First-writer-wins, anonymously.
→ Build: our room service records who answered, in the room log. Upstream fix
is out of scope.

**R8. App-serve does not survive a resume.** Nothing re-launches
`agentproto app serve` after `connect()`. e2b only survives because
`pause({keepMemory:true})` keeps the process alive; the daemon health re-probe
on connect covers the daemon, not the app server
(`sandbox-e2b/src/provider.ts:316-339`).
→ Build: on room resume, probe the artifact URL and re-run app-serve if dead.

**R9. Box cannot serve an artifact.** `toBootedSandbox` exposes neither
`ports` nor `expose()` (`sandbox-box/src/provider.ts:427-447`), so app-serve
fails there. **The artifact path is e2b-only.**
→ Accept. e2b is primary; box is the fallback for the agent session *without*
a live URL.

**R10. `pause_after_idle` is not enforced.** The value only becomes the
ledger's `expiresAt` stamp; no timer, no sweep
(`session-spawn.ts:3478-3480`). The host idle reaper is off by default
(`idle-reaper.ts:24-27`). Cost control is the provider cap: e2b 45 min
(`provider.ts:49`), box TTL null by default (`provider.ts:38-47`).
→ Build: our room service idles rooms on its own schedule.

**R11. Email is not a first-class inbound tier.** agentpush has the mailbox
surface; the `generic` inbound adapter can carry it.
→ Build: map an agentpush mail poll to a room member of tier `email`, with
digest-shaped fan-out. Explicitly the last tier to land.

---

## 5. System shape

```
   Alice                Bob                  Chloé
   WhatsApp             email                laptop browser
      │                   │                      │
      │ agentpush         │ agentpush mailbox    │ HTTPS
      ▼                   ▼                      ▼
 ┌──────────────────────────────────────────────────────────┐
 │                    RENDEZ-VOUS SERVICE                    │  ← the new code
 │                                                           │
 │  Room registry   membership, codes, tiers, artifact url    │
 │  Fan-in          attribute → POST /prompt?wait=false       │
 │                              queue:true   (never drops)    │
 │  Fan-out         SSE → turn boundaries → per-tier render   │
 │  Room web        transcript + artifact iframe + send box   │
 └──────────────────────────────────────────────────────────┘
      │ HTTP: /mcp, /sessions/:id/prompt, /events/stream
      ▼
 ┌──────────────────────────────────────────────────────────┐
 │              AGENTPROTO DAEMON  (unmodified, npm)         │
 │   session turn loop · persisted prompt queue · transcript │
 └──────────────────────────────────────────────────────────┘
      │ agent_start { sandbox: e2b, appServe }
      ▼
 ┌──────────────────────────────────────────────────────────┐
 │   E2B SANDBOX — the room's filesystem                     │
 │   agentproto app serve :3210  →  https://3210-<id>.e2b.app│ ← the artifact
 └──────────────────────────────────────────────────────────┘
```

### 5.1 Fan-in, exactly

```
inbound (agentpush webhook)
  → resolve room by (provider, source, contactRef) → Room
  → text = "[" + member.displayName + " · " + member.tier + "] " + raw
  → POST /sessions/{room.sessionId}/prompt?wait=false
      { prompt: text, queue: true, origin: "rdv:" + member.id }
  → 200 immediately, even mid-turn
```

The `queue: true` is the entire multiplayer correctness story. Without it,
R3 eats a message every time two people talk at once.

### 5.2 Fan-out, exactly

```
one long-lived SSE reader per active room:
  GET /sessions/{sessionId}/events/stream?since={cursor}

  accumulate kind="text-delta" .text
  on   kind="turn-end"  → flush:
       tier 1 → agentpush send_message, trimmed, + artifact url if changed
       tier 2 → email digest, full text + link
       tier 3 → already live; nothing to push
  persist cursor per room  (resume without dupes after a restart)
```

Tier 3 needs no push because the browser holds its own SSE to the same stream.
That asymmetry is the point of the ladder.

### 5.3 Join

`new` mints `RDV-7F3K`, boots the sandbox, starts the session, replies with
the code, a join link and a QR PNG of that link.

The QR encodes a **deep link with the code prefilled**, so the second phone
scans the first phone's screen:

```
https://wa.me/<number>?text=join%20RDV-7F3K
https://t.me/<bot>?start=RDV-7F3K
https://rdv.<host>/r/RDV-7F3K          ← tier 3, opens the room web view
```

Not a pair offer. A pair offer is tier 3b, owner-only, and mints one token per
laptop (§2.2).

---

## 6. Build plan

Frozen order. Each step is demoable on its own, so a cut at any point still
leaves a working story.

| # | Milestone | Proves |
| --- | --- | --- |
| 1 | Room registry + `new`/`join`/`resume` over one channel | the code is a durable handle |
| 2 | Fan-in with attribution and `queue:true` | two people, no lost message |
| 3 | Fan-out on turn boundaries to all tier-1 members | the room is a room |
| 4 | Sandbox boot + `appServe` → artifact URL in the reply | the deliverable is live |
| 5 | Second channel (Telegram alongside WhatsApp) | cross-surface, one session |
| 6 | QR + deep links | join in one scan, nothing installed |
| 7 | Room web view: transcript + artifact iframe + send | the fidelity ladder |
| 8 | Pause on idle, resume by code, re-serve probe (R8) | persistence, on stage |
| 9 | Rehearse end to end, twice, on real devices | it survives the venue |
| 10 | Email tier | the third fidelity |
| 11 | Stretch: native laptop pairing, Bureau in-sandbox browsing | power ceiling |

Steps 10 and 11 are slides unless step 9 passed twice.

### 6.1 Bureau, scoped

Bureau is the answer to "what can the agent *do* in this sandbox" — a stealth
browser the room can drive as a capability. It is **secondary**: it widens the
verbs, it does not carry the multiplayer thesis. Land it only after step 9,
and pitch it as one line: the room can also go look at things on the web as
you.

---

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| e2b cold boot ~30 s plus install, and boot leaks cost money | Pre-warm one box before the demo. The provider already kills on any post-create failure (`provider.ts:300-313`, after six leaked boxes on 2026-09-05). |
| Artifact is e2b-only (R9) | Accept and state it. Box is the no-artifact fallback. |
| App-serve dead after resume (R8) | Probe the URL on resume, re-run app-serve. Step 8. |
| WhatsApp 24 h window | Members initiated the chat, so the window is open. Rehearse inside it. |
| Turn collisions | `queue:true` serialises. Agent narrates the conflict: "Bob asked for 3 tiers, Alice for 2, went with 3 — say `2 tiers` to flip." |
| Anyone in the room can interrupt anyone (`session_queue_deliver` has no scope check, `session-tools.ts:2023-2058`) | Guests reach only our service, never the daemon (R6). |
| Venue network | Two SIMs and a hotspot. Venue Wi-Fi is not a plan. |
| Scope creep | Steps 10 and 11 are slides until step 9 is green twice. |

---

## 8. Is building on agentproto a cheat?

No, with one caveat worth checking against the rules in writing.

agentproto is our own open-source project, published on npm. Rendez-vous is a
**new repo** that consumes it as a dependency and adds the room layer. That is
the same posture as any team building on LangChain, the Vercel AI SDK, or the
Agents SDK itself. The judged artifact is the multiplayer room, and every line
of it is new.

Two honesty rules for the pitch:
1. Say plainly that the agent runtime is our prior open-source work, and that
   the hackathon build is the room primitive on top.
2. If we land an upstream fix during the event (R3 is a genuine bug), ship it
   as a visible PR. That reads as strength, not as borrowed credit.

Check the rules for a "no pre-existing code" clause. If one exists, the answer
is still fine — a published public dependency is not pre-existing *project*
code — but we want to have read the sentence before a judge quotes it.
