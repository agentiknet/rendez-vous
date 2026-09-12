# Rendez-vous — written submission (draft)

Companion to `rendez-vous.pdf` (6 pages) and `SCRIPT.md` (speaker read + video
beat sheet). This file is the text a judge reads, written against the four
scored criteria. Every factual claim here is anchored in `docs/REHEARSAL.md`,
`docs/ARCHITECTURE.md`, `docs/STATE.md` or `docs/UPSTREAM.md`.

---

## One line

**Rendez-vous turns a group chat into a shared agent room:** several people —
and machines — on the surfaces they already use, driving one agent session and
one living artifact together.

## The problem

Work is multiplayer. Agents are single-player. Every agent available today
lives in exactly one person's window, so the human becomes the integration
layer: copy-paste between two chat windows, a screenshot forwarded to the
other side, "let me ask the AI and get back to you." The second person never
sees the context. The deliverable dies inside one private thread.

## What we built

A room. One agent session, one shared artifact, many members — each on the
surface they already live in. You text `new` to a Telegram bot and you have a
room. You send someone the code and they join from their phone, their laptop,
or by replying to an email. Nobody installs anything, nobody shares a login,
nobody learns a new app.

Inside the room, every message carries who said it and from where. Members can
send voice notes and photos; the agent transcribes and describes them into the
shared context. The agent can answer one member privately while the others see
only that a private answer happened. It can reply with a voice note. It can
attach real files. And when the work is done, it can send the deliverable out
of the room — but only after a member confirms, and the send is written into
the shared transcript.

---

## Criterion 1 — Core requirements and functionality

**The environment is messaging people already live in.** Telegram and email
are not a wrapper around a chatbox; they are where the conversation already
happens, and the room meets it there. The laptop web view is a third surface
on the same session, not a separate product.

**The core workflow runs end to end on live infrastructure.** Observed, not
described:

- A real phone texts `new` on real Telegram; 86.5 s later the agent session
  and its shared artifact are both ready (cold boot, from nothing).
- A second person joins from a laptop and sees the full transcript plus the
  live artifact; every message on every surface is attributed to its sender
  and its surface.
- A voice note sent from the phone is transcribed and attributed. A photo is
  described by the agent and written into the artifact.
- The agent edits the shared artifact unaided, and the edit is visible in the
  laptop view while the phone conversation continues.
- The deliverable leaves the room: previewed, confirmed by a member, delivered
  as a real PDF to a messenger and to an inbox.
- Killed mid-session, the room comes back and still knows what was discussed.

**Known limits, stated plainly.** WhatsApp is not provisioned (no number, no
key) — the room is channel-agnostic by construction, so adding it is
configuration, not code. Paused sandboxes expire on the provider side in
20–60 minutes, which we handle by treating box liveness as its own fact rather
than trusting a stored URL.

## Criterion 2 — Innovation and theme alignment

**The environment is not a wrapper; it is the entire point.** Every agent
product in this space is *single-principal*: one user, one session, one
window. Sandboxes are now a commodity — nine providers, one API call — and all
of them inherit that assumption. The uncontested ground is not the sandbox, it
is the **room around it**.

**What cannot be reproduced in a standalone chatbox:**

- Two people in two different apps contributing to the same agent turn, each
  seeing the other's contribution attributed.
- An agent that addresses members *individually* — asking Alice for the
  product shot and Bob for the positioning line, each answering on their own
  channel in their own time — then reconciling both into one deliverable.
- A private answer to one member inside a shared conversation, where the
  others see that a whisper happened but not its contents.
- A deliverable that leaves the conversation under the members' explicit
  authority, with the send on the record.

**The generalisation we did not expect to find.** The room does not model
*humans*, it models *members* — anything that can speak and listen through two
endpoints. So a **local desktop agent joins the room exactly the way a person
does**, and the room solicits it with the same verb it uses to solicit Alice.
The agent in the sandbox asks the desktop agent for something only a local
machine has, and it answers into the shared transcript like any other member.
Human and machine participants, symmetric, by construction rather than by
special case. That is the pattern we would put forward as the surprising one:
multiplayer is not a feature you add to an agent, it is a layer above one, and
once it exists the distinction between a human member and an agent member
stops mattering.

## Criterion 3 — Technical execution and integration

**Architecture.** One pipeline, four layers, with the seam in a deliberate
place:

```
Telegram · WhatsApp · Email · Web · a desktop agent
                 │
           [ agentpush ]      ingress + egress — every channel behind one API
                 │
          [ RENDEZ-VOUS ]     members · attribution · fan-out by presence tier
                 │
           [ agentproto ]     the agent runtime — unmodified, from npm
                 │
              [ e2b ]         one sandbox per room, one artifact URL
```

