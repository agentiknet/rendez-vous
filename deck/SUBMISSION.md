# Submission form: copy-paste ready

Deadline: today 16:30 CEST. Every field below maps to one field on the form.

---

## Project Name

```
Rendez-vous
```

---

## Project Description

```
Rendez-vous turns any messaging app into a shared agent room. Several people,
and other agents, drive one agent session and one live document together, from
whatever app they already have open.

THE PROBLEM. AI is already in your pocket, but it is only ever in one pocket at
a time. Two colleagues working on the same thing have two separate assistants
that never talk to each other. So the human becomes the integration layer:
screenshot one chat, paste it into the other, relay what was agreed. The second
person never sees the context, and the deliverable dies inside one private
thread.

THE ENVIRONMENT IS THE POINT. You text "new" to a Telegram bot and a room
exists. You send someone the code or a QR and their phone is in the room too.
Nothing to install, no account to create, no login to share. The agent comes to
where people already are instead of asking them to move.

WHAT ONLY A ROOM CAN DO. The orchestrator agent is the only party that sees
every thread, so it can do things no single-thread chatbot can. In our demo
Julie sets a 12k budget from her phone while Tom sends a photo of a 16k venue
from his; the agent detects the conflict, says so out loud, and arbitrates
until they converge. It addresses members individually when only one of them
has what it needs. It can answer one member privately while the others see that
a private answer happened, but not what it said. Every message carries who sent
it and from where.

MEMBERS, NOT HUMANS. The room models members, so a local desktop agent joins
through the same two HTTP endpoints as a person and is treated identically. The
room cannot tell the difference, because there is no difference to tell.

A REAL MACHINE, NOT AN API. Each room gets its own e2b sandbox: nobody's
laptop, a real terminal, a real filesystem, and a public URL. When the agent
builds a PDF or puts a website online, everyone opens the same link and can
change what they see. The agent renders through an MCP tool we expose, so the
design system is enforced by construction rather than by asking a model to stay
on brand.

WORK LEAVES THE ROOM, UNDER CONTROL. Before anything is sent outside, the room
previews the recipient, the channel, the subject and the rendered document, and
waits for a member to confirm. The send is written into the shared transcript:
who asked, who confirmed, what, to whom.

TECHNICAL EXECUTION. TypeScript on Node 20, no framework, native fetch and
native SSE. agentpush (our messaging layer) puts Telegram, WhatsApp, email and
SMS behind one API, inbound and outbound. agentproto, our own open-source agent
runtime, is consumed unmodified from npm: a hard constraint from day one, never
fork, never vendor, never patch. e2b provides the sandbox. OpenAI does
speech-to-text, vision and text-to-speech; OpenRouter ran the GLM 5.3 executors
that wrote much of the code. Fan-in attributes every inbound message and posts
it with queue:true, which is load-bearing: without it a message arriving
mid-turn is silently dropped. Fan-out holds one SSE reader per room and renders
one agent turn three ways, terse on a phone, a digest in an inbox, full
transcript beside the live document on a laptop. 500 tests, all green.

WHAT WE FOUND ALONG THE WAY. Eight failures, every one of them silent. A killed
session still answers 200, so resume reported success in 0.7s having resumed
nothing. A paused sandbox expires while the room keeps handing people its dead
link. We did not work around them locally: seven pull requests are open against
our own open-source runtime, each carrying a test that reproduces the failure
before fixing it.
```

---

## Products & Tools Used

Tick: **OpenAI**, **OpenRouter**, **AI Tinkerers**

Other Products field:

```
e2b (sandbox per room), Telegram Bot API, Cloudflare Tunnel, agentpush (our own
messaging layer), agentproto (our own open-source agent runtime, from npm),
canvakit (our own template + design-kit renderer), Anthropic Claude and
z-ai GLM 5.3 via OpenRouter
```

---

## Team Contributions

```
Jeremy ANDRE (lead): everything in the Rendez-vous repo. Architecture and the
room model (members, presence tiers, attributed fan-in, tier-aware fan-out).
The agentpush integration for Telegram inbound and outbound, including a fix
upstream in agentpush so inbound Telegram media can be read at all. The e2b
sandbox boot, artifact serving and liveness handling. The MCP endpoint that
gives the sandboxed agent a render tool. Multimodal in and out through the
OpenAI API: Whisper for voice notes, vision for photos, TTS for spoken replies.
The deliverable flow and its confirmation gate. Seven pull requests upstream to
agentproto. Orchestration of GLM 5.3 coding agents over OpenRouter for parts of
the implementation, with every result verified by hand before it landed.
```

---

## Prior Work

State this plainly. It is the honest answer and judges reward it.

```
Three components pre-date the hackathon and were used as dependencies, not
built during it:

- agentproto, our open-source agent runtime, consumed unmodified from npm. We
  did not fork or patch it. The eight bugs we hit were written up with repros
  and fixed via seven pull requests opened upstream during the hackathon.
- agentpush, our messaging layer. One fix landed in it during the hackathon:
  Telegram inbound media could not be read by any consumer, because the
  provider never implemented attachment fetch.
- canvakit, our template and design-kit renderer, used to produce the PDF and
  the live site from one data file.

Everything else was built during the hackathon: the entire Rendez-vous room
service, the multimodal ingress and egress, the private-reply and solicitation
protocols, the deliverable flow with its confirmation gate, the room web view,
the MCP render tool, the desktop-agent bridge, and the 500-test suite.
```

---

## Additional Links

```
https://github.com/agentiknet/rendez-vous
```

(Repo is private. Make it public before pasting, or drop this field.)

---

## Social Post

X version, under the limit:

```
Rendez-vous: your AI is in your pocket, but only ever one pocket at a time.

We put several people AND several agents in one shared room, from the messaging
app they already use. The agent sees every thread, so it can tell Julie her
12k budget does not fit the 16k venue Tom just sent.

Built with @OpenAI @openrouter, e2b sandboxes and our own open-source runtime.
Thanks @AITinkerers @CopilotKit @exaailabs @auth0 @ambiguousio @triggerdotdev
@mozillaAI

#AgentsEverywhere
```

LinkedIn version, company names instead of handles:

```
AI is already in your pocket. It is just only ever in one pocket at a time.

Two colleagues working on the same thing have two separate assistants that
never talk. So the human becomes the relay: screenshot one chat, paste it into
the other, carry the context by hand.

For Agents, Everywhere we built Rendez-vous. You text "new" to a bot and a
shared room exists. Send someone the code and their phone is in it too. Nothing
to install, no account to share. Several people and several agents drive one
session and one live document together.

The part we did not expect: because the orchestrator is the only one that sees
every thread, it can catch what no single-thread chatbot can. Julie sets a 12k
budget from her phone. Tom sends a photo of a 16k venue from his. The agent
spots the conflict and arbitrates.

Each room runs in its own isolated sandbox with a real terminal and a public
URL, so when it builds a PDF or puts a site online, everyone opens the same
link. Nothing leaves the room until a member confirms what is being sent and to
whom.

Built with OpenAI, OpenRouter, e2b, and our own open-source agent runtime,
consumed unmodified. We hit eight silent failures on the way and opened seven
pull requests upstream rather than patching around them.

Thanks to AI Tinkerers, OpenAI, CopilotKit, OpenRouter, Exa, Auth0, Ambiguous
AI, Trigger.dev, Mozilla.ai and Google Cloud.

#AgentsEverywhere
```

---

## Video

Two minutes maximum, longer loses points. The official guide is explicit that
production values do not affect scoring: a screen recording with clear audio is
enough. See `STORYBOARD.md` for the beat sheet, and cut it to 2:00.
