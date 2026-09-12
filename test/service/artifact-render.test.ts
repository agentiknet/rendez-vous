import assert from "node:assert/strict"
import { mkdtemp, readFile, stat, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { renderArtifactHtml, renderArtifactPdf } from "../../src/service/artifact-render.ts"

/** The SEEDED template + data committed under the artifact app — the exact
 *  pair the room's agent will edit and the renderer will consume. */
const SEED_DIR = new URL("../../apps/room-artifact/.agentproto/ui/", import.meta.url)
const TEMPLATE_PATH = new URL("room.canvakit.html", SEED_DIR).pathname
const DATA_PATH = new URL("data.json", SEED_DIR).pathname

const dirs: string[] = []

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-artifact-render-"))
  dirs.push(dir)
  return dir
}

test("renderArtifactHtml renders the seeded template+data to a substantial on-brand page", async () => {
  const dir = await freshDir()
  const outPath = join(dir, "index.html")

  const rendered = await renderArtifactHtml(TEMPLATE_PATH, DATA_PATH, outPath)

  assert.equal(rendered.path, outPath)
  assert.ok(rendered.renderMs >= 0)

  const html = await readFile(outPath, "utf8")
  const bytes = (await stat(outPath)).size
  assert.equal(bytes, rendered.bytes)
  assert.ok(
    bytes > 5_000,
    `the rendered page must carry the kit's styles and the document, not a stub (${bytes} bytes)`,
  )
  assert.ok(html.includes("Rendez-vous room deliverable"), "the data's title must reach the output")
  assert.ok(html.includes("Key points"), "the data's bullet-section heading must reach the output")
  assert.ok(html.includes("replace me"), "the data's placeholder content must reach the output")
})

test("renderArtifactHtml renders with the Ternwood kit, not a default or Agentik fallback", async () => {
  const dir = await freshDir()
  const outPath = join(dir, "index.html")

  await renderArtifactHtml(TEMPLATE_PATH, DATA_PATH, outPath)

  const html = await readFile(outPath, "utf8")
  // Ternwood's terracotta accent (#C25E3A) must be IN the output as a kit
  // colour variable — a render that silently fell back to a default kit
  // would fail here, and so would a render that picked up the Agentik kit.
  assert.ok(
    /--color-accent:\s*#C25E3A/i.test(html),
    "the Ternwood accent must reach the output as a kit CSS variable",
  )
  // Agentik's brand blue must NOT appear anywhere: neither from the kit nor
  // from a template fallback left over from our own brand.
  assert.ok(!html.includes("#5586C8"), "no Agentik brand blue may survive into the artifact")
  assert.ok(!html.toLowerCase().includes("poppins"), "no Agentik Poppins stack may survive into the artifact")
  // The kit's font stack must be what the render uses.
  assert.ok(/Fraunces/.test(html), "the Ternwood display face must reach the output")
})

test("renderArtifactPdf renders the same seed to a valid, non-empty PDF", async () => {
  const dir = await freshDir()
  const outPath = join(dir, "deliverable.pdf")

  const rendered = await renderArtifactPdf(TEMPLATE_PATH, DATA_PATH, outPath)

  assert.equal(rendered.path, outPath)
  assert.ok(rendered.bytes > 0)
  assert.ok(rendered.pages >= 1, `expected at least one PDF page, got ${rendered.pages}`)
  assert.ok(rendered.renderMs >= 0)

  const bytes = await readFile(outPath)
  assert.equal(bytes.length, rendered.bytes)
  assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-", "the rendered file must carry a real PDF signature")

  console.log(
    `[artifact-render.test] canvakit pdf=${rendered.bytes}B / ${rendered.pages} page(s) in ${rendered.renderMs}ms`,
  )
})
