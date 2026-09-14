import assert from "node:assert/strict"
import { test } from "node:test"
import type { JoinLinks } from "../../src/links/index.ts"
import type { Room } from "../../src/rooms/types.ts"
import {
  aguiPayloadOf,
  aguiSseFrames,
  freshOutboxTickState,
  outboxFailureVisible,
  planOutboxRender,
  renderRoomNotFoundPage,
  renderRoomPage,
  sseSplitFrames,
  streamFailureText,
} from "../../src/web/page.ts"

function fakeLinks(overrides: Partial<JoinLinks> = {}): JoinLinks {
  return {
    web: "http://127.0.0.1:8790/r/RDV-7F3K",
    whatsapp: "https://wa.me/15550001111?text=join%20RDV-7F3K",
    telegram: "https://t.me/rdv_bot?start=RDV-7F3K",
    sms: "sms:+15550001111?&body=join%20RDV-7F3K",
    ...overrides,
  }
}

function fakeRoom(overrides: Partial<Room> = {}): Room {
  return {
    code: "RDV-7F3K",
    slug: "amber-cedar-harbor",
    sessionId: "sess-1",
    sandboxId: undefined,
    artifactUrl: undefined,
    artifactReady: undefined,
    members: [
      {
        id: "m1",
        displayName: "Alice",
        tier: "messenger",
        address: { provider: "whatsapp", source: "agentpush", contactRef: "+1" },
        joinedAt: "2026-09-11T00:00:00.000Z",
      },
      {
        id: "m2",
        displayName: "Bob",
        tier: "room-web",
        address: { provider: "room-web", source: "RDV-7F3K", contactRef: "bob" },
        joinedAt: "2026-09-11T00:00:00.000Z",
      },
    ],
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    cursor: 0,
    lastActivityAt: "2026-09-11T00:00:00.000Z",
    state: "active",
    ...overrides,
  }
}

test("renderRoomPage contains the room code and every member's name and tier", () => {
  const html = renderRoomPage(fakeRoom(), fakeLinks())
  assert.ok(html.includes("RDV-7F3K"))
  assert.ok(html.includes("Alice"))
  assert.ok(html.includes("messenger"))
  assert.ok(html.includes("Bob"))
  assert.ok(html.includes("room-web"))
})

test("renderRoomPage shows the placeholder and hides the iframe when there is no artifact yet", () => {
  const html = renderRoomPage(fakeRoom({ artifactUrl: undefined }), fakeLinks())
  assert.ok(html.includes("No artifact yet"))
  assert.match(html, /id="artifact-frame"[^>]*style="display:none"/)
})

test("renderRoomPage wires the iframe to the artifact url and hides the placeholder when one is set", () => {
  const html = renderRoomPage(fakeRoom({ artifactUrl: "https://example.test/app" }), fakeLinks())
  assert.ok(html.includes('src="https://example.test/app"'))
  assert.match(html, /id="artifact-placeholder"[^>]*style="display:none"/)
})

test("renderRoomPage escapes a member display name so it cannot break out of the HTML", () => {
  const html = renderRoomPage(
    fakeRoom({
      members: [
        {
          id: "m1",
          displayName: '<script>alert(1)</script>',
          tier: "messenger",
          address: { provider: "whatsapp", source: "agentpush", contactRef: "+1" },
          joinedAt: "2026-09-11T00:00:00.000Z",
        },
      ],
    }),
    fakeLinks(),
  )
  assert.ok(!html.includes("<script>alert(1)</script>"))
  assert.ok(html.includes("&lt;script&gt;"))
})

test("renderRoomPage includes the join links and an inline QR svg for the web link", () => {
  const links = fakeLinks()
  const html = renderRoomPage(fakeRoom(), links)
  assert.ok(html.includes(links.web))
  assert.ok(links.whatsapp !== undefined && html.includes(links.whatsapp))
  assert.ok(links.telegram !== undefined && html.includes(links.telegram))
  assert.match(html, /class="join-qr"[^>]*>\s*<svg/)
})

