import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { generateCode, normalizeCode } from "./code.ts"
import type { Address, Ask, AskStatus, DeliveryTarget, Member, PendingDelivery, Room, RoomState, Tier } from "./types.ts"

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

function isRoomState(value: unknown): value is RoomState {
  return value === "active" || value === "paused"
}

function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value)
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null
}

function isAddress(value: unknown): value is Address {
  if (!isObject(value)) return false
  if (!("provider" in value) || !("source" in value) || !("contactRef" in value)) return false
  return isString(value.provider) && isString(value.source) && isString(value.contactRef)
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
  return (
    isString(value.id) &&
    isString(value.displayName) &&
    isTier(value.tier) &&
    isAddress(value.address) &&
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
  return (
    isString(value.code) &&
    isStringOrUndefined(sessionId) &&
    isStringOrUndefined(lastSessionId) &&
    isStringOrUndefined(sandboxId) &&
    isStringOrUndefined(artifactUrl) &&
    isBooleanOrUndefined(artifactReady) &&
    (pendingDeliveries === undefined || (Array.isArray(pendingDeliveries) && pendingDeliveries.every(isPendingDelivery))) &&
    (asks === undefined || (Array.isArray(asks) && asks.every(isAsk))) &&
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
      if (!isRoomFile(parsed)) {
        throw new Error(`corrupt room store at ${filePath}: unexpected shape`)
      }
      for (const room of parsed.rooms) {
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
      room.updatedAt = now
      await this.enqueueWrite()
      return existing
    }

    const member: Member = {
      id: randomUUID(),
      displayName: input.displayName,
      tier: input.tier,
      address: input.address,
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
