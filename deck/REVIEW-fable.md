# Review — Rendez-vous submission, read as a cold judge

Read: `SUBMISSION.md`, `SCRIPT.md`, `data.json`, then `docs/STATE.md` (silent-failure
class, demo status) and, only to check specific claims, `docs/REHEARSAL.md` headings,
`docs/DEMO.md` §9, `docs/UPSTREAM.md` summary table, the commit bodies of today's six
feature commits, and the header of `scripts/room-agent.ts`.

The short version: the idea is a real 4-to-5 on innovation, the engineering underneath
is a real 4, and the submission is currently *lying to itself* about which of its claims
are observed. The rhetorical posture of the whole package is "observed, not described".
A judge who catches one row that was not observed discounts every row, including the
true ones. Several rows were not observed.

---

## 1. Scores as they stand

**Core Requirements & Functionality — 3.**
"Two people on Telegram and a laptop with attributed fan-out, and a PDF confirmed and
landing in an inbox, are proven on a real phone. Voice in, photo in, private reply, voice
reply, file attach, the machine member, and 'comes back still knowing what was discussed'
were all committed between 11:35 and 13:58 today, the rehearsal log records none of them
running through a real phone, and the project's own demo runbook says not to promise
resume continuity on stage."

**Innovation & Theme Alignment — 4.**
"The multiplayer room is a genuine pattern that a chatbox cannot reproduce, but the
'machine member solicited with the same verb' that the submission puts forward as the
surprising part is asserted, not shown: the bridge is a 415-line SSE mirror with no
ask/answer handling, STATE.md says the ask loop is half-built and the agent is not told
the syntax, and nothing in the submission names a single concrete thing Atlas knows."

**Technical Execution & Integration — 4.**
"Solid: proxied artifact URL gated on box liveness, token-free media resolution with a
test, transcript replay on resume, per-room revive lock, sixteen service test files. But
the failure-handling paragraph claims 'all five are fixed, each with a regression test'
when the project's own upstream table marks two of the five 'Documented', not fixed, and
the seven upstream pull requests that would actually earn the 5 are never mentioned."

**Usefulness & Agentic Experience — 3.**
"Nowhere in six pages, the script, or the beat sheet is there one concrete job the room
finishes: the artifact is 'a line appears in the artifact' of an unnamed document, the
use-case paragraph is a list of four abstract nouns, and the member has to learn `@me`,
`[[ask name]]`, `send pdf to`, and `confirm PDF-X7PQ` inside a chat that promised 'nobody
learns a new app'."

---

## 2. The gap to 5, per criterion

Legend: **(a)** did the work, failed to say it. **(b)** did not do the work.

### Core functionality (3 → 5)

- **(b) The live proof is a day old and the product moved this afternoon.** REHEARSAL.md's
  last section is the deliverable flow at 01:53 UTC. Every feature the submission leads
  with in Criterion 1 bullets 3, 4 (voice reply), 5 (messenger leg), and 6 landed
  after that, and the only proof cited in their commit bodies is `scripts/probe-media.ts`
  against the OpenAI API or a local harness. The gap is one real take from a real phone,
  with the log updated. That is the video. Until it exists, bullets 3–6 are claims.
- **(b) Resume continuity is contradicted by your own docs.** SUBMISSION line 63 and
  slide 3's last row say the room "still knows what was discussed". STATE.md's 10:30
  correction says the last live observation was the opposite, and DEMO.md §9 says, in
  bold, "do not promise it picks up where it left off". The replay landed at 11:35
  (`4c44e8c`) and its ordering bug was fixed at 11:59 (`15724f6`), "caught in a local
  harness". Re-prove it on the phone or change the sentence. This is the single most
  dangerous line in the package because a judge with the repo can falsify it in one grep.
- **(b) Messenger leg of the PDF send.** REHEARSAL.md §"Messenger leg — gap found,
  skipped". Fix landed in `9d70c1a`, STATE.md: "Not yet re-exercised live after the
  restart." The submission says "delivered as a real PDF to a messenger and to an inbox".
- **(b) The email tier's inbound half.** Slide 2 gives the inbox "sends: reply-to-thread".
  There is a webhook test, no live run. Minor, but it is on the slide titled "It works".
- **(a) What IS proven is undersold.** The 86.5 s cold boot, two members attributed in one
  transcript, the fan-out reaching both surfaces, the artifact edit confirmed live, the
  allowlist refusal, the byte-matched PDF in the mailbox, the box deleted via the e2b API
  and revived on the next message. Those are real and they are buried in the same list as
  the unproven rows, at equal weight.

### Innovation (4 → 5)

