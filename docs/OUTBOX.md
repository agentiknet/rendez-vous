# Outbox cursor semantics

**Normative.** Written 2026-09-13, after `797d248..28af657` shipped the outbox
and before a second implementation existed — which is the only reason it was
worth writing at all.

A pull recipient (a browser tab) has no durable address a third party holds, so
it cannot be handed a message; it must come and collect one. That collection —
the outbox, its cursor, its acknowledgement and its retention — is what this
document governs. Ownership is deliberately not governed: whatever
`audience_list` / `audience_send` eventually become (daemon builtin, MCP mount,
HTTP driver), the surface is the same, so that decision can wait. The cursor
semantics cannot: they are already the de facto spec, and a second
implementation that reads them differently produces silent data loss rather
than a compile error.

So this describes **what is true today, as a contract**, not what would be
nice. Where the code is wrong, it says so and marks it.

Keywords MUST / MUST NOT / SHOULD are used in the usual sense.

> **On the `PLAN-02 §…` citations you will find in code comments.** They point
> at the working plan that produced this system, which is a scratch document
> and is deliberately not in the repository. Where a comment cites the plan for
> a *rule*, the binding version of that rule is here. Where it cites the plan
> for *why*, the reasoning is summarised inline at the rule. Nothing in this
> document depends on reading the plan.

---

## 1. The governing invariant

> **Absence MUST NEVER read as delivery.**

Every rule below is a special case of it. The bug this whole plan exists to fix
(`PLAN-02 §1`) was a `default` transport arm turning "nobody routed this
recipient" into "delivered". Every subsequent defect found while implementing
steps 1-4 was the same shape wearing a different costume:

| where | absence that read as delivery |
|---|---|
| `CompositeTransport` | unrouted recipient → console fallback → `delivered` |
| the gap marker, step 3 | member's whole backlog pruned → `mine` empty → `pruned: false` |
| the gap marker, step 4 | room retains nothing at all → nothing to compare → `pruned: false` |
| the floor, step 4 | pull member that never acked → contributed no floor → backlog prunable |
| the page's cursor, step 3 | advanced to the room's seq → skipped its own pending record |
| the room's own voice, brief 07 | every room notice bypassed the outbox → console fallback → a web member never got its own join link |
| the silent-turn detector, brief 08 | `system` records moved `deliverySeq` → a turn with no `say`/`whisper` read as a turn that spoke |
| the detector's own tests, brief 08 | second turn never executed → "no warning" passed against the defect itself |
| `away`, brief 10 | no test touched it → the roster projection would have passed marked always-away, never-away, or absent |
| the gap marker's ownership fallback, brief 12 | a member's own oldest-OWNED seq read as a pruning signal → a member never addressed by the room's earliest records was told, on its first poll, that it had lost them |

Ten defects; nine of them sat behind a green test suite. The last three are
the same failure moved one layer out: **an absence of execution reading as a
proof of passing.** Three separate executors, sent at the code, each found one
by looking at the tests instead. When a rule below looks over-specified, this
table is why.

---

## 2. The object

A room holds an ordered set of **deliveries**. Each delivery belongs to exactly
one member.

- `Delivery.id` is `d<seq>`, minted from `Room.deliverySeq` — a monotonic
  counter of the **last id handed out**. It MUST NOT be derived from the array
  length: the array shrinks, and a reused id makes a later `mark` patch the
  wrong record.
- A pruned seq MUST NEVER be minted again.
- `deliverySeqOf(id)` parses it back. An unparseable id MUST sort as `0`, so a
  legacy record is replayed rather than skipped. Replaying is recoverable;
  skipping is not.
- `Delivery.memberId` is the **owner**. Ownership is what makes per-member
  retention and per-member scoping expressible; nothing may treat deliveries as
  a room-wide stream.

`Room.deliveries` is **not a log**. It is a work queue that keeps a short tail
of completed work, plus — since step 4 — whatever a live pull member has not
yet drained. Anything needing durable history needs its own store.

