import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { MediaStore } from "../../src/service/media-store.ts"

const dirs: string[] = []

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-brief35-"))
  dirs.push(dir)
  return dir
}

function audioData(): Buffer {
  return Buffer.from("fake-ogg-opus-data")
}

test("extensionFor('audio/ogg') returns 'ogg'", async () => {
  const dir = await freshDir()
  const store = new MediaStore(dir)
  const record = await store.save("RDV-TEST", audioData(), { contentType: "audio/ogg", pages: 1 })

  assert.equal(record.contentType, "audio/ogg")
  const filePath = join(dir, "RDV-TEST", `${record.id}.ogg`)
  const onDisk = await readFile(filePath)
  assert.ok(onDisk.length > 0, "file must exist with .ogg extension")
})

test("extensionFor('application/x-unknown') returns 'bin'", async () => {
  const dir = await freshDir()
  const store = new MediaStore(dir)
  const record = await store.save("RDV-TEST", Buffer.from("unknown-data"), { contentType: "application/x-unknown", pages: 1 })

  const filePath = join(dir, "RDV-TEST", `${record.id}.bin`)
  const onDisk = await readFile(filePath)
  assert.ok(onDisk.length > 0, "unknown type must fall back to .bin extension")
})

test("round trip: save audio, read it back, bytes are identical", async () => {
  const dir = await freshDir()
  const store = new MediaStore(dir)
  const original = audioData()
  const record = await store.save("RDV-TEST", original, { contentType: "audio/ogg", pages: 1 })

  const readBack = await store.read("RDV-TEST", record.id)
  assert.ok(readBack !== undefined, "must be readable")
  assert.ok(readBack.equals(original), "read bytes must match saved bytes")
})