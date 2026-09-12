import type { Member } from "../rooms/types.ts"

const OPEN_LINE = /^\[\[whisper to (.+)\]\]$/
const CLOSE_LINE = /^\[\[\/whisper\]\]$/

/**
 * `[[to <name>]]` … `[[/to]]` — the ordinary answer to ONE person.
 *
 * Distinct from a whisper, and the difference is what the OTHERS see. A
 * whisper is confidential, so the room is told it happened ("the agent
 * whispered to Alice") because hiding that would be dishonest. A direct reply
 * is not a secret — it is simply not everyone's business, and announcing it
 * would be noise.
 *
 * This exists because broadcast was the default. The agent named people
 * politely ("Alain: … / Claire: …") and then pushed the whole thing to every
 * phone in the room, so two people asking unrelated questions each got both
 * answers, twice the length, on a phone screen. Naming the recipient inside a
 * message everyone receives is legibility; it is not addressing.
 *
 * Members on the room WEB page still see every direct reply, prefixed with
 * its recipient: that page is the shared transcript and the projected screen.
 * What changes is whose phone buzzes.
 */
const DIRECT_OPEN_LINE = /^\[\[to (.+)\]\]$/
const DIRECT_CLOSE_LINE = /^\[\[\/to\]\]$/

export interface RawBroadcastSegment {
  kind: "broadcast"
  text: string
}

export interface RawWhisperSegment {
  kind: "whisper"
  targetName: string
  text: string
  /** `true` for `[[whisper to …]]`: the room is told the whisper happened.
   *  `false` for `[[to …]]`: an ordinary answer to one person, which the
   *  other phones simply do not receive. */
  announced: boolean
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
  announced: boolean
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
    const trimmed = line.trim()
    const whisperOpen = OPEN_LINE.exec(trimmed)
    const directOpen = whisperOpen === null ? DIRECT_OPEN_LINE.exec(trimmed) : null
    const open = whisperOpen ?? directOpen
    if (open === null) {
      broadcastLines.push(line)
      i += 1
      continue
    }
    const announced = whisperOpen !== null
    const closeTest = announced ? CLOSE_LINE : DIRECT_CLOSE_LINE

    let closeIndex = -1
    for (let j = i + 1; j < lines.length; j += 1) {
      if (closeTest.test((lines[j] ?? "").trim())) {
        closeIndex = j
        break
      }
    }

    if (closeIndex === -1) {
      broadcastLines.push(...lines.slice(i))
      break
    }

    flushBroadcast()
    segments.push({
      kind: "whisper",
      targetName: (open[1] ?? "").trim(),
      text: lines.slice(i + 1, closeIndex).join("\n"),
      announced,
    })
    i = closeIndex + 1
  }

  flushBroadcast()
  return segments
}

/**
 * Resolve a whisper target name against the room's members.
 *
 * Accepts either a bare display name (`Jeremy`) or a name qualified by its
 * surface (`Jeremy · whatsapp`, also `Jeremy - whatsapp` / `Jeremy|whatsapp`).
 *
 * The qualified form exists because ONE HUMAN can be in the room on two
 * channels — Telegram and WhatsApp — as two members with the same display
 * name. A bare name then matched whichever joined first, silently: the
 * private half of a reply went to one surface and the other saw only the
 * "(whispered to Jeremy)" marker, with nothing anywhere saying the agent had
 * aimed at the wrong device. Now the agent sees the channel in every
 * attribution (`[Jeremy · whatsapp] …`, src/fanin/index.ts) and can name it
 * back.
 *
 * A bare name that matches exactly one member still works, which is the
 * common case. A bare name matching several is deliberately still the first
 * match rather than an error — a whisper that lands on one of the human's own
 * devices is far better than one that degrades to broadcast in front of the
 * whole room.
 */
function findMember(members: Member[], name: string): Member | undefined {
  const needle = name.trim().toLowerCase()

  const exact = members.find((member) => member.displayName.toLowerCase() === needle)
  if (exact !== undefined) return exact

  // `<name> · <channel>` in any of the separators an agent is likely to emit.
  const split = needle.split(/\s*[·|]\s*|\s+-\s+/)
  if (split.length < 2) return undefined
  const channel = split[split.length - 1]?.trim()
  const bare = split.slice(0, -1).join(" · ").trim()
  if (channel === undefined || bare.length === 0) return undefined

  return members.find(
    (member) =>
      member.displayName.toLowerCase() === bare &&
      (member.address.provider.toLowerCase() === channel || member.tier.toLowerCase() === channel),
  )
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
    resolved.push({ kind: "whisper", target, text: segment.text, announced: segment.announced })
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
  // The room page is the shared transcript AND the screen people project, so
  // it keeps everything — a direct reply shown with its recipient. Phones get
  // only what is theirs.
  const seesEverything = member.tier === "room-web"

  for (const segment of segments) {
    if (segment.kind === "broadcast") {
      parts.push(segment.text)
      continue
    }
    if (segment.target.id === member.id) {
      parts.push(segment.announced ? `(private) ${segment.text}` : segment.text)
      continue
    }
    if (segment.announced) {
      parts.push(`(the agent whispered to ${segment.target.displayName})`)
      continue
    }
    if (seesEverything) {
      parts.push(`→ ${segment.target.displayName}: ${segment.text}`)
    }
    // Otherwise: nothing. An ordinary answer to someone else is not this
    // member's message, and pushing it to their phone is the noise that made
    // two people receive both halves of two unrelated conversations.
  }
  return parts.filter((part) => part.length > 0).join("\n")
}
