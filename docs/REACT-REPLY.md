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

Four independent pieces, each small, none of them this brief:

1. **Capture the inbound provider id at the dedup boundary.** When an
   envelope passes dedup (src/service/http.ts:1112), its `messageId` must be
   stored durably — keyed to the member and the ingest — instead of dying in
   the dedup FIFO. Durable, because the agent may react a turn (or a
   restart) later.
2. **Mint a room-local handle the agent can see.** The attribution line
   (`attributeText`, src/fanin/index.ts) gains a short stable suffix, e.g.
   `[Name · whatsapp · #m12] text`. The handle is minted once at ingest and
   is the agent's only citation currency — same philosophy as `member_id`
   replacing display names in BRIEF-13/43.
3. **Keep the map handle → provider id, per channel.** The handle resolves
   through the stored inbound id (piece 1) or through a captured outbound
   `message_id` (next piece). Pruning policy mirrors `pruneDeliveries`'s
   reasoning: bounded count + age window.
4. **Capture the outbound `message_id` per delivery.** `checkedSend` returns
   the provider id; `Delivery` gains an optional field (the key-absent rule
   of `toolName`/`attachment`, delivery.ts:381-385) so the agent can also
   target a message *it* sent, and mail threading could later be driven by
   records rather than an in-memory map.

Only after all four does a `react`/`reply` tool have an argument that is
honest to type into agentpush.

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
