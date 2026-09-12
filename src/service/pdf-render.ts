/**
 * Renders arbitrary HTML into a PDF via the canvakit CLI — the same
 * external toolchain `deck/` uses (deck/README.md's render command,
 * docs/ARTIFACT.md). The room's artifact app is plain HTML, not a canvakit
 * template (no YAML frontmatter, no `.slide` sections), so this wraps its
 * `<body>` content into a minimal single-slide canvakit page before handing
 * it to the CLI. No new npm dependency: canvakit is invoked as an external
 * process by absolute path (`RDV_CANVAKIT_CLI`).
 */

import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { env } from "../env.ts"

const execFileAsync = promisify(execFile)

const PDF_SIGNATURE = "%PDF-"
/** `\b` after `Page` excludes `/Type /Pages` (the tree node, singular
 *  `/Count N` on it is a false page count) without excluding `/Type /Page`
 *  followed by whitespace, `/`, or `>>` — verified against a real canvakit
 *  render (`test/service/pdf-render.test.ts`), since PDF page objects are
 *  written as plain-text dictionaries even when content streams are
 *  Flate-compressed. */
const PAGE_OBJECT_PATTERN = /\/Type\s*\/Page\b/g

function extractTag(html: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(html)
  return match?.[1]
}

function extractStyles(html: string): string {
  const head = extractTag(html, "head") ?? ""
  const styles: string[] = []
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(head)) !== null) {
    if (match[1] !== undefined) styles.push(match[1])
  }
  return styles.join("\n")
}

/**
 * Wraps arbitrary page HTML's `<body>` content and inline `<style>` blocks
 * into a minimal single-slide canvakit template — YAML frontmatter plus one
 * `.slide` div. Deliberately does NOT size `.slide` to a forced viewport
 * height: doing so (the multi-slide deck convention of `width:100vw;
 * min-height:100vh` on `.slide+.slide{break-before:page}` siblings)
 * overflows a single-slide, natural-flow page onto a spurious second blank
 * page under canvakit's `--plain` A4 layout — verified live, not assumed.
 */
export function wrapAsCanvakitPage(html: string, title: string): string {
  const body = extractTag(html, "body") ?? html
  const styles = extractStyles(html)
  return [
    "---",
    "template: true",
    "name: rdv-deliverable",
    "version: 1.0.0",
    `description: ${JSON.stringify(title)}`,
    "---",
    "<!doctype html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8" />',
    `<title>${title}</title>`,
    "<style>",
    "* { box-sizing: border-box; }",
    ".slide { padding: 2.5rem; }",
    styles,
    "</style>",
    "</head>",
    "<body>",
    `<div class="slide">${body}</div>`,
    "</body>",
    "</html>",
  ].join("\n")
}

export interface RenderedPdf {
  readonly path: string
  readonly bytes: number
  readonly pages: number
  readonly renderMs: number
}

function isPdfSignature(buffer: Buffer): boolean {
  return buffer.subarray(0, PDF_SIGNATURE.length).toString("latin1") === PDF_SIGNATURE
}

function countPages(buffer: Buffer): number {
  const text = buffer.toString("latin1")
  const matches = text.match(PAGE_OBJECT_PATTERN)
  return matches?.length ?? 0
}

export interface RenderArtifactPdfOptions {
  /** Injectable for tests; defaults to `env.canvakitCli`. */
  readonly cliPath?: string
}

/**
 * Renders `html` to a PDF at `outPath` via the canvakit CLI, exactly the
 * `export <template> --format pdf --plain --output <out>` invocation
 * deck/README.md documents (module doc comment). `--plain` skips the
 * cover+table-of-contents assembly a multi-slide deck gets, keeping plain
 * A4 geometry appropriate for a one-off business deliverable.
 */
export async function renderArtifactPdf(
  html: string,
  title: string,
  outPath: string,
  opts: RenderArtifactPdfOptions = {},
): Promise<RenderedPdf> {
  const cliPath = opts.cliPath ?? env.canvakitCli
  const workDir = await mkdtemp(join(tmpdir(), "rdv-canvakit-"))
  const templatePath = join(workDir, "deliverable.canvakit.html")
  try {
    await writeFile(templatePath, wrapAsCanvakitPage(html, title), "utf8")
    const start = Date.now()
    await execFileAsync("node", [cliPath, "export", templatePath, "--format", "pdf", "--plain", "--output", outPath])
    const renderMs = Date.now() - start
    const buffer = await readFile(outPath)
    if (!isPdfSignature(buffer)) {
      throw new Error(`renderArtifactPdf: output at ${outPath} is not a PDF (bad signature)`)
    }
    return { path: outPath, bytes: buffer.length, pages: countPages(buffer), renderMs }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}
