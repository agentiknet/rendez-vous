# react / reply — the constat that stops BRIEF-48 before any tool

**BRIEF-48.** The brief asked for two room MCP tools, `react` and `reply`, on
the shape of `send_file` (docs/SEND-FILE.md), and gave one design gate that
outranks the implementation:

> **S'il n'existe aucun identifiant stable qu'un agent puisse citer, dis-le
> et arrête-toi.**

This document is that "dis-le". The gate fails, on both tools, for the same
reason: **rendez-vous destroys every provider-native message id before the
agent could ever see one.** No tool is written in this commit. What follows
is the finding, the anchors behind it, and the design that must land first.

## 1. The finding — no citable identifier exists

What the brief demands of an identifier: stable, agent-visible, and
*surviving to the provider* — because agentpush's new tools consume
provider-native ids, not room-internal ones.

- `send_reaction` takes `message_id` = "id natif provider : wamid.* WhatsApp,
  entier Telegram, id de neige Discord" (agentpush
  `packages/tools/src/tools/send-reaction.ts`, the schema's own description).
  A room-local handle cannot be passed there; the provider would reject it.
- `reply_to_message_id` on a messenger channel maps to `content.replyTo` →
  the provider's native quoted-reply param (agentpush
  `packages/sdk/src/push.ts:1060-1080`); same requirement. Mail is the one
  channel that resolves threading server-side from a prior message id
  (Gmail `resolveThreading`, push.ts:925-937).

Against that requirement, every id in this codebase fails one clause or
another:

| Candidate id | Where it lives | Why it fails |
| --- | --- | --- |
| Inbound provider id (`wamid.*`, Telegram int) | agentpush envelope, `messageId` | Used **only** for dedup, then dropped: `MessageDedup.seen` (src/channels/agentpush/inbound.ts:243-262) and the two webhook arms (src/service/http.ts:1112, 1178). It never reaches a transcript, a record or a store. |
| What the agent actually reads of a member's message | `attributeText` | Plain text: `[Name · channel] text` (src/fanin/index.ts:86-92). No id is carried into `fanIn` (src/service/room-service.ts:1081, 1507) — there is nothing for the agent to cite. |
| Outbound provider id (`message_id` of a sent message) | agentpush `send_message` result | Discarded by `AgentpushTransport.checkedSend` (src/channels/agentpush/outbound.ts:217-236): the result is read only for `blocked`/`failed`. Even the engine's `Delivery` record never learns it. |
| `Delivery.id` (`d1..dN`) | `DeliveryEngine.mintRecords` (src/service/delivery.ts:374-391) | Room-internal, pruned (`pruneDeliveries`), never shown to the agent as an addressable handle, and — decisive — carries no provider id to hand to `send_reaction`/`reply_to_message_id`. |
| Email `threadRefByMember` | src/channels/email/outbound.ts:33, 60 | In-memory, per-member *last* message only, and never exposed to the agent. It already gives **mail** a thread reply without the agent naming anything — which is exactly why the absence went unnoticed: the only channel that works today is the one that needs no id from the agent. |
| Room-web | — | Not a reaction/reply channel at all; the outbox drain renders text (and `recordToolCall` mints for pull members only). Nothing to point at. |

**Conclusion.** An agent literally cannot designate a message today — not a
member's message (id destroyed at dedup) and not its own (id discarded in
`checkedSend`). Writing `react`/`reply` now would force the tool to *guess*
a message from `(member_id, recentness)` and pass a fabricated or absent id
to agentpush — a silent lie wearing a tool schema, the exact defect class
OUTBOX §1 and SEND-FILE.md §"the one rule" exist to close. Per the brief:
stopped here.

## 2. The design that must land before the tools

Four independent pieces. **Pieces 1-3 are BUILT** (this brief); piece 4 is
deliberately deferred — see §4.

