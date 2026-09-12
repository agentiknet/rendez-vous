import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { renderArtifactPdf, wrapAsCanvakitPage } from "../../src/service/pdf-render.ts"

const dirs: string[] = []

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-pdf-render-"))
  dirs.push(dir)
  return dir
}

const FIXTURE_HTML = [
  "<!doctype html>",
  "<html>",
  "<head>",
  '<meta charset="utf-8" />',
  "<title>Rendez-vous room artifact</title>",
  "<style>h1 { color: navy; }</style>",
  "</head>",
  "<body>",
  "<h1>Rendez-vous room artifact</h1>",
  "<p>This is the room's live artifact, served from inside its e2b sandbox.</p>",
  "</body>",
  "</html>",
].join("\n")

test("wrapAsCanvakitPage embeds the body and inline styles into a single-slide template", () => {
  const wrapped = wrapAsCanvakitPage(FIXTURE_HTML, "Test deliverable")
  assert.match(wrapped, /^---\ntemplate: true/)
  assert.match(wrapped, /class="slide"/)
  assert.match(wrapped, /<h1>Rendez-vous room artifact<\/h1>/)
  assert.match(wrapped, /h1 \{ color: navy; \}/)
  assert.match(wrapped, /<title>Test deliverable<\/title>/)
})

test("renderArtifactPdf runs the real canvakit CLI against a small HTML fixture and produces a valid, one-page PDF", async () => {
  const dir = await freshDir()
  const outPath = join(dir, "deliverable.pdf")

  const rendered = await renderArtifactPdf(FIXTURE_HTML, "Rendez-vous deliverable", outPath)

  assert.equal(rendered.path, outPath)
  assert.ok(rendered.bytes > 0)
  assert.equal(rendered.pages, 1)
  assert.ok(rendered.renderMs >= 0)

  const bytes = await readFile(outPath)
  assert.equal(bytes.length, rendered.bytes)
  assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-", "the rendered file must carry a real PDF signature")

  console.log(`[pdf-render.test] canvakit render took ${rendered.renderMs}ms, ${rendered.bytes} bytes, ${rendered.pages} page(s)`)
})
