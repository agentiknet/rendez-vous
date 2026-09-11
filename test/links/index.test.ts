import assert from "node:assert/strict"
import { test } from "node:test"
import { joinLinks, qrPng, qrSvg } from "../../src/links/index.ts"

const BASE_OPTS = {
  publicUrl: "https://rdv.example.com",
  whatsappNumber: "15551234567",
  telegramBot: "rdv_bot",
}

test("joinLinks builds the web link from publicUrl and normalized code", () => {
  const links = joinLinks("RDV-7F3K", BASE_OPTS)
  assert.equal(links.web, "https://rdv.example.com/r/RDV-7F3K")
})

test("joinLinks normalizes a lowercase, dashless code across every surface", () => {
  const links = joinLinks("rdv7f3k", BASE_OPTS)
  assert.equal(links.web, "https://rdv.example.com/r/RDV-7F3K")
  assert.equal(links.whatsapp, "https://wa.me/15551234567?text=join%20RDV-7F3K")
  assert.equal(links.telegram, "https://t.me/rdv_bot?start=RDV-7F3K")
})

test("joinLinks builds the whatsapp deep link with digits-only number and encoded text", () => {
  const links = joinLinks("RDV-7F3K", BASE_OPTS)
  assert.equal(links.whatsapp, "https://wa.me/15551234567?text=join%20RDV-7F3K")
})

test("joinLinks builds the telegram deep link with the bot username", () => {
  const links = joinLinks("RDV-7F3K", BASE_OPTS)
  assert.equal(links.telegram, "https://t.me/rdv_bot?start=RDV-7F3K")
})

test("joinLinks leaves whatsapp undefined when no number is configured", () => {
  const links = joinLinks("RDV-7F3K", { ...BASE_OPTS, whatsappNumber: undefined })
  assert.equal(links.whatsapp, undefined)
  assert.equal(links.web, "https://rdv.example.com/r/RDV-7F3K")
})

test("joinLinks leaves telegram undefined when no bot is configured", () => {
  const links = joinLinks("RDV-7F3K", { ...BASE_OPTS, telegramBot: undefined })
  assert.equal(links.telegram, undefined)
  assert.equal(links.web, "https://rdv.example.com/r/RDV-7F3K")
})

test("joinLinks throws on an invalid code", () => {
  assert.throws(() => joinLinks("not-a-code", BASE_OPTS))
  assert.throws(() => joinLinks("", BASE_OPTS))
})

test("qrSvg produces a well-formed, deterministic svg with a quiet zone", () => {
  const first = qrSvg("https://rdv.example.com/r/RDV-7F3K")
  const second = qrSvg("https://rdv.example.com/r/RDV-7F3K")
  assert.ok(first.startsWith("<svg"))
  assert.match(first, /viewBox="0 0 \d+ \d+"/)
  assert.ok(first.endsWith("</svg>"))
  assert.equal(first, second)
})

test("qrSvg differs for two different codes", () => {
  const a = qrSvg("https://rdv.example.com/r/RDV-7F3K")
  const b = qrSvg("https://rdv.example.com/r/RDV-8G4M")
  assert.notEqual(a, b)
})

test("qrPng produces PNG bytes with a valid signature, IHDR and IEND", async () => {
  const bytes = await qrPng("https://rdv.example.com/r/RDV-7F3K")
  const buf = Buffer.from(bytes)
  assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])

  const ihdrIndex = buf.indexOf("IHDR")
  assert.ok(ihdrIndex > 0)
  const width = buf.readUInt32BE(ihdrIndex + 4)
  const height = buf.readUInt32BE(ihdrIndex + 8)
  assert.ok(width > 0)
  assert.ok(height > 0)
  assert.equal(width, height)

  const iendIndex = buf.indexOf("IEND")
  assert.ok(iendIndex > ihdrIndex)
})

test("qrPng is deterministic and differs for two different codes", async () => {
  const first = await qrPng("https://rdv.example.com/r/RDV-7F3K")
  const second = await qrPng("https://rdv.example.com/r/RDV-7F3K")
  assert.deepEqual(Buffer.from(first), Buffer.from(second))

  const third = await qrPng("https://rdv.example.com/r/RDV-8G4M")
  assert.notDeepEqual(Buffer.from(first), Buffer.from(third))
})