1. **Capture the inbound provider id at the dedup boundary.** DONE. Both
   webhooks pass the envelope's `messageId` through `InboundInput
   .providerMessageId` (src/service/http.ts) instead of letting the dedup
   FIFO be its grave; `RoomService.handleMessage` mints an `inbound`
   `MessageRef` on the room the message actually landed in, never fatal —
   a failed mint must not lose the member's message.
2. **Capture the outbound `message_id` per delivery.** DONE.
   `Transport.send` resolves to the provider's `message_id` (the union's
   second arm is `void`, not `undefined`: every pre-existing transport
   keeps resolving nothing, unedited). `AgentpushTransport.checkedSend`
   returns the id on a `sent`/`queued` result instead of dropping it;
   `DeliveryEngine.attempt` writes it onto the record
   (`Delivery.providerMessageId`, present only on a delivered PUSH record,
   key-absent otherwise) and mints an `outbound` ref. A console/memory
   send, a provider that returned none, and every pull delivery record
   nothing — absence stays honest, no handle exists for a message the
   room cannot prove the id of.
3. **Keep the map handle → provider id, durable on the room.** DONE.
   `Room.messageRefs` / `Room.messageRefSeq` (same optional-key JSON
   round-trip rule as `deliveries`), minted by `RoomStore.recordMessageRef`
   with a monotonic counter — never the array length, which the prune
   shrinks; a reused handle would silently re-point an old citation.
   `pruneMessageRefs`: newest 100, 24 h window, undateable entries dropped.
   **The 24 h bound is an expiry, enforced at READ, not a write-time
   retention** (the follow-up commit made this true after the verifier's
   finding): `resolveMessageRef` and `messageRefsOf` both refuse a ref
   past the window (and an undateable one — it can never be proven young),
   so a quiet room's stale-but-still-arrayed refs answer `undefined` too.
   Resolution: `RoomStore`/`RoomService.resolveMessageRef` — `undefined`
   for unknown/malformed/expired/pruned/foreign handles. THE NAMED
   ABSENCE: a handle that does not resolve must be reported as `unknown
   message handle`, never a send to a guessed message (OUTBOX §1's fault,
   wearing a resolver).
4. **Expose the handles where the agent reads, member-invisible.** DONE,
   via `room_view`'s `recent_messages` (newest 20, ids only — HARD RULE:
   no text, and the provider id itself is NOT listed; the agent cites the
   handle, resolution is the resolver's job). The dep is optional and the
   key genuinely absent without it, so the pre-BRIEF-48 result shape is
   unchanged. **The attribution line (`attributeText`) is deliberately
   UNTOUCHED**: it is the text every member reads on their own phone, and
   inserting `#m12` there is a member-facing design decision that will be
   made in daylight, not at the last hour. Consequence, accepted: the
   agent correlates a transcript line to a handle by member_id and
   recency, not by an in-line token.

## 3. Pre-agreed return shape, for the next attempt

Deciding this now so the implementation brief inherits one convention, not a
third one:

- **Result vocabulary** follows `send_file` (docs/SEND-FILE.md): `accepted`
  (never `sent`), `recipients`, `unknown`.
- **A member whose channel cannot react** goes in a named, separate list —
  `unsupported: [{member_id, reason: "channel-cannot-react"}]` — the same
  distinction `check_delivery`'s `receipts` already draws between "no" and
  "this channel cannot say it". Nothing is minted for such a member: a
  record that can never be sent is the §1 fault in costume eleven, the
  reasoning `recordToolCall`'s tier filter already applies
  (src/service/delivery.ts:442-448).
- **Refus, pas dégradation** (agentpush's own contract,
  `send-reaction.ts`): no text fallback, ever. `emoji: ""` removes.
- **Reply on mail** reports the threading truth the way agentpush does:
  the send may go out unthreaded (`reply_threading: false` on non-Gmail
  providers, push.ts:1029) and the agent must learn the omission, not read
  it as delivered.

## 4. What this brief accepted, and what it did not touch

- **Nothing a member receives changed.** No rendering, no attribution
  text, no marker, no message body: the only new surface is the room MCP
  server's `room_view`, which members never see. Proven by test: the text
  a member receives is byte-identical with and without the capture, and
  the pre-BRIEF-48 `room_view` shape is preserved exactly when the dep is
  unwired.
- **Handle-less paths, declared (the "dead handle" audit):** a room-web or
  simulated message mints no handle (no provider id exists — absence, not
  a dead handle); a command's id (`join <code>`, `resume <slug>`) is still
  dropped (nothing citable to do with it); a blocked/failed send mints
  none (nothing was accepted, nothing to react to); a pruned handle
  resolves to `undefined` — the future tool reports it named.
- **Resolution ≠ capability.** A mail inbound id resolves fine and is
  perfectly good for reply threading; a reaction on mail must still be a
  named refusal. The ref's `channel` is there so the future tool can draw
  that line without a second source of truth.
- **A legacy room** (written before `messageRefs` existed) loads
  unchanged: both keys are optional, absent reads as "no citable
  messages", the first mint backfills the counter from the array length
  the same way `deliverySeq` did. Nothing is rewritten at load.
- **Not done here, on purpose:** the react/reply TOOLS themselves, and any
  `#m12`-in-the-attribution-line design. Both need daylight.
