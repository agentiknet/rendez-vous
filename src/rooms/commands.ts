import { normalizeCode } from "./code.ts"
import type { RoomStore } from "./store.ts"
import type { Member, Room } from "./types.ts"

export type Command =
  | { kind: "new" }
  | { kind: "join"; code: string }
  /** BRIEF-20 §3: naming a room by its SLUG never admits — it only resolves
   *  for someone the store already lists as a member of that exact room. A
   *  separate command kind (rather than teaching `join` to accept either
   *  shape) so the two admission postures stay visible at the type, not
   *  just in a branch inside one handler. */
  | { kind: "join-by-slug"; slug: string }
  | { kind: "resume"; code: string }
  | { kind: "resume-by-slug"; slug: string }
  | { kind: "leave" }
  | { kind: "where" }

export type CommandResult =
  | { ok: true; room: Room; member: Member; created: boolean; movedFrom: string | undefined }
  /** `"not-a-member"` (BRIEF-20): the slug named a real room, but the sender
   *  is not in it — a membership problem, never an "unknown" one (the room
   *  is not unknown at all) and never a silent admission. */
  | { ok: false; reason: "unknown-code" | "not-in-room" | "not-a-member" }

const NEW_PATTERN = /^new$/i
const JOIN_PATTERN = /^join\s+(.+)$/i
const RESUME_PATTERN = /^resume\s+(.+)$/i
const LEAVE_PATTERN = /^leave$/i
const WHERE_PATTERN = /^where$/i
/** Three lowercase words joined by hyphens (`words.ts`'s `generateSlug`
 *  shape) — checked against the lowercased, trimmed argument, so a member
 *  typing a slug back with different case still parses. */
const SLUG_PATTERN = /^[a-z]+(?:-[a-z]+){2}$/

export function parseCommand(text: string): Command | undefined {
  const trimmed = text.trim()

  if (NEW_PATTERN.test(trimmed)) {
    return { kind: "new" }
  }

  if (LEAVE_PATTERN.test(trimmed)) {
    return { kind: "leave" }
  }

  if (WHERE_PATTERN.test(trimmed)) {
    return { kind: "where" }
  }

  const joinMatch = JOIN_PATTERN.exec(trimmed)
  if (joinMatch !== null) {
    const arg = joinMatch[1] ?? ""
    const code = normalizeCode(arg)
    if (code !== undefined) return { kind: "join", code }
    const slug = arg.trim().toLowerCase()
    return SLUG_PATTERN.test(slug) ? { kind: "join-by-slug", slug } : undefined
  }

  const resumeMatch = RESUME_PATTERN.exec(trimmed)
  if (resumeMatch !== null) {
    const arg = resumeMatch[1] ?? ""
    const code = normalizeCode(arg)
    if (code !== undefined) return { kind: "resume", code }
    const slug = arg.trim().toLowerCase()
    return SLUG_PATTERN.test(slug) ? { kind: "resume-by-slug", slug } : undefined
  }

  return undefined
}

/** Ensures `sender` is a member of `code`, moving them off whatever other
 *  room they currently belong to (found by address) instead of leaving a
 *  stray duplicate membership behind — the mechanism behind `join`'s move
 *  semantics, shared with the room-web send path (`RoomService.sendFromRoomWeb`)
 *  so both tiers apply the same one rule. A no-op move (already a member of
 *  `code`, or not a member anywhere) just calls through to `addMember`. */
export async function ensureMembership(
  store: RoomStore,
  code: string,
  sender: Omit<Member, "id" | "joinedAt">,
): Promise<{ member: Member; movedFrom: string | undefined }> {
  const normalized = normalizeCode(code) ?? code
  const current = store.findByAddress(sender.address)
  // Only a clean single match names a room to move OUT of. An "ambiguous"
  // lookup already logged its own loud warning (RoomStore.findByAddress) —
  // this call does not additionally guess which of the address's several
  // rooms to remove from, which would be exactly the silent-pick-a-winner
  // sin R1/R5 exist to end, just moved one call frame over.
  if (current.kind === "one" && current.room.code !== normalized) {
    await store.removeMember(current.room.code, current.member.id)
    const member = await store.addMember(normalized, sender)
    return { member, movedFrom: current.room.code }
  }
  const member = await store.addMember(normalized, sender)
  return { member, movedFrom: undefined }
}