### 2.1 `kind: "tool"` — the agent called something (BRIEF-15)

A fourth kind, alongside `say` / `whisper` / `system`. It records that the
agent **called a tool** — today only `render_artifact` — so a surface can tell
the room that the shared document moved.

It rides this queue rather than a second "events" channel on purpose: a
parallel stream would have to re-derive the cursor, the per-member scoping,
the retention floor and the gap marker, and §1's table is ten entries of what
happens when a second path re-derives one of them wrongly.

The rules that are specific to it:

- **Pull members only.** `DeliveryEngine.recordToolCall` mints one record per
  pull member and none for a push member. A messenger member has no surface
  that can render a tool call; giving them a record would mean either shipping
  `args` JSON to a phone, or minting a record that can never be sent and
  marking it `delivered` anyway. They get nothing, and the absence claims
  nothing. `renderFor` returning `undefined` for the kind is the second lock,
  and `attempt` refuses to call a push member's empty render "delivered".
- **`text` is the call's arguments as JSON, not prose.** It is exactly what
  `TOOL_CALL_ARGS.delta` carries, so the AG-UI translation is a copy rather
  than a re-encoding. Every reader MUST branch on `kind` before touching
  `text`: a catch-all arm puts a serialised argument object in a transcript
  attributed to the agent.
- **The recorded args are a summary**, not the verbatim call — `render_artifact`
  records `{roomCode, blocks, artifactUrl}` and omits the document, which
  would otherwise be copied into one record per watching member and then
  pinned there by the retention floor. A client that wants the content calls
  `read_artifact`.
- **It MUST NOT move `spokenSeq`.** A turn that only rendered a document has
  not spoken, and the silent-turn warning must still fire for it — that turn
  is the one most likely to need it.
- **It is recorded only after a successful render**, and a failure to record
  never fails the render: the document exists and the agent must be told so.
- **Deduped at the mint, per member (BRIEF-10 step 2 follow-up).** A member
  whose most recent `kind: "tool"` record of the SAME `toolName` already
  carries the SAME `text` gets no new record. `room_view` is what forced
  this: it is called every turn by design (look at the room, then act), and
  every call mints one record per pull member. Retention (§7) is a ROOM-WIDE
  cap, so an unchanging room's repeated announcement would otherwise crowd
  `say`/`whisper` history — including the addressee's own — out of it. This
  does not weaken §1: the existing record already states the true fact, and
  skipping a byte-identical repeat asserts nothing new about delivery, for
  the member it is already on record for. A room that actually changed
  (a member joined, an artifact rendered) produces different `text` and
  mints exactly as before. A member with no prior record of that `toolName`
  — never called, or its record already pruned — always mints: absence of a
  comparison is not itself grounds to skip one.

In AG-UI it becomes the `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END`
triple, keyed by the delivery id, **instead of** — never alongside — the text
triple. A record that yielded zero events would be a delivery the client never
hears about, so a record missing its `toolName` is announced under
`UNNAMED_TOOL` rather than skipped: visibly wrong beats silently absent.

---

## 3. The cursor

A **cursor** is one integer per pull member: the highest delivery seq that
member's client has **rendered**, and therefore genuinely holds.

- The cursor is the client's assertion, not the server's inference. The server
  MUST NOT advance it on its own behalf.
- It is **monotonic**. An ack that would move it backwards MUST be ignored — not
  rejected as an error. A client replaying a stale response must not be able to
  rewind a retention floor.
- Absent (never acked) MUST read as `0`, not as "no opinion". A live pull member
  that has never acked holds *everything* of its own. Treating absent as "skip
  this member" is the step-4 bug in §1's table: a tab that joined and had not
  yet drained had no floor at all.

### 3.1 What the client MUST advance to

> The next `since` is **the highest seq the client actually rendered**.

