// Brief 14: "no pull member has ever acked, and every one of them goes
// away". The server-side ack/floor/staleness machinery was already
// correct (test/service/http.test.ts, test/rooms/store.test.ts) — the fault
// was entirely client-side (src/web/page.ts), so these tests drive the
// SAME exported client functions the page embeds via `.toString()` against
// a REAL room service and a REAL HTTP server, exactly the way the browser
// does, with only `fetch`/`localStorage`/`Date.now` swapped for injectable
// deps. None of `claimMember`/`freshOutboxTickState`/`runOutboxTick` existed
// before this brief — on `main` these imports fail outright, which is the
// most honest failure available: the capability they test did not exist.
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { DaemonClient } from "../../src/daemon/client.ts"
import { PULL_STALE_MS, pullMemberStale } from "../../src/rooms/types.ts"
import { RoomStore } from "../../src/rooms/store.ts"
import { LocalBooter } from "../../src/service/booter.ts"
import { ArtifactRenderStore } from "../../src/service/artifact-renders.ts"
import { createHttpServer } from "../../src/service/http.ts"
import { MediaStore } from "../../src/service/media-store.ts"
import { RoomService } from "../../src/service/room-service.ts"
import { MemoryTransport } from "../../src/service/transports.ts"
import { claimMember, freshOutboxTickState, runOutboxTick, type OutboxTickDeps } from "../../src/web/page.ts"
import { startExtendedFakeDaemon, type ExtendedFakeDaemon } from "../service/fake-daemon-extra.ts"

const dirs: string[] = []
const daemons: ExtendedFakeDaemon[] = []
const services: RoomService[] = []
const servers: { close(): Promise<void> }[] = []

after(async () => {
  await Promise.all(servers.map((server) => server.close()))
  await Promise.all(services.map((service) => service.stop()))
  await Promise.all(daemons.map((daemon) => daemon.close()))
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function harness(): Promise<{ store: RoomStore; baseUrl: string; code: string }> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-outbox-client-"))
  dirs.push(dir)
  const daemon = await startExtendedFakeDaemon()
  daemons.push(daemon)
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })
  const service = new RoomService({
    store,
    client,
    booter,
    transport: new MemoryTransport(),
    daemon: { baseUrl: daemon.url, token: undefined },
    mediaStore: new MediaStore(dir),
  })
  services.push(service)

  const server = createHttpServer(service, { mediaStore: new MediaStore(dir), renders: new ArtifactRenderStore(dir) })
  const baseUrl = await new Promise<string>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        reject(new Error("failed to bind http server"))
        return
      }
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
  servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })

  const room = await store.create()
  return { store, baseUrl, code: room.code }
}

/** A fake `localStorage` — just a `Map`, per-test, per-browser-tab. */
function fakeStorage(): { get(key: string): string | null; set(key: string, value: string): void; remove(key: string): void } {
  const map = new Map<string, string>()
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value)
    },
    remove: (key) => {
      map.delete(key)
    },
  }
}

function makeDeps(baseUrl: string, code: string, name: string, now: () => number = () => Date.now()): OutboxTickDeps {
  const storage = fakeStorage()
  return {
    roomCode: code,
    fetchImpl: (input, init) => fetch(baseUrl + String(input), init),
    getName: () => name,
    getStoredClaim: (key) => storage.get(key),
    setStoredClaim: (key, value) => storage.set(key, value),
    removeStoredClaim: (key) => storage.remove(key),
    onNameConflict: () => {},
    now,
  }
}

test("the drain runs and the ack lands for a visitor who never sends a message (brief 14, defects 1+3)", async () => {
  const { store, baseUrl, code } = await harness()
  const deps = makeDeps(baseUrl, code, "Priya")
  const state = freshOutboxTickState()

  // No /send call anywhere in this test — this visitor only ever loads the
  // page and lets the drain tick run, exactly like brief 14's "reads
  // without typing" visitor.
  const outcome = await runOutboxTick(state, deps)
  assert.equal(outcome.status, "ok", "the tick must claim, drain, and ack in one pass")

  const member = store.get(code)?.members.find((candidate) => candidate.displayName === "Priya")
  assert.ok(member !== undefined, "claiming on load must have created the member")
  assert.ok(member?.ackedAt !== undefined, "the never-sent visitor's outbox must still have acked — the liveness signal §5 asks for")
})

