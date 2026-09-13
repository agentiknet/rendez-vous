/**
 * BRIEF-22: `RDV_DAEMON_TOKEN` is an override, not the source of truth for
 * the daemon's bearer — the source is the daemon's own `runtime.json`,
 * matched by `port`, never by which candidate path happened to exist or be
 * listed first. Every fixture here lives in a temp dir; the machine's real
 * `~/.agentproto/*` files are never read. Token values are fixtures too, but
 * are still never asserted by direct string comparison — a failed
 * `assert.equal` prints both sides, and the discipline of comparing by hash
 * is worth keeping even for values that aren't real secrets.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { portFromDaemonUrl, resolveDaemonToken } from "../../src/daemon/token.ts"

const dirs: string[] = []
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-token-"))
  dirs.push(dir)
  return dir
}

async function writeRuntimeFile(dir: string, name: string, content: { port: number; token: string }): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, JSON.stringify(content))
  return path
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

const FILE_TOKEN = "fixture-token-from-runtime-json"
const OVERRIDE_TOKEN = "fixture-token-from-env-override"

test("with no override and a runtime.json holding a token, the resolved token is the file's", async () => {
  const dir = await freshDir()
  const path = await writeRuntimeFile(dir, "runtime.json", { port: 18790, token: FILE_TOKEN })

  const resolution = resolveDaemonToken({ override: undefined, port: 18790, candidatePaths: [path] })

  assert.equal(resolution.ok, true)
  if (!resolution.ok) return
  assert.equal(hash(resolution.token), hash(FILE_TOKEN))
})

test("RDV_DAEMON_TOKEN wins over the file — both arms, not just the override-present one", async () => {
  const dir = await freshDir()
  const path = await writeRuntimeFile(dir, "runtime.json", { port: 18790, token: FILE_TOKEN })

  // Arm 1: override set alongside a file holding a DIFFERENT token — the
  // override must win. A resolver that always preferred the file (precedence
  // inverted) would return FILE_TOKEN here and this assertion would catch it.
  const withOverride = resolveDaemonToken({ override: OVERRIDE_TOKEN, port: 18790, candidatePaths: [path] })
  assert.equal(withOverride.ok, true)
  if (withOverride.ok) {
    assert.equal(hash(withOverride.token), hash(OVERRIDE_TOKEN))
    assert.notEqual(hash(withOverride.token), hash(FILE_TOKEN))
  }

  // Arm 2: override absent — falls through to the file, same as the
  // dedicated test above. Kept here so precedence is proven both directions
  // in one place: a resolver that ignored the override entirely (always file)
  // would pass Arm 2 alone but fail Arm 1.
  const withoutOverride = resolveDaemonToken({ override: undefined, port: 18790, candidatePaths: [path] })
  assert.equal(withoutOverride.ok, true)
  if (withoutOverride.ok) assert.equal(hash(withoutOverride.token), hash(FILE_TOKEN))
})

test("two runtime.json files at different ports — the one matching the configured daemon port is chosen, regardless of list order", async () => {
  const dir = await freshDir()
  const stalePath = await writeRuntimeFile(dir, "stale-runtime.json", { port: 11111, token: "fixture-token-WRONG-daemon" })
  const livePath = await writeRuntimeFile(dir, "live-runtime.json", { port: 22222, token: "fixture-token-RIGHT-daemon" })

  // The stale (wrong-port) file listed FIRST — a resolver that picked by
  // path/list precedence instead of the port field would return the wrong
  // token here.
  const resolution = resolveDaemonToken({ override: undefined, port: 22222, candidatePaths: [stalePath, livePath] })
  assert.equal(resolution.ok, true)
  if (!resolution.ok) return
  assert.equal(hash(resolution.token), hash("fixture-token-RIGHT-daemon"))
  assert.notEqual(hash(resolution.token), hash("fixture-token-WRONG-daemon"))

  // Same two files, reversed order — the answer must not depend on order at all.
  const reversed = resolveDaemonToken({ override: undefined, port: 22222, candidatePaths: [livePath, stalePath] })
  assert.equal(reversed.ok, true)
  if (reversed.ok) assert.equal(hash(reversed.token), hash("fixture-token-RIGHT-daemon"))
})

test("no override and no matching runtime.json — refuses, naming the candidate files and the port", async () => {
  const dir = await freshDir()
  const missingA = join(dir, "does-not-exist-a.json")
  const missingB = join(dir, "does-not-exist-b.json")

  const resolution = resolveDaemonToken({ override: undefined, port: 33333, candidatePaths: [missingA, missingB] })

  assert.equal(resolution.ok, false)
  if (resolution.ok) return
  assert.ok(resolution.message.includes("33333"), "the message names the port that was looked for")
  assert.ok(resolution.message.includes(missingA), "the message names the first candidate file")
  assert.ok(resolution.message.includes(missingB), "the message names the second candidate file")
})

test("a runtime.json that exists but whose port does not match is treated the same as absent", async () => {
  const dir = await freshDir()
  const wrongPortPath = await writeRuntimeFile(dir, "runtime.json", { port: 44444, token: "fixture-token-unreachable" })

  const resolution = resolveDaemonToken({ override: undefined, port: 55555, candidatePaths: [wrongPortPath] })

  assert.equal(resolution.ok, false)
  if (resolution.ok) return
  assert.ok(resolution.message.includes("55555"))
})

test("portFromDaemonUrl reads the explicit port off the configured daemon URL", () => {
  assert.equal(portFromDaemonUrl("http://127.0.0.1:18790"), 18790)
  assert.equal(portFromDaemonUrl("https://daemon.example:9443"), 9443)
})
