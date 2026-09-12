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

export interface Room {
  code: string
  sessionId: string | undefined
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
}
