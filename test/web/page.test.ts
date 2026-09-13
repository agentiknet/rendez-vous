import assert from "node:assert/strict"
import { test } from "node:test"
import type { JoinLinks } from "../../src/links/index.ts"
import type { Room } from "../../src/rooms/types.ts"
import { planOutboxRender, renderRoomNotFoundPage, renderRoomPage } from "../../src/web/page.ts"

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
  assert.ok(html.includes("/outbox?since="))
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
