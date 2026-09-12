/**
 * Outbound attachments — how the agent sends a file, not just a link to one.
 *
 * The agent runs inside the e2b box. Its files are on the box's disk, which
 * this service cannot read. So "send the PDF you just made" has no obvious
 * path… except that one already exists: the artifact proxy
 * (`GET /r/:code/artifact/*`) publicly serves the very directory the agent
 * writes into. A file dropped in `<appDir>/.agentproto/ui/` is already
 * reachable at `https://<public>/r/<code>/artifact/<name>`, on a URL keyed to
 * the ROOM rather than the box, so it survives the box being replaced.
 *
 * That makes the whole feature a naming convention plus a lookup, with no new
 * transport of bytes anywhere:
 *
 *     [[attach report.pdf]]
 *     [[attach chart.png  the Q3 numbers you asked for]]
 *
 * on its own line in the agent's turn. Everything else in the turn is
 * delivered as normal text; the marker itself never reaches a member.
 *
 * Why a convention rather than a tool: the box has no tool access back into
 * the service (architecture.md §9.3) — whisper and ask work the same way, for
 * the same reason. This deliberately reuses their shape so there is one thing
 * to learn, not three.
 */

/** Media kinds agentpush accepts on `content.media[].type`. `file` is not one
 *  of them — an unknown extension is sent as `document`, which every channel
 *  renders. */
export type AttachmentKind = "image" | "document" | "audio" | "video"

export interface ParsedAttachment {
  /** Path as written by the agent, relative to the served artifact root.
   *  Leading slashes and `./` are stripped; see `sanitizeName`. */
  readonly name: string
  readonly kind: AttachmentKind
  readonly mimeType: string
  /** The rest of the marker line, when the agent wrote one. */
  readonly caption: string | undefined
}

export interface ParsedAttachments {
  /** The turn text with every `[[attach …]]` line removed. */
  readonly text: string
  readonly attachments: readonly ParsedAttachment[]
}

const ATTACH_LINE = /^[ \t]*\[\[attach[ \t]+([^\]]+)\]\][ \t]*$/i

const MIME_BY_EXTENSION: Readonly<Record<string, { mime: string; kind: AttachmentKind }>> = {
  pdf: { mime: "application/pdf", kind: "document" },
  png: { mime: "image/png", kind: "image" },
  jpg: { mime: "image/jpeg", kind: "image" },
  jpeg: { mime: "image/jpeg", kind: "image" },
  gif: { mime: "image/gif", kind: "image" },
  webp: { mime: "image/webp", kind: "image" },
  svg: { mime: "image/svg+xml", kind: "image" },
  mp3: { mime: "audio/mpeg", kind: "audio" },
  ogg: { mime: "audio/ogg", kind: "audio" },
  wav: { mime: "audio/wav", kind: "audio" },
  m4a: { mime: "audio/mp4", kind: "audio" },
  mp4: { mime: "video/mp4", kind: "video" },
  webm: { mime: "video/webm", kind: "video" },
  csv: { mime: "text/csv", kind: "document" },
  txt: { mime: "text/plain", kind: "document" },
  md: { mime: "text/markdown", kind: "document" },
  json: { mime: "application/json", kind: "document" },
  html: { mime: "text/html", kind: "document" },
  zip: { mime: "application/zip", kind: "document" },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "document" },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "document" },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "document" },
}

export function kindAndMimeFor(name: string): { kind: AttachmentKind; mime: string } {
  const dot = name.lastIndexOf(".")
  const extension = dot === -1 ? "" : name.slice(dot + 1).toLowerCase()
  const known = MIME_BY_EXTENSION[extension]
  if (known !== undefined) return { kind: known.kind, mime: known.mime }
  return { kind: "document", mime: "application/octet-stream" }
}

/**
 * Reduce whatever the agent wrote to a path under the served root.
 *
 * The marker text is agent-authored, and the resulting URL is fetched by a
 * third party (the messaging provider). `..` segments are dropped outright
 * rather than resolved: the served root is the only thing we are willing to
 * expose, and there is no legitimate attachment above it. Returns `undefined`
 * when nothing usable is left.
 */
export function sanitizeName(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/^[./\\]+/, "")
  if (trimmed.length === 0) return undefined
  const parts = trimmed
    .split(/[/\\]+/)
    .filter((part) => part.length > 0 && part !== "." && part !== "..")
  if (parts.length === 0) return undefined
  const joined = parts.join("/")
  return joined.length === 0 ? undefined : joined
}

const SAY_LINE = /^[ \t]*\[\[say[ \t]+([^\]]+)\]\][ \t]*$/i

export interface ParsedSpeech {
  /** The turn text with every `[[say …]]` line removed. */
  readonly text: string
  /** What the agent asked to say aloud, in order. */
  readonly spoken: readonly string[]
}

/**
 * `[[say …]]` — the agent replying with an actual voice note.
 *
 * Same shape as `[[attach …]]`, and deliberately a separate marker rather
 * than an option on it: an attachment names a file that already exists, this
 * names text that has to be rendered. Keeping them apart means a TTS outage
 * degrades one and not the other.
 *
 * The spoken text is REMOVED from the broadcast text, not duplicated: hearing
 * a sentence and reading it twice is worse than either alone. A member on a
 * tier that cannot play audio still gets it, because the caption carries the
 * same words.
 */
export function parseSpeech(text: string): ParsedSpeech {
  const spoken: string[] = []
  const kept: string[] = []

  for (const line of text.split("\n")) {
    const match = SAY_LINE.exec(line)
    if (match === null) {
      kept.push(line)
      continue
    }
    const body = match[1]?.trim()
    if (body === undefined || body.length === 0) {
      // Nothing to speak. Leave the marker visible rather than dropping the
      // line, so an empty `[[say]]` is a bug someone can see.
      kept.push(line)
      continue
    }
    spoken.push(body)
  }

  return { text: kept.join("\n").trim(), spoken }
}

export function parseAttachments(text: string): ParsedAttachments {
  const attachments: ParsedAttachment[] = []
  const kept: string[] = []

  for (const line of text.split("\n")) {
    const match = ATTACH_LINE.exec(line)
    if (match === null) {
      kept.push(line)
      continue
    }
    const body = match[1]
    if (body === undefined) {
      kept.push(line)
      continue
    }
    // First whitespace-delimited token is the path; the remainder, if any, is
    // a caption. A path with spaces is not supported on purpose — it would
    // make the caption unparseable, and the agent controls the filename.
    const spaceAt = body.search(/\s/)
    const rawName = spaceAt === -1 ? body : body.slice(0, spaceAt)
    const rawCaption = spaceAt === -1 ? "" : body.slice(spaceAt).trim()
    const name = sanitizeName(rawName)
    if (name === undefined) {
      // Nothing sendable, and dropping the line silently would be the exact
      // failure this project keeps finding. Leave it in the text so the room
      // can see the agent tried to attach something unusable.
      kept.push(line)
      continue
    }
    const { kind, mime } = kindAndMimeFor(name)
    attachments.push({
      name,
      kind,
      mimeType: mime,
      caption: rawCaption.length > 0 ? rawCaption : undefined,
    })
  }

  return { text: kept.join("\n").trim(), attachments }
}

/** The public, room-keyed URL a provider will fetch the attachment from.
 *  `artifactBase` is `publicArtifactUrl(code)`, which already ends in `/`. */
export function attachmentUrl(artifactBase: string, name: string): string {
  const encoded = name
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")
  return `${artifactBase}${encoded}`
}
