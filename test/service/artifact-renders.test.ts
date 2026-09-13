import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { ArtifactRenderStore } from "../../src/service/artifact-renders.ts"

const dirs: string[] = []
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-artifact-renders-"))
  dirs.push(dir)
  return dir
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test("two successive save()s for the same room produce different renderedAt values (BRIEF-05: the freshness signal must be able to distinguish renders)", async () => {
  const store = new ArtifactRenderStore(await freshDir())
  const first = await store.save("RDV-AAAA", Buffer.from("<html>1</html>"), Buffer.from("%PDF-1"), 1)
  // A real delay so the two saves cannot land in the same millisecond and
  // collide on `new Date().toISOString()` — if they ever did, that would be
  // a real finding about the signal's resolution, not papered over here.
  await delay(5)
  const second = await store.save("RDV-AAAA", Buffer.from("<html>2</html>"), Buffer.from("%PDF-2"), 1)
  assert.notEqual(first.renderedAt, second.renderedAt)
})

test("getOrLoad rebuilds a record from disk after a restart, but hydrate()'s renderedAt is the hydrate time, NOT the original save time (BRIEF-05 finding: unstable across a restart)", async () => {
  const dir = await freshDir()
  const beforeRestart = new ArtifactRenderStore(dir)
  const saved = await beforeRestart.save("RDV-BBBB", Buffer.from("<html></html>"), Buffer.from("%PDF"), 1)
  await delay(5)

  // A fresh instance simulates a service restart: no in-memory record, only
  // what hydrate() can read back from disk.
  const afterRestart = new ArtifactRenderStore(dir)
  const hydrated = await afterRestart.getOrLoad("RDV-BBBB")
  assert.ok(hydrated !== undefined, "the render must still be found on disk after a restart")
  assert.notEqual(
    hydrated?.renderedAt,
    saved.renderedAt,
    "hydrate() stamps 'now', not the original render time — this makes exactly one spurious panel reload per restart, which BRIEF-05 accepts but wants on record",
  )
})

test("getOrLoad returns undefined, not a fabricated record, for a room with no render on disk", async () => {
  const store = new ArtifactRenderStore(await freshDir())
  assert.equal(await store.getOrLoad("RDV-NOPE"), undefined)
})
