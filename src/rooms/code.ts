import { randomInt } from "node:crypto"

/** No I, O, 0, 1 — every remaining glyph reads unambiguously out loud or on a phone screen. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const CODE_LENGTH = 4
const PREFIX = "RDV-"

function pickChar(random: (() => number) | undefined): string {
  const index = random ? Math.floor(random() * ALPHABET.length) : randomInt(ALPHABET.length)
  const char = ALPHABET[index]
  if (char === undefined) {
    throw new Error(`code alphabet index out of range: ${index}`)
  }
  return char
}

export function generateCode(random?: () => number): string {
  let suffix = ""
  for (let i = 0; i < CODE_LENGTH; i++) {
    suffix += pickChar(random)
  }
  return PREFIX + suffix
}

export function normalizeCode(input: string): string | undefined {
  const trimmed = input.trim().toUpperCase()
  const body = trimmed.startsWith(PREFIX)
    ? trimmed.slice(PREFIX.length)
    : trimmed.startsWith("RDV")
      ? trimmed.slice(3)
      : trimmed

  if (body.length !== CODE_LENGTH) return undefined
  for (const char of body) {
    if (!ALPHABET.includes(char)) return undefined
  }
  return PREFIX + body
}
