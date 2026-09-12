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
We work together, but our AIs work alone. Yours is in your pocket, your colleague's is in theirs, and the two never meet, so you end up as the relay, screenshotting one chat to paste into the other. Rendez-vous removes the relay. It is one shared room where several people and several AI agents talk to a single agent in a single conversation, each from the messaging app already open on their phone.

Joining takes one message. Text "new" to create a room, or "join" with its code to enter one. Nothing to install, and it works over Telegram, WhatsApp, SMS or email. Agents join exactly the way people do, through the same two endpoints, and the room cannot tell them apart.

Because everyone speaks to the same agent, it is the only party that sees every thread at once. That is what a chatbot in one person's pocket cannot do. In our demo, Julie sets a 12k budget for the company offsite from her phone. Tom, from his, sends a photo of a venue that costs 16k. They never message each other. The agent spots the conflict, names it, and arbitrates in front of both until they converge.

Once they agree, the work still has to get done. Every room runs in its own cloud sandbox with a real terminal, real files and a public URL, so the agent writes the PDF, puts the site online, and everyone opens the same link.

Underneath sit our two open-source runtimes. agentpush unifies the messaging so Telegram, WhatsApp and email sit behind one API, and agentproto, used unmodified from npm, orchestrates the agents and their sandboxes. OpenAI handles voice and vision, OpenRouter the coding models, e2b the machines. It runs 500 green tests, and building it sent seven pull requests upstream to agentproto during the hackathon.
```

---

## Products & Tools Used

Tick: **OpenAI**, **OpenRouter**, **AI Tinkerers**

Other Products field:

```
e2b (sandbox per room), Telegram Bot API, Cloudflare Tunnel, agentpush (our own
open-source messaging unification runtime), agentproto (our own open-source
orchestration layer, from npm), canvakit (our own template and design-kit
renderer), Anthropic Claude and z-ai GLM 5.3 via OpenRouter
```

---

## Team Contributions

```
Jeremy ANDRE (lead): all of it. The room model (members, presence tiers,
attributed fan-in, tier-aware fan-out). Telegram in and out through agentpush,
including a fix landed in agentpush so inbound Telegram media can be read at
all. e2b sandbox boot, artifact serving, liveness. The MCP endpoint
that gives the sandboxed agent a render tool. Voice and vision in, voice and
files out, through the OpenAI API. The deliverable flow and its confirmation
gate. Seven pull requests upstream to agentproto. GLM 5.3 coding agents
orchestrated over OpenRouter wrote parts of the implementation; every result
was verified by hand before it landed.
```

---

## Prior Work

State this plainly. It is the honest answer and judges reward it.

```
Three of ours pre-date the hackathon and were used as dependencies, all
open-source: agentproto (our orchestration layer, consumed unmodified from
npm), agentpush (our messaging unification runtime) and canvakit (our template
renderer).

Built during the hackathon: the entire Rendez-vous room service, multimodal in
and out, the private-reply and solicitation protocols, the deliverable flow and
its confirmation gate, the room web view, the MCP render tool, the
desktop-agent bridge, the 500-test suite, seven pull requests to agentproto and
one fix to agentpush.
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

Built on our open-source runtimes, agentpush for messaging and agentproto for
orchestration, with @OpenAI @openrouter and e2b sandboxes.
Thanks @AITinkerers @CopilotKit @exaailabs @auth0 @ambiguousio @triggerdotdev
@mozillaAI

#AgentsEverywhere
```

LinkedIn version, company names instead of handles:

```
We work together. Our AIs work in silos.

AI is in your pocket, but only ever one pocket at a time. Two colleagues on the
same task have two assistants that never talk, so you become the relay:
screenshot, paste, repeat.

For Agents, Everywhere we built Rendez-vous. Text "new" to create a room, or
"join" with its code to enter one. Nothing to install, and it works over
Telegram, WhatsApp, SMS or email. Several people and several agents end up in
one conversation, working on one live document.

The part we did not expect: the orchestrator is the only one that sees every
thread, so it catches what no single-thread chatbot can. Julie sets a 12k
budget from her phone. Tom sends a 16k venue from his. The agent spots the
conflict and arbitrates.

Once they agree, the work still has to get done. Every room runs in its own
cloud sandbox with a real terminal, real files and a public URL, so the agent
writes the PDF, puts the site online, and everyone opens the same link.

Built on our two open-source runtimes: agentpush for messaging unification,
agentproto for orchestration. Plus OpenAI, OpenRouter and e2b. Seven pull
requests contributed upstream along the way.

Thanks to AI Tinkerers, OpenAI, CopilotKit, OpenRouter, Exa, Auth0, Ambiguous
AI, Trigger.dev, Mozilla.ai and Google Cloud.

#AgentsEverywhere
```

---

## Video

Two minutes maximum, longer loses points. The official guide is explicit that
production values do not affect scoring: a screen recording with clear audio is
enough. See `STORYBOARD.md` for the beat sheet, and cut it to 2:00.
