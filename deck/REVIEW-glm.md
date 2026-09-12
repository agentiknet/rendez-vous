# Review — Rendez-vous submission (glm)

Read as a judge who has never heard of this, has 90 seconds of attention, and
is scoring forty other submissions the same afternoon.

**Fact-check status, updated:** `docs/STATE.md` now carries "Resolved, same day
~13:00 local — resume now DOES carry continuity," sourcing the deck's resume
claim (commits `2b027f9`, `4c44e8c`, `15724f6`) and proving it live — session
`sess_16c7ebab` killed mid-conversation, Bob asked a follow-up, the room
answered *"Room RDV-BS27 is back — I still have us at: Lisbon offsite in March,
budget €12,000."* The claim is true. It is also, in the submission as written,
unproven to anyone who cannot read the commits. That distinction drives this
revision. The 86.5s boot claim checks out (`REHEARSAL.md:240`).

---

## 1. Scores as they stand

**Core Requirements & Functionality — 4.** *(revised up from 3)*
The contradiction that held this at 3 is resolved: the deck line is now sourced
and was proven live from a phone, and STATE explicitly authorises stating
continuity as observed. The sentence a sceptical judge writes to justify not
giving it a 5: *"Proven-once is not proven-robust — every row of the observed
list was demonstrated exactly once, and the one capability the deck leads with
(revive-with-memory) is the one with no demo beat, no quoted reply, and no
artifact a judge can check."*

**Innovation & Theme Alignment — 4.** *(unchanged)*
Not-5 sentence: *"The pattern the deck itself calls the surprising one — a
machine member solicited with a human's verb — appears in no recorded live run,
and the video beat it depends on has no first half: nothing earlier in the beat
sheet solicits a human at all."*
The multi-human room, whisper divergence, tier fan-out and authority gate
genuinely cannot live in a standalone chatbox. But the deck's 5-defence rests
on the human/machine symmetry, which is asserted (SUBMISSION criterion 2,
SCRIPT page 2) and nowhere demonstrated.

**Technical Execution & Integration — 4.** *(unchanged)*
Not-5 sentence: *"One passed run, zero concurrency evidence, and an admitted
shared-ingress route that could fire alongside theirs — 'robust orchestration'
is the section's headline, not its evidence."*
The failure-class table, the credential-leak regression test, liveness gating
and per-member credentials are real engineering. The resume work is now also
genuinely good engineering — a budget-bounded transcript replay that races
each `iterator.next()` against a timer rather than trusting an `AbortSignal`
the source may ignore, plus a designed honest branch for when recap finds
nothing. But it is in the repo, not the deck (see §2), and the reliability
evidence depth is still one sample per claim.

**Usefulness & Agentic Experience — 4.** *(unchanged)*
Not-5 sentence: *"The fourth member is an inbox that sends nothing and appears
in no demo — three members with real experiences is what this is."*

---

## 2. The gap to 5, per criterion

**Core (4 → 5).** Almost entirely (a)-class now — the work exists, the deck
doesn't surface it.

- *(a) the proof exists and the deck hides it.* The 13:00 section sources
  continuity with a live, quoted, human-legible artifact — the Lisbon reply.
  The submission carries one assertion bullet (SUBMISSION line 63) and one
  timeline row (data.json line 68); the quote — the only thing a judge can
  *see* — sits in `docs/STATE.md`, which a judge will never open. One sentence
  of surface cost converts the deck's most checkable claim.
- *(a) eight observed rows, four anchored.* The caption "Every row observed end
  to end on live infrastructure, not described" is now true, but the repo
  anchors four of eight (run 3; the 07:54 revive with 3-in/3-out counts; the
  86.5s boot; the 13:00 continuity proof). The video proves roughly four more.
  Nothing false — but a reading judge counts "observed" as trust-me.
- *(b) not done.* Two rooms running at once — the cheapest proof of robust
  orchestration — appears nowhere. Fan-out latency beyond a single boot
  timestamp: nowhere.

**Innovation (4 → 5).**

- *(a) work done, not said.* The ask-half of the symmetry is claimed in
  criterion 2 — "asking Alice for the product shot and Bob for the positioning
  line, each answering on their own channel" — but the beat sheet never
  solicits a human, so the symmetry's first half exists in prose only. If the
  room can ask Alice, putting that beat in the video costs ten seconds and
  completes the pattern on screen.
