# Speaker script — ~4:00

Plain spoken sentences, one timestamp per slide. Read at a normal pace;
padding is intentional (Run 3's own timings run long — don't rush them).

## 0:00 — Slide 1: Title

"This is Rendez-vous. One room, one agent, one artifact — and many humans,
on the surfaces they already use."

## 0:12 — Slide 2: The week

"This week, OpenAI shipped the Agents API: nine sandbox partners, one API
call. The durable sandbox is now a commodity. But every single one of those
nine is single-principal — one key, one developer, one session. The
uncontested ground isn't the sandbox. It's the room around it."

## 0:32 — Slide 3: The room primitive

"A room is simple: a durable code, many members, three tiers, one agent
session, one artifact URL. That's the whole primitive."

## 0:45 — Slide 4: The fidelity ladder

"Same room, same agent, three levels of presence. WhatsApp or Telegram get
a terse final reply. Email gets a per-turn digest. The laptop room view
gets the full transcript and a live artifact iframe. Telegram and the
laptop are already two real surfaces, not a mockup."

## 1:07 — Slide 5: Run 3

"Here's what actually happened, live, on a real phone. A real operator
typed 'new' on real Telegram. Eighty-six and a half seconds later, cold
boot, the session and the artifact were both ready. Bob joined from the
laptop. The stream shows attribution on every message — Bob tagged
room-web, the operator tagged messenger. The agent found the artifact file
on its own and edited it live. Delivery to the phone itself is
operator-confirmed — that's the honest caveat, and I'll say it again on the
limits slide."

## 1:40 — Slide 6: The silent-failure class

"This is the strongest thing we found — and the sharpest one arrived
tonight, live, on a real phone. Our own liveness check tested whether the
HTTP call succeeded, not whether the session was still alive: a killed
session still answers 200. So resume reported success in seven tenths of a
second having resumed nothing, and a message to the room was accepted,
then failed later, on the phone. Here's the distinction that matters: the
other four bugs lost data quietly. This one is worse — it reported success
while doing nothing. And the fix was sitting right there: the correct
field was already being parsed by the function next to it; this one just
never looked. It passes review, it passes tests, and it only fails when
something dies out of band — which never happens in a test suite and
always happens on stage. The other four: omit queue: true and a mid-turn
message vanishes; resume a session and the fan-out cursor freezes, so
every reply after it vanishes too; pin an inbound route to one account and
it silently never fires; ask the agent for Gmail access it already
effectively has, and it confidently proposes rebuilding it from scratch.
None of these five crash. All look like working code or correct
configuration. This is evidence you only get by running it."

## 2:35 — Slide 7: Credentials per-member

"A shared room holding one API key shares it with everyone who has the
room code. We didn't want that. Our position: each member attaches their
own tools over rendezvous, and nothing is inherited. Revocation is an
unpair, not a key rotation, because there was never a shared secret to
rotate in the first place."

## 2:53 — Slide 8: Second brain is a parameter

"Same box, same filesystem, same public artifact URL — swap one parameter
and the brain driving it changes. Nineteen adapters are already installed
on our runtime, all speaking the same protocol. This is pending the codex
proof — we haven't run it live yet, so take it as the next thing we ship,
not a claim we're making today."

## 3:11 — Slide 9: Built on our own runtime

"Rendez-vous runs on our own open-source agent runtime, unmodified,
installed straight from npm — no fork, no vendored copy. The room layer on
top of it is every line that's new, and that's the judged artifact. Along
the way we found eight bugs in our own runtime and wrote them up for our
own maintainers, not just for this pitch."

## 3:29 — Slide 10: Honest limits

"Two rehearsals were simulated end to end — no phone, no real workspace.
Run three was real: real Telegram, real web, live. Paused sandboxes expire
in twenty to sixty minutes, and tonight that happened live too — a box
expired mid-rehearsal and the room kept advertising its now-dead artifact
link, exactly what the architecture doc predicted before we ever ran it.
Resume-after-kill and that dead link are fixed after this rehearsal, but
not yet re-proved live — and a room-scoped, proxied artifact URL is now
being built ahead of voice and multimodal, so the link stops dying with
the box. We're also sharing an existing workspace's Telegram routing, so
an existing catch-all route can fire alongside ours on the same message —
that's a real risk of a double reply, not a hypothetical. WhatsApp was
never provisioned. And the phase-two credential pairing is designed but
untested. No dressing this up."

## 3:57 — Slide 11: Close

"The room is the primitive. The runtime is a detail."

---

# Shot list

| # | Beat | On screen | Which live screen |
| --- | --- | --- | --- |
| 1 | Cold open | Slide 1 | — |
| 2 | Market claim | Slide 2 | — |
| 3 | Primitive definition | Slide 3 | — |
| 4 | Fidelity ladder | Slide 4 | — |
| 5 | Cut to live proof | Terminal | Terminal (curl to `/rooms/:code`) |
| 6 | Real Telegram thread | Live screen | Telegram thread |
| 7 | Laptop room view | Live screen | Room web page (`rdv.clipgen.co/r/RDV-NG7F`) |
| 8 | Artifact before/after edit | Live screen | Artifact URL |
| 9 | Back to the run summary | Slide 5 | — |
| 10 | The silent-failure argument | Slide 6 | — |
| 11 | Credentials position | Slide 7 | — |
| 12 | Second-brain parameter | Slide 8 | — |
| 13 | Runtime honesty | Slide 9 | — |
| 14 | Limits, unvarnished | Slide 10 | — |
| 15 | Close | Slide 11 | — |

Cut 5–8 (the live proof block) run under the slide-5 narration; either play
them as a pre-recorded clip timed to 1:15–1:50, or cut live to the actual
surfaces in that order if presenting in person.
