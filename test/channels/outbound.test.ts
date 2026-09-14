import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { test } from "node:test"
import { AgentpushTransport } from "../../src/channels/agentpush/outbound.ts"
import { SendBlockedError } from "../../src/fanout/types.ts"
import type { Member } from "../../src/rooms/types.ts"

// Fixture endpoints/bodies mirror the real agentpush REST contract
// ground-truthed in docs/AGENTPUSH.md: `POST /tools/send_message`
// (packages/tools/src/tools/send-message.ts:198-250) and
// `POST /tools/upload_media` (packages/tools/src/tools/upload-media.ts:47-64),
// both dispatched through apps/api/src/app.ts:984-1051.

interface CapturedRequest {
  method: string | undefined
  path: string
  authorization: string | undefined
  body: unknown
}

interface FakeAgentpush {
  url: string
  requests: CapturedRequest[]
  respondWith: (status: number, body?: unknown) => void
  respondOnce: (status: number, body: unknown) => void
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
  let defaultBody: unknown = { status: "sent", message_id: "msg_1" }
  const queue: { status: number; body: unknown }[] = []

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const body = await readBody(req)
      requests.push({
        method: req.method,
        path: req.url ?? "",
        authorization: req.headers.authorization,
        body,
      })
      const next = queue.shift()
      const outStatus = next?.status ?? status
      const outBody = next?.body ?? defaultBody
      res.writeHead(outStatus, { "content-type": "application/json" })
      res.end(JSON.stringify(outBody))
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
    respondWith: (next: number, body?: unknown) => {
      status = next
      if (body !== undefined) defaultBody = body
    },
    respondOnce: (next: number, body: unknown) => {
      queue.push({ status: next, body })
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

function telegramMember(): Member {
  return {
    id: "mem_3",
    displayName: "Bob",
    tier: "messenger",
    address: { provider: "telegram", source: "telegram", contactRef: "123456789" },
    joinedAt: new Date().toISOString(),
  }
}

function smsMember(): Member {
  return {
    id: "mem_4",
    displayName: "Dana",
    tier: "messenger",
    address: { provider: "sms", source: "sms", contactRef: "+15559876543" },
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

test("send posts /tools/send_message with the bearer auth header and the real body shape", async () => {
  const fake = await startFakeAgentpush()
  try {
    const transport = new AgentpushTransport({ baseUrl: fake.url, apiKey: "apk_test" })
    await transport.send(whatsappMember(), { text: "hello room", artifactUrl: undefined })

    assert.equal(fake.requests.length, 1)
    const req = fake.requests[0]
    assert.ok(req)
    assert.equal(req.method, "POST")
    assert.equal(req.path, "/tools/send_message")
    assert.equal(req.authorization, "Bearer apk_test")
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
    const transport = new AgentpushTransport({ baseUrl: fake.url, apiKey: "apk_test" })
    await transport.send(roomWebMember(), { text: "hello room", artifactUrl: undefined })
    assert.equal(fake.requests.length, 0)
  } finally {
    await fake.close()
  }
})

test("a policy-blocked send (HTTP 200, status: blocked) throws SendBlockedError with blocked_reason verbatim", async () => {
  const fake = await startFakeAgentpush()
  fake.respondWith(200, { status: "blocked", blocked_reason: "opted_out", suggestion: "do not resend" })
  try {
    const transport = new AgentpushTransport({ baseUrl: fake.url, apiKey: "apk_test" })
    await assert.rejects(
      transport.send(whatsappMember(), { text: "hi", artifactUrl: undefined }),
      (error: unknown) => error instanceof SendBlockedError && error.blockedReason === "opted_out",
    )
    assert.equal(fake.requests.length, 1)
  } finally {
    await fake.close()
  }
})

test("a 500 from agentpush throws so the delivery engine retries", async () => {
  const fake = await startFakeAgentpush()
  fake.respondWith(500, { error: "internal" })
  try {
    const transport = new AgentpushTransport({ baseUrl: fake.url, apiKey: "apk_test" })
    await assert.rejects(transport.send(whatsappMember(), { text: "hi", artifactUrl: undefined }))
    assert.equal(fake.requests.length, 1)
  } finally {
    await fake.close()
  }
})

test("a connection failure throws so the delivery engine retries", async () => {
  const transport = new AgentpushTransport({ baseUrl: "http://127.0.0.1:1", apiKey: "apk_test" })
  await assert.rejects(transport.send(whatsappMember(), { text: "hi", artifactUrl: undefined }))
})

test("sendMedia uploads the png then sends it as media for a whatsapp member", async () => {
  const fake = await startFakeAgentpush()
  fake.respondOnce(201, { media_id: "media_abc" })
  fake.respondOnce(200, { status: "sent", message_id: "msg_2" })
  try {
    const transport = new AgentpushTransport({ baseUrl: fake.url, apiKey: "apk_test" })
    const png = Uint8Array.from([1, 2, 3])
    await transport.sendMedia(whatsappMember(), png, "join the room: https://rdv.example.com/r/RDV-7F3K")

    assert.equal(fake.requests.length, 2)
    const upload = fake.requests[0]
    assert.ok(upload)
    assert.equal(upload.path, "/tools/upload_media")
    assert.deepEqual(upload.body, {
      channel: "whatsapp",
      type: "image",
      data: Buffer.from(png).toString("base64"),
      filename: "qr.png",
      mimeType: "image/png",
    })

    const send = fake.requests[1]
    assert.ok(send)
    assert.equal(send.path, "/tools/send_message")
    assert.deepEqual(send.body, {
      to: { channel: "whatsapp", address: "+15551234567" },
      content: {
        text: "join the room: https://rdv.example.com/r/RDV-7F3K",
        media: [
          {
            type: "image",
            providerMediaId: "media_abc",
            caption: "join the room: https://rdv.example.com/r/RDV-7F3K",
          },
        ],
      },
    })
  } finally {
    await fake.close()
  }
})

test("send posts /tools/send_message with channel: sms for an sms member (docs/AGENTPUSH.md §9.2)", async () => {
  const fake = await startFakeAgentpush()
  try {
    const transport = new AgentpushTransport({ baseUrl: fake.url, apiKey: "apk_test" })
    await transport.send(smsMember(), { text: "hello from sms", artifactUrl: undefined })

    assert.equal(fake.requests.length, 1)
    const req = fake.requests[0]
    assert.ok(req)
    assert.equal(req.path, "/tools/send_message")
    assert.deepEqual(req.body, {
      to: { channel: "sms", address: "+15559876543" },
      content: { text: "hello from sms" },
    })
  } finally {
    await fake.close()
  }
})

test("sendMedia is unconditionally caption-only for sms — Twilio's driver declares media: false (docs/AGENTPUSH.md §9.4)", async () => {
  const fake = await startFakeAgentpush()
  try {
    const transport = new AgentpushTransport({ baseUrl: fake.url, apiKey: "apk_test" })
    const png = Uint8Array.from([1, 2, 3])
    await transport.sendMedia(smsMember(), png, "join the room: https://rdv.example.com/r/RDV-7F3K")

    assert.equal(fake.requests.length, 1)
    const req = fake.requests[0]
    assert.ok(req)
    assert.equal(req.path, "/tools/send_message")
    assert.deepEqual(req.body, {
      to: { channel: "sms", address: "+15559876543" },
      content: { text: "join the room: https://rdv.example.com/r/RDV-7F3K" },
    })
  } finally {
    await fake.close()
  }
})

test("sendMedia actually sends the image to telegram when the bytes have a public URL", async () => {
  // Telegram's driver has no buffer/base64 upload path — it can send media
  // only by public URL. Publishing the bytes first (publicMediaUrl, served
  // by GET /r/:code/media/:id) is therefore the difference between a QR
  // arriving and a "scan this" with nothing to scan.
  const fake = await startFakeAgentpush()
  try {
    const transport = new AgentpushTransport({ baseUrl: fake.url, apiKey: "apk_test" })
    const png = Uint8Array.from([1, 2, 3])
    const url = "https://rdv.example.com/r/RDV-7F3K/media/abc-123"
    await transport.sendMedia(telegramMember(), png, "Scan to join RDV-7F3K", url)

    assert.equal(fake.requests.length, 1, "no upload_media call — telegram has no upload path")
    const req = fake.requests[0]
    assert.ok(req)
    assert.equal(req.path, "/tools/send_message")
    assert.deepEqual(req.body, {
      to: { channel: "telegram", address: "123456789" },
      content: {
        text: "Scan to join RDV-7F3K",
        media: [{ type: "image", url, caption: "Scan to join RDV-7F3K" }],
      },
    })
  } finally {
    await fake.close()
  }
})

test("sendMedia falls back to a caption-only send for telegram when there is no public URL", async () => {
  const fake = await startFakeAgentpush()
  try {
    const transport = new AgentpushTransport({ baseUrl: fake.url, apiKey: "apk_test" })
    const png = Uint8Array.from([1, 2, 3])
    await transport.sendMedia(telegramMember(), png, "join the room: https://rdv.example.com/r/RDV-7F3K")

    assert.equal(fake.requests.length, 1)
    const req = fake.requests[0]
    assert.ok(req)
    assert.equal(req.path, "/tools/send_message")
    assert.deepEqual(req.body, {
      to: { channel: "telegram", address: "123456789" },
      content: { text: "join the room: https://rdv.example.com/r/RDV-7F3K" },
    })
  } finally {
    await fake.close()
  }
})

test("sendMedia falls back to a caption-only send when the whatsapp upload fails", async () => {
  const fake = await startFakeAgentpush()
  fake.respondOnce(500, { error: "upload failed" })
  fake.respondOnce(200, { status: "sent", message_id: "msg_3" })
  try {
    const transport = new AgentpushTransport({ baseUrl: fake.url, apiKey: "apk_test" })
    await transport.sendMedia(whatsappMember(), Uint8Array.from([1]), "caption with a link")

    assert.equal(fake.requests.length, 2)
    const send = fake.requests[1]
    assert.ok(send)
    assert.equal(send.path, "/tools/send_message")
    assert.deepEqual(send.body, {
      to: { channel: "whatsapp", address: "+15551234567" },
      content: { text: "caption with a link" },
    })
  } finally {
    await fake.close()
  }
})

test("sendMedia is a no-op for a room-web member", async () => {
  const fake = await startFakeAgentpush()
  try {
    const transport = new AgentpushTransport({ baseUrl: fake.url, apiKey: "apk_test" })
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
