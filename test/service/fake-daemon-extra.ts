/**
 * Wraps the M2 fake daemon (test/daemon/fake-daemon.ts) with two routes it
 * doesn't have and RoomService needs: `GET /sessions/:id` (liveness, for
 * `LocalBooter.resume`) and `GET /sessions/:id/events/stream` (SSE, for
 * `RoomFanout`). Everything else proxies straight through to the wrapped
 * instance so health/spawnAgent/prompt/kill keep their real M2 behaviour
 * (including the busy/queue simulation), without editing that file.
 */
import { Agent, createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http"
import { startFakeDaemon, type FakeDaemon, type FakeDaemonOptions } from "../daemon/fake-daemon.ts"

/** Never keep a socket to the wrapped daemon alive: without this, idle
 *  keep-alive connections left over from proxied requests make `inner.close()`
 *  hang waiting for sockets that are never going to close themselves. */
const proxyAgent = new Agent({ keepAlive: false })

export interface FanoutRecordLike {
  seq: number
  kind: string
  text?: string
  reason?: string
}

export interface ExtendedFakeDaemon {
  readonly url: string
  readonly requestsReceived: { readonly path: string; readonly body: unknown }[]
  pushRecord(sessionId: string, record: FanoutRecordLike): void
  /** Number of live `GET /sessions/:id/events/stream` connections currently held open for this session. */
  subscriberCount(sessionId: string): number
  close(): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key]
  return typeof v === "string" ? v : undefined
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

export async function startExtendedFakeDaemon(opts: FakeDaemonOptions = {}): Promise<ExtendedFakeDaemon> {
  const inner: FakeDaemon = await startFakeDaemon(opts)
  const aliveSessions = new Set<string>()
  const history = new Map<string, FanoutRecordLike[]>()
  const subscribers = new Map<string, Set<ServerResponse>>()

  function historyFor(sessionId: string): FanoutRecordLike[] {
    const existing = history.get(sessionId)
    if (existing !== undefined) return existing
    const created: FanoutRecordLike[] = []
    history.set(sessionId, created)
    return created
  }

  function subscribersFor(sessionId: string): Set<ServerResponse> {
    const existing = subscribers.get(sessionId)
    if (existing !== undefined) return existing
    const created = new Set<ServerResponse>()
    subscribers.set(sessionId, created)
    return created
  }

  function pushRecord(sessionId: string, record: FanoutRecordLike): void {
    historyFor(sessionId).push(record)
    const frame = `data: ${JSON.stringify(record)}\n\n`
    for (const res of subscribersFor(sessionId)) {
      res.write(frame)
    }
  }

  function proxy(req: IncomingMessage, res: ServerResponse, path: string, search: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const chunks: Uint8Array[] = []
      req.on("data", (chunk: Uint8Array) => chunks.push(chunk))
      req.on("error", reject)
      req.on("end", () => {
        const body = Buffer.concat(chunks)
        const headers: Record<string, string> = { connection: "close" }
        const contentType = req.headers["content-type"]
        const authorization = req.headers.authorization
        if (typeof contentType === "string") headers["content-type"] = contentType
        if (typeof authorization === "string") headers.authorization = authorization
        if (body.length > 0) headers["content-length"] = String(body.length)

        const target = new URL(`${path}${search}`, inner.url)
        const proxyReq = httpRequest(
          target,
          { method: req.method ?? "GET", headers, agent: proxyAgent },
          (proxyRes) => {
            const responseChunks: Uint8Array[] = []
            proxyRes.on("data", (chunk: Uint8Array) => responseChunks.push(chunk))
            proxyRes.on("error", reject)
            proxyRes.on("end", () => {
              const text = Buffer.concat(responseChunks).toString("utf8")
              const status = proxyRes.statusCode ?? 500

              if (path === "/sessions/agent" && req.method === "POST" && status < 300) {
                const parsed: unknown = text.length > 0 ? JSON.parse(text) : undefined
                if (isRecord(parsed)) {
                  const id = stringField(parsed, "id")
                  if (id !== undefined) aliveSessions.add(id)
                }
              }
              const forgetMatch = /^\/sessions\/([^/]+)$/.exec(path)
              // `POST /sessions/:id/kill` is the route that actually ends a
              // session (real `agentSession.close()`, per DAEMON-NOTES.md);
              // `DELETE /sessions/:id` only forgets the daemon's bookkeeping
              // row. Both are treated as "gone" here so a test can simulate
              // either an ordinary `RoomService.doPause` (which calls kill)
              // or a direct, out-of-band kill (Rehearsal Run 1, Finding 2) —
              // same daemon-side effect on `GET /sessions/:id` either way.
              const killMatch = /^\/sessions\/([^/]+)\/kill$/.exec(path)
              const deadSessionId =
                forgetMatch !== null && req.method === "DELETE" && status < 300
                  ? forgetMatch[1]
                  : killMatch !== null && req.method === "POST" && status < 300
                    ? killMatch[1]
                    : undefined
              if (deadSessionId !== undefined) {
                aliveSessions.delete(deadSessionId)
                for (const subscriber of subscribersFor(deadSessionId)) subscriber.end()
                subscribers.delete(deadSessionId)
                history.delete(deadSessionId)
              }

              const responseContentType = proxyRes.headers["content-type"]
              res.writeHead(status, { "content-type": typeof responseContentType === "string" ? responseContentType : "application/json" })
              res.end(text)
              resolve()
            })
          },
        )
        proxyReq.on("error", reject)
        if (body.length > 0) proxyReq.write(body)
        proxyReq.end()
      })
    })
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const path = url.pathname

    const aliveMatch = /^\/sessions\/([^/]+)$/.exec(path)
    if (aliveMatch !== null && req.method === "GET") {
      const id = aliveMatch[1]
      if (id !== undefined && aliveSessions.has(id)) {
        sendJson(res, 200, { id, status: "running" })
      } else {
        sendJson(res, 404, { error: "not_found" })
      }
      return
    }

    const streamMatch = /^\/sessions\/([^/]+)\/events\/stream$/.exec(path)
    if (streamMatch !== null && req.method === "GET") {
      const id = streamMatch[1]
      if (id === undefined) {
        sendJson(res, 400, { error: "bad_request" })
        return
      }
      const since = Number.parseInt(url.searchParams.get("since") ?? "0", 10)
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })
      for (const record of historyFor(id)) {
        if (record.seq > since) {
          res.write(`data: ${JSON.stringify(record)}\n\n`)
        }
      }
      subscribersFor(id).add(res)
      req.on("close", () => {
        subscribersFor(id).delete(res)
      })
      return
    }

    await proxy(req, res, path, url.search)
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "fake_daemon_extra_error", message: error instanceof Error ? error.message : String(error) })
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("failed to bind extended fake daemon")

  return {
    url: `http://127.0.0.1:${address.port}`,
    requestsReceived: inner.requestsReceived,
    pushRecord,
    subscriberCount: (sessionId: string) => subscribersFor(sessionId).size,
    close: async () => {
      for (const set of subscribers.values()) {
        for (const res of set) res.end()
      }
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
      await inner.close()
    },
  }
}
