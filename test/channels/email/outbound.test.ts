import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { test } from "node:test"
import { EmailTransport } from "../../../src/channels/email/outbound.ts"
import type { Member } from "../../../src/rooms/types.ts"

// Fixture endpoint/body mirrors the real agentpush contract ground-truthed
// in docs/AGENTPUSH.md §8: the same `POST /tools/send_message` the
// messenger tier uses, with `to.channel: "mail"` and mail-only `content`
// fields (packages/tools/src/tools/send-message.ts:33-97).

interface CapturedRequest {
  method: string | undefined
  path: string
  authorization: string | undefined
  body: unknown
}

interface FakeAgentpush {
  url: string
  requests: CapturedRequest[]
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
  const queue: { status: number; body: unknown }[] = []
  let defaultBody: unknown = { status: "sent", message_id: "gmail-msg-1" }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const body = await readBody(req)
      requests.push({ method: req.method, path: req.url ?? "", authorization: req.headers.authorization, body })
      const next = queue.shift()
      res.writeHead(next?.status ?? 200, { "content-type": "application/json" })
      res.end(JSON.stringify(next?.body ?? defaultBody))
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
    respondOnce: (status: number, body: unknown) => {
      queue.push({ status, body })
      if (queue.length === 1) defaultBody = body
    },
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
  }
}

function emailMember(source = "RDV-7F3K"): Member {
  return {
    id: "mem_1",
    displayName: "Alice",
    tier: "email",
    address: { provider: "email", source, contactRef: "alice@example.com" },
    joinedAt: new Date().toISOString(),
  }
}

function whatsappMember(): Member {
  return {
    id: "mem_2",
    displayName: "Bob",
    tier: "messenger",
    address: { provider: "whatsapp", source: "whatsapp", contactRef: "+15551234567" },
    joinedAt: new Date().toISOString(),
  }
}

test("send posts /tools/send_message with the bearer auth header, mail channel, subject and body", async () => {
  const fake = await startFakeAgentpush()
  try {
    const transport = new EmailTransport({ baseUrl: fake.url, apiKey: "apk_test" })
    await transport.send(emailMember(), { text: "Room update\n\nturn text here", artifactUrl: undefined })

    assert.equal(fake.requests.length, 1)
    const req = fake.requests[0]
    assert.ok(req)
    assert.equal(req.method, "POST")
    assert.equal(req.path, "/tools/send_message")
    assert.equal(req.authorization, "Bearer apk_test")
    assert.deepEqual(req.body, {
      to: { channel: "mail", address: "alice@example.com" },
      content: { subject: "Room RDV-7F3K update", text: "Room update\n\nturn text here" },
    })
  } finally {
    await fake.close()
  }
})

test("subject falls back to a generic line when address.source is not a room code", async () => {
  const fake = await startFakeAgentpush()
  try {
    const transport = new EmailTransport({ baseUrl: fake.url, apiKey: "apk_test" })
    await transport.send(emailMember("not-a-code"), { text: "hi", artifactUrl: undefined })
    const req = fake.requests[0]
    assert.ok(req)
    assert.deepEqual(req.body, {
      to: { channel: "mail", address: "alice@example.com" },
      content: { subject: "Rendez-vous update", text: "hi" },
    })
  } finally {
    await fake.close()
  }
})

test("the artifact link is appended when not already present in the text", async () => {
  const fake = await startFakeAgentpush()
  try {
    const transport = new EmailTransport({ baseUrl: fake.url, apiKey: "apk_test" })
    await transport.send(emailMember(), { text: "turn text", artifactUrl: "https://rdv.example.com/r/RDV-7F3K" })
    const req = fake.requests[0]
    assert.ok(req)
    assert.deepEqual(req.body, {
      to: { channel: "mail", address: "alice@example.com" },
      content: { subject: "Room RDV-7F3K update", text: "turn text\n\nhttps://rdv.example.com/r/RDV-7F3K" },
    })
  } finally {
    await fake.close()
  }
})

test("the artifact link is not duplicated when render.ts already included it", async () => {
  const fake = await startFakeAgentpush()
  try {
    const transport = new EmailTransport({ baseUrl: fake.url, apiKey: "apk_test" })
    const text = "turn text\n\nhttps://rdv.example.com/r/RDV-7F3K"
    await transport.send(emailMember(), { text, artifactUrl: "https://rdv.example.com/r/RDV-7F3K" })
    const req = fake.requests[0]
    assert.ok(req)
    assert.deepEqual(req.body, {
      to: { channel: "mail", address: "alice@example.com" },
      content: { subject: "Room RDV-7F3K update", text },
    })
  } finally {
    await fake.close()
  }
})

test("the second send threads via reply_to_message_id from the first send's message id", async () => {
  const fake = await startFakeAgentpush()
  fake.respondOnce(200, { status: "sent", message_id: "gmail-msg-1" })
  fake.respondOnce(200, { status: "sent", message_id: "gmail-msg-2" })
  try {
    const transport = new EmailTransport({ baseUrl: fake.url, apiKey: "apk_test" })
    await transport.send(emailMember(), { text: "first turn", artifactUrl: undefined })
    await transport.send(emailMember(), { text: "second turn", artifactUrl: undefined })

    assert.equal(fake.requests.length, 2)
    const first = fake.requests[0]
    const second = fake.requests[1]
    assert.deepEqual(first, {
      method: "POST",
      path: "/tools/send_message",
      authorization: "Bearer apk_test",
      body: {
        to: { channel: "mail", address: "alice@example.com" },
        content: { subject: "Room RDV-7F3K update", text: "first turn" },
      },
    })
    assert.deepEqual(second, {
      method: "POST",
      path: "/tools/send_message",
      authorization: "Bearer apk_test",
      body: {
        to: { channel: "mail", address: "alice@example.com" },
        content: { subject: "Room RDV-7F3K update", text: "second turn", reply_to_message_id: "gmail-msg-1" },
      },
    })
  } finally {
    await fake.close()
  }
})

test("send is a no-op for a non-email member", async () => {
  const fake = await startFakeAgentpush()
  try {
    const transport = new EmailTransport({ baseUrl: fake.url, apiKey: "apk_test" })
    await transport.send(whatsappMember(), { text: "hi", artifactUrl: undefined })
    assert.equal(fake.requests.length, 0)
  } finally {
    await fake.close()
  }
})

test("a 500 from agentpush does not throw", async () => {
  const fake = await startFakeAgentpush()
  fake.respondOnce(500, { error: "internal" })
  try {
    const transport = new EmailTransport({ baseUrl: fake.url, apiKey: "apk_test" })
    await assert.doesNotReject(transport.send(emailMember(), { text: "hi", artifactUrl: undefined }))
    assert.equal(fake.requests.length, 1)
  } finally {
    await fake.close()
  }
})

test("a connection failure does not throw", async () => {
  const transport = new EmailTransport({ baseUrl: "http://127.0.0.1:1", apiKey: "apk_test" })
  await assert.doesNotReject(transport.send(emailMember(), { text: "hi", artifactUrl: undefined }))
})
