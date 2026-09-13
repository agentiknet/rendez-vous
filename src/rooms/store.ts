import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { generateCode, normalizeCode } from "./code.ts"
import {
  deliveryFromAddress,
  type Address,
  type Ask,
  type AskStatus,
  type Delivery,
  type DeliveryTarget,
  type Member,
  type MemberDelivery,
  type PendingDelivery,
  type Room,
  type RoomState,
  type Tier,
} from "./types.ts"

interface RoomFile {
  rooms: Room[]
}

const TIERS: readonly Tier[] = ["messenger", "email", "room-web"]

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isStringOrUndefined(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string"
}

function isBooleanOrUndefined(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean"
}

function isNumberOrUndefined(value: unknown): value is number | undefined {
  return value === undefined || typeof value === "number"
}

function isRoomState(value: unknown): value is RoomState {
  return value === "active" || value === "paused"
}

/** Optional key on `Room`: absent on rooms that predate the field, same
 *  JSON round-trip rule as `pendingDeliveries` and `asks`. */
function isProtocol(value: unknown): value is Room["protocol"] {
  return value === undefined || value === "markers" || value === "tools"
}

function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAddress(value: unknown): value is Address {
  if (!isObject(value)) return false
  if (!("provider" in value) || !("source" in value) || !("contactRef" in value)) return false
  return isString(value.provider) && isString(value.source) && isString(value.contactRef)
}

function isMemberDelivery(value: unknown): value is MemberDelivery {
  if (!isObject(value)) return false
  if (value.mode === "pull") return true
  if (value.mode !== "push") return false
  if (!("provider" in value) || !isString(value.provider)) return false
  if (value.provider === "telegram" || value.provider === "whatsapp" || value.provider === "sms") {
    return "contactRef" in value && isString(value.contactRef)
  }
  if (value.provider === "email") return "address" in value && isString(value.address)
  return value.provider === "console"
}

function isMember(value: unknown): value is Member {
  if (!isObject(value)) return false
  if (
    !("id" in value) ||
    !("displayName" in value) ||
    !("tier" in value) ||
    !("address" in value) ||
    !("joinedAt" in value)
  ) {
    return false
  }
  // `delivery`, `claim`, `ackedSeq` and `ackedAt` are optional: members
  // persisted before any of these fields existed round-trip without the key
  // (same rule as lastError/deliveredAt on a Delivery).
  const delivery = "delivery" in value ? value.delivery : undefined
  const claim = "claim" in value ? value.claim : undefined
  const ackedSeq = "ackedSeq" in value ? value.ackedSeq : undefined
  const ackedAt = "ackedAt" in value ? value.ackedAt : undefined
  return (
    isString(value.id) &&
    isString(value.displayName) &&
    isTier(value.tier) &&
    isAddress(value.address) &&
    (delivery === undefined || isMemberDelivery(delivery)) &&
    (claim === undefined || isString(value.claim)) &&
    (ackedSeq === undefined || (typeof ackedSeq === "number" && Number.isInteger(ackedSeq) && ackedSeq >= 0)) &&
    isStringOrUndefined(ackedAt) &&
    isString(value.joinedAt)
  )
}

function isDeliveryTarget(value: unknown): value is DeliveryTarget {
  if (!isObject(value)) return false
  if (!("kind" in value)) return false
  if (value.kind === "messenger") return "member" in value && isMember(value.member)
  if (value.kind === "email") return "address" in value && isString(value.address)
  return false
}

function isPendingDelivery(value: unknown): value is PendingDelivery {
  if (!isObject(value)) return false
  if (
    !("token" in value) ||
    !("requestedBy" in value) ||
    !("target" in value) ||
    !("subject" in value) ||
    !("mediaId" in value) ||
    !("pageCount" in value) ||
    !("createdAt" in value) ||
    !("expiresAt" in value)
  ) {
    return false
  }
  return (
    isString(value.token) &&
    isString(value.requestedBy) &&
    isDeliveryTarget(value.target) &&
    isString(value.subject) &&
    isString(value.mediaId) &&
    typeof value.pageCount === "number" &&
    typeof value.createdAt === "number" &&
    typeof value.expiresAt === "number"
  )
}

