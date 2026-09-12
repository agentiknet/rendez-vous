# Speaker script — ~4:00

Plain spoken sentences, one timestamp per slide. Read at a normal pace —
padding is intentional; Run 3's own timings run long, don't rush them.

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

"This is the strongest thing we found — the sharpest one arrived tonight,
live, on a phone. Our liveness check read whether the HTTP call succeeded,
not whether the session was alive — so a killed session still answered
200, and resume reported success in seven tenths of a second having
resumed nothing. Here's the distinction: the other four bugs lost data
quietly; this one reported success while doing nothing, and the correct
field was already sitting one function over. It only fails when something
dies out of band — never in a test suite, always on stage. The other four:
omit queue: true and a message vanishes; resume and the fan-out cursor
freezes, so replies after it vanish too; pin an inbound route to one
account and it silently never fires; ask for Gmail access the agent
already has, and it proposes rebuilding it from scratch. None of these
five crash. All look like working code or correct configuration — this is
evidence you only get by running it."

## 1:53 — Slide 7: Credentials per-member

"A shared room holding one key shares it with everyone who has the room
code. Our position: each member attaches their own tools over rendezvous
— nothing inherited. Revocation is an unpair, not a key rotation, because
there was never a shared secret to rotate."

## 2:07 — Slide 8: Why a room, not two people and one bot

"Here's why this is a room, not two people texting a bot. The agent
addresses Alice and Bob individually and reconciles what each contributes:
it asks Alice for the product shot, asks Bob for the one-line positioning,
each answers on their own channel, in their own time, and the agent
synthesizes both into the deck, which goes to the client as a PDF.
Specced, not yet built."

## 2:28 — Slide 9: The swap needs a login first

"We tested this live, and the one-parameter claim doesn't hold as stated.
A fresh box has no codex credentials — installAdapters installs the
binary, not the login — so the boot failed at the auth gate before the
swap itself could even run. The mechanical part, same box, same seed, same
port, a different CLI, is plausible from the source, but unobserved. The
real second-brain work is the credential model — device-auth — not the
adapter swap."

## 2:51 — Slide 10: Built on our own runtime

"Rendez-vous runs on our own open-source runtime, unmodified, from npm —
no fork, no vendored copy. The room layer is every line that's new — the
judged artifact. We also found eight bugs in our own runtime and wrote
them up for our own maintainers."

## 3:05 — Slide 11: Honest limits

"Two rehearsals were simulated; run three was real: Telegram and web,
live. Paused sandboxes expire in twenty to sixty minutes, and tonight that
happened live too — a box expired mid-rehearsal and the room kept
advertising its dead link, exactly as predicted. That fix, and
resume-after-kill, are fixed after this rehearsal but not yet re-proved
live. We share an existing workspace's Telegram routing, so its catch-all
route can fire alongside ours, risking a double reply. WhatsApp was never
provisioned, and phase-two credential pairing is designed but untested."

## 3:32 — Slide 12: The deliverable flow

"This is the sharpest test of what a room can actually do. Jeremy asks for
a presentation, reviews it live at the artifact URL, then asks for a PDF.
The room previews it first — recipient, channel, subject, rendered
artifact — and sends only when a member explicitly confirms. The PDF
reaches Jeremy's messenger, and by email, a client outside the room. Every
send lands in the shared transcript: who asked, who confirmed, what, to
whom. Every other capability keeps work inside the room; this one lets it
leave — and the confirmation gate means authority, not just relay. Being
built, not yet observed."

## 4:04 — Slide 13: Close

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
| 12 | The middleman arc — why a room | Slide 8 | — |
| 13 | Second brain: credential, not swap | Slide 9 | — |
| 14 | Runtime honesty | Slide 10 | — |
| 15 | Limits, unvarnished | Slide 11 | — |
| 16 | Deliverable flow — ask for the PDF | Live screen | Telegram thread (phone) |
| 17 | Deliverable flow — the preview | Live screen | Room web page (laptop) |
| 18 | Deliverable flow — confirm | Live screen | Telegram thread (phone) |
| 19 | Deliverable flow — PDF arrives | Live screen | Telegram thread (phone) |
| 20 | Deliverable flow — client sees it | Live screen | Client inbox |
| 21 | Deliverable flow — slide recap | Slide 12 | — |
| 22 | Close | Slide 13 | — |

Cut 5–8 run under the slide-5 narration; play as a pre-recorded clip timed
to 0:36–1:00, or cut live if presenting in person. Beats 16–20 and the
slide-8 middleman arc are not yet observed (`docs/REHEARSAL.md`) — narrate
slides 8 and 12 straight until built and rehearsed.
