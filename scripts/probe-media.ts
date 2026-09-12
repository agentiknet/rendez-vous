/**
 * Ground-truth probe for the media chain, against the REAL Telegram and
 * OpenAI APIs — the part unit tests deliberately cannot cover.
 *
 * Each leg is proven separately, because each fails differently:
 *
 *   1. TTS   — text in, playable audio bytes out.
 *   2. STT   — those same bytes back in, text out. A round trip, so the
 *              assertion does not depend on a fixture nobody can regenerate.
 *   3. Vision — a real image in, a description out.
 *
 * Usage: RDV_OPENAI_API_KEY=… node scripts/probe-media.ts [image-path]
 *
 * Prints what it did and exits non-zero on the first failure. No room, no
 * sandbox, no e2b boot — this costs an API call, not a box.
 */

import { writeFile } from "node:fs/promises"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { env } from "../src/env.ts"
import { OpenAiSttProvider, OpenAiTtsProvider, OpenAiVisionProvider } from "../src/media/openai.ts"

function fail(message: string): never {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

const apiKey = env.openaiApiKey
if (apiKey === undefined) fail("RDV_OPENAI_API_KEY is not set — nothing to probe")

const SPOKEN = "The Lisbon offsite is in March and the budget is twelve thousand euros."

async function main(): Promise<void> {
  console.log("1/3 TTS — rendering speech…")
  const tts = new OpenAiTtsProvider(apiKey)
  const spoken = await tts.speak(SPOKEN)
  if (spoken === undefined) fail("TTS returned nothing")
  console.log(`    ok: ${spoken.bytes.byteLength} bytes of ${spoken.mime}`)
  const outPath = join(tmpdir(), `rdv-probe-tts.${spoken.extension}`)
  await writeFile(outPath, spoken.bytes)
  console.log(`    wrote ${outPath}`)

  console.log("2/3 STT — transcribing those same bytes back…")
  const stt = new OpenAiSttProvider(apiKey)
  const transcript = await stt.transcribe(spoken.bytes, spoken.mime)
  if (transcript === undefined) fail("STT returned nothing")
  console.log(`    ok: "${transcript}"`)
  // Loose on purpose: a transcript is not a string comparison. Two content
  // words surviving the round trip is what proves the chain, not exact words.
  const lowered = transcript.toLowerCase()
  const hits = ["lisbon", "march", "budget", "twelve", "12"].filter((word) => lowered.includes(word))
  if (hits.length < 2) fail(`transcript lost the content (matched only ${JSON.stringify(hits)})`)
  console.log(`    content survived the round trip: ${JSON.stringify(hits)}`)

  const imagePath = process.argv[2]
  if (imagePath === undefined) {
    console.log("3/3 vision — skipped (pass an image path to include it)")
    return
  }
  console.log(`3/3 vision — describing ${imagePath}…`)
  const bytes = new Uint8Array(await readFile(imagePath))
  const vision = new OpenAiVisionProvider(apiKey)
  const caption = await vision.caption(bytes, imagePath.endsWith(".png") ? "image/png" : "image/jpeg")
  if (caption === undefined) fail("vision returned nothing")
  console.log(`    ok: "${caption.slice(0, 300)}"`)

  console.log("\nALL LEGS PASS")
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error))
})
