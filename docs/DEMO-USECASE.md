# Demo use case — "le client vient d'appeler"

Four participants, one agent session, one deliverable. ~4 minutes.

The use case is chosen so that multiplayer is **inherent**, not decorative: no
single person has all the information, and the people who have it are not in
the same place or on the same app.

> **Le pitch en une phrase, à dire avant de commencer :** « Un client vient
> d'appeler. On a dix minutes pour lui envoyer une proposition. Mathilde a le
> client en ligne, je suis au bureau, et je pars en rendez-vous dans deux
> minutes. On va tous parler au même agent. »

## Cast

| Qui | Canal | Rôle dans l'histoire |
|---|---|---|
| **Mathilde** | Telegram | a le client au téléphone, connaît le besoin |
| **Jeremy** | Telegram | au bureau, connaît les contraintes et les prix |
| **Jeremy** | WhatsApp | le MÊME humain, parti en voiture — note vocale |
| **Le jury / le client** | Web, `rdv.clipgen.co/r/<code>` | aucun compte, aucune app |

The web page is also the screen you project: transcript, roster, room state,
and the live artifact in one view.

## Setup, before you are on stage

1. **A fresh room.** Not a room you have already used — an old room carries
   its own history into the agent's context and it will faithfully repeat
   whatever went wrong there. Mathilde sends `new` to the bot.
2. Open the room page on the projected screen and type a name in "Your name"
   (e.g. `Le client`). Nothing is sent until you send.
3. Check the agent answers once (`ping`), so the box is warm. A cold boot
   took **58s** measured on 2026-09-14 (the older "~30s" in this file was
   stale) and you really don't want that on stage.

## The script

### Beat 1 — Mathilde ouvre, seule (~30s)

**Mathilde (Telegram):**

```
On a un client qui veut un week-end à Lisbonne pour deux, début mars,
1200 € tout compris. Il faut une proposition d'ici ce soir.
```

The agent starts working and puts a first page on the artifact URL.

→ **Point at the projected page.** One person, one agent, a document appearing.
Nothing surprising yet. That's deliberate.

### Beat 2 — Jeremy arrive et contredit (~45s)

Tap the Telegram invite link the agent gives, or send `join <code>`.

**Jeremy (Telegram):**

```
Attention, à 1200 € en mars on ne tient pas l'hôtel du centre.
Soit on sort du centre, soit on passe à 1500.
```

→ The agent does NOT ask everyone to agree and wait. It **picks a path and
says in one line what it chose and why**, naming the constraint that forced
it — and it says it to the whole room, because an arbitration between two
people's constraints changes the shared plan.

That broadcast is the correct behaviour, not a shortcut: the agent's rule is
that a decision changing the shared plan goes to everyone, and that anything
concerning one person goes to that person alone. Beat 4 is where you show the
second half. Do not promise per-person answers here — measured twice on
2026-09-14, the agent broadcasts the arbitration, and it is right to.

**This is the first thing that is actually hard.** Two humans just gave one
agent contradictory constraints, from two phones, in the same second.

### Beat 3 — le même humain, un autre appareil (~45s)

Now switch to WhatsApp, as **yourself**, and send a **voice note**:

```
Ajoute le transfert aéroport, le client l'a demandé au téléphone.
```

Two things to point out, both visible on the projected transcript:

- The voice note arrives **as text** — it was transcribed on the way in.
- The agent does **not** greet you as a new participant and does not re-ask
  you what it already asked on Telegram. `[Jeremy · telegram]` and
  `[Jeremy · whatsapp]` are one human on two devices, and it knows that.

### Beat 4 — la question qu'on ne pose pas devant tout le monde (~30s)

**Jeremy (Telegram ou WhatsApp), en clair, sans aucune syntaxe:**

```
Garde ça entre nous : est-ce qu'on est en train de vendre trop cher ?
```

→ You get the answer. **Mathilde sees only that the agent whispered to you**,
never what it said.

No command, no `@me`, no prefix. You asked for discretion in your own words
and the agent worked out who the answer was for. That is the whole point:
the routing is the agent's job, not the user's.

### Beat 5 — le livrable (~30s)

**Mathilde (Telegram):**

```
Envoie-nous la proposition en PDF, et dis-moi en vocal ce que je réponds
au client.
```

→ Everyone receives the **PDF as a real attachment** on their own channel —
not a link — and Mathilde gets a **playable voice note**. The artifact page
updates live on the projected screen.

### Beat 6 — la reprise (~45s, la meilleure)

Let the room go quiet, or pause it. The sandbox is destroyed: the agent's
working context is gone, for real.

Then, from any channel:

```
On en était où ?
```

→ The room comes back on a **brand-new box**, and picks up the thread: the
transcript is replayed into the fresh session, so it still has Lisbon, March,
the 1500 € arbitration and the airport transfer.

Say this out loud, because it is the claim: **the session is persistent, the
machine is not.**

And if the transcript genuinely cannot be recovered, the agent says so
plainly instead of performing a warm greeting and contradicting itself two
turns later. That failure mode shipped once and was found on a real phone.

## What each beat proves

| Beat | Capability |
|---|---|
| 1 | shared persistent session, live artifact |
| 2 | multiplayer fan-in, arbitration, name-addressed replies |
| 3 | voice in, cross-channel identity (one human, two devices) |
| 4 | audience decided by the AGENT from natural language |
| 5 | real attachments out, voice out, live artifact |
| 6 | persistence across a destroyed sandbox — honest when it can't |

## If something misfires on stage

- **No reply at all** → check `https://rdv.clipgen.co/health`. A 502 means the
  service is down behind a live tunnel; inbound webhooks are taking 502s and
  those messages are lost. Restart it as a foreground session, never as a
  backgrounded child (a process-group reap killed it once that way).
- **A member shows as a raw id** (`6371794295`) → their stored name refreshes
  on their NEXT message; it is cosmetic, keep going.
- **A voice note comes back "could not be fetched"** → say it out loud and
  move on. It is the honest floor: the room is told the turn arrived and could
  not be read, rather than silently dropping it. That beats the alternative,
  and the alternative is what this project is about.
