export type Tier = "messenger" | "email" | "room-web"

export interface Address {
  provider: string
  source: string
  contactRef: string
}

/** How one member receives what the room sends them (PLAN-02 §3-D1).
 *
 *  The axis is push vs pull: a push recipient has a durable address a third
 *  party holds (we hand off, they hold); a pull recipient has no address at
 *  all (we hold — they connect and drain their outbox). Routing is a `switch`
 *  over this union with NO fallback arm (src/service/transports.ts): a member
 *  nobody routed is a compile error, never a console write — that fallback is
 *  what made room-web members silently "delivered" to stdout (PLAN-02 §1).
 *
 *  A future `{ mode: "push"; provider: "webhook"; url; secret }` slots in
 *  here without redesign. Do not add it before something consumes it
 *  (PLAN-02 §6). */
export type MemberDelivery =
  | { readonly mode: "push"; readonly provider: "telegram" | "whatsapp" | "sms"; readonly contactRef: string }
  | { readonly mode: "push"; readonly provider: "email"; readonly address: string }
  /** Local/dev rooms only — the explicit target of `ConsoleTransport` in
   *  cli.ts, never a catch-all: nothing derives this from an unknown
   *  provider. */
  | { readonly mode: "push"; readonly provider: "console" }
  | { readonly mode: "pull" }

/** Derive a member's delivery from their legacy persisted address, for
 *  members written before `Member.delivery` existed (PLAN-02 §3-D1's
 *  migration rule). Also the fallback when a `Member` was built by hand
 *  without the field. Throws on a provider with no delivery mode: the whole
 *  point of D1 is that an unrouted recipient must be LOUD — deriving a
 *  catch-all here would be the `default`-branch fault of PLAN-02 §1 again. */
export function deliveryFromAddress(address: Address): MemberDelivery {
  switch (address.provider) {
    case "telegram":
    case "whatsapp":
    case "sms":
      return { mode: "push", provider: address.provider, contactRef: address.contactRef }
    case "email":
      return { mode: "push", provider: "email", address: address.contactRef }
    case "console":
      return { mode: "push", provider: "console" }
    case "room-web":
      return { mode: "pull" }
  }
  throw new Error(`unrouted delivery: no delivery mode for provider "${address.provider}"`)
}

export interface Member {
  id: string
  displayName: string
  tier: Tier
  address: Address
  /** Optional key, absent on members persisted before the field existed —
   *  same JSON round-trip rule as `pendingDeliveries` and `asks`. Derived
   *  from `address` on read (`RoomStore.open`'s migration) and at write time
   *  (`addMember`), so a member in memory always has one; routing falls back
   *  to `deliveryFromAddress` only for members built by hand without it. */
  delivery?: MemberDelivery
  /** The room-web join secret (PLAN-02 §3-D3 amended): an opaque random
   *  string minted ONCE, on the join that first claims this member's name,
   *  and returned to that caller exactly once. A later join under the same
   *  name must present it — absent or wrong is a refusal ("name taken"),
   *  because identity here is `slugify(displayName)` and anyone who typed
   *  the name would otherwise receive the member's token and whispers.
   *  Absent on members persisted before the field existed (same optional-key
   *  JSON round-trip rule as `delivery`); the first browser join that
   *  presents no claim adopts them and mints one — a deliberate one-time
   *  grandfather, not an oversight. Messenger and email members never get
   *  one: their address is already a credential a third party verified. */
  claim?: string
  joinedAt: string
  /** The member's last cursor acknowledgement (PLAN-02 step 4 / brief A):
   *  `ackedSeq` is the highest delivery seq the client has RENDERED and
   *  therefore genuinely holds; `ackedAt` is the wall-clock of the last ack.
   *  Written only by `POST /rooms/:code/outbox/cursor` (via
   *  `RoomStore.ackCursor`) — a GET must never mutate. Optional on members
   *  persisted before the field existed, same JSON round-trip rule as
   *  `claim`. Absent `ackedSeq` = the floor holds nothing for this member.
   *
   *  The two fields answer two different questions and move on different
   *  rules: `ackedSeq` is MONOTONIC (an ack that would move it backwards is
   *  ignored — a client replaying an old response must not rewind the
   *  retention floor), while `ackedAt` is liveness (refreshed on every ack,
   *  even a non-advancing one, because re-asserting a cursor is still
   *  evidence the client is there). */
  ackedSeq?: number
  ackedAt?: string
}

