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

## Page 4 — the stack, and what it cost to trust it

> "One pipeline. **agentpush** is the ingress and the egress — Telegram,
> WhatsApp, email, SMS behind one API, so the room never learns a single
> provider's quirks. Rendez-vous is the room. Under it, **agentproto**, our own
> open-source agent runtime, unmodified from npm. Under that, an **e2b**
> sandbox holding the artifact.
>
> Building this we found eight failures, and every one of them was silent. A
> killed session still answers 200, so resume reported success in seven tenths
> of a second having resumed nothing. Omit one flag and a message arriving
> mid-turn is rejected and lost — the sender sees it sent. A paused sandbox
> expires and the room keeps handing people its dead link.
>
> We set one rule on day one: never fork, never vendor, never patch the
> runtime. Eight findings later it held — seven pull requests are open against
> our own runtime, each carrying a test that reproduces the silent failure
> before fixing it."

*Earns "the runtime is a detail": the seam is real enough that every fix went
under it, upstream, instead of into a private patch. And it is the page that
answers the rubric's "thoughtful failure handling" with dated evidence rather
than an adjective.*

## Page 3 — it works, live

> "Someone typed `new` on a real phone. Eighty-six and a half seconds later,
> cold boot, the session and the artifact were ready. A laptop joined; one
> agent reply reached both surfaces, every message tagged with who sent it and
> from where. The agent edited the shared artifact on request, confirmed on the
> URL while the phone thread kept going. A PDF was previewed, confirmed with a
> token, and byte-matched in the inbox. And when we deleted the sandbox out
> from under the room through the e2b API, the sweep caught it and the next
> message brought the room back.
>
> Everything I just said is in the rehearsal log with a timestamp. Everything
> below the line — voice in, photo in, the private answer, the voice reply, the
> files, the machine member, the transcript replayed on resume — is built and
> tested, and you are about to watch it happen. We keep those two lists apart
> on purpose."

*Earns the whole deck: none of it is a mock, and we are not asking to be taken
on trust for the part we can show you instead.*

## Page 2 — the room, and who is in it

> "Four members, four surfaces, one session. Alice is on Telegram. Bob is on a
> laptop. There's an inbox. And Atlas is a **local desktop agent** — a machine
> member, joined by running one script, speaking and listening through the same
> two endpoints as the humans. When the room needs the commit log from Jeremy's
> laptop, it asks Atlas with the same ask it used on Alice for the photo. Same
> verb, same endpoints, same line in the transcript. No special case."

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

## The 45-second rule

A judge scoring forty submissions stops watching at 45 seconds. **Everything
that makes this project different has to be behind them by then.** The first
draft of this sheet failed that badly: at 0:45 it had shown a room code, two
joins and a transcribed voice note — the feature set of a competent Telegram
bot, of which there will be forty. Setup is not content.

Both independent reviews reordered it the same way. This is that order.

## Beat sheet, ~85 s

| t | Beat | What moves, and why it is here |
| --- | --- | --- |
| 0:00 | **Title card, 2 s:** *"Alice and Bob — a one-page brief, 20 minutes before a client call."* Room already exists, both already in it | Name the job or the artifact quadrant means nothing. Caption "Alice typed `new` 90 s ago" instead of filming her typing it |
| 0:05 | **Atlas joins** — persistent caption in that quadrant: *"an agent running on Jeremy's Mac, joined through the same endpoints as Alice"* | The surprising thing, first. Without the caption a judge just sees a fourth name |
| 0:12 | Alice sends a **voice note** from the taxi | transcribed, attributed to Alice, visible in every quadrant; a line appears in the artifact — attribution and the shared artifact proven in one beat |
| 0:25 | The room **asks Alice** for the product shot; she answers from the phone | the first half of the symmetry. Without this beat, "same verb" at 0:35 refers to nothing |
| 0:35 | **Same verb → `[[ask Atlas]]`** for the commit log on the laptop; the machine answers into the same transcript | the second half. A machine solicited exactly like a human, on the record — inside the 45 s window |
| 0:50 | Bob asks **`@me …`** | the quadrants visibly diverge: Bob gets the answer, everyone else gets *(the agent whispered to Bob)* |
| 1:05 | Alice: "send us the PDF" → preview on the laptop → Bob confirms with the token → it lands on the phone and in the inbox | the proven flow, and the only on-screen moment of human control |
| 1:20 | Close on the artifact quadrant, finished; the transcript shows who asked and who confirmed | ends on the deliverable |

**Cut from the first draft to get here:** filming `new` being typed (−8 s), the
QR join (−8 s), Bob's photo as its own beat (−8 s — inbound media is already
proven by the voice note), and the agent's voice reply as its own beat (−10 s;
fold it under the close if it fits). Roughly 35 s of setup and commodity.

## The two moments that sell it

**0:35 and 0:50**, both now inside the 45-second window.

At 0:35 the same verb solicits a machine that solicited a human ten seconds
earlier — and the answer lands in the same transcript, attributed, with no
special case anywhere in the code.

At 0:50 the quadrants visibly diverge: one member gets a private answer, the
others get the *fact* that a private answer happened. It explains itself with
no narration, and it cannot be shown in any format except this one.

## Risks to rehearse, not discover on the take

- **The `[[ask Atlas]]` beat is the best idea and the highest risk.** Until the
  agent is taught the `[[ask]]` syntax in its own prompt it will not emit one
  unless prompted. Verify the marker appears in the boot prompt *and* both
  resume branches before shooting — resume has silently dropped capability
  lines before.
- **Atlas must stay quiet unless addressed.** The bridge mirrors every room turn
  into the desktop session and posts every desktop turn back. Prime that session
  to answer only when asked, or Atlas will comment on Alice's voice note too and
  the quadrant becomes noise that undercuts the whole point.
- **Fallback if the ask does not hold:** Atlas joins, appears in the roster, and
  answers one direct question. That still lands the machine-member point. Do not
  improvise a rescue on camera.

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
