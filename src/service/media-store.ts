/**
 * Per-room store for landed binary media. Two record families share the
 * same directory layout (`RDV_MEDIA_DIR/<room code>/<media id>[.ext]`):
 *
 *   - Rendered deliverables (docs/DELIVERABLE.md): written by `save`,
 *     always PDFs, `<id>.pdf`. The file itself is the durable artifact; the
 *     in-memory index exists only so a later `get`/`read` doesn't need to
 *     trust a caller-supplied content type or page count again.
 *   - Inbound media (docs/MULTIMODAL.md): written by `saveIngress`, the
 *     raw bytes fetched off an inbound webhook's `media[].url`, kept
 *     forever as the provenance of the normalized transcript line. Same
 *     store, same room scoping, arbitrary mime.
 *
 * Both lookup surfaces are keyed `roomCode/mediaId`, so a record landed in
 * one room is never served under another room's code — the media HTTP route
 * (`src/service/http.ts` `handleRoomMedia`) reads through this keying.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"

export interface MediaRecord {
  readonly id: string
  readonly roomCode: string
  readonly contentType: string
  readonly pages: number
  readonly bytes: number
  readonly createdAt: string
}

export interface SaveMediaInput {
  readonly contentType: string
  readonly pages: number
}

/** Inbound-media record, docs/MULTIMODAL.md's `MediaRecord` shape. A record
 *  landed before the sender's room is known (a media-only webhook is
 *  normalized before `handleInbound` resolves membership) starts
 *  roomCode-less and is re-keyed by `assignRoom` once the outcome names the
 *  room; the media route only ever serves room-keyed records. */
export interface IngressMediaRecord {
  readonly mediaId: string
  readonly kind: "voice" | "image" | "file"
  readonly source: string
  readonly mime: string
  readonly transcript: string | undefined
  readonly caption: string | undefined
  readonly confidence: number | undefined
  readonly receivedAt: string
  readonly roomCode?: string
  readonly bytes: number
  readonly error: string | undefined
}

export interface SaveIngressInput {
  kind: IngressMediaRecord["kind"]
  source: string
  mime: string
  transcript?: string
  caption?: string
  confidence?: number
  /** Set when the bytes could not be landed at all (fetch failure, oversize)
   *  — the record still exists so the `media:<id>` reference resolves to
   *  something (empty bytes), and the fan-in line carries the reason. */
  error?: string
}

/** Room code records sit under until `assignRoom` moves them. Deliberately
 *  not a legal room-code shape, so it can never collide with a real room. */
const UNASSIGNED = "__unassigned__"

export class MediaStore {
  private readonly baseDir: string
  private readonly records = new Map<string, MediaRecord>()
  private readonly ingress = new Map<string, IngressMediaRecord>()

  constructor(baseDir: string) {
    this.baseDir = baseDir
  }

  private key(roomCode: string, id: string): string {
    return `${roomCode}/${id}`
  }

  private filePath(roomCode: string, id: string, extension: string): string {
    return join(this.baseDir, roomCode, extension.length > 0 ? `${id}.${extension}` : id)
  }

  /** On-disk extension for a stored record. The store used to hardcode
   *  `"pdf"` for every `save`, which was harmless only as long as the
   *  deliverable flow (PDFs) was the sole caller — the HTTP route serves
   *  `record.contentType` regardless. Now that images go through here too,
   *  a PNG written as `<id>.pdf` is a trap for anyone reading the directory.
   *  `read` derives it identically, so the two can never disagree. */
  private extensionFor(contentType: string): string {
    const type = contentType.split(";")[0]?.trim().toLowerCase() ?? ""
    if (type === "application/pdf") return "pdf"
    if (type === "image/png") return "png"
    if (type === "image/jpeg") return "jpg"
    if (type === "image/webp") return "webp"
    if (type === "image/gif") return "gif"
    if (type === "audio/ogg") return "ogg"
    return "bin"
  }

  async save(roomCode: string, data: Buffer, opts: SaveMediaInput): Promise<MediaRecord> {
    const id = randomUUID()
    await mkdir(join(this.baseDir, roomCode), { recursive: true })
    await writeFile(this.filePath(roomCode, id, this.extensionFor(opts.contentType)), data)
    const record: MediaRecord = {
      id,
      roomCode,
      contentType: opts.contentType,
      pages: opts.pages,
      bytes: data.length,
      createdAt: new Date().toISOString(),
    }
    this.records.set(this.key(roomCode, id), record)
    return record
  }

  get(roomCode: string, id: string): MediaRecord | undefined {
    return this.records.get(this.key(roomCode, id))
  }

  /** Returns `undefined` for an unknown id or a record whose file is
   *  missing on disk — the caller treats both as "not found", never throws. */
  async read(roomCode: string, id: string): Promise<Buffer | undefined> {
    const record = this.get(roomCode, id)
    if (record === undefined) return undefined
    try {
      return await readFile(this.filePath(roomCode, id, this.extensionFor(record.contentType)))
    } catch {
      return undefined
    }
  }

  async saveIngress(data: Uint8Array, opts: SaveIngressInput): Promise<IngressMediaRecord> {
    const mediaId = randomUUID()
    await mkdir(join(this.baseDir, UNASSIGNED), { recursive: true })
    await writeFile(this.filePath(UNASSIGNED, mediaId, ""), data)
    const record: IngressMediaRecord = {
      mediaId,
      kind: opts.kind,
      source: opts.source,
      mime: opts.mime,
      transcript: opts.transcript,
      caption: opts.caption,
      confidence: opts.confidence,
      receivedAt: new Date().toISOString(),
      bytes: data.length,
      error: opts.error,
    }
    this.ingress.set(this.key(UNASSIGNED, mediaId), record)
    return record
  }

  /** Re-keys a roomCode-less ingress record under the room its sender turned
   *  out to belong to — moving the file with it, so room scoping holds from
   *  the moment the record is servable. Returns the re-keyed record, or
   *  `undefined` if the id is unknown or already assigned (never re-assigned:
   *  a record's room is fixed once known). */
  async assignRoom(mediaId: string, roomCode: string): Promise<IngressMediaRecord | undefined> {
    const record = this.ingress.get(this.key(UNASSIGNED, mediaId))
    if (record === undefined) return undefined
    await mkdir(join(this.baseDir, roomCode), { recursive: true })
    await rename(this.filePath(UNASSIGNED, mediaId, ""), this.filePath(roomCode, mediaId, ""))
    const assigned: IngressMediaRecord = { ...record, roomCode }
    this.ingress.delete(this.key(UNASSIGNED, mediaId))
    this.ingress.set(this.key(roomCode, mediaId), assigned)
    return assigned
  }

  getIngress(roomCode: string, mediaId: string): IngressMediaRecord | undefined {
    return this.ingress.get(this.key(roomCode, mediaId))
  }

  async readIngress(roomCode: string, mediaId: string): Promise<Buffer | undefined> {
    if (this.getIngress(roomCode, mediaId) === undefined) return undefined
    try {
      return await readFile(this.filePath(roomCode, mediaId, ""))
    } catch {
      return undefined
    }
  }
}