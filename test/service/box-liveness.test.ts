import assert from "node:assert/strict"
import { test } from "node:test"
import { isSandboxAlive } from "../../src/service/box-liveness.ts"

type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = Parameters<typeof fetch>[1]

function fakeFetch(handler: (url: string, init: FetchInit) => Response): typeof fetch {
  return async (input: FetchInput, init: FetchInit) => handler(String(input), init)
}

test("isSandboxAlive returns 'alive' for a running sandbox, sending the api key as X-API-Key and never in a URL/query", async () => {
  let seenUrl: string | undefined
  let seenHeaders: NonNullable<FetchInit>["headers"]
  const fetchImpl = fakeFetch((url, init) => {
    seenUrl = url
    seenHeaders = init?.headers
    return new Response(JSON.stringify({ sandboxID: "box-1", state: "running" }), { status: 200 })
  })

  const result = await isSandboxAlive("box-1", { apiKey: "secret-key", fetchImpl })
  assert.equal(result, "alive")
  assert.equal(seenUrl, "https://api.e2b.dev/sandboxes/box-1")
  assert.ok(!seenUrl?.includes("secret-key"), "the api key must never appear in the URL")
  assert.ok(isRecordOfStrings(seenHeaders))
  if (!isRecordOfStrings(seenHeaders)) return
  assert.equal(seenHeaders["X-API-Key"], "secret-key")
})

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

test("isSandboxAlive returns 'alive' when the response has no state field at all", async () => {
  const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ sandboxID: "box-1" }), { status: 200 }))
  const result = await isSandboxAlive("box-1", { apiKey: "k", fetchImpl })
  assert.equal(result, "alive")
})

test("isSandboxAlive returns 'paused' for a sandbox whose state is paused", async () => {
  const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ sandboxID: "box-1", state: "paused" }), { status: 200 }))
  const result = await isSandboxAlive("box-1", { apiKey: "k", fetchImpl })
  assert.equal(result, "paused")
})

test("isSandboxAlive returns 'gone' on a 404", async () => {
  const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ message: "sandbox not found" }), { status: 404 }))
  const result = await isSandboxAlive("box-missing", { apiKey: "k", fetchImpl })
  assert.equal(result, "gone")
})

test("isSandboxAlive returns 'gone' for a 200 response whose own body says not found", async () => {
  const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ message: "Sandbox Not Found" }), { status: 200 }))
  const result = await isSandboxAlive("box-1", { apiKey: "k", fetchImpl })
  assert.equal(result, "gone")
})

test("isSandboxAlive returns 'unknown', not 'gone', on a network error — treating unknown as gone would boot a fresh box on top of one that's fine", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("ECONNREFUSED")
  }
  const result = await isSandboxAlive("box-1", { apiKey: "k", fetchImpl })
  assert.equal(result, "unknown")
})

test("isSandboxAlive returns 'unknown' on a timeout, well within the 5s default budget when overridden", async () => {
  const fetchImpl: typeof fetch = (_input: FetchInput, init: FetchInit) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
    })
  }
  const result = await isSandboxAlive("box-1", { apiKey: "k", fetchImpl, timeoutMs: 20 })
  assert.equal(result, "unknown")
})

test("isSandboxAlive returns 'unknown' for a non-2xx, non-404 response", async () => {
  const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ error: "internal" }), { status: 500 }))
  const result = await isSandboxAlive("box-1", { apiKey: "k", fetchImpl })
  assert.equal(result, "unknown")
})

test("isSandboxAlive returns 'unknown' for an unrecognized state value, rather than guessing", async () => {
  const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ state: "hibernating" }), { status: 200 }))
  const result = await isSandboxAlive("box-1", { apiKey: "k", fetchImpl })
  assert.equal(result, "unknown")
})

test("isSandboxAlive returns 'unknown' when no api key is available anywhere", async () => {
  const fetchImpl = fakeFetch(() => {
    throw new Error("must not be called without a key")
  })
  const result = await isSandboxAlive("box-1", { apiKey: "", fetchImpl })
  assert.equal(result, "unknown")
})