- **(b) The ask loop is not closed.** STATE.md item 6: steps iii–vi not built; "an ask
  opens and is delivered but nothing closes it; the agent is not yet told about the syntax,
  so no asks are produced in the demo unless prompted." Nothing after `d258b13` touches
  this. The Atlas bridge (`e471b41`) mirrors the shared transcript stream into a desktop
  session and posts every desktop turn back attributed as `room-web`. It has no notion of
  an ask, and it is not obvious a whisper-delivered ask even reaches it, since it reads the
  shared stream. So the "same verb" beat is: the sandbox agent must be prompted to emit
  `[[ask Atlas]]`, Atlas answers because it answers everything, and nothing records the
  answer as the answer. It will *look* right on video. It is not what the submission says.
- **(a) You have a stronger, true version of the claim and don't use it.** The true
  claim: "a desktop agent joined the room through the same two HTTP endpoints as a human,
  with the same `queue: true` discipline, and the room could not tell the difference."
  That is demonstrable today. Say that, not "the room solicits it".
- **(b) Atlas has no named local fact.** Slide 2: "sends: what only a local machine
  knows." Which thing? A judge needs one example they recognise as machine-only in under
  two seconds: the latest commit on the laptop repo, the files in a folder, a test run.
  Pick one and put it on the slide and in the video.

### Technical execution (4 → 5)

- **(a) Seven open upstream PRs are never mentioned.** STATE.md item 11 lists them with
  numbers. "Never fork, never vendor, never patch" is currently a vow; seven PRs against
  your own runtime with regression tests is evidence of "thoughtful failure handling" at
  the 5 level, and it is not in the deck, the script, or the submission.
- **(b/a) "All five fixed, each with a regression test" is not true and does not need to
  be.** UPSTREAM.md status: #1 queue (Documented, PR open; the room passes `queue: true`
  itself and tests assert it), #3 account-pinned routes (Documented; worked around by a
  catch-all route, `route-overlap.test.ts` covers the overlap), #5 broker-blind planning
  (Documented; no fix, no test in this repo, the only "broker" mention in `src` is
  `env.ts`). The true statement is stronger than the false one because it includes the
  upstream work. Rewrite below.
- **(a) The engineering decisions with the best failure-handling stories are in commit
  bodies, not the submission.** The TTS caption fallback ("the sentence always arrives"),
  the recap replay budget enforced by racing `next()` because the generator ignored the
  abort signal, the marker ordering so an attachment inside a whisper is not swallowed.
  One of these on the stack slide is worth more than the ASCII diagram.

### Usefulness (3 → 5)

- **(b) No scenario.** Not one place says what Alice and Bob are making. Pick the thing
  the video shows and name it in the first line of Criterion 4, on slide 2, and in the
  first three seconds of the video.
- **(b) Command syntax is the interface.** `send pdf to <name>`, `confirm PDF-X7PQ`,
  `@me`, `[[ask name]]`. The confirm token is defensible (auditable, on the record) and
  should be *sold* as such. The rest reads as a CLI in a chat. Either show that natural
  phrasing also works, or own it in one sentence: "three verbs, all on the record".
- **(a) The presence-tier rendering is the most "native to the environment" thing you
  built and it gets one sentence.** Terse on the phone, digest in the inbox, transcript
  beside the artifact on the laptop, from one fan-out. That is exactly the rubric's
  "designed specifically for its environment". It deserves the video's laptop quadrant and
  a caption.

---

## 3. Specific rewrites

**1. SUBMISSION.md line 5–6**
> Every factual claim here is anchored in `docs/REHEARSAL.md`, `docs/ARCHITECTURE.md`, `docs/STATE.md` or `docs/UPSTREAM.md`.

Currently false for four claims. Replace with:
> Claims marked *observed* are in `docs/REHEARSAL.md` with timestamps. Claims marked *shown* are in the video. Nothing else is claimed.

Then actually mark them.

**2. SUBMISSION.md line 49–50**
> **The core workflow runs end to end on live infrastructure.** Observed, not described:

Replace with two lists:
> **Observed on a real phone, logged with timestamps:** a real phone texts `new`; 86.5 s later, cold boot, session and artifact are ready. A second member joins from a laptop; both appear attributed in one transcript and the agent's reply reaches both surfaces. The agent edits the artifact on request; the edit is confirmed on the proxied URL. A PDF is previewed, confirmed by a member with a token, rendered, and lands in the inbox, byte-matched. A box deleted through the e2b API is detected by the sweep and revived by the next message.
>
> **Built today and shown in the video:** voice in (Whisper), photo in (vision), a private `@me` reply, a voice reply, a real file attached, a desktop agent joining as a member, and resume with the prior transcript replayed into the new session.

**3. SUBMISSION.md line 63 and data.json slide 3 last row**
> Killed mid-session, the room comes back and still knows what was discussed.

Replace with:
> Killed mid-session, the room comes back on the same code and the same link, and the new session is handed the old transcript as a recap.