- *(b) not done.* No recorded live Atlas join anywhere in the fact-checked
  sections. The inbox tier does no real work. "Four members, four surfaces" is
  a roster with a passive seat.

**Technical (4 → 5).**

- *(a) work done, buried.* The 13:00 section contains the submission's
  strongest failure-handling evidence and none of it is in the deck: the fix
  for a silent failure was itself silently dead on arrival — every revival
  took the no-history branch behind an honest-looking reply, and **443 green
  tests covered the entire period**; only a live rehearsal caught it. That is
  a *stronger* instance of the deck's own five-row table than any row in it,
  and it justifies the deck's design conclusion (the transcript as the only
  checkable record) better than the table does. Also buried: the honest
  "I've lost the earlier thread" branch — designed honesty for a failure state
  most products would fake.
- *(a) undercounted.* The silent-failure list in `STATE.md` has six entries;
  the deck counts five. The sixth — the dead artifact URL in a member's thread
  — is the most demo-visible one (a judge poking the product could hit it) and
  is folded into an integration example instead of the table.
- *(b) not done.* Concurrency, fan-out counts, ingress isolation (the
  catch-all route conflict).

**Usefulness (4 → 5).**

- *(a) work done, not said.* Late-join context is proven — "A second person
  joins from a laptop and sees the full transcript plus the live artifact" —
  and never turned into its native-experience line: *join at minute 4, get
  minutes 0–4, attributed.* The Lisbon reply is also the best criterion-4
  artifact in the repo — the revived room speaks continuity in first person,
  which is exactly the "agent feels native" rubric line — and it appears in
  no deck surface.
- *(b) not done.* The tier fan-out — a terse phone reply, a per-turn email
  digest, a full laptop transcript, from one turn — is criterion-3's
  integration example #1 and appears in **no** beat, **no** slide of
  substance, and **no** demo moment. The feature that most needs the messaging
  environment is the one never shown.

---

## 3. Specific rewrites

**R1 — SUBMISSION.md line 63.** *(rewritten: the claim is now sourced, so the
surface job changes from admitting a limit to showing the proof)*
Quote: `- Killed mid-session, the room comes back and still knows what was discussed.`
Replacement:
`- Killed mid-session, the room revives with its memory. A session killed mid-conversation came back and answered a follow-up: "Room RDV-BS27 is back — I still have us at: Lisbon offsite in March, budget €12,000." The revival replays the prior transcript, budget-bounded, into the resumed session — and if it finds nothing, the room says so honestly instead of pretending.`

**R2 — data.json line 68.**
Quote: `{ "time": "resume", "label": "Killed mid-session, the room comes back still knowing what was discussed" }`
Replacement: `{ "time": "revive", "label": "Killed mid-session, the room revives with its memory — “I still have us at: Lisbon offsite in March, budget €12,000.”" }`
The quoted reply in a slide row is unusual and therefore memorable; it is also
the only slide surface a judge can check.

**R3 — data.json line 97.**
Quote: `{ "n": "3", "label": "it lands on a phone as a real file, and in an inbox, addressed to someone who was never in the room" },`
Replacement: `{ "n": "3", "label": "it lands on a phone as a real PDF and in an inbox — recipient and contents exactly as previewed" },`
"Someone who was never in the room" is unverifiable under your own third-party
rule and muddies the control story; "exactly as previewed" is the provable
claim and the stronger one.

**R4 — data.json line 85.**
Quote: `"highlight": "The runtime sits under a clean seam. That is the whole claim: swap it and the room does not move.",`
Replacement: `"highlight": "The runtime sits under a clean seam — consumed unmodified from npm, never forked, never patched. All the state a room needs lives above the seam.",`
The swap is never exercised (the Codex attempt failed at the auth gate — your
own appendix says so); the unmodified consumption is provable and is the
better claim.

**R5 — data.json line 42.**
Quote: `"sends": "what only a local machine knows",`
Replacement: `"sends": "answers the sandbox asks for — the same attributed answers a human gives",`
The current text reads as filler in the one roster row that carries the deck's
novelty.

