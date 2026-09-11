import assert from "node:assert/strict"
import { test } from "node:test"
import type { JoinLinks } from "../../src/links/index.ts"
import type { Room } from "../../src/rooms/types.ts"
import { renderRoomNotFoundPage, renderRoomPage } from "../../src/web/page.ts"

function fakeLinks(overrides: Partial<JoinLinks> = {}): JoinLinks {
  return {
    web: "http://127.0.0.1:8790/r/RDV-7F3K",
    whatsapp: "https://wa.me/15550001111?text=join%20RDV-7F3K",
    telegram: "https://t.me/rdv_bot?start=RDV-7F3K",
    ...overrides,
  }
}

function fakeRoom(overrides: Partial<Room> = {}): Room {
  return {
    code: "RDV-7F3K",
    sessionId: "sess-1",
    sandboxId: undefined,
    artifactUrl: undefined,
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
  assert.match(html, /class="invite-qr"[^>]*>\s*<svg/)
})

test("renderRoomPage omits whatsapp/telegram links when they are not configured", () => {
  const html = renderRoomPage(fakeRoom(), fakeLinks({ whatsapp: undefined, telegram: undefined }))
  assert.ok(!html.includes("wa.me"))
  assert.ok(!html.includes("t.me"))
})

test("renderRoomNotFoundPage mentions the code and a hint to create a room", () => {
  const html = renderRoomNotFoundPage("RDV-ZZZZ")
  assert.ok(html.includes("RDV-ZZZZ"))
  assert.match(html, /new/i)
})
