import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { test } from "node:test"
import { probeArtifact } from "../../src/sandbox/artifact.ts"
import { listeningPort } from "./support.ts"

async function withServer(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("failed to bind test server")
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
  }
}

test("probeArtifact reports alive on 200", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200)
      res.end("ok")
    },
    async url => {
      assert.equal(await probeArtifact(url), "alive")
    },
  )
})

test("probeArtifact reports alive on 404", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(404)
      res.end("not found")
    },
    async url => {
      assert.equal(await probeArtifact(url), "alive")
    },
  )
})

test("probeArtifact reports alive on a 3xx redirect status line", async () => {
  await withServer(
    (_req, res) => {
      // No Location header — fetch would otherwise try to follow it. Emitting
      // the raw status line is enough to exercise the `res.status < 500` check.
      res.writeHead(304)
      res.end()
    },
    async url => {
      assert.equal(await probeArtifact(url), "alive")
    },
  )
})

test("probeArtifact reports dead on 500", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(500)
      res.end("boom")
    },
    async url => {
      assert.equal(await probeArtifact(url), "dead")
    },
  )
})

test("probeArtifact reports dead on connection refused", async () => {
  // Bind and immediately close to get a port nothing is listening on.
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const port = listeningPort(server)
  await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))

  assert.equal(await probeArtifact(`http://127.0.0.1:${port}`), "dead")
})

test("probeArtifact reports dead on a timeout", async () => {
  await withServer(
    (_req, _res) => {
      // Never respond — the client's timeout must fire.
    },
    async url => {
      assert.equal(await probeArtifact(url, 100), "dead")
    },
  )
})