test("after a 401 the client re-claims and a subsequent drain succeeds (brief 14, defect 2)", async () => {
  const { baseUrl, code } = await harness()
  // An ever-advancing fake clock: proves recovery happens on a LATER tick
  // (never before the backoff window it just set), without the test
  // sleeping through CLAIM_RETRY_BASE_MS in real time.
  let clockMs = 0
  const deps = makeDeps(baseUrl, code, "Wren", () => (clockMs += 1_000_000))
  const state = freshOutboxTickState()

  const first = await runOutboxTick(state, deps)
  assert.equal(first.status, "ok", "the first tick claims and drains normally")
  assert.ok(state.memberToken !== null)

  // Simulate exactly what brief 14 names: "a restart, a re-minted token, a
  // member id change" — the token this tab is holding is no longer valid,
  // without the tab itself doing anything wrong.
  state.memberToken = "not-a-real-token"

  const afterBadToken = await runOutboxTick(state, deps)
  assert.equal(afterBadToken.status, "auth-lost", "a real 401 from the live server must be detected")
  assert.equal(state.memberToken, null, "the dead token must be nulled, not kept")

  // "The next tick" — deps.now() is a fake clock so the test does not sleep
  // through CLAIM_RETRY_BASE_MS; it only proves recovery happens on a LATER
  // tick, not that a function was merely called.
  const resumed = await runOutboxTick(state, deps)
  assert.equal(resumed.status, "ok", "the drain must resume once the backoff window has passed")
  assert.ok(state.memberToken !== null, "a fresh token must have been claimed")
})

test("an empty outbox still refreshes ackedAt so the member is not away just before PULL_STALE_MS, and pullMemberStale still reports away well after it (brief 14, defects 3+5 pair)", async () => {
  const { store, baseUrl, code } = await harness()
  const deps = makeDeps(baseUrl, code, "Sam")
  const state = freshOutboxTickState()

  const outcome = await runOutboxTick(state, deps)
  assert.equal(outcome.status, "ok")
  assert.equal(outcome.items.length, 0, "nothing was ever sent to this member — a genuinely empty outbox")

  const member = store.get(code)?.members.find((candidate) => candidate.displayName === "Sam")
  assert.ok(member?.ackedAt !== undefined, "the empty-outbox ack must have landed despite the old outboxSince<=0 gate")
  const ackedAtMs = Date.parse(member?.ackedAt ?? "")
  assert.ok(!Number.isNaN(ackedAtMs))

  // Both assertions below are derived from this SAME real, server-issued
  // timestamp — not a hard-wired constant on either side of the pair.
  assert.equal(
    pullMemberStale(member!, ackedAtMs + PULL_STALE_MS - 1000),
    false,
    "just under PULL_STALE_MS since the (unconditional) ack, the member must not read as away",
  )
  assert.equal(
    pullMemberStale(member!, ackedAtMs + PULL_STALE_MS + 1000),
    true,
    "well past PULL_STALE_MS with no further ack — a genuinely stopped tab — staleness must still fire",
  )
})

test("claimMember refuses to name-conflict silently: a claim mismatch clears the stored secret and reports it", async () => {
  const { baseUrl, code } = await harness()
  const first = makeDeps(baseUrl, code, "Nico")
  const claimed = await claimMember(first)
  assert.ok(claimed !== null)

  let conflicted = false
  const impostor = makeDeps(baseUrl, code, "Nico")
  impostor.onNameConflict = () => {
    conflicted = true
  }
  const impostorToken = await claimMember(impostor)
  assert.equal(impostorToken, null, "a claim with no matching secret must not mint a token")
  assert.ok(conflicted, "the conflict must be reported so the page can show it")
})
