import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { env } from "../env.ts"
import type { Tier } from "../rooms/types.ts"
import type { RoomService } from "./room-service.ts"

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

async function handle(service: RoomService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1")

  if (url.pathname === "/inbound/simulated" && req.method === "POST") {
    await handleInboundSimulated(service, req, res)
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
