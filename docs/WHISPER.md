# Whisper — a directed reply

A whisper is what makes the agent a participant instead of a shared prompt
box: it can answer one member instead of broadcasting, e.g. privately telling
Alice how it reconciled her request with Bob's.

## Why not a tool call

The room agent runs inside the box with no channel credentials and no MCP
tools (architecture.md §9.3 — verified, by design), so it cannot call
`agentpush` to address one member directly. A whisper is instead a
**convention in the agent's own reply text**, interpreted by the service's
fan-out (`src/fanout/whisper.ts`), never sent to any daemon route.

## Syntax

```
Hi both.
[[whisper to Alice]]
Went with your version — Bob's ask conflicted with it.
[[/whisper]]
Bob, moving ahead as discussed.
```

Each delimiter is on its own line. Text outside a block is the broadcast
part. The target name is matched case-insensitively against the room's
current members. A name matching nobody falls back to broadcast — content
kept, with `(whisper target not found: <name>)` prepended, so nothing is
silently dropped. An opening delimiter with no matching close before the end
of the reply is malformed and folds back into broadcast text untouched.

## Routing

On `turn-end`, the fan-out (`src/fanout/reader.ts`) splits the reply into
segments and renders each member's own view of the same turn:

- Broadcast segments reach everyone verbatim, as before.
- The whisper's target sees it in full, prefixed `(private) `.
- Every other member gets a one-line marker instead of the content:
  `(the agent whispered to <name>)`.

Each result still goes through the normal per-tier rendering unchanged.

## Why the transcript still records it

The shared transcript must record that a whisper happened, even though only
one member sees the content. A room where a message can vanish without a
trace is the exact silent-failure trap this project has spent the night
fixing. A whisper is deliberately narrow — content, not the event — so trust
in the room's honesty never depends on it.

## Limits

- **The web view (tier 3) sees the content.** It reads the raw daemon
  transcript and has no per-member auth yet, so `src/web/page.ts` renders a
  whisper as `whispered to <name>` with the text collapsed under a toggle
  labelled "private, visible here because the web room has no member auth
  yet" — honest about the gap, not pretending it's private there too.
- An unmatched target is a broadcast, not an error: a mistyped name must never
  stall the demo.