/** `join <code>` and `resume <code>` share one mechanism (rule 1): both name
 *  an existing room and move the sender into it through `ensureMembership`. */
async function moveIntoRoom(
  store: RoomStore,
  code: string,
  sender: Omit<Member, "id" | "joinedAt">,
): Promise<CommandResult> {
  const room = store.get(code)
  if (room === undefined) {
    return { ok: false, reason: "unknown-code" }
  }
  const { member, movedFrom } = await ensureMembership(store, room.code, sender)
  const updated = store.get(room.code) ?? room
  return { ok: true, room: updated, member, created: false, movedFrom }
}

/** BRIEF-20 §3, the security boundary of the whole brief: a slug IDENTIFIES,
 *  it does not ADMIT. This only ever succeeds when `store.findByAddress`
 *  already lists `sender` as a member of the room the slug names — it never
 *  calls `store.addMember` for anyone who isn't already on that roster, so a
 *  slug can never become an accepted join credential the way a code is. A
 *  member confirming their own room this way is a no-op refresh through the
 *  same `ensureMembership` path `join`/`resume` use, not a new mechanism. */
async function enterBySlug(
  store: RoomStore,
  slug: string,
  sender: Omit<Member, "id" | "joinedAt">,
): Promise<CommandResult> {
  const room = store.getBySlug(slug)
  if (room === undefined) {
    return { ok: false, reason: "unknown-code" }
  }
  const current = store.findByAddress(sender.address)
  if (current.kind !== "one" || current.room.code !== room.code) {
    return { ok: false, reason: "not-a-member" }
  }
  const { member } = await ensureMembership(store, room.code, sender)
  const updated = store.get(room.code) ?? room
  return { ok: true, room: updated, member, created: false, movedFrom: undefined }
}

async function leaveCurrent(
  store: RoomStore,
  sender: Omit<Member, "id" | "joinedAt">,
): Promise<CommandResult> {
  const found = store.findByAddress(sender.address)
  // Same posture as `ensureMembership`: only a clean single match is safe to
  // act on. An "ambiguous" address already got its own loud warning from
  // `findByAddress` — `leave` does not additionally decide which of several
  // pre-existing rooms to clear, which would be deleting/normalising the
  // very duplicates this brief is explicit about leaving alone.
  if (found.kind !== "one") {
    return { ok: false, reason: "not-in-room" }
  }
  const { room, member } = found
  await store.removeMember(room.code, member.id)
  const updated = store.get(room.code) ?? room
  return { ok: true, room: updated, member, created: false, movedFrom: undefined }
}

/** `where` is read-only (rule 1 governs writes, not reads) and has no place
 *  in a result shaped for a move/create/leave outcome, so it is excluded
 *  here — `RoomService.handleWhere` calls `store.findByAddress` directly
 *  instead of routing through this function. */
export async function handleCommand(
  store: RoomStore,
  command: Exclude<Command, { kind: "where" }>,
  sender: Omit<Member, "id" | "joinedAt">,
): Promise<CommandResult> {
  switch (command.kind) {
    case "new": {
      const room = await store.create()
      // R1/R2: `new` is an explicit act by the member too — it moves the
      // pointer off whatever room they were in exactly like `join`/`resume`
      // do, through the one shared mechanism, not a bypassing `addMember`.
      const { member, movedFrom } = await ensureMembership(store, room.code, sender)
      const updated = store.get(room.code) ?? room
      return { ok: true, room: updated, member, created: true, movedFrom }
    }
    case "join":
      return moveIntoRoom(store, command.code, sender)
    case "join-by-slug":
      return enterBySlug(store, command.slug, sender)
    case "resume":
      return moveIntoRoom(store, command.code, sender)
    case "resume-by-slug":
      return enterBySlug(store, command.slug, sender)
    case "leave":
      return leaveCurrent(store, sender)
  }
}
