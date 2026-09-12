# Middleman — the agent solicits, records, and never stalls

Status: spec only. No code in this document is built. Every competitor's
agent is a shared prompt box that answers whoever talks. Ours knows **who
knows what** and solicits from each member individually — only possible
because the room spans channels. This composes whisper (the directed ask,
`docs/WHISPER.md`), multimodal ingress (the picture, `docs/MULTIMODAL.md`),
the artifact page (where synthesis lands), and the deliverable flow (the
PDF out).

## 1. The arc

```
 Alice (whatsapp)                    Bob (email)
      ▲   │                               ▲   │
 ask  │   │ picture                       │   │ pitch text
      │   ▼            one room           │   ▼
 ┌─────────────────────────────────────────────────────┐
 │ AGENT (middleman): collect the pieces, synthesise   │──▶ artifact page
 └─────────────────────────────────────────────────────┘         │
                                                          confirmed deliverable flow
                                                                 ▼
                                                            PDF to client
```

1. Alice says "make the deck"; the agent whispers her "send me the product shot" and Bob "give me the one-line positioning".
2. Each replies on their own channel, in their own time; a picture lands, normalised per `docs/MULTIMODAL.md`, and answers the ask.
3. The agent synthesises both pieces into the artifact page.
4. The deck goes out as a PDF through the confirmed deliverable flow.

## 2. Question (a): does the landed whisper support agent-initiated solicitation?