**R6 — data.json line 67.**
Quote: `{ "time": "out", "label": "The agent replies with a voice note, and attaches real files" },`
Replacement: `{ "time": "out", "label": "A member confirms, and the deliverable leaves the room as a real PDF — to the phone and the inbox" },`
Page 3's caption promises "Every row observed end to end." Voice-note-out is a
capability claim from What-we-built; confirmed delivery is in the criterion-1
observed list. The evidence page should carry observed rows.

**R7 — SCRIPT.md lines 112–113.**
Quote: `**0:50 and 1:05.** At 0:50 the same verb solicits a machine that solicited a human thirty seconds earlier. At 1:05 the quadrants visibly diverge — one`
Replacement: `**0:30–0:35 and 0:50 on the re-ordered sheet.** At 0:30 the room asks Alice for the product shot and she answers from the phone; at 0:35 it asks Atlas with the same verb, and the machine's answer lands in the same transcript. At 0:50 the quadrants visibly diverge — one`
As written, "solicited a human thirty seconds earlier" refers to nothing: no
beat solicits a human before 0:50.

**R8 — SCRIPT.md, beat table after 0:25.** Insert the missing first half:
`| 0:30 | The room asks Alice for the product shot → she answers from the phone | the agent solicits a human — attributed, on her own channel |`

**R9 — SUBMISSION.md lines 212–214.**
Quote: `Real screens only, no re-enactment. Rehearsed beat by beat against the local simulator at zero cost, then shot in one take.`
Replacement: `Real screens only, no re-enactment — rehearsed beat by beat against the local simulator, then shot in one take. Watch 0:30–0:35: the room asks a machine the way it asked Alice, and the machine answers into the same transcript.`
The section's last sentence currently spends itself on process ("zero cost")
instead of on what the take proves.

