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
We work together. Our AIs work in silos.

AI is in your pocket, but only ever one pocket at a time. Two colleagues on the
same task have two assistants that never talk, so you become the relay:
screenshot, paste, repeat.

Rendez-vous puts several people and several agents in one shared room. Text
"new" to a bot and the room exists. Send the code and someone's phone is in it
too. Nothing to install, no login to share.

The orchestrator is the only party that sees every thread, so it catches what a
single-thread chatbot cannot. Julie sets a 12k budget from her phone. Tom sends
a 16k venue from his. The agent spots the conflict and arbitrates. It solicits
one member when only they have what it needs, and can answer privately while
the others see that a private answer happened.

The room models members, not humans, so a desktop agent joins through the same
two endpoints as a person and is treated identically.

Each room runs in its own e2b sandbox: real terminal, real files, public URL.
The agent builds a PDF or puts a site online and everyone opens the same link.
Nothing leaves the room until a member confirms the recipient and the content,
and every send is logged with who asked and who confirmed.

Stack: TypeScript, no framework. Two open-source runtimes of ours do the heavy
lifting: agentpush, our messaging unification runtime, puts Telegram, WhatsApp
and email behind one API, inbound and outbound; agentproto, our orchestration
layer, runs the agents and the sandboxes, consumed unmodified from npm. Plus
OpenAI for speech, vision and voice replies, OpenRouter for the coding agents,
e2b for the machine, and an MCP tool we expose so the agent renders on brand by
construction. 500 tests green, and seven pull requests contributed upstream to
agentproto during the hackathon.
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

For Agents, Everywhere we built Rendez-vous. Text "new" to a bot and a shared
room exists. Send the code and someone's phone is in it too. Nothing to
install, no login to share. Several people and several agents drive one session
and one live document together.

The part we did not expect: the orchestrator is the only one that sees every
thread, so it catches what no single-thread chatbot can. Julie sets a 12k
budget from her phone. Tom sends a 16k venue from his. The agent spots the
conflict and arbitrates.

Each room runs in its own sandbox with a real terminal and a public URL. Build
a PDF or a site, everyone opens the same link. Nothing leaves until someone
confirms.

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
