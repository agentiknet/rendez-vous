import assert from "node:assert/strict"
import { test } from "node:test"
import { loadEnv } from "../../src/env.ts"

test("whatsappNumber is undefined when not configured", () => {
  const env = loadEnv({})
  assert.equal(env.whatsappNumber, undefined)
})

test("whatsappNumber strips a leading + and keeps digits", () => {
  const env = loadEnv({ RDV_WHATSAPP_NUMBER: "+1 555 123 4567".replaceAll(" ", "") })
  assert.equal(env.whatsappNumber, "15551234567")
})

test("whatsappNumber accepts digits without a leading +", () => {
  const env = loadEnv({ RDV_WHATSAPP_NUMBER: "15551234567" })
  assert.equal(env.whatsappNumber, "15551234567")
})

test("whatsappNumber rejects non-digit characters", () => {
  assert.throws(() => loadEnv({ RDV_WHATSAPP_NUMBER: "+1 555 123 4567" }))
  assert.throws(() => loadEnv({ RDV_WHATSAPP_NUMBER: "abc123" }))
})

test("telegramBot is undefined when not configured", () => {
  const env = loadEnv({})
  assert.equal(env.telegramBot, undefined)
})

test("telegramBot strips a leading @", () => {
  const env = loadEnv({ RDV_TELEGRAM_BOT: "@rdv_bot" })
  assert.equal(env.telegramBot, "rdv_bot")
})

test("telegramBot accepts a bare username without @", () => {
  const env = loadEnv({ RDV_TELEGRAM_BOT: "rdv_bot" })
  assert.equal(env.telegramBot, "rdv_bot")
})
