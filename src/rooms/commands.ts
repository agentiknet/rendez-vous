import { normalizeCode } from "./code.ts"
import type { RoomStore } from "./store.ts"
import type { Member, Room } from "./types.ts"

export type Command = { kind: "new" } | { kind: "join"; code: string } | { kind: "resume"; code: string }

export type CommandResult =
  | { ok: true; room: Room; member: Member; created: boolean }
  | { ok: false; reason: "unknown-code" }

const NEW_PATTERN = /^new$/i
const JOIN_PATTERN = /^join\s+(.+)$/i
const RESUME_PATTERN = /^resume\s+(.+)$/i

export function parseCommand(text: string): Command | undefined {
  const trimmed = text.trim()

  if (NEW_PATTERN.test(trimmed)) {
    return { kind: "new" }
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
  return { ok: true, room: updated, member, created: false }
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
      return { ok: true, room: updated, member, created: true }
    }
    case "join":
      return joinExisting(store, command.code, sender)
    case "resume":
      return joinExisting(store, command.code, sender)
  }
}
