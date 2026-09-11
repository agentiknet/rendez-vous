import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { test } from "node:test"
import { AgentpushTransport } from "../../src/channels/agentpush/outbound.ts"
import type { Member } from "../../src/rooms/types.ts"

interface CapturedRequest {
  method: string | undefined
  path: string
  authorization: string | undefined
  body: unknown
}

interface FakeAgentpush {
  url: string
  requests: CapturedRequest[]
  respondWith: (status: number) => void
  close: () => Promise<void>
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString("utf8")
  return text.length > 0 ? JSON.parse(text) : undefined
}

async function startFakeAgentpush(): Promise<FakeAgentpush> {
  const requests: CapturedRequest[] = []
  let status = 200

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const body = await readBody(req)
      requests.push({
        method: req.method,
        path: req.url ?? "",
        authorization: req.headers.authorization,
        body,
      })
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: status < 300 }))
    })()
  })

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address")
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    respondWith: (next: number) => {
      status = next
    },
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
  }
}

function whatsappMember(): Member {
  return {
    id: "mem_1",
    displayName: "Alice",
    tier: "messenger",
    address: { provider: "whatsapp", source: "whatsapp", contactRef: "+15551234567" },
    joinedAt: new Date().toISOString(),
  }
}

function roomWebMember(): Member {
  return {
    id: "mem_2",
    displayName: "Chloe",
    tier: "room-web",
    address: { provider: "room-web", source: "room-web", contactRef: "browser-1" },
    joinedAt: new Date().toISOString(),
  }
}

test("send posts the path, bearer auth header and JSON body for a whatsapp member", async () => {
  const fake = await startFakeAgentpush()
  try {
    const transport = new AgentpushTransport({ baseUrl: fake.url, apiKey: "test-key" })
    await transport.send(whatsappMember(), { text: "hello room", artifactUrl: undefined })

    assert.equal(fake.requests.length, 1)
    const req = fake.requests[0]
    assert.ok(req)
    assert.equal(req.method, "POST")
    assert.equal(req.path, "/send_message")
    assert.equal(req.authorization, "Bearer test-key")
    assert.deepEqual(req.body, {
      to: { channel: "whatsapp", address: "+15551234567" },
      content: { text: "hello room" },
    })
  } finally {
    await fake.close()
  }
})

test("send is a no-op for a room-web member", async () => {
  const fake = await startFakeAgentpush()
  try {
    const transport = new AgentpushTransport({ baseUrl: fake.url, apiKey: "test-key" })
    await transport.send(roomWebMember(), { text: "hello room", artifactUrl: undefined })
    assert.equal(fake.requests.length, 0)
  } finally {
    await fake.close()
  }
})

test("a 500 from agentpush does not throw", async () => {
  const fake = await startFakeAgentpush()
  fake.respondWith(500)
  try {
    const transport = new AgentpushTransport({ baseUrl: fake.url, apiKey: "test-key" })
    await assert.doesNotReject(transport.send(whatsappMember(), { text: "hi", artifactUrl: undefined }))
    assert.equal(fake.requests.length, 1)
  } finally {
    await fake.close()
  }
})

test("a connection failure does not throw", async () => {
  const transport = new AgentpushTransport({ baseUrl: "http://127.0.0.1:1", apiKey: "test-key" })
  await assert.doesNotReject(transport.send(whatsappMember(), { text: "hi", artifactUrl: undefined }))
})

test("sendMedia sends the caption as text and never surfaces the png bytes as an error", async () => {
  const fake = await startFakeAgentpush()
  try {
    const transport = new AgentpushTransport({ baseUrl: fake.url, apiKey: "test-key" })
    const png = Uint8Array.from([1, 2, 3])
    await transport.sendMedia(whatsappMember(), png, "join the room: https://rdv.example.com/r/RDV-7F3K")

    assert.equal(fake.requests.length, 1)
    const req = fake.requests[0]
    assert.ok(req)
    assert.deepEqual(req.body, {
      to: { channel: "whatsapp", address: "+15551234567" },
      content: { text: "join the room: https://rdv.example.com/r/RDV-7F3K" },
    })
  } finally {
    await fake.close()
  }
})

test("sendMedia is a no-op for a room-web member", async () => {
  const fake = await startFakeAgentpush()
  try {
    const transport = new AgentpushTransport({ baseUrl: fake.url, apiKey: "test-key" })
    await transport.sendMedia(roomWebMember(), Uint8Array.from([1]), "caption")
    assert.equal(fake.requests.length, 0)
  } finally {
    await fake.close()
  }
})

test("no apiKey configured omits the authorization header", async () => {
  const fake = await startFakeAgentpush()
  try {
    const transport = new AgentpushTransport({ baseUrl: fake.url, apiKey: undefined })
    await transport.send(whatsappMember(), { text: "hi", artifactUrl: undefined })
    const req = fake.requests[0]
    assert.ok(req)
    assert.equal(req.authorization, undefined)
  } finally {
    await fake.close()
  }
})
