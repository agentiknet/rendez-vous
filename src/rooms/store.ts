import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { generateCode, normalizeCode } from "./code.ts"
import { generateSlug, normalizeSlug } from "./words.ts"
import {
  deliveryFromAddress,
  type Address,
  type Ask,
  type AskStatus,
  type Delivery,
  type DeliveryAttachment,
  type DeliveryTarget,
  type Member,
  type MemberDelivery,
  type MessageRef,
  type PendingDelivery,
  MESSAGE_REF_RETENTION_MS,
  pruneMessageRefs,
  type RecoveryLink,
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
  // `delivery`, `claim`, `ackedSeq`, `ackedAt` and `aguiSentMessageIds` are
  // optional: members persisted before any of these fields existed
  // round-trip without the key (same rule as lastError/deliveredAt on a
  // Delivery).
  const delivery = "delivery" in value ? value.delivery : undefined
  const claim = "claim" in value ? value.claim : undefined
  const ackedSeq = "ackedSeq" in value ? value.ackedSeq : undefined
  const ackedAt = "ackedAt" in value ? value.ackedAt : undefined
  const lastSpokeAt = "lastSpokeAt" in value ? value.lastSpokeAt : undefined
  const aguiSentMessageIds = "aguiSentMessageIds" in value ? value.aguiSentMessageIds : undefined
  return (
    isString(value.id) &&
    isString(value.displayName) &&
    isTier(value.tier) &&
    isAddress(value.address) &&
    (delivery === undefined || isMemberDelivery(delivery)) &&
    (claim === undefined || isString(value.claim)) &&
    (ackedSeq === undefined || (typeof ackedSeq === "number" && Number.isInteger(ackedSeq) && ackedSeq >= 0)) &&
    isStringOrUndefined(ackedAt) &&
    isStringOrUndefined(lastSpokeAt) &&
    (aguiSentMessageIds === undefined || (Array.isArray(aguiSentMessageIds) && aguiSentMessageIds.every(isString))) &&
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

/** BRIEF-23: one persisted `RecoveryLink`. `usedAt` is optional: a live link
 *  round-trips with the key absent (same rule as `isAsk`'s optional fields). */
function isRecoveryLink(value: unknown): value is RecoveryLink {
  if (!isObject(value)) return false
  if (
    !("token" in value) ||
    !("displayName" in value) ||
    !("requestedBy" in value) ||
    !("createdAt" in value) ||
    !("expiresAt" in value)
  ) {
    return false
  }
  const usedAt = "usedAt" in value ? value.usedAt : undefined
  return (
    isString(value.token) &&
    isString(value.displayName) &&
    isString(value.requestedBy) &&
    isNumberOrUndefined(usedAt) &&
    typeof value.createdAt === "number" &&
    typeof value.expiresAt === "number"
  )
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
  // `toolName` is optional and present on `kind: "tool"` records only. A
  // record failing this predicate makes `open()` reject the WHOLE file as
  // "unexpected shape" — so a kind missing from the list below does not lose
  // one record, it refuses to boot the service against a room file that
  // contains one. Keep it in step with `Delivery["kind"]`.
  const toolName = "toolName" in value ? value.toolName : undefined
  // `attachment` (BRIEF-44) is optional and present on `kind: "attachment"`
  // records only: the file the record delivers. Same rule as `toolName` — a
  // record failing here refuses the whole room file, it never silently
  // drops one.
  const attachment = "attachment" in value ? value.attachment : undefined
  // BRIEF-48: optional, present on delivered push records only. Same
  // optional-key JSON round-trip rule as `toolName`.
  const providerMessageId = "providerMessageId" in value ? value.providerMessageId : undefined
  // BRIEF 49: optional, on `kind: "reaction"`/`kind: "reply"` records only —
  // the resolved provider id the record acts on, and the reaction's emoji.
  // Same optional-key JSON round-trip rule as `toolName`.
  const reactsTo = "reactsTo" in value ? value.reactsTo : undefined
  const emoji = "emoji" in value ? value.emoji : undefined
  return (
    isString(value.id) &&
    isString(value.memberId) &&
    (value.kind === "say" ||
      value.kind === "whisper" ||
      value.kind === "system" ||
      value.kind === "tool" ||
      value.kind === "attachment" ||
      value.kind === "reaction" ||
      value.kind === "reply") &&
    isStringOrUndefined(toolName) &&
    (attachment === undefined || isDeliveryAttachment(attachment)) &&
    isStringOrUndefined(reactsTo) &&
    isStringOrUndefined(emoji) &&
    isString(value.text) &&
    isDeliveryStatus(value.status) &&
    ((typeof failures === "number" && failures >= 0) ||
      (failures === undefined && typeof legacyFailureCount === "number" && legacyFailureCount >= 0)) &&
    (confirmedBy === undefined || confirmedBy === "transport" || confirmedBy === "recipient") &&
    isStringOrUndefined(lastError) &&
    isStringOrUndefined(providerMessageId) &&
    isString(value.createdAt) &&
    isStringOrUndefined(deliveredAt)
  )
}

/** One citable message (BRIEF-48, `MessageRef` in src/rooms/types.ts). */
function isMessageRef(value: unknown): value is MessageRef {
  if (!isObject(value)) return false
  return (
    isString(value.handle) &&
    /^m\d+$/.test(value.handle) &&
    isString(value.memberId) &&
    (value.direction === "inbound" || value.direction === "outbound") &&
    isString(value.channel) &&
    isString(value.providerId) &&
    isString(value.createdAt)
  )
}

/** The pre-rename failure count key, read off the raw record. */
function legacyAttempts(record: object): unknown {
  return "attempts" in record ? record.attempts : undefined
}

/** The file on a `kind: "attachment"` record (BRIEF-44). Kept in step with
 *  `DeliveryAttachment` (src/rooms/types.ts). */
function isDeliveryAttachment(value: unknown): value is DeliveryAttachment {
  if (!isObject(value)) return false
  const caption = "caption" in value ? value.caption : undefined
  return (
    isString(value.url) &&
    isString(value.filename) &&
    isString(value.mimeType) &&
    (value.kind === "image" || value.kind === "document" || value.kind === "audio" || value.kind === "video") &&
    isStringOrUndefined(caption)
  )
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

/** BRIEF-20: every room in the file gets a `slug`, globally unique within
 *  it, before `isRoom` ever sees the raw shape — `slug` is a required field
 *  on `Room`, so a legacy file (all 19 rooms live today) must already carry
 *  one by the time validation runs. Assigning an identifier here is not the
 *  "never backfill a guess" violation brief 12's `deliveryLowWater` warns
 *  against: a slug is not an inference about the room's past (which this
 *  project will not guess), it is a fresh identity being minted for
 *  something that never had one — the same operation `RoomStore.create`
 *  performs for a brand new room, just run once over the existing rooster.
 *  Returns whether anything was actually assigned, so `open` knows whether
 *  the in-memory backfill needs writing back to disk at all. */
function backfillSlugs(rooms: readonly unknown[]): { rooms: unknown[]; assigned: boolean } {
  const used = new Set<string>()
  for (const room of rooms) {
    if (isObject(room) && typeof room.slug === "string" && room.slug.length > 0) used.add(room.slug)
  }
  let assigned = false
  const withSlugs = rooms.map((room) => {
    if (!isObject(room) || (typeof room.slug === "string" && room.slug.length > 0)) return room
    let slug = generateSlug()
    while (used.has(slug)) slug = generateSlug()
    used.add(slug)
    assigned = true
    return { ...room, slug }
  })
  return { rooms: withSlugs, assigned }
}

/** Read-time migration for the whole file. */
function migrateRoomFile(value: unknown): { migrated: unknown; slugsAssigned: boolean } {
  if (!isObject(value) || !Array.isArray(value.rooms)) return { migrated: value, slugsAssigned: false }
  const { rooms, assigned } = backfillSlugs(value.rooms.map(migrateRoomRaw))
  return { migrated: { ...value, rooms }, slugsAssigned: assigned }
}

// JSON.stringify drops object keys whose value is `undefined`, so a persisted room with an
// unset sessionId/sandboxId/artifactUrl/artifactReady round-trips with that key absent, not
// present-as-undefined. These are the only optional fields on Room, so a missing key is
// treated the same as undefined.
function isRoom(value: unknown): value is Room {
  if (!isObject(value)) return false
  if (
    !("code" in value) ||
    !("slug" in value) ||
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
  const recoveries = "recoveries" in value ? value.recoveries : undefined
  const deliveries = "deliveries" in value ? value.deliveries : undefined
  const deliverySeq = "deliverySeq" in value ? value.deliverySeq : undefined
  const spokenSeq = "spokenSeq" in value ? value.spokenSeq : undefined
  const deliveryLowWater = "deliveryLowWater" in value ? value.deliveryLowWater : undefined
  const protocol = "protocol" in value ? value.protocol : undefined
  const messageRefs = "messageRefs" in value ? value.messageRefs : undefined
  const messageRefSeq = "messageRefSeq" in value ? value.messageRefSeq : undefined
  return (
    isString(value.code) &&
    isString(value.slug) &&
    isStringOrUndefined(sessionId) &&
    isStringOrUndefined(lastSessionId) &&
    isStringOrUndefined(sandboxId) &&
    isStringOrUndefined(artifactUrl) &&
    isBooleanOrUndefined(artifactReady) &&
    (pendingDeliveries === undefined || (Array.isArray(pendingDeliveries) && pendingDeliveries.every(isPendingDelivery))) &&
    (asks === undefined || (Array.isArray(asks) && asks.every(isAsk))) &&
    (recoveries === undefined || (Array.isArray(recoveries) && recoveries.every(isRecoveryLink))) &&
    (deliveries === undefined || (Array.isArray(deliveries) && deliveries.every(isDelivery))) &&
    isNumberOrUndefined(deliverySeq) &&
    isNumberOrUndefined(spokenSeq) &&
    isNumberOrUndefined(deliveryLowWater) &&
    (messageRefs === undefined || (Array.isArray(messageRefs) && messageRefs.every(isMessageRef))) &&
    isNumberOrUndefined(messageRefSeq) &&
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

/** One (room, member) pair `findByAddress` matched for a given address. */
export interface AddressMatch {
  readonly room: Room
  readonly member: Member
}

/** `findByAddress`'s answer (BRIEF-13 rule 2): "zero, one, or several", never
 *  a winner picked from several. `"none"` — the address has no membership
 *  anywhere. `"one"` — the clean case every caller wants. `"ambiguous"` — a
 *  broken invariant (R1: at most one membership per address): the store
 *  already holds more than one, and the caller must be able to tell that
 *  apart from a clean match rather than silently receiving whichever room
 *  happened to be inserted first. */
export type AddressLookup =
  | { readonly kind: "none" }
  | ({ readonly kind: "one" } & AddressMatch)
  | { readonly kind: "ambiguous"; readonly matches: readonly AddressMatch[] }

export class RoomStore {
  private readonly filePath: string
  private readonly rooms: Map<string, Room>
  /** `slug → code` (BRIEF-20): a slug never changes once minted, so unlike
   *  `rooms` this index is never invalidated by `update`'s copy-on-write —
   *  it only ever grows, in `create` and in the one-time backfill below. */
  private readonly slugs: Map<string, string>
  private writeChain: Promise<void>

  private constructor(filePath: string, rooms: Map<string, Room>) {
    this.filePath = filePath
    this.rooms = rooms
    this.slugs = new Map(Array.from(rooms.values(), (room) => [room.slug, room.code]))
    this.writeChain = Promise.resolve()
  }

  static async open(dir: string): Promise<RoomStore> {
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, "rooms.json")
    const rooms = new Map<string, Room>()
    let slugsAssigned = false

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
      const { migrated, slugsAssigned: assigned } = migrateRoomFile(parsed)
      if (!isRoomFile(migrated)) {
        throw new Error(`corrupt room store at ${filePath}: unexpected shape`)
      }
      slugsAssigned = assigned
      for (const room of migrated.rooms) {
        rooms.set(room.code, room)
      }
    }

    const store = new RoomStore(filePath, rooms)
    // BRIEF-20: at least one pre-existing room had no slug — persist the
    // backfill now, through the store's own write path, so a second boot
    // reads the same slugs back from disk instead of minting fresh ones
    // (idempotent, not re-minted per boot). Never touches `.rdv/` directly.
    if (slugsAssigned) {
      await store.persist()
    }
    return store
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

  /** Settle every write already enqueued — the store's own "nothing of mine
   *  is still touching the disk". Each mutator is handed its own persist to
   *  await, so a caller that awaits its mutation is already safe; this exists
   *  for the writes nobody holds, the ones a fire-and-forget caller started
   *  (the delivery engine's background drain, `DeliveryEngine.whenIdle`'s
   *  reason to exist). Shutdown — and a test tearing its temp directory down
   *  — must wait here, or `persist`'s `<file>.<uuid>.tmp` can land in a
   *  directory that is already being removed. Never rejects: `writeChain` is
   *  the failure-swallowed tail, and a flush reports "no write is still in
   *  flight", not whether the last one succeeded. */
  async flush(): Promise<void> {
    await this.writeChain
  }

  async create(): Promise<Room> {
    let code = generateCode()
    while (this.rooms.has(code)) {
      code = generateCode()
    }
    let slug = generateSlug()
    while (this.slugs.has(slug)) {
      slug = generateSlug()
    }
    const now = new Date().toISOString()
    const room: Room = {
      code,
      slug,
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
    this.slugs.set(slug, code)
    await this.enqueueWrite()
    return room
  }

  get(code: string): Room | undefined {
    const normalized = normalizeCode(code)
    if (normalized === undefined) return undefined
    return this.rooms.get(normalized)
  }

  /** BRIEF-20: the slug's OWN lookup — kept a separate method from `get`
   *  rather than accepting either shape in one call, so every call site has
   *  to say out loud which security posture it wants (`get`: this identifier
   *  admits; `getBySlug`: this identifier only ever identifies — see
   *  `commands.ts`'s `joinBySlug`/`resumeBySlug` for the membership check
   *  that makes that real). */
  getBySlug(slug: string): Room | undefined {
    const code = this.slugs.get(normalizeSlug(slug))
    return code === undefined ? undefined : this.rooms.get(code)
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

  /** Persist the fact that one member SENT a message into the room (brief
   *  36, presence): receiving a message is proof the member is there —
   *  stronger evidence than an ack, and the one liveness signal
   *  `pullMemberStale` ignored. Written only by the ordinary inbound path
   *  (`RoomService.handleMessage`); `lastSpokeAt` is a liveness stamp and
   *  nothing else — unlike `ackedAt`, it is not any cursor's wall-clock,
   *  and the never-acked warning and `presenceBasis` keep reading
   *  `ackedAt` alone. A member removed between the caller's routing and
   *  this write is a no-op, mirroring `ackCursor`'s posture. */
  async stampMemberSpoke(code: string, memberId: string, at: string): Promise<void> {
    const normalized = normalizeCode(code)
    if (normalized === undefined) {
      throw new Error(`invalid room code: ${code}`)
    }
    const room = this.rooms.get(normalized)
    if (room === undefined) {
      throw new Error(`unknown room: ${normalized}`)
    }
    const member = room.members.find((candidate) => candidate.id === memberId)
    if (member === undefined) return
    member.lastSpokeAt = at
    room.updatedAt = at
    await this.enqueueWrite()
  }

  /** Persist the fact that one member has sent this `AguiMessage.id` into
   *  the room, and answer whether it was NEW (`"new"`) or already recorded
   *  (`"seen"`). This is the send-once key behind `POST /rooms/:code/agui`
   *  (D6): AG-UI clients replay the whole thread on every run and poll the
   *  endpoint to stay alive, so the trailing user message is otherwise sent
   *  once per poll. Scoped per member, like every other member field — the
   *  same text from two members is two messages, and the same id from two
   *  members is not one.
   *
   *  Recorded BEFORE the caller sends: the check and the append are one
   *  synchronous step here, so two overlapping POSTs carrying the same id
   *  cannot both pass the guard while the first awaits the room's send. The
   *  trade is deliberately at-most-once (the endpoint's contract): an id
   *  consumed by a send that then fails is not re-sendable by replay, which
   *  is the safe direction for a room — a lost retry beats a duplicated
   *  message. The append is not capped: each id is a handful of bytes and a
   *  member's real human messages are bounded, while evicting an old id
   *  would let it be sent again.
   *
   *  A member removed between the caller's auth and this write is a no-op
   *  answered `"seen"` — nothing to record, and the caller's guard treats it
   *  as already handled rather than sending into a member that is gone. */
  async recordAguiMessage(code: string, memberId: string, messageId: string): Promise<"new" | "seen"> {
    const normalized = normalizeCode(code)
    if (normalized === undefined) {
      throw new Error(`invalid room code: ${code}`)
    }
    const room = this.rooms.get(normalized)
    if (room === undefined) {
      throw new Error(`unknown room: ${normalized}`)
    }
    const member = room.members.find((candidate) => candidate.id === memberId)
    if (member === undefined) return "seen"
    const seen = member.aguiSentMessageIds ?? []
    if (seen.includes(messageId)) return "seen"
    member.aguiSentMessageIds = [...seen, messageId]
    room.updatedAt = new Date().toISOString()
    await this.enqueueWrite()
    return "new"
  }

  /** Mint one citable message (BRIEF-48, docs/REACT-REPLY.md §2 piece 3):
   *  the handle is drawn from the room's monotonic `messageRefSeq` — never
   *  from `messageRefs.length`, which the prune shrinks and a reused
   *  handle would silently re-point at another message. The mint PRUNES in
   *  the same write (`pruneMessageRefs`), so the tail stays bounded; a
   *  handle the prune later drops resolves to `undefined` — the caller
   *  (a future react/reply tool) reports that named, never as a send to a
   *  guessed message. In-place mutation like `addMember` above, one
   *  persist. */
  async recordMessageRef(
    code: string,
    input: { memberId: string; direction: MessageRef["direction"]; channel: string; providerId: string },
    at?: string,
  ): Promise<MessageRef> {
    const normalized = normalizeCode(code)
    if (normalized === undefined) {
      throw new Error(`invalid room code: ${code}`)
    }
    const room = this.rooms.get(normalized)
    if (room === undefined) {
      throw new Error(`unknown room: ${normalized}`)
    }
    const createdAt = at ?? new Date().toISOString()
    const nowMs = Number.isNaN(Date.parse(createdAt)) ? Date.now() : Date.parse(createdAt)
    const lastSeq = room.messageRefSeq ?? room.messageRefs?.length ?? 0
    const ref: MessageRef = {
      handle: `m${lastSeq + 1}`,
      memberId: input.memberId,
      direction: input.direction,
      channel: input.channel,
      providerId: input.providerId,
      createdAt,
    }
    room.messageRefs = pruneMessageRefs([...(room.messageRefs ?? []), ref], nowMs)
    room.messageRefSeq = lastSeq + 1
    room.updatedAt = createdAt
    await this.enqueueWrite()
    return ref
  }

  /** Resolve a handle to the message it cites — `undefined` when the handle
   *  is unknown, malformed, pruned, EXPIRED, or names another room.
   *
   *  BRIEF-48 follow-up: the 24 h bound is an expiry enforced HERE, at
   *  read, not merely a write-time retention. `pruneMessageRefs` runs only
   *  on mint, so a quiet room's array can still physically hold refs past
   *  their window — and a resolver that read the array directly would keep
   *  answering for them, making "100 recent, 24 h" a guarantee wider than
   *  the code honours (traffic-dependent, exactly the OUTBOX §1 shape).
   *  An undateable ref is refused too: it can never be proven young, and
   *  the prune would have dropped it at the next mint anyway. Deliberately
   *  NOT an error: the absence is the answer, and the caller's job is to
   *  say so plainly (`unknown message handle: m12`), never to fall back to
   *  a guessed message. */
  async resolveMessageRef(code: string, handle: string): Promise<MessageRef | undefined> {
    const normalized = normalizeCode(code)
    if (normalized === undefined) return undefined
    const room = this.rooms.get(normalized)
    if (room === undefined) return undefined
    const ref = (room.messageRefs ?? []).find((candidate) => candidate.handle === handle)
    if (ref === undefined) return undefined
    const stamp = Date.parse(ref.createdAt)
    if (Number.isNaN(stamp) || Date.now() - stamp > MESSAGE_REF_RETENTION_MS) return undefined
    return ref
  }

  /** The room's whole citable tail, oldest first — the read behind
   *  `room_view`'s `recent_messages` (the agent's only handle surface; the
   *  member never sees one — the attribution line is untouched by
   *  BRIEF-48). Filtered by the SAME read-side expiry `resolveMessageRef`
   *  applies, so the agent can never cite a handle this list showed and
   *  the resolver then refuses: one bound, enforced at both doors. */
  messageRefsOf(code: string): readonly MessageRef[] {
    const normalized = normalizeCode(code)
    if (normalized === undefined) return []
    const now = Date.now()
    return (this.rooms.get(normalized)?.messageRefs ?? []).filter((ref) => {
      const stamp = Date.parse(ref.createdAt)
      return !Number.isNaN(stamp) && now - stamp <= MESSAGE_REF_RETENTION_MS
    })
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
        | "recoveries"
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

  /** BRIEF-13 rule 2/3: scans every room for a membership at `address` and
   *  never returns a winner when more than one holds it — "repair on read,
   *  loudly" means an ambiguous address is logged with every code it was
   *  found in, at warning level, on every call, not silently normalised to
   *  the first (oldest, by `Map` insertion order) match. */
  findByAddress(address: Address): AddressLookup {
    const matches: AddressMatch[] = []
    for (const room of this.rooms.values()) {
      const member = room.members.find((candidate) => sameAddress(candidate.address, address))
      if (member !== undefined) matches.push({ room, member })
    }
    if (matches.length === 0) return { kind: "none" }
    const [first, ...rest] = matches
    if (first === undefined) return { kind: "none" }
    if (rest.length === 0) return { kind: "one", room: first.room, member: first.member }
    const codes = matches.map((match) => match.room.code).join(", ")
    console.warn(
      `findByAddress: ${address.provider}/${address.contactRef} has a membership in more than one room (${codes}) — broken invariant, not resolved silently`,
    )
    return { kind: "ambiguous", matches }
  }
}
