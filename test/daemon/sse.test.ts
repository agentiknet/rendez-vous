import assert from "node:assert/strict"
import { test } from "node:test"
import { sseData } from "../../src/daemon/sse.ts"

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = []
  for await (const data of sseData(stream)) out.push(data)
  return out
}

test("sseData yields one frame per data field", async () => {
  const frames = await collect(streamFromChunks(['data: {"a":1}\n\n', 'data: {"a":2}\n\n']))
  assert.deepEqual(frames, ['{"a":1}', '{"a":2}'])
})

test("sseData joins multi-line data fields with newlines", async () => {
  const frames = await collect(streamFromChunks(["data: line one\ndata: line two\n\n"]))
  assert.deepEqual(frames, ["line one\nline two"])
})

test("sseData ignores comment lines", () => {
  return collect(streamFromChunks([": keep-alive\n\ndata: hello\n\n"])).then(frames => {
    assert.deepEqual(frames, ["hello"])
  })
})

test("sseData ignores non-data fields", async () => {
  const frames = await collect(streamFromChunks(["event: ping\nid: 1\ndata: hello\n\n"]))
  assert.deepEqual(frames, ["hello"])
})

test("sseData handles a frame split across multiple chunks", async () => {
  const frames = await collect(streamFromChunks(["data: hel", "lo wor", "ld\n\n"]))
  assert.deepEqual(frames, ["hello world"])
})

test("sseData handles a data field split at the field boundary", async () => {
  const frames = await collect(streamFromChunks(["dat", "a: hello\n", "\n"]))
  assert.deepEqual(frames, ["hello"])
})

test("sseData strips exactly one leading space after the colon", async () => {
  const frames = await collect(streamFromChunks(["data:  hello\n\n"]))
  assert.deepEqual(frames, [" hello"])
})

test("sseData yields nothing for a stream with no data frames", async () => {
  const frames = await collect(streamFromChunks([": keep-alive\n\n", ": keep-alive\n\n"]))
  assert.deepEqual(frames, [])
})