test("renderRoomPage renders one join button per configured surface, plus a stay-here button that never depends on config", () => {
  const links = fakeLinks()
  const html = renderRoomPage(fakeRoom(), links)
  assert.match(html, /class="join-btn"[^>]*>Join on WhatsApp</)
  assert.match(html, /class="join-btn"[^>]*>Join on Telegram</)
  assert.match(html, /class="join-btn"[^>]*>Join by SMS</)
  assert.match(html, /id="stay-here-button"[^>]*>Stay here</)
  // `links.sms` contains a literal `&`, HTML-escaped to `&amp;` in the href —
  // spot-check the un-ambiguous, non-escaped prefix instead of the full string.
  assert.ok(links.sms !== undefined && html.includes('href="sms:+15550001111?&amp;body=join%20RDV-7F3K"'))
})

test("renderRoomPage omits whatsapp/telegram/sms join buttons when they are not configured", () => {
  const html = renderRoomPage(fakeRoom(), fakeLinks({ whatsapp: undefined, telegram: undefined, sms: undefined }))
  assert.ok(!html.includes("wa.me"))
  assert.ok(!html.includes("t.me"))
  assert.ok(!html.includes("sms:"))
  assert.match(html, /id="stay-here-button"[^>]*>Stay here</)
})

test("renderRoomPage shows the room code in a large, prominent element", () => {
  const html = renderRoomPage(fakeRoom(), fakeLinks())
  assert.match(html, /class="join-code"[^>]*>Room <span class="code" id="room-code">RDV-7F3K<\/span>/)
})

test("renderRoomPage's inline script no longer parses whisper markers — whispers arrive through the outbox drain (PLAN-02 §3-D5)", () => {
  const html = renderRoomPage(fakeRoom(), fakeLinks())
  assert.ok(!html.includes("parseWhisperBlocks"), "the [[whisper to X]] marker protocol is dead")
  assert.ok(!html.includes("renderTurnBody"))
  // The outbox drain IS in the page: the embedded pure plan function, the
  // poll, the claim exchange, and the gap notice.
  assert.ok(html.includes("const planOutboxRender ="), "the tested plan function is embedded verbatim")
  // BRIEF-15 step 2: the drain moved from `GET /outbox?since=` to an AG-UI
  // run. The cursor ACK still posts to `/outbox/cursor` — AG-UI has no
  // acknowledgement of its own (D7), and without it the retention floor is
  // released and this member's backlog becomes prunable.
  assert.ok(html.includes("/agui"), "the drain is an AG-UI run")
  assert.ok(html.includes("/outbox/cursor"), "the cursor ack must survive the transport change")
  assert.ok(html.includes("/claim"), "the claim exchange is in the page")
  assert.ok(html.includes("rdv-claim:"), "the claim secret is stored keyed by room code + name")
  assert.ok(html.includes("outbox-gap"))
})

test("renderRoomPage gives a visitor with no name yet a visible 'not a member' status, and a repeatedly-failing drain a visible failure banner (brief 14, defects 1+4)", () => {
  const html = renderRoomPage(fakeRoom(), fakeLinks())
  assert.ok(html.includes('id="member-status"'), "a spectator with no name must be told, visibly, that it is not receiving private replies")
  assert.ok(html.includes('id="outbox-failure"'), "an ack/drain that fails repeatedly must surface in the page, not just a silent catch")
  assert.ok(html.includes("const runOutboxTick ="), "the tested claim-and-drain tick is embedded verbatim, same trick as planOutboxRender")
  assert.ok(html.includes("const claimMember ="))
})

test("planOutboxRender dedupes on Delivery.id (at-least-once) and never repeats an item", () => {
  const seen: Record<string, boolean> = {}
  const first = planOutboxRender(
    { pruned: false, deliveries: [{ id: "d1", kind: "say", text: "one" }, { id: "d2", kind: "whisper", text: "two" }] },
    seen,
  )
  assert.equal(first.items.length, 2)
  assert.equal(first.gap, undefined)
  // The same records replayed (a reconnect) must produce nothing new.
  const replay = planOutboxRender(
    { pruned: false, deliveries: [{ id: "d1", kind: "say", text: "one" }, { id: "d2", kind: "whisper", text: "two" }] },
    seen,
  )
  assert.equal(replay.items.length, 0)
  const fresh = planOutboxRender({ pruned: false, deliveries: [{ id: "d3", kind: "whisper", text: "three" }] }, seen)
  assert.deepEqual(fresh.items, [{ id: "d3", kind: "whisper", text: "three" }])
})

