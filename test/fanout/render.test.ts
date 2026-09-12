import assert from "node:assert/strict"
import { test } from "node:test"
import { renderForTier } from "../../src/fanout/render.ts"

test("room-web is never rendered, regardless of artifact state", () => {
  assert.equal(renderForTier("room-web", "hello", "https://x.test", true), undefined)
  assert.equal(renderForTier("room-web", "hello", undefined, false), undefined)
})

test("messenger omits the artifact url when unchanged", () => {
  const message = renderForTier("messenger", "hello there", "https://x.test", false)
  assert.equal(message?.text, "hello there")
  assert.equal(message?.artifactUrl, "https://x.test")
})

test("messenger appends the artifact url on its own line when changed", () => {
  const message = renderForTier("messenger", "hello there", "https://x.test", true)
  assert.equal(message?.text, "hello there\nhttps://x.test")
})

test("messenger appends nothing when artifactChanged is true but there is no url", () => {
  const message = renderForTier("messenger", "hello there", undefined, true)
  assert.equal(message?.text, "hello there")
})

test("messenger collapses 3+ newlines to 2 and trims outer whitespace", () => {
  const message = renderForTier("messenger", "  a\n\n\n\nb  ", undefined, false)
  assert.equal(message?.text, "a\n\nb")
})

test("messenger leaves two newlines alone", () => {
  const message = renderForTier("messenger", "a\n\nb", undefined, false)
  assert.equal(message?.text, "a\n\nb")
})

test("messenger caps at 1500 chars total, ellipsis included", () => {
  const long = "x".repeat(2000)
  const message = renderForTier("messenger", long, undefined, false)
  assert.equal(message?.text.length, 1500)
  assert.ok(message?.text.endsWith("…"))
})

test("messenger leaves text under the cap untouched", () => {
  const short = "x".repeat(100)
  const message = renderForTier("messenger", short, undefined, false)
  assert.equal(message?.text, short)
})

test("email renders a digest with a Room update header and the body", () => {
  const message = renderForTier("email", "the body", undefined, false)
  assert.equal(message?.text, "Room update\n\nthe body")
})

test("email always includes the artifact link when present, regardless of artifactChanged", () => {
  const unchanged = renderForTier("email", "the body", "https://x.test", false)
  const changed = renderForTier("email", "the body", "https://x.test", true)
  assert.equal(unchanged?.text, "Room update\n\nthe body\n\nhttps://x.test")
  assert.equal(changed?.text, "Room update\n\nthe body\n\nhttps://x.test")
})

test("messenger renders an already-resolved whisper marker line like any other text", () => {
  const message = renderForTier("messenger", "broadcast part\n(the agent whispered to Alice)", undefined, false)
  assert.equal(message?.text, "broadcast part\n(the agent whispered to Alice)")
})

test("email renders an already-resolved private whisper body inside the digest", () => {
  const message = renderForTier("email", "(private) the actual private text", undefined, false)
  assert.equal(message?.text, "Room update\n\n(private) the actual private text")
})

test("email omits the artifact link when there is no url", () => {
  const message = renderForTier("email", "the body", undefined, true)
  assert.equal(message?.text, "Room update\n\nthe body")
})