function isAskStatus(value: unknown): value is AskStatus {
  return value === "open" || value === "answered" || value === "nudged" || value === "expired" || value === "proceeded"
}

function isAsk(value: unknown): value is Ask {
  if (!isObject(value)) return false
  if (
    !("id" in value) ||
    !("toMemberId" in value) ||
    !("what" in value) ||
    !("askedAt" in value) ||
    !("status" in value)
  ) {
    return false
  }
  // answeredBy/answeredAt/mediaId are optional: JSON.stringify drops undefined
  // values, so a persisted ask round-trips with those keys absent.
  const answeredBy = "answeredBy" in value ? value.answeredBy : undefined
  const answeredAt = "answeredAt" in value ? value.answeredAt : undefined
  const mediaId = "mediaId" in value ? value.mediaId : undefined
  return (
    isString(value.id) &&
    isString(value.toMemberId) &&
    isString(value.what) &&
    isString(value.askedAt) &&
    isAskStatus(value.status) &&
    isStringOrUndefined(answeredBy) &&
    isStringOrUndefined(answeredAt) &&
    isStringOrUndefined(mediaId)
  )
}

function isDeliveryStatus(value: unknown): value is Delivery["status"] {
  return value === "pending" || value === "delivered" || value === "failed"
}

function isDelivery(value: unknown): value is Delivery {
  if (!isObject(value)) return false
  if (
    !("id" in value) ||
    !("memberId" in value) ||
    !("kind" in value) ||
    !("text" in value) ||
    !("status" in value) ||
    !("createdAt" in value)
  ) {
    return false
  }
  // `failures` (renamed from `attempts`, PLAN-02 §3-D2) is accepted under
  // either name here because validation runs BEFORE the read-time migration
  // in `open()` has renamed it; `confirmedBy` is optional (see isMember).
  const failures = "failures" in value ? value.failures : undefined
  const legacyFailureCount = "attempts" in value ? value.attempts : undefined
  const confirmedBy = "confirmedBy" in value ? value.confirmedBy : undefined
  // lastError/deliveredAt are optional: JSON.stringify drops undefined values,
  // so a persisted delivery round-trips with those keys absent (same rule as
  // `isAsk` above).
  const lastError = "lastError" in value ? value.lastError : undefined
  const deliveredAt = "deliveredAt" in value ? value.deliveredAt : undefined
  return (
    isString(value.id) &&
    isString(value.memberId) &&
    (value.kind === "say" || value.kind === "whisper" || value.kind === "system") &&
    isString(value.text) &&
    isDeliveryStatus(value.status) &&
    ((typeof failures === "number" && failures >= 0) ||
      (failures === undefined && typeof legacyFailureCount === "number" && legacyFailureCount >= 0)) &&
    (confirmedBy === undefined || confirmedBy === "transport" || confirmedBy === "recipient") &&
    isStringOrUndefined(lastError) &&
    isString(value.createdAt) &&
    isStringOrUndefined(deliveredAt)
  )
}

/** The pre-rename failure count key, read off the raw record. */
function legacyAttempts(record: object): unknown {
  return "attempts" in record ? record.attempts : undefined
}

/** Read-time migration for one room (PLAN-02 §3-D1/D2): members persisted
 *  before `Member.delivery` existed get it derived from their address, and a
 *  delivery still carrying the pre-rename `attempts` key gets it mapped to
 *  `failures`. In-memory only: nothing is rewritten to disk here — the room
 *  is migrated again on its next persist. Runs before `isRoom` validation,
 *  so the migrated shape is re-validated wholesale. */