test("planOutboxRender turns the pruned gap marker into visible text, never silence (PLAN-02 §3-D6)", () => {
  const plan = planOutboxRender({ pruned: true, deliveries: [] }, {})
  assert.ok(typeof plan.gap === "string" && plan.gap.length > 0, "a destroyed backlog is announced, not rendered as silence")
  assert.equal(plan.items.length, 0)
})

test("planOutboxRender announces a gap once per gap, not once per poll — a genuinely new gap at a higher cursor still gets its own banner (brief 12, defect 3)", () => {
  // Mirrors exactly what drainOutbox (src/web/page.ts) does with plan.gap:
  // append a div for it, and nothing else. A fake transcript element, not a
  // spy on planOutboxRender's return value, so the assertion is on what the
  // DOM would actually end up containing.
  function fakeTranscript(): { children: { className: string; textContent: string }[]; appendChild(el: { className: string; textContent: string }): void } {
    const children: { className: string; textContent: string }[] = []
    return {
      children,
      appendChild(el) {
        children.push(el)
      },
    }
  }
  const transcript = fakeTranscript()
  const seen: Record<string, boolean> = {}
  const gapState: { lastReportedSince?: number } = {}

  function tick(payload: { pruned?: boolean; deliveries?: { id: string; kind: string; text: string }[] }, since: number): void {
    const plan = planOutboxRender(payload, seen, since, gapState)
    if (plan.gap !== undefined) {
      transcript.appendChild({ className: "outbox-gap", textContent: plan.gap })
    }
  }

  // Tick 1: the server reports a genuine gap at since=0 (the client's first
  // poll). One banner.
  tick({ pruned: true, deliveries: [] }, 0)
  assert.equal(transcript.children.length, 1, "the first gap is announced")
  assert.equal(transcript.children[0]?.className, "outbox-gap")

  // Tick 2: same cursor, the server still (correctly) reports pruned:true —
  // this is the SAME unresolved gap, polled again 2s later. No second
  // banner.
  tick({ pruned: true, deliveries: [] }, 0)
  assert.equal(transcript.children.length, 1, "a repeat poll at the same cursor renders no second banner for the same gap")

  // Tick 3: a genuinely new gap — the cursor has moved forward (new mail was
  // rendered) and the room reports a fresh loss above that higher cursor.
  // This one must render.
  tick({ pruned: true, deliveries: [{ id: "d5", kind: "say", text: "hi" }] }, 5)
  assert.equal(transcript.children.length, 2, "a new gap at a higher cursor is a different gap, and IS rendered")
  assert.equal(transcript.children[1]?.className, "outbox-gap")
})

test("renderRoomNotFoundPage mentions the code and a hint to create a room", () => {
  const html = renderRoomNotFoundPage("RDV-ZZZZ")
  assert.ok(html.includes("RDV-ZZZZ"))
  assert.match(html, /new/i)
})

test("renderRoomPage server-renders the live state: pill, agent status, member badges with joined-at", () => {
  const html = renderRoomPage(fakeRoom(), fakeLinks(), true)
  assert.match(html, /id="state-pill" class="pill live">live</)
  assert.ok(html.includes(">working ·"), "agent busy renders as working before JS runs")
  assert.ok(html.includes('class="tier-badge tier-messenger">messenger<'))
  assert.ok(html.includes('class="tier-badge tier-room-web">room-web<'))
  assert.ok(html.includes("member-joined"))
})

test("renderRoomPage embeds the polling state script that patches the DOM every 3s", () => {
  const html = renderRoomPage(fakeRoom(), fakeLinks())
  assert.ok(html.includes('"/r/" + ROOM_CODE + "/state"'))
  assert.ok(html.includes("pollState, 3000"))
  assert.ok(html.includes("connection lost, retrying"))
  assert.ok(html.includes("updated-ago"))
  assert.ok(!html.includes("location.reload"), "no full-page reloads")
})

test("renderRoomPage for a paused room shows the paused pill and the paused artifact message with no dead link", () => {
  const html = renderRoomPage(
    fakeRoom({ state: "paused", artifactUrl: "https://3210-dead.e2b.app", artifactReady: false }),
    fakeLinks(),
  )
  assert.match(html, /id="state-pill" class="pill paused">paused</)
  assert.ok(html.includes("artifact paused, the link will come back when the room wakes"))
  assert.ok(!html.includes("e2b.app"), "the raw e2b host never reaches the page")
  assert.match(html, /id="artifact-frame"[^>]*style="display:none"/)
})

