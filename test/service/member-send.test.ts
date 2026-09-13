import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"

/** Files allowed to call the transport's send family on a member. The
 *  helper's push arm IS the send; the delivery engine is the other side of
 *  the accept path. Everywhere else is a bypass waiting to happen — the
 *  original bug was exactly one: `room-service.ts` and `reader.ts` called
 *  `this.transport.send(...)` directly, bypassing the DeliveryEngine and
 *  the outbox, and every pull member's mail fell into the console fallback
 *  and was printed to stdout instead of ever being delivered. */
const ALLOWED = new Set(["member-send.ts", "delivery.ts", "transports.ts", "outbound.ts"])

const PATTERN = /transport\.(send|sendAttachment|sendMedia)\(/

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(path)))
    else if (entry.name.endsWith(".ts")) files.push(path)
  }
  return files
}

test("no transport.send call survives outside the member-send helper (brief 07)", async () => {
  const files = await walk(new URL("../../src", import.meta.url).pathname)
  assert.ok(files.length > 0)
  const offenders: string[] = []
  for (const file of files) {
    if (!ALLOWED.has(file.split("/").pop() ?? "")) {
      const source = await readFile(file, "utf8")
      if (PATTERN.test(source)) offenders.push(file)
    }
  }
  assert.deepEqual(offenders, [], `direct transport sends outside the helper: ${offenders.join(", ")}`)
})