function migrateRoomRaw(room: unknown): unknown {
  if (!isObject(room) || !Array.isArray(room.members)) return room
  return {
    ...room,
    members: room.members.map((member: unknown) => {
      if (!isObject(member)) return member
      const existing = "delivery" in member ? member.delivery : undefined
      if (existing !== undefined || !isObject(member.address) || !isAddress(member.address)) return member
      const address = member.address
      try {
        return { ...member, delivery: deliveryFromAddress(address) }
      } catch {
        // An address with no delivery mode stays unmigrated — `isMember` then
        // accepts the member (no `delivery` key) and the routing layer throws
        // the loud "unrouted" error when someone tries to send to them, which
        // is exactly where the failure belongs.
        return member
      }
    }),
    deliveries: Array.isArray(room.deliveries)
      ? room.deliveries.map((delivery: unknown) => {
          if (!isObject(delivery)) return delivery
          if ("failures" in delivery) return delivery
          const attempts = legacyAttempts(delivery)
          if (typeof attempts !== "number") return delivery
          const { attempts: _dropped, ...rest } = delivery
          void _dropped
          return { ...rest, failures: attempts }
        })
      : room.deliveries,
  }
}

/** Read-time migration for the whole file. */
function migrateRoomFile(value: unknown): unknown {
  if (!isObject(value) || !Array.isArray(value.rooms)) return value
  return { ...value, rooms: value.rooms.map(migrateRoomRaw) }
}

// JSON.stringify drops object keys whose value is `undefined`, so a persisted room with an
// unset sessionId/sandboxId/artifactUrl/artifactReady round-trips with that key absent, not
// present-as-undefined. These are the only optional fields on Room, so a missing key is
// treated the same as undefined.
function isRoom(value: unknown): value is Room {
  if (!isObject(value)) return false
  if (
    !("code" in value) ||
    !("members" in value) ||
    !("createdAt" in value) ||
    !("updatedAt" in value) ||
    !("cursor" in value) ||
    !("lastActivityAt" in value) ||
    !("state" in value)
  ) {
    return false
  }
  const sessionId = "sessionId" in value ? value.sessionId : undefined
  const lastSessionId = "lastSessionId" in value ? value.lastSessionId : undefined
  const sandboxId = "sandboxId" in value ? value.sandboxId : undefined
  const artifactUrl = "artifactUrl" in value ? value.artifactUrl : undefined
  const artifactReady = "artifactReady" in value ? value.artifactReady : undefined
  const pendingDeliveries = "pendingDeliveries" in value ? value.pendingDeliveries : undefined
  const asks = "asks" in value ? value.asks : undefined
  const deliveries = "deliveries" in value ? value.deliveries : undefined
  const deliverySeq = "deliverySeq" in value ? value.deliverySeq : undefined
  const spokenSeq = "spokenSeq" in value ? value.spokenSeq : undefined
  const deliveryLowWater = "deliveryLowWater" in value ? value.deliveryLowWater : undefined
  const protocol = "protocol" in value ? value.protocol : undefined
  return (
    isString(value.code) &&
    isStringOrUndefined(sessionId) &&
    isStringOrUndefined(lastSessionId) &&
    isStringOrUndefined(sandboxId) &&
    isStringOrUndefined(artifactUrl) &&
    isBooleanOrUndefined(artifactReady) &&
    (pendingDeliveries === undefined || (Array.isArray(pendingDeliveries) && pendingDeliveries.every(isPendingDelivery))) &&
    (asks === undefined || (Array.isArray(asks) && asks.every(isAsk))) &&
    (deliveries === undefined || (Array.isArray(deliveries) && deliveries.every(isDelivery))) &&
    isNumberOrUndefined(deliverySeq) &&
    isNumberOrUndefined(spokenSeq) &&
    isNumberOrUndefined(deliveryLowWater) &&
    isProtocol(protocol) &&
    Array.isArray(value.members) &&
    value.members.every(isMember) &&
    isString(value.createdAt) &&
    isString(value.updatedAt) &&
    typeof value.cursor === "number" &&
    isString(value.lastActivityAt) &&
    isRoomState(value.state)
  )
}

function isRoomFile(value: unknown): value is RoomFile {
  if (!isObject(value)) return false
  if (!("rooms" in value)) return false
  return Array.isArray(value.rooms) && value.rooms.every(isRoom)
}

function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function sameAddress(a: Address, b: Address): boolean {
  return a.provider === b.provider && a.source === b.source && a.contactRef === b.contactRef
}

export class RoomStore {
  private readonly filePath: string
  private readonly rooms: Map<string, Room>
  private writeChain: Promise<void>