It MUST NOT be the `cursor` field of the response. That field carries the
*room's* `deliverySeq`, which sits past records that were still `pending` when
the snapshot was taken — advancing to it skips the client's own undelivered
mail, permanently. This shipped in step 3 and was fixed in step 4; the field's
own doc comment still describes the broken behaviour (see §9).

---

## 4. The drain

`GET /rooms/:code/outbox`, `Authorization: Bearer <memberToken>`.

- Auth is the **header only**. A query-string token arm MUST NOT be added. That
  workaround belongs to `/mcp/room` and exists for a reason that does not apply
  here (`PLAN-02 §4.1`).
- The server resolves the member from the token and filters **server-side,
  before the bytes leave the process**. A whisper on a shared stream is not a
  whisper. A client-side filter is not an implementation of this rule; it is a
  pretence of one.
- A wrong or absent token returns `401` and reveals nothing — not even whether
  the room has members.
- `?since=<seq>` returns every delivery owned by that member with
  `deliverySeqOf(id) > since`. Omitting `since` means "everything retained".
- The response includes `pending` records. They are the member's mail; status is
  the server's bookkeeping, not a visibility rule.

### 4.1 Delivery is at-least-once

A reconnect MAY repeat records. Clients MUST dedupe on `Delivery.id`. We are
not building exactly-once, and no document may imply that we are — it costs a
two-phase ack for a chat surface.

---

## 5. The acknowledgement

`POST /rooms/:code/outbox/cursor`, same token family, body `{ "seq": <n> }`.

- It MUST be a separate endpoint. A `GET` MUST NOT mutate room state.
- The client acks **after rendering**, never on receipt. Acking on receipt
  re-creates exactly the conflation §6 exists to prevent.
- Two fields move on two different rules, and conflating them is a bug:
  - `ackedSeq` — monotonic, the retention floor's input.
  - `ackedAt` — liveness, refreshed on **every** ack including a non-advancing
    one. Re-asserting an unchanged cursor is still evidence the client is there.
- A client with an empty outbox SHOULD therefore re-post its unchanged cursor as
  its liveness signal. Floor-advance and presence are deliberately separate
  claims.

---

## 6. `confirmedBy` — two meanings of "delivered"

- `"transport"` — a push provider accepted the hand-off. There is no read
  receipt and there never will be.
- `"recipient"` — the client acked a cursor at or above this record's seq. The
  recipient genuinely has it. This is the **stronger** guarantee.
- Absent — honest ignorance. It MUST NOT be backfilled by any migration. A
  record that predates the ack protocol has no confirmation and must not
  acquire one retroactively.

A surface that cannot tell these apart will mislead exactly when it matters.
A dashboard reporting "delivered" over a mixed set is not reporting anything.

---

## 7. Retention

Two bounds exist on completed records, each closing a cost the other cannot:

- a **count cap** (`MAX_RETAINED_DELIVERED = 20`), because the store serializes
  wholesale on every write, so one busy room taxes every other room;
- an **age window** (`DELIVERED_RETENTION_MS = 1h`), because a whisper record
  holds private text at rest in a room whose whole point was that it was
  private.

Neither may be removed. The floor overrides both, narrowly:

> A `delivered` record is kept iff its **owner** is a live pull member **and**
> its seq is above **that owner's** cursor.

- The floor is **per-member**, never room-wide. A room-wide `min(cursor)` makes
  one laggard tab pin every other member's records — including push records
  that have nothing to do with it — and silently voids the count cap for
  everything above it.
- `pending` and `failed` records are never pruned, at any age. `pending` is the
  at-least-once guarantee; `failed` is the evidence behind the correction the
  agent was sent.
- An undateable `delivered` record is dropped rather than kept — it can never
  age out — unless its owner's floor holds it.

### 7.1 The bound on the floor is liveness, not size

A floor with no release pins the log forever. A pull member that has not acked
for `PULL_STALE_MS` is **stale**:

- it is marked **away** in the roster, so the agent stops addressing a ghost —
  this is the `Ecran` failure, solved once;
