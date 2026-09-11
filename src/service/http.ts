import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { TranscriptRecord } from "../daemon/records.ts"
import { env } from "../env.ts"
import type { Tier } from "../rooms/types.ts"
import { renderRoomNotFoundPage, renderRoomPage } from "../web/page.ts"
import type { RoomService } from "./room-service.ts"

/** The only record kinds the room web transcript renders (architecture.md
 *  §5.2's fan-out list, extended with the tier-3 richer view). */
const STREAM_KINDS: ReadonlySet<TranscriptRecord["kind"]> = new Set([
  "user-prompt",
  "text-delta",
  "thought",
  "tool-call",
  "tool-result",
  "turn-end",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key]
  return typeof v === "string" ? v : undefined
}

function isTier(value: unknown): value is Tier {
  return value === "messenger" || value === "email" || value === "room-web"
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
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

async function handleInboundSimulated(service: RoomService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  if (!isRecord(body)) {
    sendJson(res, 400, { error: "invalid_body" })
    return
  }
  const provider = stringField(body, "provider")
  const source = stringField(body, "source")
  const contactRef = stringField(body, "contactRef")
  const displayName = stringField(body, "displayName")
  const text = stringField(body, "text")
  const tier = body.tier
  if (
    provider === undefined ||
    source === undefined ||
    contactRef === undefined ||
    displayName === undefined ||
    text === undefined ||
    !isTier(tier)
  ) {
    sendJson(res, 400, { error: "invalid_body" })
    return
  }

  const outcome = await service.handleInbound({
    address: { provider, source, contactRef },
    displayName,
    tier,
    text,
  })
  sendJson(res, 200, outcome)
}

function handleGetRoom(service: RoomService, res: ServerResponse, encodedCode: string): void {
  const code = decodeURIComponent(encodedCode)
  const room = service.getRoom(code)
  if (room === undefined) {
    sendJson(res, 404, { error: "not_found" })
    return
  }
  sendJson(res, 200, room)
}

async function handleHealth(service: RoomService, res: ServerResponse): Promise<void> {
  const rooms = service.roomCount()
  const daemon = await service.daemonHealth()
  sendJson(res, 200, { status: "ok", rooms, daemon })
}

function handleRoomPage(service: RoomService, res: ServerResponse, encodedCode: string): void {
  const code = decodeURIComponent(encodedCode)
  const room = service.getRoom(code)
  if (room === undefined) {
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" })
    res.end(renderRoomNotFoundPage(code))
    return
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  res.end(renderRoomPage(room))
}

function parseSince(raw: string | null): number {
  if (raw === null) return 0
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

async function handleRoomStream(
  service: RoomService,
  req: IncomingMessage,
  res: ServerResponse,
  encodedCode: string,
  since: number,
): Promise<void> {
  const code = decodeURIComponent(encodedCode)
  const room = service.getRoom(code)
  if (room === undefined) {
    sendJson(res, 404, { error: "not_found" })
    return
  }
  if (room.sessionId === undefined) {
    sendJson(res, 409, { error: "no_session" })
    return
  }
  const sessionId = room.sessionId

  const controller = new AbortController()
  req.on("close", () => controller.abort())

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  // Node buffers headers until the first write() otherwise — an idle room
  // (nobody talking yet) would leave the browser's EventSource stuck
  // "connecting" forever instead of open-and-waiting.
  res.flushHeaders()

  try {
    for await (const record of service.events(sessionId, since, controller.signal)) {
      if (!STREAM_KINDS.has(record.kind)) continue
      res.write(`data: ${JSON.stringify(record)}\n\n`)
    }
  } catch {
    // Upstream closed, was aborted by the browser disconnecting, or the
    // daemon dropped the connection — either way the client's EventSource
    // reconnects from its own last-seen `since`, nothing to do here.
  } finally {
    res.end()
  }
}

async function handleRoomSend(
  service: RoomService,
  req: IncomingMessage,
  res: ServerResponse,
  encodedCode: string,
): Promise<void> {
  const code = decodeURIComponent(encodedCode)
  const body = await readJsonBody(req)
  if (!isRecord(body)) {
    sendJson(res, 400, { error: "invalid_body" })
    return
  }
  const displayName = stringField(body, "displayName")
  const text = stringField(body, "text")
  if (displayName === undefined || text === undefined || displayName.trim().length === 0 || text.trim().length === 0) {
    sendJson(res, 400, { error: "invalid_body" })
    return
  }

  const outcome = await service.sendFromRoomWeb(code, displayName, text)
  if (outcome.kind === "unknown-code") {
    sendJson(res, 404, { error: "not_found" })
    return
  }
  if (outcome.kind === "no-session") {
    sendJson(res, 409, { error: "no_session" })
    return
  }
  sendJson(res, 200, outcome.result)
}

async function handle(service: RoomService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1")

  if (url.pathname === "/health" && req.method === "GET") {
    await handleHealth(service, res)
    return
  }

  if (url.pathname === "/inbound/simulated" && req.method === "POST") {
    await handleInboundSimulated(service, req, res)
    return
  }

  const pageMatch = /^\/r\/([^/]+)$/.exec(url.pathname)
  if (pageMatch !== null && req.method === "GET") {
    const encodedCode = pageMatch[1]
    if (encodedCode === undefined) {
      sendJson(res, 400, { error: "invalid_code" })
      return
    }
    handleRoomPage(service, res, encodedCode)
    return
  }

  const streamMatch = /^\/rooms\/([^/]+)\/stream$/.exec(url.pathname)
  if (streamMatch !== null && req.method === "GET") {
    const encodedCode = streamMatch[1]
    if (encodedCode === undefined) {
      sendJson(res, 400, { error: "invalid_code" })
      return
    }
    await handleRoomStream(service, req, res, encodedCode, parseSince(url.searchParams.get("since")))
    return
  }

  const sendMatch = /^\/rooms\/([^/]+)\/send$/.exec(url.pathname)
  if (sendMatch !== null && req.method === "POST") {
    const encodedCode = sendMatch[1]
    if (encodedCode === undefined) {
      sendJson(res, 400, { error: "invalid_code" })
      return
    }
    await handleRoomSend(service, req, res, encodedCode)
    return
  }

  const roomMatch = /^\/rooms\/([^/]+)$/.exec(url.pathname)
  if (roomMatch !== null && req.method === "GET") {
    const encodedCode = roomMatch[1]
    if (encodedCode === undefined) {
      sendJson(res, 400, { error: "invalid_code" })
      return
    }
    handleGetRoom(service, res, encodedCode)
    return
  }

  sendJson(res, 404, { error: "not_found" })
}

export function createHttpServer(service: RoomService): Server {
  return createServer((req, res) => {
    handle(service, req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error", message: error instanceof Error ? error.message : String(error) })
      }
    })
  })
}

export function startHttpServer(service: RoomService): Server {
  const server = createHttpServer(service)
  server.listen(env.port)
  return server
}
