# Demo use case — "one room, one agent, and we can kill the machine"

> Candidate replacement for `docs/DEMO-USECASE.md`. Same cast, same room, half
> the time, re-centered on the actual product: **we control the harness**. The
> multi-user room is the surface; agentproto is the thing underneath.

**2 minutes. 4 beats. One pitch, one kill shot.**

The spoken pitch (~10s, before beat 1):

> « Trois personnes, trois canaux, une seule session d'agent partagée. Et
> maintenant le moment que j'aime : au milieu de la conversation, on détruit
> la machine qui fait tourner l'agent. La session survit. Regardez. »

The original 4-min script (Lisbon beats with PDF deliverable and whisper) is
kept in git history; its full capability list stays true, this is the cut.

## Cast (unchanged)

| Qui | Canal | Rôle |
|---|---|---|
| **Mathilde** | Telegram | opens the room, holds the brief |
| **Jeremy** | Telegram **et** WhatsApp | same human, two devices — contradiction + voice note |
| **Le jury / spectateur** | Web, `rdv.clipgen.co/r/<code>` | no account, the projected screen |

## Setup (unchanged in kind, rehearsed in detail)

1. Fresh room: Mathilde sends `new`. Old rooms carry old history.
2. Room page on the projected screen, "Your name" filled, nothing sent yet.
3. Warm ping BEFORE the pitch — cold boot measured 58s (2026-09-14). A cold
   boot on stage is 58 seconds of silence; it will not happen.
4. **The pause command is prepared and tested.** The kill path is
   `service.pauseRoom(code)` from the service side (RUNBOOK) — NEVER a daemon
   `kill` (strands the room permanently — REHEARSAL.md).

## The script

### Beat 1 — trois surfaces, une salle (~25s)

**Mathilde (Telegram):**

```
On a un client qui veut un week-end à Lisbonne pour deux, début mars,
1200 € tout compris. Proposition pour ce soir.
```

Point at the page: first artifact version appears. Then, immediately:

**Jeremy taps the invite link / `join <code>`** — the roster gains
`[Jeremy · telegram]` visibly. Then **Jeremy switches to WhatsApp and sends a
voice note**: « C'est Jeremy, je suis sur la route. »

→ It arrives **as text** on the transcript, and the agent does NOT greet a
new participant: `[Jeremy · whatsapp]` is the same human, it knows that.

**Proves in 25s:** join capability, multiplayer fan-in, voice→text,
cross-channel identity. Three beats of the old script, one beat now.

### Beat 2 — l'agent bricole le harness PENDANT qu'il orchestre (~35s)

**Jeremy (Telegram):**

```
Vérifie les prix réels sur le web, invente rien. Dis-nous ce que tu fais.
```

→ The agent **tells the room what it is doing** (« je cherche les prix de
mars, je reviens »), performs a **real tool call inside the box** (web search),
and comes back with a sourced number — the artifact updates while people
watch. **Mid-search, Mathilde interjects** (« il n'aime pas les auberges ») —
the turn is queued and answered without dropping the search work.

**This is the new claim of the demo.** The agent is not a chatbot with a
document; it is running harness work (tools, files, network) inside a sandbox
while orchestrating several humans at once. The queue is what makes
"interject mid-work" safe instead of racy.

**Rehearsal gate:** search from inside the e2b box must be proven in rehearsal
(network egress + adapter tool availability). If search fails on stage, the
honest fallback is any *visible* harness work — a computed comparison table
written to the artifact — and you say so. The claim is "real tool work in the
box", not "the internet".

### Beat 3 — l'arbitrage, à toute la salle (~20s)

**Jeremy (Telegram):**

```
À 1200 € en mars on ne tient pas l'hôtel du centre. Soit on sort du
centre, soit on passe à 1500.
```

→ The agent picks a path, says in one line what it chose and why, **to the
whole room** (measured 2× on 2026-09-14 — it is the correct behaviour: a
decision that changes the shared plan goes to everyone).

### Beat 4 — on détruit la machine (~35s, le money shot)

Beat 3 has just landed. **Run the prepared `service.pauseRoom(code)`** — the
box is destroyed for real while the room is warm. Say it plainly:

> « Là, la machine vient de mourir. Vraiment. »

Show the room page / the pause state. Then, from WhatsApp:

**Jeremy:** « On en était où ? »

→ The room revives on a fresh box and picks up the thread — Lisbon, March,
the searched price, the 1500 arbitration, Mathilde's constraint. And you say
the claim out loud, because it is the product:

> **« La session est persistante. La machine ne l'est pas. »**

If the transcript genuinely cannot be recovered, the agent says so plainly
instead of performing warmth — that shipped once and was caught on a real
phone. Keep it.

## What each beat proves

| Beat | Capability |
|---|---|
| 1 | join + multiplayer fan-in + cross-channel identity, in one breath |
| 2 | real harness work in the sandbox, concurrent with multi-human orchestration |
| 3 | arbitration, broadcast to the shared plan |
| 4 | harness control: pause/destroy/rebirth on a fresh box, durable session |

## Cut from the 4-min version (say it, don't show it)

One sentence before beat 1 or after beat 4, whichever fits the room:
« La même salle gère aussi les chuchotements (l'agent décide qui voit quoi),
les PDF en pièce jointe, et la pause auto après 20 minutes. » The full script
lives in `docs/DEMO-USECASE.md` history for the long-form audience.

If the clock allows 2:20, the **whisper** beat is the one to add back — it is
20 seconds, no setup, and "the agent decides the audience, not the user" is a
one-liner that lands with non-technical judges.

## Pièges (unchanged, because they are the ones that bit)

- Never `kill` the daemon session for beat 4 — `service.pauseRoom(code)` only.
- Prewarm the room near the take (idle auto-pause at 20 min can bite during
  makeup).
- One restart authority, in a PTY that survives. Never `&` from a disposable
  shell.
- Voice note "could not be fetched" → say it aloud, keep going.
- Raw member id on the roster → cosmetic, refreshes on next message.
- No code edits during the take.
