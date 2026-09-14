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
  | { kind: "leave"; code?: string }
  | { kind: "where" }

export type CommandResult =
  | { ok: true; room: Room; member: Member; created: boolean; movedFrom: string | string[] | undefined }
  /** `"not-a-member"` (BRIEF-20): the slug named a real room, but the sender
   *  is not in it — a membership problem, never an "unknown" one (the room
   *  is not unknown at all) and never a silent admission. */
  | { ok: false; reason: "unknown-code" | "not-in-room" | "not-a-member" }

const NEW_PATTERN = /^new$/i
const JOIN_PATTERN = /^join\s+(.+)$/i
const RESUME_PATTERN = /^resume\s+(.+)$/i
const LEAVE_PATTERN = /^leave(?:[ \t]+(.+))?$/i
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
    const match = LEAVE_PATTERN.exec(trimmed)
    const arg = match?.[1]?.trim()
    if (arg !== undefined && arg.length > 0) {
      const code = normalizeCode(arg)
      if (code !== undefined) return { kind: "leave", code }
      const slug = arg.toLowerCase()
      return SLUG_PATTERN.test(slug) ? { kind: "leave", code: slug } : undefined
    }
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
 *  room(s) they currently belong to (found by address) instead of leaving a
 *  stray duplicate membership behind — the mechanism behind `join`'s move
 *  semantics, shared with the room-web send path (`RoomService.sendFromRoomWeb`)
 *  so both tiers apply the same one rule. A no-op move (already a member of
 *  `code`, or not a member anywhere) just calls through to `addMember`.
 *
 *  An "ambiguous" address (the address is a member of several rooms) removes
 *  from ALL of them — the target was named explicitly by the caller, so this
 *  is not guessing which room a message belongs to (the read-side invariant
 *  that must never guess). It is honouring the room the person named. */
export async function ensureMembership(
  store: RoomStore,
  code: string,
  sender: Omit<Member, "id" | "joinedAt">,
): Promise<{ member: Member; movedFrom: string | string[] | undefined }> {
  const normalized = normalizeCode(code) ?? code
  const current = store.findByAddress(sender.address)
  // A clean single match that names a room other than the target: move off
  // that one room (the same behaviour this function has always had).
  if (current.kind === "one" && current.room.code !== normalized) {
    await store.removeMember(current.room.code, current.member.id)
    const member = await store.addMember(normalized, sender)
    return { member, movedFrom: current.room.code }
  }
  // An ambiguous address named a room, so there is nothing to guess — they
  // named it. Remove from every other room, then add to the named one.
  if (current.kind === "ambiguous") {
    const movedFrom: string[] = []
    for (const match of current.matches) {
      if (match.room.code !== normalized) {
        await store.removeMember(match.room.code, match.member.id)
        movedFrom.push(match.room.code)
      }
    }
    const member = await store.addMember(normalized, sender)
    return { member, movedFrom: movedFrom.length > 0 ? movedFrom : undefined }
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
 *  same `ensureMembership` path `join`/`resume` use, not a new mechanism.
 *
 *  BRIEF-13 step 4b: "already lists `sender` as a member" is a fact about
 *  `findByAddress`'s ANSWER, not about its `kind` being `"one"` — an address
 *  ambiguously in several rooms, one of which is the room this slug names,
 *  genuinely IS a member of that room; `kind !== "one"` used to refuse it
 *  with `"not-a-member"`, a claim that is simply false about them, and the
 *  one path that could have resolved their own ambiguity was closed to
 *  exactly the person the ambiguity is about. Still refused, unchanged: a
 *  `"none"` address (never a member anywhere) and an ambiguous address none
 *  of whose matches name THIS room — the boundary above is untouched, because
 *  it is still checking the same fact, only reading it correctly out of the
 *  `"ambiguous"` shape too. Resolution itself is not new logic: an ambiguous
 *  match falls into `ensureMembership`'s existing ambiguous branch, which
 *  already removes every OTHER membership before confirming this one — the
 *  ambiguity collapses as a consequence of the move semantics `join`/`resume`
 *  already document, not by a second admission mechanism. */
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
  const alreadyOnThisRoster =
    (current.kind === "one" && current.room.code === room.code) ||
    (current.kind === "ambiguous" && current.matches.some((match) => match.room.code === room.code))
  if (!alreadyOnThisRoster) {
    return { ok: false, reason: "not-a-member" }
  }
  const { member, movedFrom } = await ensureMembership(store, room.code, sender)
  const updated = store.get(room.code) ?? room
  // `movedFrom` is honest here now too: resolving an ambiguous address drops
  // every OTHER room it was in, which is a real fact worth reporting, not the
  // hardcoded `undefined` this returned before — the "one, same room" no-op
  // case still yields `undefined` from `ensureMembership` itself, unchanged.
  return { ok: true, room: updated, member, created: false, movedFrom }
}

async function leaveCurrent(
  store: RoomStore,
  sender: Omit<Member, "id" | "joinedAt">,
  identifier?: string,
): Promise<CommandResult> {
  // Leave a specific room named by the sender (by code or slug). The person
  // named it, so there is nothing to guess.
  if (identifier !== undefined) {
    const code = normalizeCode(identifier)
    const room = code !== undefined ? store.get(code) : store.getBySlug(identifier)
    if (room === undefined) {
      return { ok: false, reason: "unknown-code" }
    }
    const member = room.members.find(
      (m) =>
        m.address.provider === sender.address.provider &&
        m.address.source === sender.address.source &&
        m.address.contactRef === sender.address.contactRef,
    )
    if (member === undefined) {
      return { ok: false, reason: "not-in-room" }
    }
    await store.removeMember(room.code, member.id)
    const updated = store.get(room.code) ?? room
    return { ok: true, room: updated, member, created: false, movedFrom: undefined }
  }

  const found = store.findByAddress(sender.address)
  // Leave ALL rooms for an ambiguous address — they asked to be out, and no
  // winner exists when the answer is "none of them". This is not guessing
  // which room a message belongs to: it is honouring the person who said
  // "leave".
  if (found.kind === "ambiguous") {
    for (const match of found.matches) {
      await store.removeMember(match.room.code, match.member.id)
    }
    const first = found.matches[0]
    if (first === undefined) {
      return { ok: false, reason: "not-in-room" }
    }
    const updated = store.get(first.room.code) ?? first.room
    return { ok: true, room: updated, member: first.member, created: false, movedFrom: undefined }
  }
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
      return leaveCurrent(store, sender, command.code)
  }
}