test("renderRoomPage keeps the join chooser and QR alongside the state row", () => {
  const html = renderRoomPage(fakeRoom(), fakeLinks())
  assert.ok(html.includes('id="state-row"'))
  assert.match(html, /class="join-qr"[^>]*>\s*<svg/)
  assert.match(html, /id="stay-here-button"[^>]*>Stay here</)
})

// --- BRIEF-15: the tool kind on the room page --------------------------

test("planOutboxRender names a tool record explicitly instead of collapsing it into `say` — the catch-all arm would attribute an args blob to the agent", () => {
  const plan = planOutboxRender(
    { pruned: false, deliveries: [{ id: "d7", kind: "tool", text: '{"blocks":3}', toolName: "render_artifact" }] },
    {},
  )
  assert.equal(plan.items.length, 1)
  assert.equal(plan.items[0]?.kind, "tool")
  assert.equal(plan.items[0]?.toolName, "render_artifact")
})

test("planOutboxRender carries no toolName on a non-tool record, so the renderer cannot mistake one for a call", () => {
  const plan = planOutboxRender({ pruned: false, deliveries: [{ id: "d1", kind: "say", text: "hello" }] }, {})
  assert.equal(plan.items[0]?.kind, "say")
  assert.equal(plan.items[0]?.toolName, undefined)
})

test("an unrecognised kind still falls back to `say` — only `tool` was carved out, and an unknown kind's text IS prose by every other reading", () => {
  const plan = planOutboxRender({ pruned: false, deliveries: [{ id: "d1", kind: "future-kind", text: "hello" }] }, {})
  assert.equal(plan.items[0]?.kind, "say")
})

test("the embedded page renders a tool record as its own bubble and never prints its args — the transcript is where humans read", () => {
  const html = renderRoomPage(fakeRoom(), fakeLinks())
  assert.ok(html.includes('item.kind === "tool"'), "the browser-side renderer must branch on the tool kind")
  assert.ok(html.includes("The shared document was just updated."), "render_artifact gets a sentence a human can act on")
  assert.ok(html.includes(".bubble.tool"), "the tool bubble must have a style of its own, not inherit the agent's")
  // The one thing that must NOT be in the renderer: the args. `item.text` is
  // written into the body for every other kind; a tool record must not reach
  // that line.
  const toolArm = html.slice(html.indexOf('item.kind === "tool"'), html.indexOf('const el = bubble(item.kind === "whisper"'))
  assert.ok(!toolArm.includes("body.textContent = item.text"), "a tool record's args must never be written into the transcript body")
})

// --- BRIEF-15 step 2: the page as an AG-UI client ----------------------

