import type { Member } from "../rooms/types.ts"

const OPEN_LINE = /^\[\[whisper to (.+)\]\]$/
const CLOSE_LINE = /^\[\[\/whisper\]\]$/

export interface RawBroadcastSegment {
  kind: "broadcast"
  text: string
}

export interface RawWhisperSegment {
  kind: "whisper"
  targetName: string
  text: string
}

export type RawSegment = RawBroadcastSegment | RawWhisperSegment

export interface ResolvedBroadcastSegment {
  kind: "broadcast"
  text: string
}

export interface ResolvedWhisperSegment {
  kind: "whisper"
  target: Member
  text: string
}

export type ResolvedSegment = ResolvedBroadcastSegment | ResolvedWhisperSegment

/**
 * Splits a turn's accumulated reply text on `[[whisper to <name>]]` /
 * `[[/whisper]]` delimiter lines. A delimiter only counts on its own line
 * (matched against the trimmed line, exactly). An opening delimiter with no
 * matching close before the end of the text is malformed: everything from
 * that line onward is folded back into broadcast text untouched, rather than
 * silently eaten — the transcript must never lose text to a typo'd block.
 */
export function parseWhisperSegments(text: string): RawSegment[] {
  const lines = text.split("\n")
  const segments: RawSegment[] = []
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
    segments.push({ kind: "whisper", targetName: (open[1] ?? "").trim(), text: lines.slice(i + 1, closeIndex).join("\n") })
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
 * Resolves raw segments against the room's current members. A whisper whose
 * target name matches nobody (case-insensitively) falls back to broadcast —
 * the content is kept, not discarded, with a note prepended so it's visible
 * why it wasn't private. Nothing a reply says is ever dropped from the
 * transcript by this step.
 */
export function resolveWhisperSegments(text: string, members: Member[]): ResolvedSegment[] {
  const raw = parseWhisperSegments(text)
  const resolved: ResolvedSegment[] = []
  for (const segment of raw) {
    if (segment.kind === "broadcast") {
      resolved.push(segment)
      continue
    }
    const target = findMember(members, segment.targetName)
    if (target === undefined) {
      const note = `(whisper target not found: ${segment.targetName})`
      resolved.push({ kind: "broadcast", text: segment.text.length > 0 ? `${note}\n${segment.text}` : note })
      continue
    }
    resolved.push({ kind: "whisper", target, text: segment.text })
  }
  return resolved
}

/**
 * Renders the text one member should see for a turn: broadcast segments
 * verbatim, their own whisper segments prefixed "(private)", and every other
 * member's whisper collapsed to a one-line marker — so the fact that a
 * whisper happened is never invisible, even though its content is.
 */
export function renderWhisperForMember(segments: ResolvedSegment[], member: Member): string {
  const parts: string[] = []
  for (const segment of segments) {
    if (segment.kind === "broadcast") {
      parts.push(segment.text)
      continue
    }
    parts.push(
      segment.target.id === member.id
        ? `(private) ${segment.text}`
        : `(the agent whispered to ${segment.target.displayName})`,
    )
  }
  return parts.join("\n")
}
