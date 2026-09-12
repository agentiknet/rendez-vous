/**
 * Renders the room artifact's canvakit template + data through the canvakit
 * CLI — once as HTML (the live site) and once as PDF (the deliverable) —
 * exactly the invocations deck/README.md documents (`export <template>
 * --format html|pdf --design kit:agentik --output <out>`).
 *
 * One authored source (`room.canvakit.html` + `data.json`) produces BOTH
 * outputs through the SAME design kit, so the site and the PDF match by
 * construction: the agent edits structured data, and the design system is
 * enforced by canvakit rather than by asking a model to stay on brand.
 *
 * No new npm dependency: canvakit is invoked as an external process by
 * absolute path (`env.canvakitCli`), the same shape `pdf-render.ts` uses.
 */

import { execFile } from "node:child_process"
import { copyFile, mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { env } from "../env.ts"

const execFileAsync = promisify(execFile)

const PDF_SIGNATURE = "%PDF-"

/**
 * The demo client's designkit: Ternwood, the fictional ~30-person company the
 * demo rooms deliver for. Its own brand, deliberately NOT Agentik's — a
 * seminar budget PDF carrying our logo makes no sense to the members watching.
 * The ref is a named constant because the brand is meant to be swappable:
 * point this at another `_design/<slug>.md` (same colour key names) and every
 * render — site and PDF — rebrands with no other change.
 */
const ARTIFACT_KIT_SLUG = "ternwood"
const ARTIFACT_KIT_REF = `kit:${ARTIFACT_KIT_SLUG}`

/**
 * Where the kit lives: `apps/room-artifact/_design/ternwood.md`, next to the
 * artifact app itself. `kit:` refs resolve as `_design/<slug>.md` relative to
 * the canvakit process's CWD (deck/README.md; canvakit's designkit registry
 * resolves `kit:<slug>` to `_design/<slug>.md` under the workspace root it
 * finds from the CWD), so the renderer stages this file into its throwaway
 * work dir's `_design/` before spawning. Keeping it under `apps/room-artifact/`
 * means one `_design/` directory serves the artifact renderer AND travels with
 * the app seed into the box (src/sandbox/boot.ts's `seedFromDir` copies
 * `apps/room-artifact/` wholesale), while `deck/_design/` stays deck's own.
 * Resolved from this file's own location, like `booter.ts`'s
 * `ARTIFACT_SEED_DIR`, so it doesn't depend on process.cwd().
 */
const ARTIFACT_KIT_PATH = fileURLToPath(new URL(`../../apps/room-artifact/_design/${ARTIFACT_KIT_SLUG}.md`, import.meta.url))

export interface RenderedArtifactHtml {
  readonly path: string
  readonly bytes: number
  readonly renderMs: number
}

export interface RenderedArtifactPdf {
  readonly path: string
  readonly bytes: number
  readonly pages: number
  readonly renderMs: number
}

export interface RenderArtifactOptions {
  /** Injectable for tests; defaults to `env.canvakitCli`. */
  readonly cliPath?: string
  /** Injectable for tests; defaults to the Ternwood kit
   *  (`apps/room-artifact/_design/ternwood.md`). */
  readonly kitPath?: string
}

/** `\b` after `Page` excludes `/Type /Pages` (the tree node) without
 *  excluding `/Type /Page` followed by whitespace, `/`, or `>>` — same
 *  pattern `pdf-render.ts` uses, verified against real canvakit output. */
const PAGE_OBJECT_PATTERN = /\/Type\s*\/Page\b/g

function isPdfSignature(buffer: Buffer): boolean {
  return buffer.subarray(0, PDF_SIGNATURE.length).toString("latin1") === PDF_SIGNATURE
}

function countPages(buffer: Buffer): number {
  const matches = buffer.toString("latin1").match(PAGE_OBJECT_PATTERN)
  return matches?.length ?? 0
}

interface ArtifactRenderResult {
  readonly bytes: number
  readonly renderMs: number
}

async function renderArtifact(
  templatePath: string,
  dataPath: string,
  outPath: string,
  format: "html" | "pdf",
  opts: RenderArtifactOptions,
): Promise<ArtifactRenderResult> {
  const cliPath = opts.cliPath ?? env.canvakitCli
  const workDir = await mkdtemp(join(tmpdir(), "rdv-artifact-render-"))
  try {
    // The CLI resolves `kit:<slug>` refs against its CWD's `_design/` and the
    // file source's path against the template's directory — see the comment
    // on ARTIFACT_KIT_PATH. Stage all three into the work dir and pass the
    // template by its RELATIVE name: with an absolute template path the
    // source resolution regresses to CWD-relative (verified live) and the
    // render refuses to start.
    await mkdir(join(workDir, "_design"), { recursive: true })
    await copyFile(opts.kitPath ?? ARTIFACT_KIT_PATH, join(workDir, "_design", `${ARTIFACT_KIT_SLUG}.md`))
    const templateName = "room.canvakit.html"
    await copyFile(templatePath, join(workDir, templateName))
    await copyFile(dataPath, join(workDir, "data.json"))
    const start = Date.now()
    await execFileAsync(
      "node",
      [
        cliPath,
        "export",
        templateName,
        "--format",
        format,
        "--design",
        ARTIFACT_KIT_REF,
        "--output",
        outPath,
      ],
      { cwd: workDir },
    )
    const renderMs = Date.now() - start
    const buffer = await readFile(outPath)
    if (format === "pdf" && !isPdfSignature(buffer)) {
      throw new Error(`renderArtifact: ${outPath} is not a PDF (bad signature)`)
    }
    if (format === "html" && buffer.length === 0) {
      throw new Error(`renderArtifact: ${outPath} is empty`)
    }
    return { bytes: buffer.length, renderMs }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

/**
 * Renders the template+data to an on-brand HTML page at `outPath` (the live
 * site artifact). The output is self-contained apart from the Google-Fonts
 * `<link>` canvakit emits for the kit's Poppins stack.
 */
export async function renderArtifactHtml(
  templatePath: string,
  dataPath: string,
  outPath: string,
  opts: RenderArtifactOptions = {},
): Promise<RenderedArtifactHtml> {
  const { bytes, renderMs } = await renderArtifact(templatePath, dataPath, outPath, "html", opts)
  return { path: outPath, bytes, renderMs }
}

/**
 * Renders the template+data to an on-brand PDF at `outPath` (the
 * deliverable). Same template, same design kit, same data as
 * `renderArtifactHtml` — the two outputs match by construction.
 */
export async function renderArtifactPdf(
  templatePath: string,
  dataPath: string,
  outPath: string,
  opts: RenderArtifactOptions = {},
): Promise<RenderedArtifactPdf> {
  const { bytes, renderMs } = await renderArtifact(templatePath, dataPath, outPath, "pdf", opts)
  const buffer = await readFile(outPath)
  return { path: outPath, bytes, pages: countPages(buffer), renderMs }
}