If you re-prove it on the phone today, keep the original and add the timestamp. If not, use this.

**4. SUBMISSION.md line 61–62**
> The deliverable leaves the room: previewed, confirmed by a member, delivered as a real PDF to a messenger and to an inbox.

Replace with:
> The deliverable leaves the room: previewed with recipient, channel and subject; confirmed by a member with a token; rendered; landed in the inbox and byte-matched against the mailbox. Sending to a member's own messenger by name is built and shown in the video.

**5. SUBMISSION.md line 162–163**
> None crash. Four lost data quietly; one reported success while doing nothing. All five are fixed, each with a regression test, and each written up with a repro.

Replace with:
> None crash. Four lost data quietly; one reported success while doing nothing. Three are fixed in this repo with regression tests, two are worked around with a test that pins the workaround, all five are written up with repros, and seven pull requests are open upstream against our own runtime, each carrying a test that reproduces the silent failure.

**6. SUBMISSION.md line 93–96**
> So a **local desktop agent joins the room exactly the way a person does**, and the room solicits it with the same verb it uses to solicit Alice. The agent in the sandbox asks the desktop agent for something only a local machine has, and it answers into the shared transcript like any other member.

Replace with the version that is true today, and name the fact:
> So a **local desktop agent joins the room exactly the way a person does**: the same two HTTP endpoints, the same cursor, the same `queue: true` discipline, attributed in the transcript like anyone else. In the video the room asks it for the latest commits on Jeremy's laptop, something no sandbox can know, and the answer lands in the shared transcript attributed to Atlas.

(Substitute whatever local fact you actually demo. Do not leave it abstract.)

**7. SUBMISSION.md line 175–180, the use-case paragraph**
> Any piece of work that more than one person has an opinion about and that has to end in an artifact: a deck before a meeting, a spec between a founder and an engineer, ...

Replace with one story, the one the video shows:
> Alice and Bob have twenty minutes before a client call. Alice sends a voice note from a taxi. Bob drops the product shot from his laptop. The room asks Bob's machine for the current version number. It writes the one-page brief while all three watch it change. Alice says "send us the PDF", Bob confirms, and it is in both inboxes before the call. Nobody opened a new app and nobody relayed anything.

**8. data.json slide 1 eyebrow**
> Rendez-vous — one room, one agent, one artifact, many humans

Replace with:
> Rendez-vous — one room, one agent, one artifact, many members

Slide 2's caption says "the room models members, not humans". Slide 1 contradicts it in the first line a judge reads.

**9. data.json slide 2, Atlas row, "Joined by" column**
> the same two endpoints

That is not how; that is what. Replace with:
> running one script on the laptop

**10. data.json slide 3 caption**
> Every row observed end to end on live infrastructure, not described.

Replace with:
> Rows one to three and the artifact edit observed on live infrastructure with timestamps; the rest shown in the video, real screens, one take.

Or, better, reorder the rows so the observed ones are first and the caption splits at the seam.

**11. SCRIPT.md page 2**
> When the room needs something only a local machine has, it asks Atlas exactly the way it asks Alice for a photo. Same verb. No special case.

Replace with:
> When the room needs the commit list from Jeremy's laptop, it asks Atlas with the same ask it used on Alice for the photo. Same verb, same endpoints, same line in the transcript. No special case.

**12. data.json slide 6**
> The room is the primitive. / The runtime is a detail.

The second half is a claim you cannot support (the Codex flip failed, and you say so in the appendix) and that the rubric does not score. Replace with the line that hits Innovation 5 directly:
> The room is the primitive. / A machine joins it the way a person does.

---

## 4. What to cut