/** Builds the SSE body the AG-UI endpoint actually writes. */
function sse(...events: readonly Record<string, unknown>[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
}

const RUN_OPEN = { type: "RUN_STARTED", threadId: "t", runId: "r" }
const RUN_CLOSE = { type: "RUN_FINISHED", threadId: "t", runId: "r" }

test("aguiSseFrames parses the frames the endpoint writes and drops what is not a frame", () => {
  const frames = aguiSseFrames(sse(RUN_OPEN, { type: "TEXT_MESSAGE_END", messageId: "d1" }, RUN_CLOSE))
  assert.deepEqual(frames.map((frame) => frame.type), ["RUN_STARTED", "TEXT_MESSAGE_END", "RUN_FINISHED"])

  assert.deepEqual(aguiSseFrames(""), [])
  assert.deepEqual(aguiSseFrames("data: not json\n\n"), [], "an unparseable payload is dropped, not thrown on")
  assert.deepEqual(aguiSseFrames("data: {\"no\":\"type\"}\n\n"), [], "a frame with no type is not a frame")
  // A truncated tail (the connection died mid-write) must not become a frame.
  assert.deepEqual(aguiSseFrames(sse(RUN_OPEN) + 'data: {"type":"TEXT_MES'), [{ type: "RUN_STARTED" }])
})

test("aguiSseFrames tolerates the `event:` line the outbox SSE arm writes alongside its data", () => {
  const frames = aguiSseFrames('event: meta\ndata: {"type":"RUN_STARTED"}\n\n')
  assert.deepEqual(frames, [{ type: "RUN_STARTED" }])
})

test("aguiPayloadOf maps the text triple back to a record, keyed by messageId, with the CUSTOM kind event as the authority", () => {
  const payload = aguiPayloadOf(
    aguiSseFrames(
      sse(
        RUN_OPEN,
        { type: "CUSTOM", name: "rdv.outbox.kind", value: { messageId: "d1", kind: "whisper" } },
        { type: "TEXT_MESSAGE_START", messageId: "d1", role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "d1", delta: "for your eyes only" },
        { type: "TEXT_MESSAGE_END", messageId: "d1" },
        RUN_CLOSE,
      ),
    ),
  )
  // The role would have said "assistant" — a whisper shown with a public
  // badge is the failure this assertion exists for.
  assert.deepEqual(payload.deliveries, [{ id: "d1", kind: "whisper", text: "for your eyes only" }])
  assert.equal(payload.pruned, false)
})

test("aguiPayloadOf maps the TOOL_CALL triple to a kind:'tool' record carrying its name and its args", () => {
  const payload = aguiPayloadOf(
    aguiSseFrames(
      sse(
        RUN_OPEN,
        { type: "CUSTOM", name: "rdv.outbox.kind", value: { messageId: "d7", kind: "tool" } },
        { type: "TOOL_CALL_START", toolCallId: "d7", toolCallName: "render_artifact" },
        { type: "TOOL_CALL_ARGS", toolCallId: "d7", delta: '{"blocks":3}' },
        { type: "TOOL_CALL_END", toolCallId: "d7" },
        RUN_CLOSE,
      ),
    ),
  )
  assert.deepEqual(payload.deliveries, [{ id: "d7", kind: "tool", text: '{"blocks":3}', toolName: "render_artifact" }])
})

test("a TOOL_CALL_START whose kind event went missing is STILL a tool record — a lost CUSTOM frame must not turn args JSON into agent prose", () => {
  const payload = aguiPayloadOf(
    aguiSseFrames(sse(RUN_OPEN, { type: "TOOL_CALL_START", toolCallId: "d7", toolCallName: "render_artifact" }, { type: "TOOL_CALL_ARGS", toolCallId: "d7", delta: "{}" }, RUN_CLOSE)),
  )
  assert.equal(payload.deliveries?.[0]?.kind, "tool")
})

test("aguiPayloadOf concatenates streamed deltas, for text and for args alike", () => {
  const payload = aguiPayloadOf(
    aguiSseFrames(
      sse(
        RUN_OPEN,
        { type: "TEXT_MESSAGE_CONTENT", messageId: "d1", delta: "hello " },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "d1", delta: "world" },
        { type: "TOOL_CALL_START", toolCallId: "d2", toolCallName: "render_artifact" },
        { type: "TOOL_CALL_ARGS", toolCallId: "d2", delta: '{"blo' },
        { type: "TOOL_CALL_ARGS", toolCallId: "d2", delta: 'cks":3}' },
        RUN_CLOSE,
      ),
    ),
  )
  assert.equal(payload.deliveries?.[0]?.text, "hello world")
  assert.deepEqual(JSON.parse(String(payload.deliveries?.[1]?.text)), { blocks: 3 })
})

test("records keep the run's order, and a kind event alone creates no record — a kind with no content following it is not a delivery", () => {
  const payload = aguiPayloadOf(
    aguiSseFrames(
      sse(
        RUN_OPEN,
        { type: "CUSTOM", name: "rdv.outbox.kind", value: { messageId: "d9", kind: "system" } },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "d1", delta: "first" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "d2", delta: "second" },
        RUN_CLOSE,
      ),
    ),
  )
  assert.deepEqual(payload.deliveries?.map((record) => record.id), ["d1", "d2"])
})

test("the gap CUSTOM event becomes pruned:true, and its absence is the false — there is no reassurance event to look for (docs/OUTBOX.md §8)", () => {
  const withGap = aguiPayloadOf(
    aguiSseFrames(sse(RUN_OPEN, { type: "CUSTOM", name: "rdv.outbox.gap", value: { since: 2, cursor: 9 } }, RUN_CLOSE)),
  )
  assert.equal(withGap.pruned, true)
  assert.equal(aguiPayloadOf(aguiSseFrames(sse(RUN_OPEN, RUN_CLOSE))).pruned, false)
})