**R10 — SUBMISSION.md, after the paragraph closing the five-row table
("None crash. Four lost data quietly…"), add the capstone:**
`And one instance of the class was ours, not upstream: the first version of the continuity fix never ran. Every revival silently took the no-history branch, hiding behind an honest "I've lost the earlier thread" reply that looks exactly like the feature working — and 443 green tests covered the entire period. Only a live rehearsal caught it. That is the case for rehearsing on real surfaces instead of trusting a green suite, and it is why the room writes down who asked, who confirmed, and what was sent: when the suite says green and the feature is dead, the transcript is the only record that can be checked afterwards.`
This is the deck's own silent-failure argument turning on itself and being
caught by the deck's own remedy (rehearsal). No mechanism detail, no commit
hashes — judge-legible. Note `STATE.md` itself endorses surfacing it ("itself
finding-shaped and worth saying out loud").

**R11 — SCRIPT.md, appendix Q&A paragraph after the five failures** *(the
mechanism, at Q&A depth where it belongs)*:
`And the fix for a silent failure was itself silent once: pausing cleared the session id before the revive read it, so every revival took the no-history branch behind the honest reply. 443 green tests through the whole period; the local harness caught it, not the suite. The running version replays the prior transcript budget-bounded and keeps the id across the pause.`

Render nit, one line: page 2's ladder header says "Joined by" but every row
stores its value under the key `latency`. If the renderer maps it, fine —
check it once.

---

## 4. What to cut

**Page 4 (the stack).** A full page for a diagram whose headline claim ("swap
it and the room does not move") is never exercised, and whose caption
duplicates the appendix failure slide. Move the four-layer diagram to the
appendix (or a two-line caption on page 2). That frees the page for **"One
turn, three renderings"** — the presence-tier fan-out, which is integration
example #1, shown nowhere, and is the strongest "environment shapes the core
workflow" material the rubric asks for. A deck that shows one agent turn
becoming a terse SMS-sized reply, a per-turn email digest, and a full
transcript beside a live artifact has made an argument no chatbot submission
can make.

Also cut: data.json line 86's five-failure caption (page 4) — the appendix
slide already owns the failures; carrying them twice spends page space on Q&A.
If page 4's replacement is built, the freed caption slot should carry the
revive-with-memory proof instead (see R2) — failure-count duplication out,
checkable proof in.

Page 1, page 5, page 6: fine. Page 1 earns its pain. Page 5's authority gate
is the deck's control story and earns its page. Page 6 earns its close.

---

## 5. The demo video

The format is right — a 4-up frame with one clock is the only format that
shows simultaneity, and simultaneity *is* the product. That choice itself is a
rubric point for criterion 4.

**Is the beat sheet ordered so a judge who stops at 45 seconds has seen the
strongest thing? No — backwards.** At 45 seconds the current sheet has shown:
room creation, two joins, a transcribed voice note, a described photo. That is
the feature set of a competent Telegram-bot submission, of which forty exist.
The deck's own two moments that sell it are at 0:50 and 1:05 — 56% and 72%
through, past the attention line. Worse: the 0:50 line ("the same verb
solicited a human thirty seconds earlier") refers to a solicitation that never
happened on screen. The symmetry's first half has no beat.

**Single best moment:** the `[[ask Atlas]]` beat — a machine answering into a
shared transcript under the same verb that asked a human. It is not early
enough, and it currently has no first half. Fix both.

**Re-ordered sheet (~90s), including the resume beat the fact-check now
permits:**

| t | Beat |
| --- | --- |
| 0:00 | Alice types `new`; Bob's laptop opens the room |
| 0:05 | Bob joins by QR — both in the roster |
| 0:08 | Atlas joins — a **machine** in the same roster, same tier |
| 0:15 | Alice voice note → transcribed, attributed, a line in the artifact |
| 0:30 | The room **asks Alice** for the product shot → she answers from the phone |
| 0:35 | Same verb → `[[ask Atlas]]` → the machine answers on the record |
| 0:50 | Bob `@me` → quadrants diverge: the answer vs *(the agent whispered to Bob)* |
| 1:05 | Alice: "send us the PDF" → preview + confirm on the laptop → PDF lands on the phone and the inbox |
| 1:20 | Session killed mid-conversation → Bob texts a follow-up → the room answers *"Room RDV-BS27 is back — I still have us at: Lisbon offsite in March, budget €12,000."* |
| 1:30 | Close on the artifact quadrant — the transcript shows who asked, who confirmed |

Both best moments now land before 1:00; the creation preamble is compressed to
five seconds; and the video now ends on the deck's strongest reliability proof
instead of a generic agent-voice capability.

Shoot-risk on the new 1:20 beat: a revival boots a fresh box, and the boot gap
is on camera. Rehearse it through the simulator first and budget the gap; if
the answer takes more than ~20 seconds to appear, cut the beat — the Lisbon
quote in the written submission (R1) carries the claim, and the video keeps
its 85s take. Do not let a 40-second dead frame into the strongest asset.

**What to cut to make room:**
1. The 1:30 voice-note-out final beat (−10s) — now replaced by the resume beat. Agent-voice-out is a capability, not a pattern; every submission with an agent and a channel has it.
2. The Bob-photo beat as its own moment (−8s). Inbound-media-in is already proven by the voice note; if kept, fold it to 0:22.
3. The `new`-preamble (−8s). Room creation proves nothing another submission doesn't.

**The beat that must not be cut:** the 1:05 authority gate. It is the only
on-screen moment of human control, which the usefulness-5 rubric line
requires, and the only beat that makes the room feel like a governed place
rather than a group chat with a bot.

**Risk to name:** the two beats that carry the video (Atlas solicit, whisper
divergence) remain the two with the least recorded evidence — the 13:00 proof
covers resume, not Atlas. Rehearse them through `/inbound/simulated` first,
because a failed `[[ask Atlas]]` take leaves the submission's novelty resting
on prose.

---

## 6. The one thing

**Surface the proof the repo already has: the Lisbon quote in criterion 1
(R1) and the dead-on-arrival capstone in criterion 3 (R10).**

The submission's residual weakness is no longer truth — it is that a judge
cannot check it. Two line-level edits, zero risk, minutes of work, and they
convert at once: the deck's most checkable-sounding claim (revive-with-memory)
from assertion into artifact — an actual quoted reply from the room — and the
deck's central engineering argument (silent failures, caught by rehearsal)
from a table of upstream bugs into a demonstrated posture that includes the
failure of the deck's own first fix and its own 443-test suite. Nothing else
on the list moves two criteria with two sentences. The video re-order from §5
remains the highest-impact *shooting* fix and stands as given — but if only
one thing gets fixed, fix the text: it is certain, and the video is not.
