import assert from "node:assert/strict"
import { test } from "node:test"
import type { OutboundMessage, Transport } from "../../src/fanout/types.ts"
import type { Member } from "../../src/rooms/types.ts"
import { CompositeTransport, hasSendMedia, MemoryTransport, type RecordedSend } from "../../src/service/transports.ts"

class PlainTransport implements Transport {
  readonly sends: RecordedSend[] = []

  async send(member: Member, message: OutboundMessage): Promise<void> {
    this.sends.push({ member, message })
  }
}

function member(displayName: string, provider: string): Member {
  return {
    id: `${provider}:${displayName}`,
    displayName,
    tier: provider === "whatsapp" || provider === "telegram" ? "messenger" : "room-web",
    address: { provider, source: provider, contactRef: displayName.toLowerCase() },
    joinedAt: "2026-09-11T00:00:00.000Z",
  }
}

test("hasSendMedia is true for a transport with a real sendMedia method, false otherwise", () => {
  assert.equal(hasSendMedia(new MemoryTransport()), true)
  assert.equal(hasSendMedia(new PlainTransport()), false)
})

test("CompositeTransport.send routes whatsapp, telegram and sms to the messenger transport, everything else to the fallback, when no email transport is configured", async () => {
  const messenger = new MemoryTransport()
  const fallback = new MemoryTransport()
  const composite = new CompositeTransport(messenger, fallback)

  const message: OutboundMessage = { text: "hi", artifactUrl: undefined }
  await composite.send(member("Alice", "whatsapp"), message)
  await composite.send(member("Bob", "telegram"), message)
  await composite.send(member("Sam", "sms"), message)
  await composite.send(member("Chloe", "room-web"), message)
  await composite.send(member("Dana", "email"), message)

  assert.deepEqual(
    messenger.sends.map((s) => s.member.displayName),
    ["Alice", "Bob", "Sam"],
  )
  assert.deepEqual(
    fallback.sends.map((s) => s.member.displayName),
    ["Chloe", "Dana"],
  )
})

test("CompositeTransport.send routes email to the email transport when one is configured", async () => {
  const messenger = new MemoryTransport()
  const fallback = new MemoryTransport()
  const email = new MemoryTransport()
  const composite = new CompositeTransport(messenger, fallback, email)

  const message: OutboundMessage = { text: "hi", artifactUrl: undefined }
  await composite.send(member("Dana", "email"), message)
  await composite.send(member("Chloe", "room-web"), message)

  assert.deepEqual(
    email.sends.map((s) => s.member.displayName),
    ["Dana"],
  )
  assert.deepEqual(
    fallback.sends.map((s) => s.member.displayName),
    ["Chloe"],
  )
})

test("CompositeTransport.sendMedia delegates to whichever side handled the send, when it supports media", async () => {
  const inner = new MemoryTransport()
  const fallback = new MemoryTransport()
  const composite = new CompositeTransport(inner, fallback)

  const png = new Uint8Array([1, 2, 3])
  await composite.sendMedia(member("Alice", "whatsapp"), png, "caption for Alice")
  await composite.sendMedia(member("Chloe", "room-web"), png, "caption for Chloe")

  assert.equal(inner.mediaSends.length, 1)
  assert.equal(inner.mediaSends[0]?.member.displayName, "Alice")
  assert.equal(fallback.mediaSends.length, 1)
  assert.equal(fallback.mediaSends[0]?.member.displayName, "Chloe")
})

test("CompositeTransport.sendMedia falls back to a caption-only text send when the routed side has no media support", async () => {
  const inner = new PlainTransport()
  const fallback = new PlainTransport()
  const composite = new CompositeTransport(inner, fallback)

  const png = new Uint8Array([1, 2, 3])
  await composite.sendMedia(member("Alice", "whatsapp"), png, "scan to join")

  assert.equal(inner.sends.length, 1)
  assert.equal(inner.sends[0]?.message.text, "scan to join")
})