- its floor is **released**, and the prune reclaims its backlog;
- it MUST NOT be removed from the room.

That last one is not a preference. A room-web member's id is stable across a tab
closing and reopening *only* because nothing removes it: identity is
`slugify(displayName)`, so `sameAddress` re-finds the existing member. Remove
it and the next visit is a **new principal** with a cursor starting at
`deliverySeq` — and everything sent meanwhile is invisible while the reconnect
looks perfectly healthy. An adversarial review asserted this already happened;
it was wrong only because nothing removes the member today (`PLAN-02 §7.1`).
Any implementation that does remove it makes that review retroactively correct.

`PULL_STALE_MS` MUST be chosen against the client's poll cadence, with the
margin written down. Today: 90 s against a 2 s drain — 45 missed ticks, so a
transient mobile stall cannot cost a backlog, while a closed tab is reclaimed in
about a minute and a half. A value at the scale of the poll interval turns a
slow network into data loss with nothing but a gap marker to show for it.

---

## 8. The gap marker

`since` is answered by filtering survivors. Without a marker, a destroyed
backlog is indistinguishable from "nothing new" — §1's invariant, violated in
the very mechanism written to protect it.

- `pruned: true` MUST be returned when the requested `since` is below anything
  the client should have seen and cannot.
- It is computed from the room's **low-water mark** — the highest seq ever
  pruned, monotonic, persisted. This is the only answer knowable when the room
  retains nothing at all, which is precisely the total-loss case.
- Where the mark is present, it is the exact and complete answer, and it is
  the ONLY signal consulted — in particular, a member's own oldest-OWNED seq
  MUST NOT be read as a pruning signal: ownership says who a record was for,
  never whether anything was ever pruned, and a member who simply was not the
  addressee of the room's earliest records has an oldest-owned seq above zero
  having lost nothing.
- Only where a room's pruned history predates the mark (`deliveryLowWater` is
  **absent**, not merely zero) MAY an implementation OR-in a second, weaker
  signal (the oldest retained seq, room-wide). This fallback is scoped to that
  legacy case alone: an unconditional weak signal that fires on every poll
  does not err on the safe side, it trains the reader to ignore the marker —
  the original bug with extra steps. The marker MUST err toward reporting a
  gap that did not happen. **Never the reverse.**
- It fires only for an **explicitly presented** `since`. Omitting `since` means
  "everything retained", a request nothing can be lost from; firing there would
  tell every first-time client it had lost something that never existed.
- `pruned: false` does not mean "you are up to date". It means nothing
  observable was lost. Any UI that renders it as reassurance is misreading it.

A client receiving `pruned: true` MUST surface the gap. Rendering a gap as
silence is the original bug with extra steps.

---

## 9. Known deviation — discharged

`OutboxPayload.cursor` was documented in `src/service/http.ts` as "the cursor the
client's next `since` should be one past" — the step-3 bug, written down as if it
were the contract. **Fixed in `72006f2`**, and this section was stale from that
commit until an executor cross-checking it for brief 10 said so. The comment at
`http.ts:622` now states §3.1's rule and names the trap it used to be.

Nothing replaces it: there is no known deviation today. The section stays so the
next reader can see that a normative document went wrong in the same direction
as the code it governs — by describing an intention rather than a behaviour —
and that only a second reader caught it.

---

## 10. Deliberately unspecified

Named so their absence is a decision, not an oversight:

- **the transport of the drain.** SSE and polling are two readings of one
  endpoint with one cursor; today's client polls, because `EventSource` cannot
  carry an `Authorization` header and the alternative is a token in the URL.
  That is a client-side constraint, not a contract term.
- **exactly-once.** See §4.1.
- **durable history.** The outbox is a work queue with a tail. Anything else is
  a different store and a different plan.
- **ownership** — builtin, MCP, or HTTP driver. That is the AIP-14 contract
  work, and it is separable by construction (`REVIEW-adversarial-02` answer 2).
  This appendix is what makes it safe to defer.
