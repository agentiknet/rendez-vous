/**
 * Per-room store for the canvakit render the room's agent produces through
 * the `render_artifact` MCP tool (`src/service/mcp-canvakit.ts`). Two files
 * per room under `RDV_MEDIA_DIR/<room code>/artifact/`:
 *
 *   - `index.html` — the rendered live site, served at the room's stable
 *     artifact proxy URL (`src/service/artifact-proxy.ts` serves this as the
 *     index instead of proxying to the box).
 *   - `deliverable.pdf` — the same document as a PDF, stored next to it so
 *     the deliverable flow can hand it on later without a re-render.
 *   - `source.json` — the typed blocks `render_artifact` was CALLED with,
 *     kept so `read_artifact` can hand the document back to an agent in the
 *     shape it would edit it in. Deliberately not the HTML: the rendered
 *     page is a design artifact full of CSS, and an agent asked to change
 *     one bullet needs the blocks, not the stylesheet.
 *
 * Same room-keying discipline as `MediaStore`: a render landed under one
 * room code is never served under another. The in-memory record exists only
 * so the tool's return value can report sizes/page count without re-parsing;
 * the files themselves are the durable artifact and survive a service
 * restart (the proxy path reads from disk, and the in-memory index is
 * rebuilt lazily on first touch).
 *
 * Writes are atomic across the set: every file is written to a temp name
 * first and renamed only once ALL of them succeeded, so a crash mid-save
 * leaves the OLD set intact, never a mixed one (new HTML, old PDF).
 *
 * `source.json` is OPTIONAL on read and never synthesised. A render that
 * landed before this file started keeping it has HTML and a PDF and no
 * source, and `readSource` returns `undefined` for it — which the caller
 * must report as "I cannot read it", never as "there is nothing there".
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { env } from "../env.ts"

export interface ArtifactRenderRecord {
  readonly roomCode: string
  readonly htmlBytes: number
  readonly pdfBytes: number
  /** Page count of the PDF at render time. A record hydrated back from disk
   *  after a restart reports 0 ("unknown") rather than re-parsing the PDF —
   *  nothing on the serving path needs the number, only the tool's return
   *  value does, and that value is computed at render time. */
  readonly pages: number
  readonly renderedAt: string
}

export class ArtifactRenderStore {
  private readonly baseDir: string
  private readonly records = new Map<string, ArtifactRenderRecord>()

  constructor(baseDir: string = env.mediaDir) {
    this.baseDir = baseDir
  }

  private dirPath(roomCode: string): string {
    return join(this.baseDir, roomCode, "artifact")
  }

  /** Rebuild the in-memory record from disk for a room whose index is missing
   *  from the map but present on disk (a service restart). Tolerant: a
   *  directory that doesn't exist means "no render", never a throw. */
  private async hydrate(roomCode: string): Promise<ArtifactRenderRecord | undefined> {
    const dir = this.dirPath(roomCode)
    try {
      const html = await readFile(join(dir, "index.html"))
      const pdf = await readFile(join(dir, "deliverable.pdf"))
      const record: ArtifactRenderRecord = {
        roomCode,
        htmlBytes: html.length,
        pdfBytes: pdf.length,
        pages: 0,
        renderedAt: new Date().toISOString(),
      }
      this.records.set(roomCode, record)
      return record
    } catch {
      return undefined
    }
  }

  /** `source` is the typed blocks the render was produced FROM. Optional so
   *  every existing caller and test keeps compiling, but production passes
   *  it — omitting it stores a render `read_artifact` can see and cannot
   *  read. */
  async save(
    roomCode: string,
    html: Buffer,
    pdf: Buffer,
    pages: number,
    source?: readonly unknown[],
  ): Promise<ArtifactRenderRecord> {
    const dir = this.dirPath(roomCode)
    await mkdir(dir, { recursive: true })
    const tmpHtml = join(dir, `.index.${randomUUID()}.tmp`)
    const tmpPdf = join(dir, `.deliverable.${randomUUID()}.pdf.tmp`)
    await writeFile(tmpHtml, html)
    await writeFile(tmpPdf, pdf)
    // Written before ANY rename, so a failure here leaves the whole old set
    // untouched rather than a new page beside its old source.
    const tmpSource = source === undefined ? undefined : join(dir, `.source.${randomUUID()}.json.tmp`)
    if (tmpSource !== undefined) await writeFile(tmpSource, JSON.stringify(source, null, 2), "utf8")
    await rename(tmpHtml, join(dir, "index.html"))
    await rename(tmpPdf, join(dir, "deliverable.pdf"))
    if (tmpSource !== undefined) await rename(tmpSource, join(dir, "source.json"))
    const record: ArtifactRenderRecord = {
      roomCode,
      htmlBytes: html.length,
      pdfBytes: pdf.length,
      pages,
      renderedAt: new Date().toISOString(),
    }
    this.records.set(roomCode, record)
    return record
  }

  has(roomCode: string): boolean {
    return this.records.has(roomCode)
  }

  /** The stored render record, hydrating from disk first — the async form
   *  the HTTP layer uses, so a service restart doesn't make members' pages
   *  (or the `renderedAt` freshness signal) disappear until the next render
   *  lands. */
  async getOrLoad(roomCode: string): Promise<ArtifactRenderRecord | undefined> {
    const existing = this.records.get(roomCode)
    if (existing !== undefined) return existing
    return this.hydrate(roomCode)
  }

  /** True when a stored render exists. Same hydrate-first behaviour as
   *  `getOrLoad`, kept as a boolean convenience for callers that only need
   *  the fact, not the record. */
  async hasOrLoad(roomCode: string): Promise<boolean> {
    return (await this.getOrLoad(roomCode)) !== undefined
  }

  /** The typed blocks the stored render was produced from, or `undefined`
   *  when this room's render predates source capture (or the file is
   *  unreadable/corrupt). NEVER an empty array as a stand-in: `[]` is a
   *  legitimate document — an agent that rendered nothing — and returning it
   *  for "I don't have the source" is the absence-reads-as-fact mistake in
   *  its smallest possible form. */
  async readSource(roomCode: string): Promise<readonly unknown[] | undefined> {
    try {
      const raw = await readFile(join(this.dirPath(roomCode), "source.json"), "utf8")
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  async readHtml(roomCode: string): Promise<Buffer | undefined> {
    try {
      return await readFile(join(this.dirPath(roomCode), "index.html"))
    } catch {
      return undefined
    }
  }
}