- **agentpush** is our messaging layer: Telegram, WhatsApp, email and SMS
  behind one API, inbound and outbound, so the room never learns a single
  provider's quirks.
- **Rendez-vous** is the room itself — the registry of members and tiers, the
  attributed fan-in, the tier-aware fan-out, the artifact proxy, and the
  authority to send work outward.
- **agentproto** is our own open-source agent runtime, consumed **unmodified**
  from npm. A hard constraint from day one: never fork, never vendor, never
  patch. Every upstream bug we hit was written up with a repro instead of
  worked around locally.
- **e2b** provides one sandbox per room holding the shared artifact; OpenAI
  does speech-to-text, vision and text-to-speech; canvakit renders the PDF.

**Depth of integration, not surface.** Three examples where the integration is
the engineering:

1. *Presence tiers.* `messenger | email | room-web` is a first-class property
   of a member. The same agent turn becomes a terse reply on a phone, a
   per-turn digest in an inbox, and a full transcript beside a live artifact
   on a laptop — one fan-out, three renderings.
2. *Media, both directions, without leaking a credential.* Telegram delivers
   inbound media as an opaque `file_id` that only the bot token can resolve.
   Resolving it inline would embed that token in a URL posted to every
   downstream consumer, so resolution stays server-side in the messaging layer
   and the token never leaves it. A regression test asserts the token appears
   nowhere in the returned value.
3. *Liveness as its own fact.* A sandbox can expire while the room still holds
   its URL. The room therefore never advertises a stored artifact link — it
   advertises a proxied, room-keyed URL and gates it on a probe result, so a
   dead box produces no clickable link anywhere.

**Thoughtful failure handling — earned the hard way.** We found five
independent upstream bugs while building, all of the same shape: *silent*.

| # | Failure | Why it was invisible |
| --- | --- | --- |
| 1 | A killed session still answers `200`, so resume reported success in 0.7 s having resumed nothing | success response, no error |
| 2 | Omit `queue: true` and a message arriving mid-turn is rejected and lost | the sender sees their message sent |
| 3 | The fan-out cursor freezes on resume — every reply after it vanishes | the agent keeps answering, nobody receives |
| 4 | An account-pinned inbound route is filtered out and never fires | correct-looking configuration |
| 5 | The agent proposes rebuilding a capability the workspace already brokered | a plausible plan |

None crash. Four lost data quietly; one reported success while doing nothing.
All five are fixed, each with a regression test, and each written up with a
repro. This is also *why* the room records who asked, who confirmed, and what
was sent: in a system whose failures are silent, the transcript is the only
thing that can be checked afterwards.

**Credentials are per-member, not per-room** — a deliberate design call. A
shared room key is a key shared with everyone who has the room code, so there
is no room key: each member attaches their own tools, and revocation is an
unpair rather than a rotation.

## Criterion 4 — Usefulness and agentic experience

**The use case.** Any piece of work that more than one person has an opinion
about and that has to end in an artifact: a deck before a meeting, a spec
between a founder and an engineer, a quote between an agency and a client, a
plan between two people who are not at the same desk. Today that work is
relayed by hand between private agent windows. Here it happens once, in front
of everyone.

**Native to the environment.** There is no app to open. You send a message
where you already send messages. Joining is a code or a QR. A phone member
gets short replies sized for a phone; a laptop member gets the transcript and
the document side by side; an inbox member gets a digest they can reply to.
Nobody is asked to move to where the agent lives — the agent comes to where
they already are.

**Control stays with the members.** Nothing leaves the room without an
explicit confirmation from a member, and the preview shows exactly what would
go and to whom before anyone commits. Every send is recorded in the shared
transcript with who asked and who confirmed. A member can ask for a private
answer without leaving the room, and the room tells the others that a private
exchange happened — control without a hidden back channel.

---

## The demo video

One 4-up frame, about 90 seconds, one clock running across all four quadrants,
because the product *is* simultaneity and a linear screencast cannot show it.

| | |
| --- | --- |
| ↖ Alice — phone, Telegram | ↗ Bob — laptop, room web view |
| ↙ Atlas — local desktop agent | ↘ The artifact, being written |

The two beats that carry it: the room solicits the **machine** member with the
same verb it used on a human thirty seconds earlier; and a private `@me`
answer makes the quadrants visibly diverge — one member sees the answer, the
others see only that a whisper happened. Full beat sheet in `SCRIPT.md`.

Real screens only, no re-enactment. Rehearsed beat by beat against the local
simulator at zero cost, then shot in one take.
