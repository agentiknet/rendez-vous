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

### 2.3 The room spec (our environment template)

Borrowed directly from the Agents API's environment template (§1.2): a
reusable configuration that provisions a fresh environment per session.
Ours provisions a fresh **box per room**, and it is the room's identity.

```
RoomSpec {
  id            "pitch-deck" | "landing-page" | "incident"
  version       semver
  provider      "e2b"                      # box has no port exposure (R9)
  image         template slug
  packages      string[]                   # baked or installed at boot
  setupCommands string[]                   # deterministic, NOT an agent turn
  ports         number[]                   # 3210 = the artifact
  artifact      { app: dir, port: 3210 }   # what gets served publicly
  runtime       "agentproto" | "openai"    # which brain drives the box (§9)
  tools         MCP server refs
  greeting      what a joiner is told on arrival
}
```

Two properties earn their keep:

- **Deterministic provisioning.** `setupCommands` beats asking an agent to
  install things, which we learned the hard way. The spec is the place that
  rule lives.
- **A spec is shareable.** A room spec is a file. Publish it, hand someone a
  QR, and they get a preconfigured room with the right packages, the right
  tools and the right opening line. That is a product surface, not just
  config.

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

**Two distinct roles, not a contradiction.** The above is about message
fan-in/fan-out (§3, §5) — rendezvous is not that primitive, unchanged. But
the same broker is also the substrate a second job reaches for: pairing a
room's box back to a member's own daemon so a tool call resolves under that
member's credentials, not the room's. See §9.3, "Tool grants without a
shared credential." One primitive, two independent jobs.

### 2.4 Multimodal is the ladder, extended