/** Push or pull, per member — the one question the fan-out's artifact-notice
 *  gate and any other "should this reach a phone?" check asks. Pull members
 *  have no push transport at all (their drain is the outbox); pushing to
 *  them is a caller bug that `CompositeTransport` turns into a loud throw. */
export function deliveryModeOf(member: Member): "push" | "pull" {
  return (member.delivery ?? deliveryFromAddress(member.address)).mode
}

/** Providers `deliveryFromAddress` routes (D1's exhaustive union). The
 *  inbound HTTP surface validates against this list so a join with an
 *  unroutable provider is a validated 400 naming the provider, never an
 *  uncaught throw from `deliveryFromAddress`. Keep in sync with that
 *  switch — it is its domain, written out because a function that answers
 *  "does this route?" by throwing cannot be asked. */
export const ROUTED_PROVIDERS: readonly string[] = ["telegram", "whatsapp", "sms", "email", "console", "room-web"]

export type RoomState = "active" | "paused"

/** Where a confirmed delivery would actually go (src/service/deliverable.ts
 *  resolves member names and `messenger self` to these). Part of the room
 *  record only so `PendingDelivery` is persistable — a member target keeps
 *  the whole `Member` so the send path knows the provider/tier. */
export type DeliveryTarget =
  | { readonly kind: "messenger"; readonly member: Member }
  | { readonly kind: "email"; readonly address: string }

/** One requested-not-yet-confirmed deliverable send, persisted on the room
 *  (docs/DELIVERABLE.md): survives a service restart, unlike the in-memory
 *  pending map it is hydrated back from. One record per target — `messenger
 *  self` with no requester (the agent's block) resolves to several members,
 *  each getting its own token. */
export interface PendingDelivery {
  readonly token: string
  readonly requestedBy: string
  readonly target: DeliveryTarget
  readonly subject: string
  readonly mediaId: string
  readonly pageCount: number
  readonly createdAt: number
  readonly expiresAt: number
}

/** Lifecycle of one solicitation (docs/MIDDLEMAN.md §3): `"open"` when the
 *  agent asks a member for something, `"answered"` when their next message
 *  closes it, `"nudged"`/`"proceeded"`/`"expired"` by the no-stall timers and
 *  the `skip` reply. Steps iv (web panel) and v (timers) consume the same
 *  union, so it is complete from the start. */
export type AskStatus = "open" | "answered" | "nudged" | "expired" | "proceeded"

/** One thing the room is waiting on from one member, recorded in the room
 *  (docs/MIDDLEMAN.md §3) — not in the agent's head, which gets compacted.
 *  `toMemberId` is `member.id`, never the display name: names collide. */
export interface Ask {
  readonly id: string
  readonly toMemberId: string
  readonly what: string
  readonly askedAt: string
  readonly status: AskStatus
  readonly answeredBy: string | undefined
  readonly answeredAt: string | undefined
  /** Set when a multimodal ingress message (`media:<id>`, docs/MULTIMODAL.md)
   *  answers the ask. */
  readonly mediaId: string | undefined
}

/** Retry cap for one `Delivery` (PLAN §3.3), mirroring Mastra's
 *  `MAX_NOTIFICATION_DELIVERY_ATTEMPTS`. A deterministic failure must stop
 *  being retried on every boot — at the cap the record goes `failed` and the
 *  agent is told through the reactive channel instead. */
export const MAX_DELIVERY_ATTEMPTS = 5

/** One accepted-but-not-yet-confirmed outbound message to one member
 *  (PLAN §3.3). Persisted so a process that dies between acceptance and
 *  delivery re-attempts on boot: this, not a tool receipt, is the
 *  at-least-once guarantee — the receipt travels over the same fallible
 *  tunnel as the tool call itself. */
