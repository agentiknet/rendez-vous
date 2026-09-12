export type Tier = "messenger" | "email" | "room-web"

export interface Address {
  provider: string
  source: string
  contactRef: string
}

export interface Member {
  id: string
  displayName: string
  tier: Tier
  address: Address
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
  /** Which addressing protocol this room's agent was booted with. Absent on
   *  rooms that predate the field — same JSON round-trip rule as
   *  `pendingDeliveries` and `asks`. Never changed in place. */
  protocol?: "markers" | "tools"
}