test("aguiPayloadOf never reads STATE_SNAPSHOT.cursor — the room-wide deliverySeq can sit past this member's own pending records (brief F)", () => {
  const payload = aguiPayloadOf(
    aguiSseFrames(sse(RUN_OPEN, { type: "STATE_SNAPSHOT", snapshot: { cursor: 999, roomCode: "RDV-TEST" } }, RUN_CLOSE)),
  )
  assert.deepEqual(payload.deliveries, [], "a snapshot is not a delivery")
})

test("the embedded page ships the AG-UI drain, not the JSON one — the transports must not both be live in the browser", () => {
  const html = renderRoomPage(fakeRoom(), fakeLinks())
  assert.ok(html.includes("const aguiPayloadOf ="), "the AG-UI parser is embedded verbatim, same trick as planOutboxRender")
  assert.ok(html.includes("const aguiSseFrames ="))
  assert.ok(html.includes('"/agui"') || html.includes("/agui"), "the drain must target the AG-UI route")
  assert.ok(!html.includes("const outboxPayloadOf ="), "the superseded JSON parser must not still be shipped")
})

test("the embedded pure-function block EVALUATES and runs standalone — the free-variable trap this `.toString()` embed sets, which no test that imports the module can see", () => {
  const html = renderRoomPage(fakeRoom(), fakeLinks())

  // Slice the two DOM-free declaration blocks out of the page's own script:
  // the render plan, and the claim/drain/AG-UI block. Everything after
  // `const outboxFailureVisible` touches `document`, so the slice stops there.
  const planStart = html.indexOf("const OUTBOX_GAP_TEXT =")
  const planEnd = html.indexOf("const transcriptEl")
  const drainStart = html.indexOf("const CLAIM_RETRY_BASE_MS =")
  const drainEnd = html.indexOf("const memberStatusEl")
  for (const [name, index] of Object.entries({ planStart, planEnd, drainStart, drainEnd })) {
    assert.ok(index > 0, `could not locate ${name} in the page — this test's slice is stale, not the page`)
  }
  const block = html.slice(planStart, planEnd) + "\n" + html.slice(drainStart, drainEnd)

  // Evaluated in its own scope with NOTHING from this module in it. A
  // function whose body reaches for a constant the page forgot to declare
  // throws here, exactly as it would in the browser — and only when called,
  // which is why this drives a real call rather than checking the source.
  const run = new Function(
    "frames",
    `${block}\nreturn { payload: aguiPayloadOf(aguiSseFrames(frames)), failure: outboxFailureVisible({ drainFailureStreak: 99 }) };`,
  )
  const body =
    'data: {"type":"RUN_STARTED"}\n\n' +
    'data: {"type":"CUSTOM","name":"rdv.outbox.kind","value":{"messageId":"d7","kind":"tool"}}\n\n' +
    'data: {"type":"TOOL_CALL_START","toolCallId":"d7","toolCallName":"render_artifact"}\n\n' +
    'data: {"type":"TOOL_CALL_ARGS","toolCallId":"d7","delta":"{}"}\n\n' +
    'data: {"type":"RUN_FINISHED"}\n\n'
  const result: unknown = run(body)
  assert.ok(result !== null && typeof result === "object" && "payload" in result)
  const payload = result.payload
  assert.ok(payload !== null && typeof payload === "object" && "deliveries" in payload)
  assert.deepEqual(payload.deliveries, [{ id: "d7", kind: "tool", text: "{}", toolName: "render_artifact" }])
})

// --- BRIEF-21: the stream's own 409 no_session must read as words, not console noise ---

test("streamFailureText renders the no_session state as a readable sentence naming the fix, keyed on the error field alone", () => {
  const text = streamFailureText("no_session")
  assert.ok(typeof text === "string" && text.length > 0, "a named, known failure must never render as nothing")
  assert.ok(text!.toLowerCase().includes("no live agent"), "the sentence must say what is actually wrong")
  assert.ok(text!.toLowerCase().includes("send a message"), "the sentence must name the actual fix: writing wakes the room")
})

test("streamFailureText renders nothing for an error code it does not recognise — an unrecognised failure is not this brief's to invent a sentence for", () => {
  assert.equal(streamFailureText("some_future_error"), undefined)
  assert.equal(streamFailureText(undefined), undefined)
})

