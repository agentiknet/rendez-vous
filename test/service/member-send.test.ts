import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { RoomStore } from "../../src/rooms/store.ts"
import { DeliveryEngine } from "../../src/service/delivery.ts"
import { MemberSender } from "../../src/service/member-send.ts"
import { MemoryTransport } from "../../src/service/transports.ts"

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

/** Torn down once, after the file — not in a per-test `finally`. The store
 *  persists asynchronously, so an immediate `rm` races its own writes and
 *  throws ENOTEMPTY out of the cleanup while the assertions themselves pass:
 *  a green test reported red for a reason that has nothing to do with what it
 *  asserts. Same pattern as `test/fanout/reader.test.ts`. */
const dirs: string[] = []
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

test("BRIEF-20: an outbound to a push member carries the room's slug and not its code; a pull member's outbox record carries neither", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rdv-member-send-"))
  dirs.push(dir)
  const store = await RoomStore.open(dir)
  const room = await store.create()
  const push = await store.addMember(room.code, {
    displayName: "Alice",
    tier: "messenger",
    address: { provider: "whatsapp", source: "agentpush", contactRef: "+1" },
  })
  const pull = await store.addMember(room.code, {
    displayName: "Chloe",
    tier: "room-web",
    address: { provider: "room-web", source: "room-web", contactRef: "chloe" },
  })

  const transport = new MemoryTransport()
  // `autoDrain: false` is the actual fix, not tidiness. `accept` kicks
  // `void this.drain(code)` deliberately off the critical path
  // (`delivery.ts`), so `send` resolves while a background drain is still
  // writing to `dir`; the teardown's `rm` then races a `.tmp` the store is
  // mid-write and throws ENOTEMPTY — failing a test whose every assertion
  // passed. This test reads the record and the direct push send; neither
  // needs a drain, and the option exists for exactly this.
  const engine = new DeliveryEngine({ store, transport, autoDrain: false })
  const sender = new MemberSender({ store, transport, engine })

  await sender.send(room.code, push, { text: "hello room", artifactUrl: undefined })
  await sender.send(room.code, pull, { text: "hello room", artifactUrl: undefined })

  assert.equal(transport.sends[0]?.message.text, `hello room\n[${room.slug}]`, "a push send must carry the room's slug")
  assert.ok(!transport.sends[0]?.message.text.includes(room.code), "a push send must NOT carry the room's join code (BRIEF-20)")

  const record = store.get(room.code)?.deliveries?.find((delivery) => delivery.memberId === pull.id)
  assert.ok(record !== undefined)
  assert.equal(
    record.text,
    "hello room",
    "the room-web page already shows the code — a pull member's own outbox record must not duplicate it",
  )
})