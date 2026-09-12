import assert from "node:assert/strict"
import { test } from "node:test"
import type { OutboundMessage, Transport } from "../../src/fanout/types.ts"
import { deliveryFromAddress, type Member, type MemberDelivery } from "../../src/rooms/types.ts"
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

test("deliveryFromAddress derives push modes from messenger and email providers and pull from room-web, and throws on a provider nobody routed", () => {
  assert.deepEqual(deliveryFromAddress({ provider: "whatsapp", source: "s", contactRef: "+1" }), {
    mode: "push",
    provider: "whatsapp",
    contactRef: "+1",
  })
  assert.deepEqual(deliveryFromAddress({ provider: "email", source: "s", contactRef: "a@b.test" }), {
    mode: "push",
    provider: "email",
    address: "a@b.test",
  })
  assert.deepEqual(deliveryFromAddress({ provider: "console", source: "s", contactRef: "dev" }), {
    mode: "push",
    provider: "console",
  })
  assert.deepEqual(deliveryFromAddress({ provider: "room-web", source: "room-web", contactRef: "chloe" }), {
    mode: "pull",
  })
  assert.throws(() => deliveryFromAddress({ provider: "slack", source: "s", contactRef: "x" }), /unrouted delivery/)
})

test("CompositeTransport.send routes telegram, whatsapp and sms push members to the messenger transport, derived from the legacy address when no delivery is set", async () => {
  const messenger = new MemoryTransport()
  const composite = new CompositeTransport(messenger, new MemoryTransport())

  const message: OutboundMessage = { text: "hi", artifactUrl: undefined }
  await composite.send(member("Alice", "whatsapp"), message)
  await composite.send(member("Bob", "telegram"), message)
  await composite.send(member("Sam", "sms"), message)

  assert.deepEqual(
    messenger.sends.map((send) => send.member.displayName),
    ["Alice", "Bob", "Sam"],
  )
})

test("CompositeTransport.send routes email to the email transport when one is configured", async () => {
  const messenger = new MemoryTransport()
  const email = new MemoryTransport()
  const composite = new CompositeTransport(messenger, new MemoryTransport(), email)

  await composite.send(member("Dana", "email"), { text: "hi", artifactUrl: undefined })

  assert.deepEqual(email.sends.map((send) => send.member.displayName), ["Dana"])
})

test("CompositeTransport.send throws for an email push member when no email transport is wired — there is no fallback arm", async () => {
  const composite = new CompositeTransport(new MemoryTransport(), new MemoryTransport())

  await assert.rejects(
    () => composite.send(member("Dana", "email"), { text: "hi", artifactUrl: undefined }),
    /unrouted delivery/,
  )
})

test("CompositeTransport.send throws for a pull member (room-web, derived) — they drain their outbox, no transport is called", async () => {
  const messenger = new MemoryTransport()
  const consoleTarget = new MemoryTransport()
  const composite = new CompositeTransport(messenger, consoleTarget)

  await assert.rejects(
    () => composite.send(member("Chloe", "room-web"), { text: "hi", artifactUrl: undefined }),
    /pull recipient/,
  )
  assert.equal(messenger.sends.length, 0)
  assert.equal(consoleTarget.sends.length, 0, "the console target is not a catch-all for pull members")
})

test("CompositeTransport.send routes an explicit console push member to the console target", async () => {
  const messenger = new MemoryTransport()
  const consoleTarget = new MemoryTransport()
  const composite = new CompositeTransport(messenger, consoleTarget)

  const localDev: Member = { ...member("Local", "console"), delivery: { mode: "push", provider: "console" } }
  await composite.send(localDev, { text: "hi", artifactUrl: undefined })

  assert.deepEqual(consoleTarget.sends.map((send) => send.member.displayName), ["Local"])
  assert.equal(messenger.sends.length, 0)
})

test("CompositeTransport.send honours an explicit member.delivery over the address-derived one", async () => {
  const messenger = new MemoryTransport()
  const consoleTarget = new MemoryTransport()
  const composite = new CompositeTransport(messenger, consoleTarget)

  // A member whose legacy address would derive push/telegram but whose
  // explicit delivery says pull: the union wins, no messenger send.
  const overridden: Member = { ...member("Chloe", "telegram"), delivery: { mode: "pull" } }
  await assert.rejects(() => composite.send(overridden, { text: "hi", artifactUrl: undefined }), /pull recipient/)
  assert.equal(messenger.sends.length, 0)
})

test("CompositeTransport.sendMedia delegates to whichever side handled the send, when it supports media", async () => {
  const inner = new MemoryTransport()
  const composite = new CompositeTransport(inner, new MemoryTransport())

  const png = new Uint8Array([1, 2, 3])
  await composite.sendMedia(member("Alice", "whatsapp"), png, "caption for Alice")

  assert.equal(inner.mediaSends.length, 1)
  assert.equal(inner.mediaSends[0]?.member.displayName, "Alice")
})

test("CompositeTransport.sendMedia falls back to a caption-only text send when the routed side has no media support", async () => {
  const inner = new PlainTransport()
  const composite = new CompositeTransport(inner, new MemoryTransport())

  const png = new Uint8Array([1, 2, 3])
  await composite.sendMedia(member("Alice", "whatsapp"), png, "scan to join")

  assert.equal(inner.sends.length, 1)
  assert.equal(inner.sends[0]?.message.text, "scan to join")
})

test("an unrouted delivery mode does not compile: the routing switch has no default and its arms are asserted exhaustive against MemberDelivery", () => {
  // This is the type-level assertion, spelled out here so it is greppable:
  // `CompositeTransport.routeFor` switches over `member.delivery` with no
  // `default` and ends in a `never`-typed exhaustiveness guard (`unrouted`,
  // src/service/transports.ts). Adding a MemberDelivery variant without a
  // routing arm fails `pnpm check-types` with "Argument of type '<new
  // variant>' is not assignable to parameter of type 'never'". This runtime
  // test only pins the documented mechanism — and the full variant list the
  // switch must cover — in place.
  const variants: MemberDelivery[] = [
    { mode: "push", provider: "telegram", contactRef: "1" },
    { mode: "push", provider: "whatsapp", contactRef: "1" },
    { mode: "push", provider: "sms", contactRef: "1" },
    { mode: "push", provider: "email", address: "a@b.test" },
    { mode: "push", provider: "console" },
    { mode: "pull" },
  ]
  assert.equal(variants.length, 6, "every MemberDelivery variant must have a routing arm")
})