**Least earned: slide 4, the stack.** Four boxes in ASCII and four bullets that restate
them. A judge scoring Technical Execution does not score architecture diagrams; they score
evidence of reliability and depth. The caption on that slide ("five silent upstream
failures we found and fixed") is the only sentence on it doing work, and it points at the
appendix, which is where the actual evidence lives. Meanwhile, the seven upstream PRs
appear nowhere.

**What takes the space:** collapse the stack to one strip at the top of the page (one
line: `Telegram · Email · Web · desktop agent → agentpush → Rendez-vous → agentproto
(unmodified, npm) → e2b`) and use the rest of page 4 for the current appendix "five silent
failures" content plus one line: "Seven PRs open upstream, each with a test that reproduces
the failure." Move the diagram to the appendix. That turns page 4 from generic to the
strongest technical page in the deck.

**Second cut, if you need a page: half of page 6.** See rewrite 12. The "runtime is a
detail" thesis costs you page 4's framing, page 6's second line, and a Q&A appendix slide
defending a swap that failed. Drop the thesis; keep the appendix line about per-member
credentials, which is good.

**Do not cut:** page 5. The confirmation gate with the send on the record is your best
answer to "controllable" in Criterion 4 and it is the one page that is entirely proven.

---

## 5. The demo video

**Ordering fails the 45-second test.** At 0:45 the judge has seen: a room code, a QR join,
a third name in a roster, and a voice note transcribed. The first three are setup and the
fourth is a commodity. Both moments you say sell it are at 0:50 and 1:05. A judge who
stops at 0:45 has seen nothing they could not get from a Telegram bot with Whisper.

**Single best moment: 1:05, the `@me` divergence.** It is the only beat that explains
itself visually with no narration: three quadrants say "the agent whispered to Bob", one
shows the answer. It is also the only one of the two "selling" beats that is fully built
(`162163d`, reuses the whisper path). It should be at or before 0:30.

**The 0:50 Atlas beat is the best idea and the highest risk.** Three reasons, all from your
own docs:
- The sandbox agent is not told the `[[ask]]` syntax, so it will only emit one if the
  opening prompt or a member prompts it (STATE.md item 6).
- Nothing closes an ask (step iii not built), so the "answer arrives attributed" is just a
  normal Atlas turn, and the "Outstanding" panel does not exist.
- The bridge forwards *every* room turn into the desktop session and posts back *every*
  desktop turn. Unless the desktop agent is instructed to stay silent except when asked,
  Atlas will comment on Alice's voice note and Bob's photo too, and the quadrant becomes
  noise that undercuts "same as a human".

Rehearse it through the simulator exactly as the shooting notes say, with the desktop
session primed to answer only when addressed. If it does not hold on the take, fall back
to the true claim: Atlas joins, appears in the roster, and answers one direct question.
That still lands the "machine member" point.

**Nothing on screen says Atlas is a machine.** A judge sees a fourth name. Put a
persistent caption in that quadrant: "Atlas — an agent running on Jeremy's Mac, joined
through the same endpoints as Alice." Without it the whole beat is invisible.

**No task is named.** The artifact quadrant is a document being written, of what? Put a
title card in the first two seconds: "Alice and Bob: a one-page brief, 20 minutes before a
call." Then the artifact quadrant means something.

**Proposed reorder, under 90 s:**

| t | Beat | Why here |
| --- | --- | --- |
| 0:00 | Title card, two seconds: the job. Room already exists; Alice and Bob already in. | Setup is not content. Show a caption "Alice typed `new` 90 s ago" instead of typing it. |
| 0:03 | Atlas joins; caption says it is a local agent, same endpoints. | Puts the surprising thing first. |
| 0:10 | Alice voice note; transcript attributed on all quadrants; artifact line appears. | Proves attribution and the shared artifact in one beat. |
| 0:22 | Bob asks `@me …`; his quadrant gets the answer, the others show the whisper marker. | Best visual moment, now inside the 45 s window. |
| 0:35 | The room asks Atlas for the local fact; Atlas answers; Alice and Bob see it attributed. | Second selling beat, still inside 45 s. |
| 0:50 | Alice: "send us the PDF"; preview on the laptop; Bob confirms with the token; the PDF lands on Alice's phone and in the inbox; the transcript records who asked and who confirmed. | The proven flow, and the Criterion 4 control story. |
| 1:15 | Close on the artifact quadrant, finished. Voice reply plays over it if it fits. | Ends on the deliverable. |

**Cut to get there:** typing `new` (0:00), the QR join (0:15), the photo (0:40, a vision
demo any wrapper can do, and it costs 10 s), and the voice reply as its own beat (fold it
into the close or drop it). That removes roughly 35 s of setup and commodity.

**One more risk:** the beat sheet has four members on slide 2 (the inbox is the fourth)
and three in the video. Fine, but the email surface only appears at the very end as a PDF
recipient. If you want the inbox tier to count, show the digest arriving in the laptop's
mail client in the 0:50 beat.

---

## 6. The one thing

**Shoot the real take today, from a real phone, and rewrite slide 3 and Criterion 1 so
they claim exactly what the take shows, nothing more.**

Why this and not the scenario, the Atlas fact, or the stack slide: the submission's entire
posture is "observed, not described" and "no mock". That posture is your differentiator
against forty other decks, and it is currently carrying at least four rows that were not
observed, one of which (resume continuity) your own runbook tells you not to say. A judge
who reads the repo, or who simply asks "when did you last run this on a phone", can
falsify it. When one "observed" row falls, the true rows fall with it, and Criterion 1
drops from a defensible 4 to a 2 on trust alone.

The take fixes three things at once: it becomes the evidence for slide 3, it forces the
Atlas beat and the `@me` beat to either work or be honestly downgraded, and it produces the
video the rubric will actually score. Everything else in this review is a rewrite you can
do in an hour after the take is in the can.
