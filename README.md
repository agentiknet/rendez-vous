# Rendez-vous

**A shared, persistent agent sandbox that several people drive at once, each
from the surface they already live in.**

Alice on WhatsApp. Bob on email. Chloé on her laptop. One room, one agent, one
artifact, three fidelities.

```
new              → RDV-7F3K + join QR + live artifact URL
join RDV-7F3K    → you are in the room, on whatever you are holding
resume RDV-7F3K  → tomorrow, with state intact
```

## Why

The durable agent session plus sandbox is now a commodity. OpenAI shipped the
Agents API on 2026-09-10 with nine sandbox partners behind it. Every one of
them is single-principal: one key, one developer, one session.

The uncontested ground is not the sandbox. It is the room around it — several
humans, several surfaces, one live agent state.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Short version: Rendez-vous is
a host service that drives an **unmodified** agentproto daemon over its public
HTTP surface. No fork, no vendoring. It adds the room registry, attributed
fan-in, tier-aware fan-out, and the room web view.

## Status

Concept locked, ground-truthed against agentproto main. Build in progress.