Multimodal is not a new axis. It is the fidelity ladder (§2.1) extended to a
second dimension: not just how much of the transcript a tier sees, but which
encoding. A voice note or photo is normalized to text plus a durable media
reference **at the room service, before anything is enqueued** — the
session's prompt queue stays text-only, so a second binary ingestion path
never becomes a second chance to drop a message silently (the class of bug
`docs/UPSTREAM.md`'s "The pattern" names). STT/vision credentials stay at
the service, never enter the box, consistent with §9.3's "Tool grants
belong to the room." Attribution stays uniform —
`[Alice · whatsapp · voice] "..."` — and the SSE transcript still replays
for late joiners, because text replays and audio does not.

Outbound is symmetric: the transcript record stays canonical text, and each
tier renders it at its own fidelity — a voice reply is a TTS rendering of
that record, not a separate message. Full ingress/egress design, the stored
media record shape, and the implementation plan are in
`docs/MULTIMODAL.md`.

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

---

## 9. Phase 2 — the room owns the box, runtimes plug in

Everything in §1 through §8 assumes one runtime: an agentproto session that
boots a box and owns it. That coupling is wrong, and fixing it is what turns
Rendez-vous from a good demo into a primitive.

### 9.1 Invert the ownership

Today the agent session boots the sandbox, and closing the session pauses or
kills it (`sandbox-agent-session-proxy.ts:458-489`). So the room's artifact
lives and dies with one agent process.

Flip it. **The room owns the box. Agent sessions attach and detach.**

```
  Room ──owns──▶ Sandbox (filesystem + the public artifact URL)
    │                ▲
    │                │ attach / detach
    └──drives──▶ Runtime session  (swappable, restartable, plural)
```

agentproto already supports this: `sandbox_attach` is connect-never-boot,
returns a durable connection descriptor, imposes no refcount or lease, and
permits any number of concurrent attachers (`sandbox-attach.ts:103-176`).

What it buys, all of it structural:
- Restart the agent without losing the room or the URL.
- Swap the brain mid-room.
- Run more than one agent in the same room (§9.4).
- R8 and R10 stop being special cases: room lifecycle governs the box, so
  re-serve-on-resume and idle-pause are room concerns with an obvious owner.

### 9.2 RoomRuntime — the three verbs

A room needs exactly three things from whatever is thinking:

```ts
interface RoomRuntime {
  start(spec: RoomSpec, sandboxId: string): Promise<RuntimeSessionId>
  postTurn(id: RuntimeSessionId, attributed: string): Promise<void>  // MUST NOT DROP
  subscribe(id: RuntimeSessionId, cursor: Cursor): AsyncIterable<RuntimeEvent>
}
```

`postTurn` must not drop when the runtime is mid-turn. That one line is the
whole multiplayer contract, and it is the line every single-principal runtime
leaves unwritten.

### 9.3 Two ways to put another brain in the box

**Correction to an earlier draft of this section**, which proposed building an
OpenAI adapter on top of `codex exec-server`. That is the harder of two paths
and it is not the one to take first.

**(A) A local adapter in our box. Free today.**

The host already has **19 installed adapters**, all speaking ACP to the same
session interface — verified via `adapter_list`:

| adapter | protocol | notable models |
| --- | --- | --- |
| `codex` | acp | gpt-5.2-codex, gpt-5.1-codex-max, gpt-5.6-sol |
| `claude-code` | acp | fable-5.1, opus, sonnet, haiku |
| `gemini` | acp | gemini-3.5-flash, gemini-3.1-pro |
| `grok-cli` | acp | grok-4.6 |
| `kimi-cli` | acp | kimi-k3 |
| `mistral-vibe` | acp | mistral-vibe-cli, mistral-large |
| `opencode`, `hermes`, `jcode`, `mastracode` | acp/print | 400 to 550 routed models each |

A sandbox spec's `installAdapters` installs any of them **inside the box**, and
the box's own daemon spawns it there. So the second brain is one parameter:

```
agent_start({
  adapter: "codex",                         // was "claude-code"
  model:   "gpt-5.2-codex",
  sandbox: { provider: "e2b", config: { installAdapters: ["codex"] } },
  appServe: { dir: "...", port: 3210 },
})
```

Same box. Same filesystem. Same public artifact URL. Different brain, running
**locally in the room's own sandbox**, on its own CLI auth. Zero new code.

**Proved 2026-09-12: does not hold as stated.** One fresh e2b boot with only
`adapter` and `model` changed failed at the auth gate: a fresh box has no codex
credentials. `installAdapters` installs the binary, not the login. The daemon
destroyed the box on failure, so the mechanical swap (same box, seed, port,
different CLI) is plausible from source but unobserved. The real second-brain
work is the credential model described below (device-auth first), not the
adapter swap. Full spawn body and errors: `docs/CODEX-FLIP.md`.

This reframes §9.4 completely. "Bring your own agent" is not the expensive
stretch goal — it is the **cheapest** big idea we have, because the adapter
layer already did the work. A room can host Claude, Codex, Gemini and Mistral
on one filesystem today.

**(B) The hosted Agents API. Secondary.**

Their self-hosted sandbox option runs `codex exec-server` in our box over an
outbound WebSocket, with OpenAI's managed harness driving it from their
servers. It buys their orchestration, context compaction and recovery, and it
costs a real adapter.

Worth building only if (A) proves the point and we want the contrast on stage:
same room, one brain local in our box, one brain hosted on theirs.

**Auth in a box — resolved, and better than a shared API key.**

`codex login` exposes three non-interactive paths (`codex login --help`):

| flag | what it does |
| --- | --- |
| `--device-auth` | device-code flow: box prints a code + URL, human approves elsewhere |
| `--with-access-token` | reads a ChatGPT access token from stdin |
| `--with-api-key` | reads an API key from stdin |

Locally, `~/.codex/auth.json` is `auth_mode: "chatgpt"` and holds OAuth
material (`id_token`, `access_token`, `refresh_token`, `account_id`) **and** an
`OPENAI_API_KEY`. agentproto passes secrets into a box as **env-var slugs**
resolved through the broker (`session-spawn.ts:3427-3448`), never from
`process.env`, and mounts no files (`sandbox-providers/registry.ts:35`,
`mounts: false`).

**Nothing is sent automatically.** A box gets a credential only if the spec
declares it in `env.passthrough`. There is no implicit forwarding of your
local login.

Ranked for our use:

1. **`--device-auth` — the right default.** No secret of yours ever leaves your
   machine. The box prints a code, the member approves it on their own phone or
   laptop, and the box holds tokens *that member* authorised. It is also the
   same gesture as joining the room: a short code on one screen, approved on
   another.
2. **`--with-access-token` + `env.passthrough: ["CODEX_ACCESS_TOKEN"]`.**
   Subscription billing, env-shaped, and **only the access token travels — the
   long-lived `refresh_token` stays home.** This is the automated room-boot
   path.
3. **`--with-api-key`.** Simplest, but bills API rates and drops the account
   association.

**Correction to an earlier draft**, which said subscription auth cannot reach a
box and recommended an API key. `--with-access-token` makes it env-shaped, and
`--device-auth` removes the need to ship anything at all. The API key is now
third choice, not first.

**This is what makes "bring your own agent" real.** Each member device-auths
their **own** subscription into the room's box. Alice bills her Claude Max, Bob
bills his ChatGPT. No shared keys, no pooled credential, and cost attribution
per member falls out for free. That is a materially better story than "we have
a key in an env file", and it is the same interaction the room already teaches
people: scan, approve, you are in.

**And it re-opens the fourth presence tier.** With device auth the box is
authenticated as that member's actual account, so the auth precondition for
"see it in your own Codex" is now cleanly satisfiable. Whether Codex syncs
session history server-side is still unverified, and the box's own
`~/.codex/sessions` still lives in the box. The session-file lift (copy the
box's session out, resume locally) remains the variant that depends on nothing
OpenAI has to give us. Test both; claim neither yet.

**Credential scope is a room-spec policy, not a global decision.**

You do not have to choose "device-auth every sandbox" or "ship my key
everywhere". agentproto already models the middle: a **named auth profile**
(`~/.agentproto/auth-profiles.json`, `auth_profile_list`), referenced at spawn
as `access: { profileRef }`. A profile stores non-secret metadata plus a key
identity; the secret itself never appears in a listing.

This host already carries one for Codex:

```
{ id: "codex-local", endpoint: "openai", method: "oauth-bearer",
  source: "codex", label: "My Codex login",
  models: ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"],
  keyStatus: "self-refreshing" }
```

`keyStatus` is the axis that matters:

- **`self-refreshing`** — read fresh from the local login on every spawn
  (`~/.codex/auth.json` for codex, the Keychain for claude-code). agentproto
  stores nothing. Host-bound.
- **`stored`** — held in agentproto's own credential store behind a
  `credentialRef`, with a one-way fingerprint. Reusable, portable across boxes.

So the room spec carries an `auth` field with three modes:

| mode | who approves | stored where | friction | bills |
| --- | --- | --- | --- | --- |
| `profile` | nobody, uses `profileRef` | host profile store | none | room owner |
| `device` | every member, every room | nowhere, dies with the box | per room | each member |
| `device-once` | member, first room only | that member's minted profile | once ever | each member |

**`device-once` is the default we want.** A member device-auths the first time
they ever join a room; we mint them a profile from it; every later room
references `profileRef` and they are never asked again. One approval, N rooms,
per-member billing, and no pooled credential anywhere.

Reserve `device` for a room spec that declares itself sensitive, and `profile`
for solo or development rooms where the operator is the only human.

**Tool grants belong to the room.** Everything above is about which *model*
account authenticates the box. A separate question, easy to conflate with it:
a room is multiplayer, so any *tool* granted to the room is granted to every
member of it. Credentials for those tools must be scoped per member and per
room — never inherited from whoever happened to boot the box. Concretely:
agentpush API keys have exactly three scopes, `send-only`, `read-only`, `full`
(`packages/core/src/domain/api-keys/schema.ts:4` in the read-only checkout) —
none of them per-member. "Let the agent read email" as a room capability would
hand the whole workspace mailbox to anyone who has the room code, not just the
member who connected it. The email presence tier itself never needs this:
inbound mail becomes a room turn through the `rendez-vous-mail` route
(docs/AGENTPUSH.md §8.3), which is routing a message in, not granting mailbox
access. Per-member tool scoping is phase 2; sketched next.

**Tool grants without a shared credential — pair the box back to the
member.** Don't scope the credential harder inside the box — keep it out of
the box entirely. Invert pairing's usual direction: tier 3b (§2.2, §6) is a
laptop pairing *into* a room's daemon. Here the box pairs *out*: the
**member's own daemon** mints the offer as `side=daemon` (`pair_offer`,
`pairing-tools.ts:45-83`; URL built `side=daemon&t=<token>`,
`pairing-registry.ts:600`), and the **box** is the `side=client` accepting
that offer — the broker caps nothing per-daemon, only per-token (`offers`
map `pairing-registry.ts:243`, `channels` set `:247`, independent loop per
token `:462`, cited in §2.2). Spliced, the room reaches that member's tools
through that member's own daemon. No Gmail credential, no agentpush key, no
token for that member ever enters the box.

Properties:
- **Per-member by construction.** Alice attaches her daemon and the room
  reaches her Gmail as Alice; Bob attaches his, reaches his tools as Bob.
  Neither inherits the other's — there is no shared credential to inherit.
- **Revocation is an unpair, not a key rotation.** `pair_revoke` drops the
  splice and blocks reconnection (`pairing-tools.ts:104-121`); nothing to
  rotate because nothing was ever copied into the box.
- **Same argument as device-auth above, aimed at tools not models.** The
  secret never leaves the member's machine, because that machine is where
  the tool call actually executes.
- **Answers "a stranger has your room code" with a design, not a caveat.**
  A stranger who joins gets the room — transcript, artifact, typing. They
  get no one's tools; no member's daemon has paired with them.

**Untested by us — what would have to be verified:** network egress from a
sandboxed box out to the broker (providers may restrict outbound WS); which
side mints the token in this topology (the code fixes the offering party as
`side=daemon`, `pairing-registry.ts:600`, so the member offers and the box
accepts — never driven with a sandboxed box as the accepting client, only a
human laptop); what the box's own daemon exposes to the room agent after
pairing (the seam from "box holds a live pairing" to "room agent can call a
member's tool through it" is not built); and what scope the paired daemon
grants — per this doc's own R6, a paired client gets the **entire** daemon
surface today, owner bearer injected, `authorize: req => req`
(`tunnel-serve.ts:62-67`, `:167-169`). Pairing back solves *whose* credential
is used, not *how much* the room can do with it — per-tool narrowing still
has to happen on the member's side; this relocates the R6 gap, it doesn't
close it.

**One consequence worth designing around:** subscription auth gates the model
list. The `codex-local` profile allows only `gpt-5.6-luna | sol | terra` — the
ChatGPT-tier models — while the adapter manifest lists 38 including
`gpt-5.2-codex`. An API key reaches the API models; a subscription reaches the
subscription models. A room spec that names a model must therefore be
compatible with the auth mode it asks for, and the spec validator should catch
that mismatch at boot rather than at first turn.

**The experiment that decides how loud we are.** The Agents API docs do not
specify what happens when input arrives mid-turn (§1.3). Two outcomes, both
good: it queues, and the room is portable; or it errors, and our layer has to
supply multiplayer that their runtime does not have. Run it. Do not assume.

### 9.3b The artifact URL must outlive the box

**The gap, as shipped.** `src/fanout/render.ts:19` appends the room's raw
`artifactUrl` to outbound messages, and `src/fanout/reader.ts:112` re-sends it
whenever it changes. That URL is e2b's own:
`https://<port>-<sandboxId>.e2b.app`, a pure function of sandbox id and port
(`sandbox-e2b/src/provider.ts:274-276`).

Stable for a given box. **Not stable across box replacement.** And boxes get
replaced: a pre-warmed box expires within 20 to 60 minutes while the local
ledger still calls it `paused` (see `docs/DEMO.md` §1), a resume can cold-boot,
a box can die.

So the failure is concrete: Alice has the artifact link in her WhatsApp thread.
The room resumes onto a fresh box. Her link is dead. The code does re-send a
new one, so she is not stranded, but the thread now holds a broken link and
anyone who scrolled up or bookmarked gets a dead page. Step 4 of the demo
script is *resume after kill*, so this is on the critical path, not a corner
case.

**The fix needs no new tunnel.** The service already runs behind cloudflared at
`RDV_PUBLIC_URL` — it has to, for agentpush webhooks and join links. Add one
route on it:

```
GET /r/:code/artifact/*   →  look up room.artifactUrl  →  reverse-proxy
```

Which gives `https://<rdv-host>/r/RDV-7F3K/artifact`:

- **stable forever**, because it is keyed on the room code, not the box;
- survives box replacement, cold boot and pause/resume with no re-send;
- same shape as the join link already in the QR, so one mental model;
- same origin as the room web view, so the artifact iframe has no
  cross-origin problem;
- gateable to room members, which the raw e2b URL never was — today that URL
  is public to anyone who has it.

**Proxy, not redirect.** A `302` is less code but puts the ephemeral e2b origin
in the browser bar, so the viewer's tab goes stale the moment the box changes.
A reverse proxy keeps the stable URL in the bar for the whole session.

The cost is that the service must be up whenever anyone views the artifact. It
already must be up for messaging and the web room, so this adds no new
dependency.

**Tunnel choice matters more than it looks.** `scripts/tunnel.sh --quick` mints
a fresh random `*.trycloudflare.com` on every run, so a restart silently
invalidates every join link and QR already sent. `--named` keeps a stable
hostname across restarts. For anything rehearsed or printed in advance, use
`--named`.

Optional polish, not required: wildcard DNS (`RDV-7F3K.rdv.<host>`) resolving
to the same proxy. Prettier on stage, needs a wildcard cert and a named tunnel,
and buys nothing functional over the path form.

### 9.4 Two agents, one room

Once the box is room-owned and runtimes are pluggable, a room can host more
than one brain on the same filesystem. Two framings, in order of how novel
they are:

- **Bring your own agent.** Alice's Claude and Bob's GPT, same room, same
  artifact. Multiplayer extended from humans to models. Nobody has this.
- **Builder and reviewer.** One writes, one critiques, both visible in the
  transcript.

The hazard is real: two writers on one filesystem interleaving turns. Do not
hand-wave it. The room already serialises human input through a queue; the
same lock has to cover agents, or each agent gets a lane it alone may write.
Land it only with the collision story written down.

### 9.5 Frozen order for phase 2

1. Land everything in flight and get the demo rehearsed. Phase 2 starts from a
   green, rehearsed MVP or not at all.
2. Room spec (§2.3) as a real file format, with the current hardcoded boot as
   its first spec.
3. Invert ownership (§9.1): room owns `sandboxId`, sessions attach.
4. **Second brain, path (A)**: boot a room with `adapter: "codex"` in the same
   spec. One parameter. This is now the cheapest proof that the room is
   brain-agnostic, so it comes before any interface extraction.
5. Extract `RoomRuntime` (§9.2) once two brains have actually run, so the
   interface is shaped by two real implementations rather than one and a guess.
6. Test the session-file lift (§9.3): copy the box's codex session out and
   resume it locally. A fourth presence tier if it works, and it depends on
   nothing OpenAI has to give us.
7. Run the concurrent-input experiment against the Agents API (§9.3).
8. §9.4 multi-brain rooms, with the collision story settled first.
9. Path (B), the hosted Agents API adapter, only if the contrast is worth it.
