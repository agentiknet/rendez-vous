import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { generateCode, normalizeCode } from "./code.ts"
import type { Address, Member, Room, RoomState, Tier } from "./types.ts"

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
  const sandboxId = "sandboxId" in value ? value.sandboxId : undefined
  const artifactUrl = "artifactUrl" in value ? value.artifactUrl : undefined
  const artifactReady = "artifactReady" in value ? value.artifactReady : undefined
  return (
    isString(value.code) &&
    isStringOrUndefined(sessionId) &&
    isStringOrUndefined(sandboxId) &&
    isStringOrUndefined(artifactUrl) &&
    isBooleanOrUndefined(artifactReady) &&
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

  async update(
    code: string,
    patch: Partial<
      Pick<Room, "sessionId" | "sandboxId" | "artifactUrl" | "artifactReady" | "cursor" | "lastActivityAt" | "state">
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
