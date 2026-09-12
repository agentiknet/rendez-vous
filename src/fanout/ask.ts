import type { Member } from "../rooms/types.ts"
import type { ResolvedBroadcastSegment } from "./whisper.ts"

const OPEN_LINE = /^\[\[ask (.+)\]\]$/
const CLOSE_LINE = /^\[\[\/ask\]\]$/

export interface RawAskSegment {
  kind: "ask"
  targetName: string
  text: string
}

export type RawTurnSegment = { kind: "broadcast"; text: string } | RawAskSegment

export interface ResolvedAskSegment {
  kind: "ask"
  target: Member
  text: string
}

export type ResolvedTurnSegment = ResolvedBroadcastSegment | ResolvedAskSegment

/**
 * Splits a turn's accumulated reply text on `[[ask <name>]]` / `[[/ask]]`
 * delimiter lines (docs/MIDDLEMAN.md §3) — the sibling of
 * `parseWhisperSegments`, with the same rules: a delimiter only counts on its
 * own line, and an opening delimiter with no matching close before the end of
 * the text is malformed and folds back into broadcast text untouched, rather
 * than silently eaten. Ask blocks are extracted first; whisper blocks are
 * parsed on whatever broadcast text remains.
 */
export function parseAskSegments(text: string): RawTurnSegment[] {
  const lines = text.split("\n")
  const segments: RawTurnSegment[] = []
  let broadcastLines: string[] = []
  let i = 0

  const flushBroadcast = (): void => {
    const joined = broadcastLines.join("\n")
    if (joined.length > 0) segments.push({ kind: "broadcast", text: joined })
    broadcastLines = []
  }

  while (i < lines.length) {
    const line = lines[i] ?? ""
    const open = OPEN_LINE.exec(line.trim())
    if (open === null) {
      broadcastLines.push(line)
      i += 1
      continue
    }

    let closeIndex = -1
    for (let j = i + 1; j < lines.length; j += 1) {
      if (CLOSE_LINE.test((lines[j] ?? "").trim())) {
        closeIndex = j
        break
      }
    }

    if (closeIndex === -1) {
      broadcastLines.push(...lines.slice(i))
      break
    }

    flushBroadcast()
    segments.push({ kind: "ask", targetName: (open[1] ?? "").trim(), text: lines.slice(i + 1, closeIndex).join("\n") })
    i = closeIndex + 1
  }

  flushBroadcast()
  return segments
}

function findMember(members: Member[], name: string): Member | undefined {
  const needle = name.toLowerCase()
  return members.find((member) => member.displayName.toLowerCase() === needle)
}

/**
 * Resolves raw turn segments against the room's current members. An ask whose
 * target name matches nobody (case-insensitively) falls back to broadcast —
 * content kept, with a note prepended so it's visible why it wasn't a
 * directed ask. A typo'd ask must never stall the demo, and never records a
 * phantom wait on nobody.
 */
export function resolveAskSegments(text: string, members: Member[]): ResolvedTurnSegment[] {
  const raw = parseAskSegments(text)
  const resolved: ResolvedTurnSegment[] = []
  for (const segment of raw) {
    if (segment.kind === "broadcast") {
      resolved.push(segment)
      continue
    }
    const target = findMember(members, segment.targetName)
    if (target === undefined) {
      const note = `(ask target not found: ${segment.targetName})`
      resolved.push({ kind: "broadcast", text: segment.text.length > 0 ? `${note}\n${segment.text}` : note })
      continue
    }
    resolved.push({ kind: "ask", target, text: segment.text })
  }
  return resolved
}

/** The text the asked member themselves sees — a private delivery of the ask,
 *  prefixed so it reads as the room waiting on them, not a broadcast. */
export function askTextForTarget(text: string): string {
  return `(the room is waiting on you) ${text}`
}

/** The one-line marker every OTHER member sees when an ask opens — once, on
 *  open, never repeated per turn. */
export function askMarkerForOthers(target: Member, what: string): string {
  return `(waiting on ${target.displayName}: ${what})`
}