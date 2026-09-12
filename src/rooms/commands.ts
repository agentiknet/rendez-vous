import { normalizeCode } from "./code.ts"
import type { RoomStore } from "./store.ts"
import type { Member, Room } from "./types.ts"

export type Command =
  | { kind: "new" }
  | { kind: "join"; code: string }
  | { kind: "resume"; code: string }
  | { kind: "leave" }

export type CommandResult =
  | { ok: true; room: Room; member: Member; created: boolean; movedFrom: string | undefined }
  | { ok: false; reason: "unknown-code" | "not-in-room" }

const NEW_PATTERN = /^new$/i
const JOIN_PATTERN = /^join\s+(.+)$/i
const RESUME_PATTERN = /^resume\s+(.+)$/i
const LEAVE_PATTERN = /^leave$/i

export function parseCommand(text: string): Command | undefined {
  const trimmed = text.trim()

  if (NEW_PATTERN.test(trimmed)) {
    return { kind: "new" }
  }

  if (LEAVE_PATTERN.test(trimmed)) {
    return { kind: "leave" }
  }

  const joinMatch = JOIN_PATTERN.exec(trimmed)
  if (joinMatch !== null) {
    const code = normalizeCode(joinMatch[1] ?? "")
    return code === undefined ? undefined : { kind: "join", code }
  }

  const resumeMatch = RESUME_PATTERN.exec(trimmed)
  if (resumeMatch !== null) {
    const code = normalizeCode(resumeMatch[1] ?? "")
    return code === undefined ? undefined : { kind: "resume", code }
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
  if (current !== undefined && current.room.code !== normalized) {
    await store.removeMember(current.room.code, current.member.id)
    const member = await store.addMember(normalized, sender)
    return { member, movedFrom: current.room.code }
  }
  const member = await store.addMember(normalized, sender)
  return { member, movedFrom: undefined }
}

async function joinExisting(
  store: RoomStore,
  code: string,
  sender: Omit<Member, "id" | "joinedAt">,
): Promise<CommandResult> {
  const room = store.get(code)
  if (room === undefined) {
    return { ok: false, reason: "unknown-code" }
  }
  const member = await store.addMember(code, sender)
  const updated = store.get(code) ?? room
  return { ok: true, room: updated, member, created: false, movedFrom: undefined }
}

async function joinRoom(
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

async function leaveCurrent(
  store: RoomStore,
  sender: Omit<Member, "id" | "joinedAt">,
): Promise<CommandResult> {
  const found = store.findByAddress(sender.address)
  if (found === undefined) {
    return { ok: false, reason: "not-in-room" }
  }
  const { room, member } = found
  await store.removeMember(room.code, member.id)
  const updated = store.get(room.code) ?? room
  return { ok: true, room: updated, member, created: false, movedFrom: undefined }
}

export async function handleCommand(
  store: RoomStore,
  command: Command,
  sender: Omit<Member, "id" | "joinedAt">,
): Promise<CommandResult> {
  switch (command.kind) {
    case "new": {
      const room = await store.create()
      const member = await store.addMember(room.code, sender)
      const updated = store.get(room.code) ?? room
      return { ok: true, room: updated, member, created: true, movedFrom: undefined }
    }
    case "join":
      return joinRoom(store, command.code, sender)
    case "resume":
      return joinExisting(store, command.code, sender)
    case "leave":
      return leaveCurrent(store, sender)
  }
}