  private constructor(filePath: string, rooms: Map<string, Room>) {
    this.filePath = filePath
    this.rooms = rooms
    this.writeChain = Promise.resolve()
  }

  static async open(dir: string): Promise<RoomStore> {
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, "rooms.json")
    const rooms = new Map<string, Room>()

    let raw: string | undefined
    try {
      raw = await readFile(filePath, "utf8")
    } catch (error) {
      if (isNodeErrnoException(error) && error.code === "ENOENT") {
        raw = undefined
      } else {
        throw error
      }
    }

    if (raw !== undefined) {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`corrupt room store at ${filePath}: invalid JSON (${message})`)
      }
      const migrated = migrateRoomFile(parsed)
      if (!isRoomFile(migrated)) {
        throw new Error(`corrupt room store at ${filePath}: unexpected shape`)
      }
      for (const room of migrated.rooms) {
        rooms.set(room.code, room)
      }
    }

    return new RoomStore(filePath, rooms)
  }

  private async persist(): Promise<void> {
    const data: RoomFile = { rooms: Array.from(this.rooms.values()) }
    const json = JSON.stringify(data, null, 2)
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(tempPath, json, "utf8")
    await rename(tempPath, this.filePath)
  }

  private enqueueWrite(): Promise<void> {
    const next = this.writeChain.then(() => this.persist())
    this.writeChain = next.catch(() => undefined)
    return next
  }

  async create(): Promise<Room> {
    let code = generateCode()
    while (this.rooms.has(code)) {
      code = generateCode()
    }
    const now = new Date().toISOString()
    const room: Room = {
      code,
      sessionId: undefined,
      sandboxId: undefined,
      artifactUrl: undefined,
      artifactReady: undefined,
      members: [],
      createdAt: now,
      updatedAt: now,
      cursor: 0,
      lastActivityAt: now,
      state: "active",
      asks: [],
      // Present and 0 from birth, so absent can mean only one thing: a room
      // persisted before this field existed, whose pruned history is
      // genuinely unknown (docs/OUTBOX.md §8). A room created with the field
      // has a provable answer — nothing pruned yet — and MUST NOT fall back
      // to the weaker legacy signal.
      deliveryLowWater: 0,
    }
    this.rooms.set(code, room)
    await this.enqueueWrite()
    return room
  }

  get(code: string): Room | undefined {
    const normalized = normalizeCode(code)
    if (normalized === undefined) return undefined
    return this.rooms.get(normalized)
  }

  list(): Room[] {
    return Array.from(this.rooms.values())
  }

  async addMember(code: string, input: Omit<Member, "id" | "joinedAt">): Promise<Member> {
    const normalized = normalizeCode(code)
    if (normalized === undefined) {
      throw new Error(`invalid room code: ${code}`)
    }
    const room = this.rooms.get(normalized)
    if (room === undefined) {
      throw new Error(`unknown room: ${normalized}`)
    }

    const existing = room.members.find((member) => sameAddress(member.address, input.address))
    const now = new Date().toISOString()
    if (existing !== undefined) {
      existing.displayName = input.displayName
      // The one-time grandfather (Member.claim's doc): a member persisted
      // before claims existed has none, and the caller who first joins under
      // this name is the same human coming back — adopt the claim they were
      // minted. Once set, `input.claim` is ignored: only the room-web claim
      // path ever passes one, and re-claiming must never rotate the secret.
      if (existing.claim === undefined && input.claim !== undefined) {
        existing.claim = input.claim
      }
      room.updatedAt = now
      await this.enqueueWrite()
      return existing
    }

    const member: Member = {
      id: randomUUID(),
      displayName: input.displayName,
      tier: input.tier,
      address: input.address,
      // The single construction point for members: every member in memory has
      // a delivery mode, derived from the address when the caller (whose
      // `InboundInput` predates the field) did not set one. Throws on a
      // provider with no delivery mode — loud, per D1.
      delivery: input.delivery ?? deliveryFromAddress(input.address),
      ...(input.claim !== undefined ? { claim: input.claim } : {}),
      joinedAt: now,
    }
    room.members.push(member)
    room.updatedAt = now
    await this.enqueueWrite()
    return member
  }

  /** Idempotent: removing a member id that isn't (or is no longer) in the
   *  room returns `undefined` instead of throwing, so a duplicate `leave` or
   *  a `join`-triggered move racing another removal is safe to retry. */
  async removeMember(code: string, memberId: string): Promise<Member | undefined> {
    const normalized = normalizeCode(code)
    if (normalized === undefined) {
      throw new Error(`invalid room code: ${code}`)
    }
    const room = this.rooms.get(normalized)
    if (room === undefined) {
      throw new Error(`unknown room: ${normalized}`)
    }

    const index = room.members.findIndex((member) => member.id === memberId)
    if (index === -1) {
      return undefined
    }
    const [removed] = room.members.splice(index, 1)
    room.updatedAt = new Date().toISOString()
    await this.enqueueWrite()
    return removed
  }

  /** Persist one member's cursor acknowledgement (PLAN-02 step 4, brief A).
   *
   *  MONOTONIC on the seq: an ack that would move `ackedSeq` backwards (or
   *  keep it where it is) does not touch it — a client replaying an old
   *  response must not rewind the retention floor. The wall-clock is
   *  refreshed in BOTH cases: re-asserting a cursor is still liveness
   *  evidence, and liveness (not the cursor) is what `pullMemberStale`
   *  reads — a client that keeps posting its unchanged cursor stays live
   *  and keeps holding its floor legitimately, because it really did
   *  receive everything up to it.
   *
   *  Returns `"applied"` when the cursor advanced, `"ignored"` otherwise
   *  (backwards/no-op ack, or a member removed between the caller's auth
   *  and this write). */
  async ackCursor(code: string, memberId: string, seq: number, at: string): Promise<"applied" | "ignored"> {
    const normalized = normalizeCode(code)
    if (normalized === undefined) {
      throw new Error(`invalid room code: ${code}`)
    }
    const room = this.rooms.get(normalized)
    if (room === undefined) {
      throw new Error(`unknown room: ${normalized}`)
    }
    const member = room.members.find((candidate) => candidate.id === memberId)
    if (member === undefined) return "ignored"
    const applied = seq > (member.ackedSeq ?? 0)
    if (applied) member.ackedSeq = seq
    member.ackedAt = at
    room.updatedAt = at
    await this.enqueueWrite()
    return applied ? "applied" : "ignored"
  }

  async update(
    code: string,
    patch: Partial<
      Pick<
        Room,
        | "sessionId"
        | "lastSessionId"
        | "sandboxId"
        | "artifactUrl"
        | "artifactReady"
        | "cursor"
        | "lastActivityAt"
        | "state"
        | "pendingDeliveries"
        | "asks"
        | "deliveries"
        | "deliverySeq"
        | "spokenSeq"
        | "deliveryLowWater"
        | "protocol"
      >
    >,
  ): Promise<Room> {
    const normalized = normalizeCode(code)
    if (normalized === undefined) {
      throw new Error(`invalid room code: ${code}`)
    }
    const room = this.rooms.get(normalized)
    if (room === undefined) {
      throw new Error(`unknown room: ${normalized}`)
    }
    const updated: Room = {
      ...room,
      ...patch,
      updatedAt: new Date().toISOString(),
    }
    // The low-water mark is MONOTONIC (brief B): it is the highest seq ever
    // pruned in this room, so a prune that drops nothing (or a stale snapshot
    // reporting an older mark) can never pull it down — a client comparing
    // `since` against it would otherwise be told a destroyed backlog was
    // intact. Absent means zero, for rooms persisted before the field.
    if (patch.deliveryLowWater !== undefined || room.deliveryLowWater !== undefined) {
      updated.deliveryLowWater = Math.max(room.deliveryLowWater ?? 0, patch.deliveryLowWater ?? 0)
    }
    this.rooms.set(normalized, updated)
    await this.enqueueWrite()
    return updated
  }

  findByAddress(address: Address): { room: Room; member: Member } | undefined {
    for (const room of this.rooms.values()) {
      const member = room.members.find((candidate) => sameAddress(candidate.address, address))
      if (member !== undefined) return { room, member }
    }
    return undefined
  }
}
