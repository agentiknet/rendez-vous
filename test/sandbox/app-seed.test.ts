import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { buildAppSeedScript } from "../../src/sandbox/app-seed.ts"

async function withAppSource(
  appMd: string,
  uiHtml: string,
  run: (localAppSourceDir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-app-seed-"))
  try {
    await mkdir(join(dir, ".agentproto", "ui"), { recursive: true })
    await writeFile(join(dir, ".agentproto", "APP.md"), appMd)
    await writeFile(join(dir, ".agentproto", "ui", "index.html"), uiHtml)
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("buildAppSeedScript embeds both files' exact content as heredocs", async () => {
  await withAppSource("---\nschema: app/v1\n---\nhi", "<html>hi</html>\n", async localDir => {
    const script = buildAppSeedScript(localDir, "/home/user/apps/rdv-hello")
    assert.match(script, /^set -e$/m)
    assert.match(script, /mkdir -p '\/home\/user\/apps\/rdv-hello\/\.agentproto\/ui'/)
    assert.match(script, /cat > '\/home\/user\/apps\/rdv-hello\/\.agentproto\/APP\.md' <<'RDV_SEED_APP_MD_EOF'/)
    assert.ok(script.includes("---\nschema: app/v1\n---\nhi"))
    assert.match(script, /cat > '\/home\/user\/apps\/rdv-hello\/\.agentproto\/ui\/index\.html' <<'RDV_SEED_UI_HTML_EOF'/)
    assert.ok(script.includes("<html>hi</html>"))
  })
})

test("buildAppSeedScript guards every file write behind an 'APP.md does not already exist' check", async () => {
  await withAppSource("app content", "<html>ui</html>", async localDir => {
    const script = buildAppSeedScript(localDir, "/home/user/apps/rdv-hello")
    const guardLine = "if [ ! -e '/home/user/apps/rdv-hello/.agentproto/APP.md' ]; then"
    const guardIndex = script.indexOf(guardLine)
    const fiIndex = script.lastIndexOf("\nfi")
    assert.ok(guardIndex >= 0, "script should open with the existence guard")
    assert.ok(fiIndex > guardIndex, "script should close the guard with fi")

    const mkdirIndex = script.indexOf("mkdir -p")
    const appMdWriteIndex = script.indexOf("cat > '/home/user/apps/rdv-hello/.agentproto/APP.md'")
    const uiHtmlWriteIndex = script.indexOf("cat > '/home/user/apps/rdv-hello/.agentproto/ui/index.html'")
    for (const index of [mkdirIndex, appMdWriteIndex, uiHtmlWriteIndex]) {
      assert.ok(index > guardIndex && index < fiIndex, "every write must sit inside the guard, not outside it")
    }
  })
})

test("buildAppSeedScript is idempotent — identical output on repeated calls", async () => {
  await withAppSource("content-a", "content-b", async localDir => {
    const first = buildAppSeedScript(localDir, "/home/user/apps/rdv-hello")
    const second = buildAppSeedScript(localDir, "/home/user/apps/rdv-hello")
    assert.equal(first, second)
  })
})

test("buildAppSeedScript rejects a boxAppDir containing a single quote", async () => {
  await withAppSource("a", "b", async localDir => {
    assert.throws(() => buildAppSeedScript(localDir, "/home/user/apps/rdv'hello"), /single quote/)
  })
})

test("buildAppSeedScript throws when the app source is missing APP.md", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rdv-app-seed-empty-"))
  try {
    assert.throws(() => buildAppSeedScript(dir, "/home/user/apps/rdv-hello"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