test("sseSplitFrames extracts every complete data: frame from a buffer and carries a trailing partial frame forward as rest, never dropping it", () => {
  const whole = sseSplitFrames('data: {"seq":1,"kind":"text-delta"}\n\ndata: {"seq":2,"kind":"turn-end"}\n\n')
  assert.deepEqual(whole.frames, ['{"seq":1,"kind":"text-delta"}', '{"seq":2,"kind":"turn-end"}'])
  assert.equal(whole.rest, "")

  // A chunk boundary landing mid-record: the second frame is not yet
  // terminated by a blank line, so it must come back as `rest`, not be lost.
  const partial = sseSplitFrames('data: {"seq":1,"kind":"text-delta"}\n\ndata: {"seq":2,"ki')
  assert.deepEqual(partial.frames, ['{"seq":1,"kind":"text-delta"}'])
  assert.equal(partial.rest, 'data: {"seq":2,"ki')

  // Feeding the rest of the bytes into a second call, with the carried
  // `rest` prepended, completes the frame the first call held back.
  const completed = sseSplitFrames(partial.rest + 'nd":"turn-end"}\n\n')
  assert.deepEqual(completed.frames, ['{"seq":2,"kind":"turn-end"}'])
})

test("a repeated stream failure escalates to the reused failure banner, and one alone does not — the same threshold defect 4 already built", () => {
  const state = freshOutboxTickState()
  assert.equal(outboxFailureVisible(state), false, "a fresh tab must not shout before anything has failed")

  state.streamFailureStreak = 1
  assert.equal(outboxFailureVisible(state), false, "one failed connection attempt is plausibly a single dropped packet")

  state.streamFailureStreak = 3
  assert.equal(outboxFailureVisible(state), true, "three in a row is no longer plausibly transient — the banner must show")
})

// --- BRIEF-23A finding 1: the recovery URL scrub runs unconditionally, not only on success ---

test("BRIEF-23A: a redemption whose fetch rejects leaves no recovery parameter in the URL and still shows the failure sentence — the scrub runs before the conditional, not inside the success arm", () => {
  const html = renderRoomPage(fakeRoom(), fakeLinks())
  const fnStart = html.indexOf("async function applyRecoveryFromUrl() {")
  assert.ok(fnStart > 0, "applyRecoveryFromUrl must be embedded in the page")

  const scrubIdx = html.indexOf("history.replaceState(null, \"\", location.pathname);", fnStart)
  assert.ok(scrubIdx > fnStart, "the URL scrub must be inside applyRecoveryFromUrl")

  const condIdx = html.indexOf("if (result.status === \"restored\")", fnStart)
  assert.ok(condIdx > fnStart, "the restored-if conditional must be inside applyRecoveryFromUrl")

  assert.ok(scrubIdx < condIdx, "history.replaceState must appear BEFORE the if/restored — unconditional scrub, not success-only")

  const failArm = html.indexOf("recoveryFailureText(result.error)", fnStart)
  assert.ok(failArm > fnStart, "the failure sentence must still render from result.error, not from the URL")
  assert.ok(failArm > condIdx, "the failure arm must follow the restored conditional (still inside else)")
})

test("BRIEF-23A: the success path still scrubs the URL and stores the claim — finding 1's move must not regress the success path", () => {
  const html = renderRoomPage(fakeRoom(), fakeLinks())
  assert.ok(html.includes("history.replaceState(null, \"\", location.pathname);"), "the URL scrub must be present somewhere in the page")
  assert.ok(html.includes("setStoredClaim("), "the claim storage call (inside redeemRecovery) must still be embedded")
  assert.ok(html.includes("nameErrorEl.style.display = \"none\""), "the success branch still hides the error element")
})

test("renderRoomPage ships the stream's failure text and reconnect parser verbatim, and a status line to render them into", () => {
  const html = renderRoomPage(fakeRoom(), fakeLinks())
  assert.ok(html.includes('id="stream-status"'), "the no_session sentence needs somewhere visible to land")
  assert.ok(html.includes("const streamFailureText ="), "the tested classifier is embedded verbatim, same trick as planOutboxRender")
  assert.ok(html.includes("const sseSplitFrames ="), "the incremental SSE parser is embedded verbatim")
  assert.ok(!html.includes("new EventSource"), "EventSource never exposes a failed response's body, so it cannot carry the error field")
})
