import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { after, test } from "node:test"

// `env` (src/env.ts) reads `process.env` once at import time, so this must be
// set, and the module under test dynamically imported, before any static
// import elsewhere in the process chain could have already frozen it.
process.env.RDV_PUBLIC_URL = "https://rdv.example"
const { publicArtifactUrl, proxyArtifact } = await import("../../src/service/artifact-proxy.ts")

function isAddressInfo(value: string | AddressInfo | null): value is AddressInfo {
  return value !== null && typeof value === "object"
}

const upstreams: Server[] = []
const proxies: Server[] = []

after(async () => {
  await Promise.all(upstreams.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(proxies.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function startUpstream(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler)
  upstreams.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!isAddressInfo(address)) throw new Error("failed to bind upstream")
  return `http://127.0.0.1:${address.port}`
}

interface StartProxyOpts {
  artifactUrl: string | undefined
  prefix?: string
  timeoutMs?: number
}

/** Wires `proxyArtifact` behind a real HTTP server the same way `http.ts`
 *  would: strip the `/artifact` prefix off the incoming request into
 *  `subPath`/`search`, hand the rest to the module under test. */
async function startProxy(opts: StartProxyOpts): Promise<string> {
  const prefix = opts.prefix ?? "/artifact"
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const subPath = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname
    proxyArtifact(
      {
        artifactUrl: opts.artifactUrl,
        method: req.method,
        subPath,
        search: url.search,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      },
      res,
    ).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500)
      res.end(String(error))
    })
  })
  proxies.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!isAddressInfo(address)) throw new Error("failed to bind proxy")
  return `http://127.0.0.1:${address.port}`
}

test("publicArtifactUrl is the room-code-keyed URL, not the raw box URL", () => {
  assert.equal(publicArtifactUrl("RDV-7F3K"), "https://rdv.example/r/RDV-7F3K/artifact/")
})

test("proxies GET / to the upstream root, streaming the body and copying content-type", async () => {
  const upstreamUrl = await startUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
    res.end("hello from the box")
  })
  const proxyUrl = await startProxy({ artifactUrl: upstreamUrl })

  const res = await fetch(`${proxyUrl}/artifact/`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8")
  assert.equal(await res.text(), "hello from the box")
})

test("appends the request's sub-path to the artifact base URL", async () => {
  const upstreamUrl = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end(`path=${req.url}`)
  })
  const proxyUrl = await startProxy({ artifactUrl: upstreamUrl })

  const res = await fetch(`${proxyUrl}/artifact/deep/link.html`)
  assert.equal(await res.text(), "path=/deep/link.html")
})

test("preserves the request's query string on the upstream request", async () => {
  const upstreamUrl = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end(`path=${req.url}`)
  })
  const proxyUrl = await startProxy({ artifactUrl: upstreamUrl })

  const res = await fetch(`${proxyUrl}/artifact/page?foo=bar&baz=1`)
  assert.equal(await res.text(), "path=/page?foo=bar&baz=1")
})

test("copies cache headers through from the upstream response", async () => {
  const upstreamUrl = await startUpstream((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/css",
      "cache-control": "max-age=3600",
      etag: '"abc123"',
    })
    res.end("body {}")
  })
  const proxyUrl = await startProxy({ artifactUrl: upstreamUrl })

  const res = await fetch(`${proxyUrl}/artifact/style.css`)
  assert.equal(res.headers.get("cache-control"), "max-age=3600")
  assert.equal(res.headers.get("etag"), '"abc123"')
})

test("strips hop-by-hop headers from the upstream response", async () => {
  // "proxy-authenticate"/"trailer" are hop-by-hop headers Node's own http
  // server never adds on its own — unlike "connection"/"keep-alive", which
  // Node's server injects into every keep-alive response regardless of what
  // upstream sent, so they can't prove this module's own stripping.
  const upstreamUrl = await startUpstream((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/plain",
      "proxy-authenticate": "Basic",
      trailer: "x-checksum",
    })
    res.end("ok")
  })
  const proxyUrl = await startProxy({ artifactUrl: upstreamUrl })

  const res = await fetch(`${proxyUrl}/artifact/`)
  assert.equal(res.headers.get("content-type"), "text/plain")
  assert.equal(res.headers.get("proxy-authenticate"), null)
  assert.equal(res.headers.get("trailer"), null)
})

test("only proxies GET and HEAD; other methods are rejected without reaching the upstream", async () => {
  let upstreamHit = false
  const upstreamUrl = await startUpstream((_req, res) => {
    upstreamHit = true
    res.writeHead(200)
    res.end("should not be reached")
  })
  const proxyUrl = await startProxy({ artifactUrl: upstreamUrl })

  const res = await fetch(`${proxyUrl}/artifact/`, { method: "POST" })
  assert.equal(res.status, 405)
  assert.equal(upstreamHit, false)
})

test("a HEAD request proxies through with no body", async () => {
  const upstreamUrl = await startUpstream((req, res) => {
    if (req.method === "HEAD") {
      res.writeHead(200, { "content-type": "text/plain", "content-length": "5" })
      res.end()
      return
    }
    res.writeHead(200)
    res.end("hello")
  })
  const proxyUrl = await startProxy({ artifactUrl: upstreamUrl })

  const res = await fetch(`${proxyUrl}/artifact/`, { method: "HEAD" })
  assert.equal(res.status, 200)
  assert.equal(await res.text(), "")
})

test("does not follow an upstream redirect: the 3xx and its Location pass through as-is", async () => {
  const upstreamUrl = await startUpstream((req, res) => {
    res.writeHead(302, { location: `${req.headers.host ? "http://" + req.headers.host : ""}/elsewhere` })
    res.end()
  })
  const proxyUrl = await startProxy({ artifactUrl: upstreamUrl })

  const res = await fetch(`${proxyUrl}/artifact/`, { redirect: "manual" })
  assert.equal(res.status, 302)
  assert.ok(res.headers.get("location")?.endsWith("/elsewhere"))
})

test("returns a self-healing 503 page when the room has no artifactUrl yet", async () => {
  const proxyUrl = await startProxy({ artifactUrl: undefined })

  const res = await fetch(`${proxyUrl}/artifact/`)
  assert.equal(res.status, 503)
  assert.match(res.headers.get("content-type") ?? "", /text\/html/)
  const html = await res.text()
  assert.match(html, /refresh/i)
  assert.match(html, /not available yet/i)
})

test("returns the same self-healing 503 page when the upstream is unreachable", async () => {
  // A port nothing listens on (bound then immediately closed): connection
  // refused, not a timeout — proves the unreachable-upstream path shares the
  // missing-artifactUrl path's exact response shape, per the brief's "either
  // way, one page".
  const closed = createServer()
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve))
  const closedPort = (closed.address() as AddressInfo).port
  await new Promise<void>((resolve) => closed.close(() => resolve()))

  const proxyUrl = await startProxy({ artifactUrl: `http://127.0.0.1:${closedPort}` })
  const res = await fetch(`${proxyUrl}/artifact/`)
  assert.equal(res.status, 503)
  const html = await res.text()
  assert.match(html, /not available yet/i)
})

test("times out and self-heals when the upstream never responds", async () => {
  const upstreamUrl = await startUpstream((req, res) => {
    // Never call res.end() / res.writeHead(): the request just hangs.
    void req
    void res
  })
  const proxyUrl = await startProxy({ artifactUrl: upstreamUrl, timeoutMs: 100 })

  const res = await fetch(`${proxyUrl}/artifact/`)
  assert.equal(res.status, 503)
})
