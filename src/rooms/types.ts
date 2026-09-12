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
  joinedAt: string
}

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
   *  provider accepted the hand-off. The union names a `"recipient"` variant
   *  — the client advanced its cursor past the record — but nothing may set
   *  it: an SSE flush proves the server SENT, not that anyone received, and
   *  making `"recipient"` real needs a cursor-acknowledgement write (a POST
   *  of last-seen-seq) that does not exist yet (PLAN-02 §3-D2 amendment F8).
   *  Pull deliveries are therefore delivered-and-unconfirmed: `confirmedBy`
   *  stays absent on them. Absent on records persisted before the field. */
  readonly confirmedBy?: "transport" | "recipient"
  readonly lastError: string | undefined
  readonly createdAt: string
  readonly deliveredAt: string | undefined
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
