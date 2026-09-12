/**
 * Per-room store for rendered deliverables (docs/DELIVERABLE.md). Each save
 * writes a file under `RDV_MEDIA_DIR/<room code>/<media id>.pdf` and records
 * a small metadata entry — the file itself is the durable artifact; the
 * in-memory index exists only so a later `get`/`read` doesn't need to trust
 * a caller-supplied content type or page count again.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { env } from "../env.ts"

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

export class MediaStore {
  private readonly baseDir: string
  private readonly records = new Map<string, MediaRecord>()

  constructor(baseDir: string = env.mediaDir) {
    this.baseDir = baseDir
  }

  private key(roomCode: string, id: string): string {
    return `${roomCode}/${id}`
  }

  private filePath(roomCode: string, id: string): string {
    return join(this.baseDir, roomCode, `${id}.pdf`)
  }

  async save(roomCode: string, data: Buffer, opts: SaveMediaInput): Promise<MediaRecord> {
    const id = randomUUID()
    await mkdir(join(this.baseDir, roomCode), { recursive: true })
    await writeFile(this.filePath(roomCode, id), data)
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
      return await readFile(this.filePath(roomCode, id))
    } catch {
      return undefined
    }
  }
}
