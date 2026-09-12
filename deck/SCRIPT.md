# Speaker script — 6 pages, ~2:30

Written backwards from the last line. Page 6 is the claim; pages 5 to 1 exist
only to make it unarguable by the time we get there. If a sentence doesn't
earn the close, it isn't in the deck.

The appendix at the bottom is Q&A material and is **not** part of the six.

---

## Page 6 — the close (written first)

> "The room is the primitive. The runtime is a detail."

Everything above has to make both halves land. *Primitive*, because the room
holds things no runtime holds: who is in it, who said what, what was agreed,
what is allowed to leave. *A detail*, because the runtime under it is one
swappable layer and we show you exactly where the seam is.

## Page 5 — work leaves the room, on purpose

> "Every capability so far keeps work inside the room. This one lets it leave.
> Someone asks for the PDF. The room previews it first — recipient, channel,
> subject, the rendered document — and it goes out only when a member
> confirms. It lands on a phone and in an inbox, and the send is written into
> the shared transcript: who asked, who confirmed, what, to whom.
> That's a room with a notion of authority, not a relay."

*Earns "primitive": a thing with membership and authority is not a feature of
an agent, it's the layer above one.*

## Page 4 — the stack

> "One pipeline. **agentpush** is the ingress and the egress — Telegram,
> WhatsApp, email, SMS behind one API, so the room never learns a single
> provider's quirks. Rendez-vous is the room itself: members, attribution,
> fan-out by tier. Under it, **agentproto** — our own open-source agent
> runtime, unmodified, installed from npm. Under that, an **e2b** sandbox, one
> per room, holding the shared artifact. OpenAI does the voice and the vision;
> canvakit renders the PDF."

*Earns "the runtime is a detail": you can see it is one layer with a clean
seam above and below. Swap it and the room doesn't move.*

## Page 3 — it works, live

> "Someone typed `new` on a real phone. Eighty-six and a half seconds later,
> cold boot, the session and the artifact were ready. A second person joined
> from a laptop. Every message attributed, on every surface. A voice note goes
> in and comes back transcribed and attributed to whoever sent it. A photo goes
> in and the agent describes it into the artifact. Someone asks a question
> privately and only they get the answer — the others see that a whisper
> happened, not what it said. The agent edits the artifact unaided, and it can
> reply with a voice note of its own."

*Earns the whole deck: none of this is a mock.*

## Page 2 — the room, and who is in it

> "Four members, four surfaces, one session. Alice is on Telegram. Bob is on a
> laptop. There's an inbox. And Atlas is a **local desktop agent** — a machine
> member, joined the same way, speaking and listening through the same two
> endpoints as the humans. When the room needs something only a local machine
> has, it asks Atlas exactly the way it asks Alice for a photo. Same verb. No
> special case."

*Earns "primitive": the room doesn't model humans, it models members. That's
the generalisation every single-principal sandbox is missing.*

## Page 1 — the problem

> "Work is multiplayer. Agents are single-player. Every agent you use today
> lives in exactly one person's window — so the human becomes the integration
> layer: copy-paste between two chat windows, a screenshot forwarded to the
> other side, 'let me ask the AI and get back to you.' The second person never
> sees the context, and the deliverable dies inside one private thread."

*The only page that is allowed to be about the pain.*

---

# The demo — one 4-up frame, ~90 seconds

A linear screencast cannot prove this product, because the product **is**
simultaneity. One frame, four quadrants, one clock running across all of them.

| | |
| --- | --- |
| ↖ **Alice** — phone, Telegram | ↗ **Bob** — laptop, room web view |
| ↙ **Atlas** — local desktop agent | ↘ **The artifact**, being written |

Three members contributing, one quadrant showing the shared result. Two of the
members are human, one is a machine, and the room treats them identically —
which is the point you cannot make with four human quadrants.

## Beat sheet

| t | Beat | What moves, and where |
| --- | --- | --- |
| 0:00 | Alice types `new` on Telegram | room code appears; Bob's laptop opens it |
| 0:15 | Bob joins by QR | he appears in the roster on all four |
| 0:20 | Atlas joins | a **machine** lands in the same roster, same tier |
| 0:25 | Alice sends a **voice note** | transcribed, attributed to Alice, visible to Bob and Atlas; a line appears in the artifact |
| 0:40 | Bob sends a **photo** | the agent describes it; it lands in the artifact |
| 0:50 | The room needs a local fact → **`[[ask Atlas]]`** | Atlas answers from the desktop; Alice and Bob see the answer arrive attributed |
| 1:05 | Bob asks **`@me …`** | answer in Bob's quadrant only; Alice's shows *(the agent whispered to Bob)* |
| 1:20 | Alice: "send us the PDF" | preview + confirm gate on the laptop, then the PDF lands on the phone and in the inbox |
| 1:30 | The agent replies **with a voice note** | close on the artifact quadrant |

## The two moments that sell it

**0:50 and 1:05.** At 0:50 the same verb solicits a machine that solicited a
human thirty seconds earlier. At 1:05 the quadrants visibly diverge — one
member gets a private answer and the others get the fact that a private answer
happened. Neither can be shown in any format except this one.

## Shooting notes

- Real screens only. No mock, no re-enactment.
- One clock overlaid across the whole frame, never per-quadrant.
- Rehearse every beat first through `/inbound/simulated` with
  `RDV_BOOTER=local` — no sandbox, no cost — then shoot one real take.
- Outbound goes only to Jeremy's own Telegram contact and
  `jeremy@agentik.net`. Never a third party, in rehearsal or on the take.

---

# Appendix — Q&A only, not part of the six

**The five silent failures.** One shape, five independent bugs found while
building. A killed session still answers 200, so resume reported success in
seven tenths of a second having resumed nothing. Omit `queue: true` and a
message vanishes. Resume and the fan-out cursor freezes, so replies after it
vanish too. Pin an inbound route to one account and it silently never fires.
Ask for Gmail access the agent already has, and it proposes rebuilding it from
scratch. None of them crash. All of them look like working code or correct
configuration — which is exactly why the room writes down who asked, who
confirmed, and what was sent.

**Honest limits.** Paused sandboxes expire in 20 to 60 minutes; one did, live,
mid-rehearsal, and the room kept advertising its dead link until we made
liveness its own fact. WhatsApp is not provisioned — no number, no key; the
room is channel-agnostic by construction, so it's a config change, not code.
We share an existing workspace's Telegram routing, so a catch-all route there
could fire alongside ours.

**Why not just swap the brain for Codex?** We tried, live. It failed at the
auth gate, not at the swap: a fresh box has no codex credentials and
`installAdapters` installs the binary, not the login. The real second-brain
work is the credential model — device auth, per member — not the adapter
swap. Which is also why credentials in this product are per-member and never
per-room: a shared room key is a key shared with everyone holding the room
code, and revocation here is an unpair, not a rotation.
