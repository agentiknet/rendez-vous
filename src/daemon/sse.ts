/**
 * Iterate `data:` frames of an SSE body. Handles multi-line `data:` fields,
 * ignores comments (`: keep-alive`) and other field names. Ends when the
 * server closes or the caller breaks out of the loop (which cancels the
 * reader and closes the socket).
 */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let dataLines: string[] = []
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl = buffer.indexOf("\n")
      while (nl !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "")
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf("\n")
        if (line === "") {
          if (dataLines.length > 0) {
            yield dataLines.join("\n")
            dataLines = []
          }
          continue
        }
        if (line.startsWith(":")) continue
        const colon = line.indexOf(":")
        const field = colon === -1 ? line : line.slice(0, colon)
        if (field !== "data") continue
        const rawValue = colon === -1 ? "" : line.slice(colon + 1)
        dataLines.push(rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue)
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}
