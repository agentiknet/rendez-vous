import assert from "node:assert/strict"
import { test } from "node:test"
import { DaemonClient } from "../../src/daemon/client.ts"
import { attributeText, fanIn, type Sender } from "../../src/fanin/index.ts"
import { startFakeDaemon } from "../daemon/fake-daemon.ts"

const alice: Sender = { id: "member_alice", displayName: "Alice", tier: "messenger" }
const bob: Sender = { id: "member_bob", displayName: "Bob", tier: "email" }

test("attributeText prefixes displayName and tier", () => {
  assert.equal(attributeText(alice, "hello"), "[Alice · messenger] hello")
  assert.equal(attributeText(bob, "hi there"), "[Bob · email] hi there")
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
