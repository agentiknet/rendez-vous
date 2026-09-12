import assert from "node:assert/strict"
import { test } from "node:test"
import { DaemonClient } from "../../src/daemon/client.ts"
import { attributeText, fanIn, parseAudienceDirective, type Sender } from "../../src/fanin/index.ts"
import { startFakeDaemon } from "../daemon/fake-daemon.ts"

const alice: Sender = { id: "member_alice", displayName: "Alice", tier: "messenger" }
const bob: Sender = { id: "member_bob", displayName: "Bob", tier: "email" }

test("attributeText prefixes displayName and tier", () => {
  assert.equal(attributeText(alice, "hello"), "[Alice · messenger] hello")
  assert.equal(attributeText(bob, "hi there"), "[Bob · email] hi there")
})

// --- who the answer is for -------------------------------------------
// The agent could always direct a reply (whisper). The member could not.
// `room` must stay the default: a shared agent that quietly starts
// answering privately breaks the one property the room exists for.

test("a plain message is addressed to the whole room, with no directive claimed", () => {
  const parsed = parseAudienceDirective("what should we build?")
  assert.deepEqual(parsed, { audience: "room", text: "what should we build?", explicit: false })
})

test("@me and its aliases ask for a private answer", () => {
  for (const prefix of ["@me", "@moi", "/me", "/private", "/prive", "/privé", "@private"]) {
    const parsed = parseAudienceDirective(`${prefix} what did Bob say?`)
    assert.equal(parsed.audience, "sender-only", `${prefix} should be private`)
    assert.equal(parsed.text, "what did Bob say?", `${prefix} should be stripped`)
    assert.equal(parsed.explicit, true)
  }
})

test("@all and its aliases are accepted and stripped, even though room is already the default", () => {
  for (const prefix of ["@all", "@tous", "/all", "/tous", "@room", "/room"]) {
    const parsed = parseAudienceDirective(`${prefix} ship it`)
    assert.equal(parsed.audience, "room", `${prefix} should be room`)
    assert.equal(parsed.text, "ship it")
    assert.equal(parsed.explicit, true, "typing it explicitly is worth recording")
  }
})

test("directives are case-insensitive", () => {
  assert.equal(parseAudienceDirective("@ME secret").audience, "sender-only")
  assert.equal(parseAudienceDirective("/Private secret").audience, "sender-only")
  assert.equal(parseAudienceDirective("@All everyone").audience, "room")
})

test("a directive only counts at the start, followed by a break", () => {
  // The failure this prevents: swallowing a real word as a command.
  const meeting = parseAudienceDirective("@meeting at 5 works for me")
  assert.equal(meeting.audience, "room")
  assert.equal(meeting.explicit, false)
  assert.equal(meeting.text, "@meeting at 5 works for me", "nothing may be stripped")

  const midSentence = parseAudienceDirective("send it to @me later")
  assert.equal(midSentence.audience, "room")
  assert.equal(midSentence.text, "send it to @me later")

  const mail = parseAudienceDirective("write to alice@mesnil.fr")
  assert.equal(mail.audience, "room")
  assert.equal(mail.text, "write to alice@mesnil.fr")
})

test("attributeText marks a private turn so the agent knows to whisper the whole reply", () => {
  assert.equal(attributeText(alice, "what did Bob say?", "sender-only"), "[Alice · messenger · private] what did Bob say?")
  assert.equal(attributeText(alice, "hello", "room"), "[Alice · messenger] hello")
})

test("a bare directive with nothing after it is not sent", async () => {
  const daemon = await startFakeDaemon({})
  try {
    const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
    const result = await fanIn(client, "sess_bare", alice, "@me")
    assert.equal(result.ok, false)
    assert.equal(daemon.requestsReceived.filter(r => r.path === "/sessions/sess_bare/prompt").length, 0)
  } finally {
    await daemon.close()
  }
})

test("fanIn sends the private marker and strips the directive", async () => {
  const daemon = await startFakeDaemon({})
  try {
    const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
    await fanIn(client, "sess_priv", alice, "@me did Bob approve the budget?")

    const req = daemon.requestsReceived.find(r => r.path === "/sessions/sess_priv/prompt")
    assert.ok(req !== undefined)
    assert.deepEqual(req.body, {
      prompt: "[Alice · messenger · private] did Bob approve the budget?",
      queue: true,
      origin: "rdv:member_alice",
    })
  } finally {
    await daemon.close()
  }
})

test("fanIn posts the attributed text with queue:true and an rdv: origin", async () => {
  const daemon = await startFakeDaemon({})
  try {
    const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
    const result = await fanIn(client, "sess_fanin", alice, "hello room")
    assert.deepEqual(result, { ok: true, queued: false })

    const req = daemon.requestsReceived.find(r => r.path === "/sessions/sess_fanin/prompt")
    assert.ok(req !== undefined)
    assert.deepEqual(req.body, {
      prompt: "[Alice · messenger] hello room",
      queue: true,
      origin: "rdv:member_alice",
    })
  } finally {
    await daemon.close()
  }
})

test("fanIn trims raw text before attribution", async () => {
  const daemon = await startFakeDaemon({})
  try {
    const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
    await fanIn(client, "sess_trim", alice, "  hello  \n")
    const req = daemon.requestsReceived.find(r => r.path === "/sessions/sess_trim/prompt")
    assert.ok(req !== undefined)
    assert.deepEqual(req.body, { prompt: "[Alice · messenger] hello", queue: true, origin: "rdv:member_alice" })
  } finally {
    await daemon.close()
  }
})

test("fanIn rejects empty input without calling the daemon", async () => {
  const daemon = await startFakeDaemon({})
  try {
    const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
    const result = await fanIn(client, "sess_empty", alice, "   ")
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, "other")
    assert.equal(daemon.requestsReceived.length, 0)
  } finally {
    await daemon.close()
  }
})

test("two members fanning in while the session is busy both land as queued turns, in order", async () => {
  const daemon = await startFakeDaemon({})
  try {
    const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
    // First message dispatches immediately and makes the fake session busy.
    const first = await fanIn(client, "sess_room", alice, "who wants pizza")
    assert.deepEqual(first, { ok: true, queued: false })

    const second = await fanIn(client, "sess_room", alice, "I vote pepperoni")
    const third = await fanIn(client, "sess_room", bob, "I vote mushroom")

    assert.ok(second.ok && second.queued)
    assert.ok(third.ok && third.queued)
    if (second.ok && second.queued && third.ok && third.queued) {
      assert.equal(second.queuePosition, 1)
      assert.equal(third.queuePosition, 2)
    }

    const prompts = daemon.requestsReceived
      .filter(r => r.path === "/sessions/sess_room/prompt")
      .map(r => r.body)
    assert.deepEqual(prompts, [
      { prompt: "[Alice · messenger] who wants pizza", queue: true, origin: "rdv:member_alice" },
      { prompt: "[Alice · messenger] I vote pepperoni", queue: true, origin: "rdv:member_alice" },
      { prompt: "[Bob · email] I vote mushroom", queue: true, origin: "rdv:member_bob" },
    ])
  } finally {
    await daemon.close()
  }
})
