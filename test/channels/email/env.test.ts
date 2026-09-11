import assert from "node:assert/strict"
import { test } from "node:test"
import { loadEnv } from "../../../src/env.ts"

test("emailWebhookSecret is undefined when not configured", () => {
  assert.equal(loadEnv({}).emailWebhookSecret, undefined)
})

test("emailWebhookSecret passes through verbatim", () => {
  assert.equal(loadEnv({ RDV_EMAIL_WEBHOOK_SECRET: "whsec_mail_123" }).emailWebhookSecret, "whsec_mail_123")
})

test("emailWebhookSecret is independent from agentpushWebhookSecret", () => {
  const env = loadEnv({
    RDV_AGENTPUSH_WEBHOOK_SECRET: "messenger-secret",
    RDV_EMAIL_WEBHOOK_SECRET: "mail-secret",
  })
  assert.equal(env.agentpushWebhookSecret, "messenger-secret")
  assert.equal(env.emailWebhookSecret, "mail-secret")
})