**Yes — initiated asks can be *sent* today, but nothing tracks them.** The
mechanism: the agent only produces text inside a turn, and a whisper is a
convention in that reply text, parsed by the service's fan-out
(`src/fanout/whisper.ts:40`, `parseWhisperSegments`) at each `turn-end`
(`src/fanout/reader.ts:116-119`, resolved at `:139`). So an initiated ask is
simply a whisper block emitted in the turn that received the request — and N
addressed messages in one turn already land (`docs/WHISPER.md`, "One turn, N
addressed messages"). The agent can already say: "Alice, send me the product
shot; Bob, the one-line positioning," each delivered privately, everyone
else seeing only the marker (`whisper.ts:120-133`).

What whisper **lacks** is the other half of solicitation: an ask has a
lifecycle — open, answered, nudged, expired, proceeded — and a whisper does
not. A whisper is stateless text: once flushed to the transport
(`reader.ts:141-152`) nothing anywhere remembers that the room is waiting on
Alice. Nothing nudges her, nothing marks the ask closed when her picture
arrives, nothing tells the agent on timeout that it should proceed. The ask
persists only as a promise the model keeps in its head — and the model's
head is compacted, restarted, and resumed by `resume RDV-7F3K`.

## 3. The Ask record — outstanding asks live in the room record

The fix is the same move the room already made for membership and the
fan-out cursor: make it room state, not conversation memory.

```ts
interface Ask {
  id: string                        // "a3"
  toMemberId: string                // member.id, not name — names collide
  what: string                      // "the product shot"
  askedAt: string
  status: "open" | "answered" | "nudged" | "expired" | "proceeded"
  answeredBy: string | undefined    // member.id
  answeredAt: string | undefined
  mediaId: string | undefined       // set when a picture answers it (docs/MULTIMODAL.md)
}
```

Persisted on the `Room` next to `cursor` and `members`
(`src/rooms/types.ts:19-40`, `src/rooms/store.ts`), surviving daemon
restart, box replacement and resume, exactly like the cursor does.

**Syntax.** A whisper block variant the agent writes in its reply:

```
[[ask Alice]] send me the product shot [[/ask]]
```

The service records it as an open `Ask` and delivers it to Alice as a
whisper prefixed `(the room is waiting on you) `. Parsing mirrors
`parseWhisperSegments` (`whisper.ts:40-81`): malformed blocks fold back into
broadcast text untouched, unmatched names fall back to broadcast with a
visible note — a typo'd ask must never stall the demo.

**Resolution.** The next message from that member closes the ask. The
service tags the fan-in text `[Alice · messenger · answers ask a3] ...` so
the agent and the transcript both see the closure (same attribution
convention as §5.1 and `docs/MULTIMODAL.md`). A picture answers an ask by
media id: the ingress text already carries `media:<id>`, matched to the
member's open ask, setting `answeredBy`/`answeredAt`/`mediaId` alongside the
stored `MediaRecord` (`docs/MULTIMODAL.md`).

**Visibility — everywhere the same record:** the web page shows an
**"Outstanding"** panel rendered from the room record; every fan-out to
other members carries a one-line marker `(waiting on Alice: product shot)`
— once, when the ask opens, not repeated every turn; a late joiner or a
resumed box reads the same record, so there is no second source of truth to
diverge.

**Why, stated twice because it is the bug class of the night:** the failure
mode this project keeps finding (`docs/UPSTREAM.md`, "The pattern") is
invisible state diverging from reality — a wait checked by nothing, routed
around with no error anywhere, noticed only when a human observes a reply
never came. And an agent silently waiting forever for an answer nothing
will ever produce is the same failure wearing a friendlier face: it looks
like patience, and it stalls the room exactly as hard.

## 4. The no-stall policy — decided, not optional

- **Nudge once.** After `RDV_ASK_NUDGE_MINUTES` (default **10**) the service
  whispers the member: `(still waiting on you: product shot; reply, or say
  skip)`. Status becomes `nudged`. One nudge, not a drip.
- **Proceed.** After `RDV_ASK_PROCEED_MINUTES` (default **30**) the service
  posts a **service-originated turn** into the room, visible to all:
  `Alice has not answered ask a3 (product shot); proceed with what you have`.
  Status becomes `proceeded`, and the agent continues without the piece.
- **Skip.** A member can answer `skip` at any time; the ask closes as
  `expired`.
- **Every transition is a transcript line** — nudge, proceed, skip, answer —
  so no ask ever changes state invisibly. The agent **never blocks**; it is
  told this in the opening prompt (§5). It is a synthesiser of what has
  arrived, never a waiter on what has not.

## 5. What the agent is told

Additions to the room's opening prompt: you can ask a specific member for a
specific thing with `[[ask <name>]] ... [[/ask]]` — ask for **exactly one
thing per ask**, since two things in one ask means neither can be tracked as
answered. Asks are recorded in the room, shown on the web page, and visible
to everyone as a one-line marker; do not restate them every turn. When a
reply is tagged `answers ask <id>`, that ask is closed — use what was sent.
If the room tells you an ask timed out, **proceed immediately** with what
you have: never wait on an unanswered ask, and never apologise for a missing
piece at length — one clause, then synthesise.

## 6. Ownership boundary

- **Synthesis writes to the artifact page.** The deck draft, the pieces
  collected, the reconciliation — all of it lands on the artifact, where
  every tier already sees it at its own fidelity (§2.1).
- **The final send goes through the confirmed deliverable flow.** The PDF
  out is the deliverable flow's send, gated by its preview and confirm step.
- **Nothing new leaves the room without the preview and confirm gate.** The
  ask mechanism changes who the agent talks *to*; it creates no new egress.

## 7. Implementation plan — frozen order, after the deliverable flow

| # | Step | Size | Tests |
| --- | --- | --- | --- |
| i | `Ask` record on `Room` + store persistence beside `cursor`/`members` (extends `src/rooms/types.ts`, `src/rooms/store.ts`) | S | persist/reload round-trip; record survives a store restart |
| ii | `[[ask <name>]] ... [[/ask]]` syntax in fan-out (`src/fanout/whisper.ts` sibling parser; prefix `(the room is waiting on you) `, one-line marker on open) | M | parse happy path; malformed block folds to broadcast; unmatched name falls back visibly; N asks + whispers + broadcast in one turn; marker emitted once, on open only |
| iii | Answer tagging on fan-in: next message from that member closes the ask, `[Alice · messenger · answers ask a3]` tag on the fan-in text; picture answers by media id | M | text answer closes; image answer sets `mediaId` per docs/MULTIMODAL.md; message from a *different* member does not close it; answered ask idempotent (no double-close) |
| iv | Web "Outstanding" panel from the room record | S | panel reflects record; closed asks leave the panel; late-joiner replay shows the same state |
| v | Nudge + proceed timers: `RDV_ASK_NUDGE_MINUTES` (10) / `RDV_ASK_PROCEED_MINUTES` (30), service-originated proceed turn, `skip` → `expired`; every transition a transcript line | M | nudge fires once at threshold; proceed turn is attributed service-origin and visible to all tiers; skip path; **the never-answered test: an ask nobody ever answers ends with the room proceeding on schedule, agent continuing, transcript recording every transition** |
| vi | Opening-prompt additions (§5) | XS | prompt contains the one-thing-per-ask rule and the proceed-on-timeout rule |

Step v's never-answered test is the thesis: the room's worst case is not a stall, it is a graceful degrade with a paper trail.