export interface Delivery {
  readonly id: string
  readonly memberId: string
  readonly kind: "say" | "whisper"
  readonly text: string
  readonly status: "pending" | "delivered" | "failed"
  /** Failure count, not attempt count: it only moves when a send fails, and
   *  a delivered record carries `0` (PLAN-02 §3-D2). Renamed from `attempts`
   *  while the type was open — `attempts` counted failures. */
  readonly failures: number
  /** Who confirmed the delivery (PLAN-02 §3-D2). `"transport"` = the push
   *  provider accepted the hand-off. `"recipient"` = the client acked a
   *  cursor at or above this record's seq (POST /rooms/:code/outbox/cursor)
   *  — the genuinely stronger guarantee, real since the cursor ack shipped
   *  (PLAN-02 step 4; D2's amendment F8 is discharged). Set only when the
   *  ack lands or when a pull record completes for a member whose cursor
   *  already covers it; never backfilled onto records that predate the ack
   *  by any migration — absence stays the honest value there. */
  readonly confirmedBy?: "transport" | "recipient"
  readonly lastError: string | undefined
  readonly createdAt: string
  readonly deliveredAt: string | undefined
}

/** `Delivery.id` → its position in the room's monotonic `deliverySeq`. Ids
 *  are `d<seq>` (`DeliveryEngine.accept`); a room that predates the counter
 *  has exactly those ids too. Anything unparseable sorts as 0, so it is
 *  replayed only when `since` is omitted-and-zero, and never skipped into a
 *  silently-replayed position. Lives here (not in http.ts) because the
 *  retention floor and the cursor ack compare the same numbers. */
export function deliverySeqOf(id: string): number {
  const match = /^d(\d+)$/.exec(id)
  return match === null ? 0 : Number.parseInt(match[1] ?? "0", 10)
}

/** How long a pull member may go without a cursor ack before it is declared
 *  stale: marked away in the roster (the agent stops addressing a ghost) and
 *  its retention floor is released (the prune reclaims its backlog). It is
 *  NEVER removed from the room — the member id is stable across a tab
 *  closing and reopening only because nothing removes it, and removing it
 *  would make the next visit a new principal whose cursor starts at
 *  `deliverySeq`, hiding everything sent meanwhile (PLAN-02 §3-D6
 *  constraint 1, §7.1/F3).
 *
 *  90 s, against the page's clocks (src/web/page.ts): the state poll runs
 *  every 3 s and the outbox drain every 2 s, each followed by a cursor ack.
 *  90 s is 30 missed state polls / 45 missed drain ticks — a slow mobile
 *  network stalls well past a few missed polls without releasing the floor,
 *  while an actually-closed tab is reclaimed within a minute and a half. A
 *  value at the scale of the poll interval itself would turn a transient
 *  stall into pruned backlog: data loss with nothing but the gap marker to
 *  show for it. */
export const PULL_STALE_MS = 90_000

/** Whether a pull member is stale: no ack for `PULL_STALE_MS`. A member that
 *  has never acked is dated from `joinedAt` — it has not acked for exactly
 *  that long, which is what makes the `Ecran` ghost (a tab that joined and
 *  never drained) go away. Undateable timestamps never declare staleness:
 *  a member we cannot age is one we cannot safely release. Push members are
 *  never stale — their delivery is someone else's problem the moment the
 *  transport accepts it. */
export function pullMemberStale(member: Member, nowMs: number): boolean {
  if (deliveryModeOf(member) !== "pull") return false
  const stamp = Date.parse(member.ackedAt ?? member.joinedAt)
  return !Number.isNaN(stamp) && nowMs - stamp > PULL_STALE_MS
}

/** The retention floor (PLAN-02 §3-D6): the lowest acked cursor across the
 *  room's LIVE pull members, or `undefined` when no live pull member has
 *  acked anything. `pruneDeliveries` may never drop a delivered record whose
 *  seq is above this — it is undrained mail, not completed work. Stale
 *  members contribute nothing: their floor is released, and the gap marker
 *  tells their tab what happened when it comes back. */
export function retentionFloor(room: Room, nowMs: number): number | undefined {
  let floor: number | undefined
  for (const member of room.members) {
    if (deliveryModeOf(member) !== "pull") continue
    if (pullMemberStale(member, nowMs)) continue
    const seq = member.ackedSeq
    if (seq !== undefined && (floor === undefined || seq < floor)) floor = seq
  }
  return floor
}

