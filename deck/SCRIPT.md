# Speaker script — ~4:00

Plain spoken sentences, one timestamp per slide. Read at a normal pace.
Slides 10–13 are appendix — Q&A material, not part of the timed read; skip
past them unless a question calls for one.

## 0:00 — Slide 1: Title

"This is Rendez-vous. One room, one agent, one artifact — and many humans,
on the surfaces they already use."

## 0:08 — Slide 2: The problem

"Work is multiplayer. Agents are single-player. Every agent you use today
lives in exactly one person's window."

## 0:20 — Slide 3: The consequence

"So the human becomes the integration layer: a copy-paste relay between two
chat windows, a screenshot forwarded to the other side, 'let me ask the AI
and get back to you.' The second person never sees the context. The
deliverable dies inside one private thread."

## 0:42 — Slide 4: The solution

"The room. One agent session, many humans, on the surfaces they already
use. No install, no shared login, no new app. And the timing works in our
favor: sandboxes are commodity now — nine partners, one API call — and
every single one of them is still single-principal. The uncontested ground
isn't the sandbox. It's the room around it."

## 1:02 — Slide 5: The product working

"Here's the product working, live, on a real phone. Someone typed 'new' on
real Telegram; eighty-six and a half seconds later, cold boot, the session
and artifact were ready. A second person joined from the laptop. Every
message in the stream is attributed — room-web tagged one way, the phone's
messenger tagged another. The agent found the artifact file on its own and
edited it live. Delivery to the phone: confirmed."

## 1:28 — Slide 6: How we built it

"One pipeline: agentpush ingress, into a room — many contacts, one session
— fan-out by presence tier, an e2b sandbox, one artifact URL. WhatsApp and
Telegram get quick text in, terse replies out. Email gets a per-turn
digest. The laptop room view gets the full transcript and the live
artifact. All of it built on our own open-source runtime — unmodified,
straight from npm."

## 1:52 — Slide 7: The designed call

"A shared room holding one key would share it with everyone who has the
room code. So we didn't design it that way: each member attaches their own
tools over rendezvous — nothing inherited. Revocation is an unpair, not a
key rotation, because there was never a shared secret to rotate."

## 2:10 — Slide 8: Work leaves the room

"This is the sharpest test of what a room can do. Jeremy asks the room to
build a presentation, reviews it live at the artifact URL, then asks for a
PDF. The room previews it first — recipient, channel, subject, the
rendered artifact — and sends only when a member explicitly confirms. The
PDF reaches Jeremy's own messenger, and by email, a client who isn't a
member of the room. Every send lands in the shared transcript: who asked,
who confirmed, what, to whom. This is a room with a notion of authority,
not just relay."

## 2:38 — Slide 9: Close

"The room is the primitive. The runtime is a detail."

---

## Appendix (Q&A material — not read in the timed pass)

**Slide 10 — the five findings.** One shape, five independent bugs. A
killed session still answers 200, so resume reported success in seven
tenths of a second having resumed nothing — found live, tonight, on a
phone. The other four: omit `queue: true` and a message vanishes; resume
and the fan-out cursor freezes, so replies after it vanish too; pin an
inbound route to one account and it silently never fires; ask for Gmail
access the agent already has, and it proposes rebuilding it from scratch.
Four of these five lost data quietly. This one reported success while
doing nothing. None crash. All look like working code or correct
configuration.

**Slide 11 — honest limits.** Resume-after-kill is fixed but not yet
re-proved on a real phone. Paused sandboxes expire in 20 to 60 minutes —
one did, live, mid-rehearsal, and the room kept advertising its dead
link. WhatsApp was never provisioned. We share an existing workspace's
Telegram routing, so its catch-all route can fire alongside ours, risking
a double reply.

**Slide 12 — the codex verdict.** We tested swapping the agent's brain for
Codex live. It doesn't hold as stated: a fresh box has no codex
credentials, `installAdapters` installs the binary, not the login, so the
boot failed at the auth gate before the mechanical swap could even be
observed. The real second-brain work is the credential model —
device-auth — not the adapter swap.

**Slide 13 — the middleman arc.** Why a room, not two people texting a
bot: the agent addresses members individually and reconciles what each
contributes. It asks Alice for the product shot, asks Bob for the one-line
positioning, each answers on their own channel in their own time, and the
agent synthesizes both into the deck. Specced, not yet built.

---

# Shot list

| # | Beat | On screen | Which live screen |
| --- | --- | --- | --- |
| 1 | Cold open | Slide 1 | — |
| 2 | The problem | Slide 2 | — |
| 3 | The consequence | Slide 3 | — |
| 4 | The solution | Slide 4 | — |
| 5 | Cut to live proof | Terminal | Terminal (curl to `/rooms/:code`) |
| 6 | Real Telegram thread | Live screen | Telegram thread |
| 7 | Laptop room view | Live screen | Room web page (`rdv.clipgen.co/r/RDV-NG7F`) |
| 8 | Artifact before/after edit | Live screen | Artifact URL |
| 9 | Back to the product-working recap | Slide 5 | — |
| 10 | How we built it | Slide 6 | — |
| 11 | The designed call | Slide 7 | — |
| 12 | Work leaves the room — ask for the PDF | Live screen | Telegram thread (phone) |
| 13 | Work leaves the room — the preview | Live screen | Room web page (laptop) |
| 14 | Work leaves the room — confirm | Live screen | Telegram thread (phone) |
| 15 | Work leaves the room — PDF arrives | Live screen | Telegram thread (phone) |
| 16 | Work leaves the room — client sees it | Live screen | Client inbox |
| 17 | Work leaves the room — slide recap | Slide 8 | — |
| 18 | Close | Slide 9 | — |
| — | Q&A: findings | Slide 10 | — |
| — | Q&A: honest limits | Slide 11 | — |
| — | Q&A: codex verdict | Slide 12 | — |
| — | Q&A: middleman arc | Slide 13 | — |

Cut 5–8 run under the slide-5 narration; play as a pre-recorded clip timed
to 1:02–1:28, or cut live if presenting in person. Beats 12–16 are not yet
observed live end-to-end through the room's own flow (`docs/REHEARSAL.md`)
— narrate slide 8 straight until rehearsed through the room itself rather
than a side script.
