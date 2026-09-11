import assert from "node:assert/strict"
import { test } from "node:test"
import { generateCode, normalizeCode } from "../../src/rooms/code.ts"

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const FORBIDDEN = ["I", "O", "0", "1"]

test("generateCode produces RDV-XXXX from the unambiguous alphabet", () => {
  for (let i = 0; i < 200; i++) {
    const code = generateCode()
    assert.match(code, /^RDV-[A-Z0-9]{4}$/)
    const suffix = code.slice(4)
    for (const char of suffix) {
      assert.ok(ALPHABET.includes(char), `unexpected char ${char} in ${code}`)
    }
    for (const forbidden of FORBIDDEN) {
      assert.ok(!suffix.includes(forbidden), `forbidden char ${forbidden} in ${code}`)
    }
  }
})

test("generateCode uses the injected random source deterministically", () => {
  const values = [0, 0.25, 0.5, 0.75]
  let index = 0
  const random = () => {
    const value = values[index] ?? 0
    index += 1
    return value
  }
  const code = generateCode(random)
  assert.equal(code, "RDV-AJS2")
})

test("normalizeCode accepts lowercase with dash", () => {
  assert.equal(normalizeCode("rdv-7f3k"), "RDV-7F3K")
})

test("normalizeCode accepts uppercase without dash", () => {
  assert.equal(normalizeCode("RDV7F3K"), "RDV-7F3K")
})

test("normalizeCode trims surrounding whitespace and accepts bare body", () => {
  assert.equal(normalizeCode(" 7f3k "), "RDV-7F3K")
})

test("normalizeCode rejects wrong length", () => {
  assert.equal(normalizeCode("RDV-7F3"), undefined)
  assert.equal(normalizeCode("RDV-7F3KK"), undefined)
})

test("normalizeCode rejects characters outside the alphabet", () => {
  assert.equal(normalizeCode("RDV-I0O1"), undefined)
})

test("normalizeCode rejects empty and garbage input", () => {
  assert.equal(normalizeCode(""), undefined)
  assert.equal(normalizeCode("hello there"), undefined)
})