export interface Room {
  code: string
  sessionId: string | undefined
  /** The session id this room had before it was paused or its session died.
   *
   *  Pausing clears `sessionId` (`doPause`, `reviveIfSessionDied`), which is
   *  correct — a paused room has no live session. But the daemon keeps that
   *  session's transcript readable after it is killed, and replaying it is
   *  the whole of `src/service/recap.ts`. Without somewhere to keep the id,
   *  the resume path had nothing to read: it looked at `room.sessionId`,
   *  found `undefined` because pausing had already cleared it, and every
   *  resume silently took the no-history branch. Proven that way in a local
   *  harness on 2026-09-12 — the honest "I've lost the earlier thread" reply
   *  fired every single time, so the bug hid behind a message that looked
   *  exactly like the feature working.
   *
   *  Optional key, absent on rooms that predate the field — same JSON
   *  round-trip rule as `pendingDeliveries` and `asks`. */
  lastSessionId?: string
  sandboxId: string | undefined
  artifactUrl: string | undefined
  /** Whether the daemon's own readiness probe confirmed `artifactUrl` was
   *  actually answering, last time it was set (`RoomSessionResult.artifactReady`,
   *  src/sandbox/boot.ts). Undefined when no boot has ever reported it —
   *  e.g. a room with no artifact concept at all (`LocalBooter`). */
  artifactReady: boolean | undefined
  members: Member[]
  createdAt: string
  updatedAt: string
  cursor: number
  /** Last time anyone sent a message into this room, or the room's own agent
   *  produced a turn — the idle-pause sweep's clock (architecture.md R10). */
  lastActivityAt: string
  /** `"paused"` once the idle sweep has killed the session (e2b: pauses the
   *  box; local: just ends it). A message or `resume` brings it back to
   *  `"active"`. */
  state: RoomState
  /** Deliveries requested but not yet confirmed/cancelled (docs/DELIVERABLE.md).
   *  Persisted so they survive a service restart; absent on rooms that predate
   *  the field (same JSON round-trip rule as `sessionId` below). */
  pendingDeliveries?: PendingDelivery[]
  /** Outstanding/closed asks (docs/MIDDLEMAN.md §3). Optional key, `[]` on
   *  fresh rooms, absent on rooms that predate the field — same JSON
   *  round-trip rule as `pendingDeliveries` below. */
  asks?: Ask[]
  /** Outbound `say`/`whisper` messages accepted for delivery (PLAN §3.3),
   *  one record per target member. Persisted so a process that dies between
   *  acceptance and delivery re-attempts on boot. Optional key, absent on
   *  rooms that predate the field — same JSON round-trip rule as
   *  `pendingDeliveries` and `asks`. Carries message text, so it is
   *  deliberately stripped from every public projection (`toPublicRoom`,
   *  src/service/http.ts) — and pruned once `delivered`
   *  (`pruneDeliveries`, src/service/delivery.ts), so the text does not sit
   *  at rest forever.
   *
   *  This array is NOT a log: it is a work queue that happens to keep a short
   *  tail of completed work. Anything that needs a durable history of what was
   *  said needs its own store. */
  deliveries?: Delivery[]
  /** Monotonic counter behind `Delivery.id` — the LAST id handed out, so the
   *  next is `deliverySeq + 1`.
   *
   *  Ids used to be derived from `deliveries.length`, which was only
   *  collision-free while the array never shrank. It shrinks now (delivered
   *  records are pruned), and a reused id would make `DeliveryEngine.mark`
   *  patch the wrong record — marking someone else's pending whisper
   *  `delivered` without ever sending it. The counter never goes backwards,
   *  so a pruned id is never minted twice.
   *
   *  Optional key, absent on rooms that predate the field; those rooms have
   *  `d1..dN` ids matching their array length, which is what
   *  `DeliveryEngine.accept` falls back to. */
  deliverySeq?: number
  /** Which addressing protocol this room's agent was booted with. Absent on
   *  rooms that predate the field — same JSON round-trip rule as
   *  `pendingDeliveries` and `asks`. Never changed in place. */
  protocol?: "markers" | "tools"
}
