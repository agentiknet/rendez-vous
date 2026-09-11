/**
 * Minimal stand-in for the three daemon routes DaemonClient drives, enough
 * to prove the client's request/response handling — including the
 * busy-session queue behaviour from docs/DAEMON-NOTES.md — without a real
 * agentproto daemon. Not a test file itself (no `*.test.ts` name), just a
 * helper the client tests import.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

export interface FakeDaemon {
  readonly url: string
  readonly requestsReceived: { readonly path: string; readonly body: unknown }[]
  close(): Promise<void>
}

export interface FakeDaemonOptions {
  readonly requireAuth?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  return text.length > 0 ? JSON.parse(text) : undefined
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

export async function startFakeDaemon(opts: FakeDaemonOptions = {}): Promise<FakeDaemon> {
  const busyBySession = new Map<string, boolean>()
  const queuePositionBySession = new Map<string, number>()
  const requestsReceived: { path: string; body: unknown }[] = []

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const path = url.pathname

    if (opts.requireAuth !== undefined && path.startsWith("/sessions") && req.method !== "GET") {
      const header = req.headers.authorization
      if (header !== `Bearer ${opts.requireAuth}`) {
        sendJson(res, 401, {
          error: "sessions_unauthorized",
          message: "Authorization: Bearer <token> required on mutating /sessions/* routes.",
        })
        return
      }
    }

    if (path === "/health" && req.method === "GET") {
      sendJson(res, 200, { status: "ok", version: "9.9.9", build: { sha: "deadbeef" } })
      return
    }

    if (path === "/sessions/agent" && req.method === "POST") {
      const body = await readBody(req)
      requestsReceived.push({ path, body })
      const sandboxRequested = isRecord(body) && body.sandbox !== undefined
      const appServeRequested = isRecord(body) && isRecord(body.appServe) ? body.appServe : undefined
      sendJson(res, 201, {
        id: "sess_fake",
        status: "running",
        ...(sandboxRequested ? { sandboxId: "sandbox_fake" } : {}),
        ...(appServeRequested !== undefined
          ? {
              appServe: {
                appId: "app_fake",
                dir: appServeRequested.dir,
                port: typeof appServeRequested.port === "number" ? appServeRequested.port : 3210,
                url: "https://fake-artifact.example",
                ready: true,
              },
            }
          : {}),
      })
      return
    }

    const promptMatch = path.match(/^\/sessions\/([^/]+)\/prompt$/)
    if (promptMatch !== null && req.method === "POST") {
      const sessionId = promptMatch[1]
      if (sessionId === undefined) {
        sendJson(res, 400, { error: "bad_request" })
        return
      }
      const body = await readBody(req)
      requestsReceived.push({ path, body })

      if (sessionId === "sess_missing") {
        sendJson(res, 404, { error: "send_prompt_failed", message: `no session "${sessionId}"` })
        return
      }
      if (sessionId === "sess_dead") {
        sendJson(res, 409, { error: "session_not_alive", status: "exited" })
        return
      }

      const queueRequested = isRecord(body) && body.queue === true
      const busy = busyBySession.get(sessionId) ?? false

      if (!busy) {
        busyBySession.set(sessionId, true)
        sendJson(res, 202, { ok: true, id: sessionId, queued: true })
        return
      }

      if (queueRequested) {
        const next = (queuePositionBySession.get(sessionId) ?? 0) + 1
        queuePositionBySession.set(sessionId, next)
        sendJson(res, 202, {
          ok: true,
          id: sessionId,
          queued: true,
          pending: true,
          queueId: `q_test${next}`,
          queuePosition: next,
        })
        return
      }

      sendJson(res, 409, {
        error: "send_prompt_failed",
        message: `enqueuePrompt: session "${sessionId}" is mid-turn — wait for it to finish or cancel`,
      })
      return
    }

    const killMatch = path.match(/^\/sessions\/([^/]+)\/kill$/)
    if (killMatch !== null && req.method === "POST") {
      requestsReceived.push({ path, body: undefined })
      sendJson(res, 200, { ok: true, sessionId: killMatch[1] })
      return
    }

    sendJson(res, 404, { error: "not_found" })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      sendJson(res, 500, { error: "fake_daemon_error", message: err instanceof Error ? err.message : String(err) })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("failed to bind fake daemon")

  return {
    url: `http://127.0.0.1:${address.port}`,
    requestsReceived,
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
  }
}
