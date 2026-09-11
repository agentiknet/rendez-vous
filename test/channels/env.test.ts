import assert from "node:assert/strict"
import { test } from "node:test"
import { loadEnv } from "../../src/env.ts"

test("agentpushUrl is undefined when not configured", () => {
  assert.equal(loadEnv({}).agentpushUrl, undefined)
})

test("agentpushUrl strips a trailing slash", () => {
  assert.equal(loadEnv({ RDV_AGENTPUSH_URL: "https://agentpush.example/" }).agentpushUrl, "https://agentpush.example")
})

test("agentpushUrl passes through a url with no trailing slash", () => {
  assert.equal(loadEnv({ RDV_AGENTPUSH_URL: "https://agentpush.example" }).agentpushUrl, "https://agentpush.example")
})

test("agentpushKey is undefined when not configured", () => {
  assert.equal(loadEnv({}).agentpushKey, undefined)
})

test("agentpushKey passes through verbatim", () => {
  assert.equal(loadEnv({ RDV_AGENTPUSH_KEY: "shh" }).agentpushKey, "shh")
})

test("agentpushWebhookSecret is undefined when not configured", () => {
  assert.equal(loadEnv({}).agentpushWebhookSecret, undefined)
})

test("agentpushWebhookSecret passes through verbatim", () => {
  assert.equal(loadEnv({ RDV_AGENTPUSH_WEBHOOK_SECRET: "topsecret" }).agentpushWebhookSecret, "topsecret")
})
