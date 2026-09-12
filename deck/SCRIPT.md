# Speaker script — ~4:00

Plain spoken sentences, one timestamp per slide. Read at a normal pace;
padding is intentional (Run 3's own timings run long — don't rush them).

## 0:00 — Slide 1: Title

"This is Rendez-vous. One room, one agent, one artifact — and many humans,
on the surfaces they already use."

## 0:06 — Slide 2: The week

"This week, OpenAI shipped the Agents API: nine sandbox partners, one API
call. Every one of those nine is single-principal — one key, one
developer, one session. The uncontested ground isn't the sandbox. It's the
room around it."

## 0:18 — Slide 3: The room primitive

"A room is simple: a durable code, many members, three tiers, one agent
session, one artifact URL."

## 0:23 — Slide 4: The fidelity ladder

"Same room, same agent, three levels of presence. WhatsApp or Telegram get
a terse final reply, email gets a per-turn digest, the laptop room view
gets the full transcript and a live artifact iframe. Telegram and the
laptop are already two real surfaces."

## 0:36 — Slide 5: Run 3

"Here's what actually happened, live, on a real phone. A real operator
typed 'new' on real Telegram; eighty-six and a half seconds later, cold
boot, the session and artifact were ready. Bob joined from the laptop. The
stream shows attribution on every message — Bob tagged room-web, the
operator tagged messenger. The agent found the artifact file on its own
and edited it live. Delivery to the phone is operator-confirmed — I'll say
that again on the limits slide."

## 1:00 — Slide 6: The silent-failure class

"This is the strongest thing we found — and the sharpest one arrived
tonight, live, on a phone. Our own liveness check tested whether the HTTP
call succeeded, not whether the session was alive: a killed session still
answers 200. So resume reported success in seven tenths of a second having
resumed nothing, and a message was accepted, then failed later, on the
phone. Here's the distinction: the other four bugs lost data quietly. This
one reported success while doing nothing — the correct field was already
sitting one function over, and this one just never looked. It only fails
when something dies out of band, which never happens in a test suite and
always happens on stage. The other four: omit queue: true and a mid-turn
message vanishes; resume a session and the fan-out cursor freezes, so
every reply after it vanishes too; pin an inbound route to one account and
it silently never fires; ask for Gmail access the agent already has, and
it proposes rebuilding it from scratch. None of these five crash. All look
like working code or correct configuration. This is evidence you only get
by running it."

## 2:00 — Slide 7: Credentials per-member

"A shared room holding one key shares it with everyone who has the room
code. Our position: each member attaches their own tools over rendezvous
— nothing inherited. Revocation is an unpair, not a key rotation, because
there was never a shared secret to rotate."

## 2:14 — Slide 8: Second brain is a parameter

"Same box, same filesystem, same public artifact URL — swap one parameter
and the brain changes. Nineteen adapters are already installed, all
speaking the same protocol. This is pending the codex proof — the next
thing we ship, not a claim we're making today."

## 2:28 — Slide 9: Built on our own runtime

"Rendez-vous runs on our own open-source runtime, unmodified, from npm —
no fork, no vendored copy. The room layer on top is every line that's new,
the judged artifact. Along the way we found eight bugs in our own runtime
and wrote them up for our own maintainers."

## 2:42 — Slide 10: Honest limits

"Two rehearsals were simulated — no phone, no real workspace. Run three
was real: Telegram and web, live. Paused sandboxes expire in twenty to
sixty minutes, and tonight that happened live too — a box expired
mid-rehearsal and the room kept advertising its dead artifact link,
exactly as predicted. That fix, and resume-after-kill, are fixed after
this rehearsal but not yet re-proved live; a room-scoped proxied artifact
URL is now being built to close that gap for good. We also share an
existing workspace's Telegram routing, so its catch-all route can fire
alongside ours, risking a double reply. WhatsApp was never provisioned,
and the phase-two credential pairing is designed but untested."

## 3:17 — Slide 11: The deliverable flow

"One more thing, because it's the sharpest test of what a room can
actually do. In the room, Jeremy asks for a presentation, reviews it live
at the artifact URL, then asks for a PDF. The room previews it first —
recipient, channel, subject, the rendered artifact — and sends only when a
member explicitly confirms. The PDF reaches Jeremy's own messenger, and by
email, a client who isn't a member of the room at all. Every send lands in
the shared transcript: who asked, who confirmed, what was sent, to whom.
Every other capability keeps work inside the room; this one lets the room
produce a work product that leaves it, and that confirmation gate is a
room with a notion of authority, not just relay. This is being built, not
yet observed."

## 3:58 — Slide 12: Close

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
| 15 | Deliverable flow — ask for the PDF | Live screen | Telegram thread (phone) |
| 16 | Deliverable flow — the preview | Live screen | Room web page (laptop) |
| 17 | Deliverable flow — confirm | Live screen | Telegram thread (phone) |
| 18 | Deliverable flow — PDF arrives | Live screen | Telegram thread (phone) |
| 19 | Deliverable flow — client sees it | Live screen | Client inbox |
| 20 | Deliverable flow — slide recap | Slide 11 | — |
| 21 | Close | Slide 12 | — |

Cut 5–8 (the live proof block) run under the slide-5 narration; either play
them as a pre-recorded clip timed to 0:36–1:00, or cut live to the actual
surfaces in that order if presenting in person. Beats 15–19 (the
deliverable flow) are not yet observed end to end (see `docs/REHEARSAL.md`)
— record them live only once the feature is built and rehearsed; until
then, narrate slide 11 straight and skip the live cut.
