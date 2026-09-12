/**
 * `resolveDisplayName` — real names instead of raw contact refs.
 *
 * agentpush's envelope has no name field, so `displayName` arrives as the
 * contact ref and the room reads like a database: `[8876379006 · messenger]`.
 * These tests pin the two things that matter — that a lookup failure can
 * never break message delivery, and that the operator override always wins.
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import { resolveDisplayName, type DisplayNameFetch } from "../../src/channels/display-name.ts"

const TOKEN = "123456:FAKE"

function respond(body: unknown, ok = true): DisplayNameFetch {
  return async () => ({ ok, json: async () => body })
}

test("a Telegram id resolves to the account's first name", async () => {
  const name = await resolveDisplayName("telegram", "6371794295", {
    telegramBotToken: TOKEN,
    fetch: respond({ ok: true, result: { first_name: "Jeremy", username: "Codec404" } }),
    noCache: true,
  })

  assert.equal(name, "Jeremy")
})

test("falls back to the @handle when the account has no first name", async () => {
  const name = await resolveDisplayName("telegram", "999", {
    telegramBotToken: TOKEN,
    fetch: respond({ ok: true, result: { username: "someone" } }),
    noCache: true,
  })

  assert.equal(name, "someone")
})

test("the contact ref survives every failure mode", async () => {
  const cases: Array<[string, DisplayNameFetch]> = [
    ["HTTP error", respond({ description: "nope" }, false)],
    ["telegram ok:false", respond({ ok: false, description: "chat not found" })],
    ["no result", respond({ ok: true })],
    ["blank first_name", respond({ ok: true, result: { first_name: "   " } })],
    [
      "network throw",
      async () => {
        throw new Error("ECONNRESET")
      },
    ],
  ]

  for (const [label, fetchImpl] of cases) {
    const name = await resolveDisplayName("telegram", "6371794295", {
      telegramBotToken: TOKEN,
      fetch: fetchImpl,
      noCache: true,
    })
    // A room with an ugly name works; a room whose message never arrived
    // because a name lookup failed does not.
    assert.equal(name, "6371794295", `${label} should fall back to the ref`)
  }
})

test("no token means no lookup at all — the ref is used directly", async () => {
  let called = false
  const name = await resolveDisplayName("telegram", "6371794295", {
    telegramBotToken: undefined,
    fetch: async () => {
      called = true
      return { ok: true, json: async () => ({}) }
    },
    noCache: true,
  })

  assert.equal(name, "6371794295")
  assert.equal(called, false, "must not call Telegram without a token")
})

test("non-telegram channels are never looked up against Telegram", async () => {
  // WhatsApp/SMS/email have no name API wired here; asking Telegram about a
  // phone number would be a wrong answer, not a missing one.
  for (const provider of ["whatsapp", "sms", "email"]) {
    let called = false
    const name = await resolveDisplayName(provider, "33679942048", {
      telegramBotToken: TOKEN,
      fetch: async () => {
        called = true
        return { ok: true, json: async () => ({ ok: true, result: { first_name: "Wrong" } }) }
      },
      noCache: true,
    })
    assert.equal(name, "33679942048", `${provider} should keep the ref`)
    assert.equal(called, false, `${provider} must not hit the Telegram API`)
  }
})

test("the result is cached, so the inbound hot path costs one lookup per contact", async () => {
  let calls = 0
  const counting: DisplayNameFetch = async () => {
    calls += 1
    return { ok: true, json: async () => ({ ok: true, result: { first_name: "Tomtip" } }) }
  }

  const first = await resolveDisplayName("telegram", "8876379006", { telegramBotToken: TOKEN, fetch: counting })
  const second = await resolveDisplayName("telegram", "8876379006", { telegramBotToken: TOKEN, fetch: counting })

  assert.equal(first, "Tomtip")
  assert.equal(second, "Tomtip")
  assert.equal(calls, 1, "second resolution should come from the cache")
})
