/**
 * BRIEF-19's panel, tested against the code that actually ships: every view
 * function below is embedded into the browser script via `toString()`
 * (src/service/roster-panel.html.ts), so these assertions are about the
 * rendered panel, not about a parallel implementation of it.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  isHostResponse,
  mergeRoomCodes,
  planRosterRows,
  presenceViewOf,
  renderRosterRow,
  roomIdentityLabel,
  rosterPanelHtml,
  unreadLabelOf,
  type PanelDocument,
  type PanelElement,
  type RosterListPayload,
  type RosterListRoom,
  type RosterRowView,
} from "../../src/service/roster-panel.html.ts"

/** A DOM stand-in that records everything the row renderer does to it —
 *  including every `setAttribute`, which amendment 1 says must be NONE. */
class FakeElement implements PanelElement {
  readonly tag: string
  className = ""
  textContent = ""
  readonly children: FakeElement[] = []
  readonly attributes: { name: string; value: string }[] = []

  constructor(tag: string) {
    this.tag = tag
  }

  appendChild(child: PanelElement): void {
    if (child instanceof FakeElement) this.children.push(child)
  }

  setAttribute(name: string, value: string): void {
    this.attributes.push({ name, value })
  }
}

const fakeDocument: PanelDocument = {
  createElement: (tag: string) => new FakeElement(tag),
}

function flatten(el: FakeElement): FakeElement[] {
  return [el, ...el.children.flatMap(flatten)]
}

function row(overrides: Partial<RosterRowView> = {}): RosterRowView {
  return {
    code: "RDV-AAAA",
    slug: "harbor-lantern-ember",
    identity: "RDV-AAAA",
    presence: { kind: "present", label: "present" },
    memberCount: 3,
    unreadLabel: "",
    active: false,
    displayName: "Alice",
    ...overrides,
  }
}

function render(view: RosterRowView): FakeElement {
  const el = renderRosterRow(fakeDocument, view)
  assert.ok(el instanceof FakeElement)
  if (!(el instanceof FakeElement)) throw new Error("unreachable")
  return el
}

// --- The honest dot. The PAIR is the point: a test that only checks the
// never-acked arm passes with every dot hard-wired to "unknown". ----

test("presenceBasis never-acked renders as unknown, and acked+away renders as away", () => {
  const never = presenceViewOf({ presence: "present", presenceBasis: "never-acked" })
  assert.equal(never.kind, "unknown", "a member who has never acked has no presence READING")
  assert.equal(never.label, "unknown", "the word must say unknown, not away")

  const away = presenceViewOf({ presence: "away", presenceBasis: "acked" })
  assert.equal(away.kind, "away", "a real ack that has gone stale IS away")
  assert.equal(away.label, "away")

  const present = presenceViewOf({ presence: "present", presenceBasis: "acked" })
  assert.equal(present.kind, "present")
  assert.equal(present.label, "present")
})

test("a never-acked room renders a hollow unknown marker, and a stale acked one renders a filled away marker", () => {
  const unknown = render(row({ presence: presenceViewOf({ presence: "present", presenceBasis: "never-acked" }) }))
  const unknownNodes = flatten(unknown)
  assert.ok(unknownNodes.some((node) => node.className.includes("dot-unknown")), "the marker must be the unknown one")
  assert.ok(!unknownNodes.some((node) => node.className.includes("dot-away")), "never-acked must not borrow the away marker")
  assert.ok(unknownNodes.some((node) => node.textContent === "you: unknown"), "and it must say so in words")

  const away = render(row({ presence: presenceViewOf({ presence: "away", presenceBasis: "acked" }) }))
  const awayNodes = flatten(away)
  assert.ok(awayNodes.some((node) => node.className.includes("dot-away")), "a real stale ack IS away")
  assert.ok(!awayNodes.some((node) => node.className.includes("dot-unknown")))
  assert.ok(awayNodes.some((node) => node.textContent === "you: away"))
})

test("the hollow unknown marker is styled hollow, and the away marker is not", () => {
  const html = rosterPanelHtml({ provider: "whatsapp", contactRef: "+1", displayName: "Alice" }, "https://example.test")
  const unknownRule = /\.dot-unknown \{([^}]*)\}/.exec(html)?.[1] ?? ""
  assert.ok(unknownRule.includes("transparent"), `the unknown marker must not be a filled dot, got: ${unknownRule}`)
  assert.ok(unknownRule.includes("border"), `the unknown marker must be an outline, got: ${unknownRule}`)
  const awayRule = /\.dot-away \{([^}]*)\}/.exec(html)?.[1] ?? ""
  assert.ok(/background:\s*#/.test(awayRule), `an away reading IS filled, got: ${awayRule}`)
})

// --- AMENDMENT 1: the room identity is a label, never a join affordance. ----

test("the room identity is rendered as plain text and never as a link, a data attribute or a copy target", () => {
  const el = render(row({ identity: "RDV-SECRET", code: "RDV-SECRET" }))
  const nodes = flatten(el)

  const carriers = nodes.filter((node) => node.textContent === "RDV-SECRET")
  assert.equal(carriers.length, 1, "the identity must appear exactly once, as text")
  assert.equal(carriers[0]?.tag, "span", "a span, not an anchor")

  // Nothing in the row sets ANY attribute — so the identity cannot be in an
  // href, a data-*, a title, a value or anything else a screenshot or a
  // click could turn back into a capability.
  const attributes = nodes.flatMap((node) => node.attributes)
  assert.deepEqual(attributes, [], `the row must set no attributes at all, got: ${JSON.stringify(attributes)}`)
  assert.ok(!nodes.some((node) => node.tag === "a"), "no anchor may be rendered for the identity")
})

test("the shipped panel has no join affordance anywhere: no href, no anchor, no clipboard, no QR", () => {
  const html = rosterPanelHtml({ provider: "whatsapp", contactRef: "+1", displayName: "Alice" }, "https://example.test")
  assert.ok(!/href/i.test(html), "an href would make a displayed room code one click from a join")
  assert.ok(!/<a[\s>]/i.test(html), "no anchor elements")
  assert.ok(!/clipboard/i.test(html), "a copy button is the affordance amendment 1 forbids")
  assert.ok(!/\bqr\b/i.test(html), "a QR of a room code is a join capability in image form")
  assert.ok(!/setAttribute/.test(html), "no attribute may ever carry the identity")
})

test("roomIdentityLabel is the single accessor, and planRosterRows is its only call site per render", () => {
  assert.equal(roomIdentityLabel({ slug: "harbor-lantern-ember" }), "harbor-lantern-ember", "BRIEF-20: the label is the slug")
  assert.equal(roomIdentityLabel({}), "", "a room with no slug renders unnamed, not a crash")
  // The arm that matters: a room carrying a code but no slug must render
  // NOTHING. A fallback to `code` here would restore the leak the split
  // removed, silently, on exactly the rooms whose data is oldest.
  const sluglessButCoded: RosterListRoom = { code: "RDV-AAAA" }
  assert.equal(roomIdentityLabel(sluglessButCoded), "", "a slugless room must never fall back to showing its join code")

  // One call site: the embedded script names it exactly twice — once in the
  // `const roomIdentityLabel = …` definition planRosterRows closes over, and
  // once inside planRosterRows itself. A second render path calling it would
  // push this over.
  const html = rosterPanelHtml({ provider: "whatsapp", contactRef: "+1", displayName: "Alice" }, "https://example.test")
  const mentions = html.match(/roomIdentityLabel/g) ?? []
  assert.equal(mentions.length, 2, `expected one definition and one call site, got ${mentions.length}`)
})

// --- Counts, and the rest of the row. ----

test("0 unread renders as nothing, not as \"0\"", () => {
  assert.equal(unreadLabelOf(0), "")
  assert.equal(unreadLabelOf(undefined), "")
  assert.equal(unreadLabelOf(4), "4")

  const quiet = flatten(render(row({ unreadLabel: unreadLabelOf(0) })))
  assert.ok(!quiet.some((node) => node.className.includes("badge-unread")), "no badge at all when nothing is unread")
  assert.ok(!quiet.some((node) => node.textContent === "0"), "a zero badge says nothing a blank says better")

  const noisy = flatten(render(row({ unreadLabel: unreadLabelOf(4) })))
  const badge = noisy.find((node) => node.className.includes("badge-unread"))
  assert.equal(badge?.textContent, "4")
})

test("planRosterRows keeps the ambiguity flag and marks exactly the active room", () => {
  const plan = planRosterRows({
    ambiguous: false,
    rooms: [
      { code: "RDV-AAAA", slug: "harbor-lantern-ember", presence: "present", presenceBasis: "acked", memberCount: 2, unread: 0, active: true, displayName: "Alice" },
      { code: "RDV-BBBB", slug: "copper-meadow-signal", presence: "away", presenceBasis: "acked", memberCount: 5, unread: 3, active: false, displayName: "Alice" },
    ],
  })
  assert.equal(plan.ambiguous, false)
  assert.deepEqual(plan.rows.map((r) => r.identity), ["harbor-lantern-ember", "copper-meadow-signal"])
  assert.ok(
    !plan.rows.some((r) => r.identity.includes("RDV-")),
    "BRIEF-20: a row's rendered identity is the slug — a join code must never reach it",
  )
  assert.deepEqual(plan.rows.map((r) => r.active), [true, false], "exactly one row may carry the active pointer")
  assert.deepEqual(plan.rows.map((r) => r.unreadLabel), ["", "3"])

  const broken = planRosterRows({ ambiguous: true, rooms: [{ code: "RDV-AAAA", active: false }] })
  assert.equal(broken.ambiguous, true, "a broken invariant is carried through, never sorted away")
})

test("BRIEF-24: the panel gets each room's join code from the host-only _meta, merged by slug, never from the model-visible text", () => {
  const payload: RosterListPayload = {
    ambiguous: false,
    rooms: [
      { slug: "harbor-lantern-ember", presenceBasis: "acked", memberCount: 2 },
      { slug: "copper-meadow-signal", presenceBasis: "acked", memberCount: 1 },
    ],
  }
  const merged = mergeRoomCodes(payload, {
    rooms: [
      { slug: "harbor-lantern-ember", code: "RDV-AAAA" },
      { slug: "copper-meadow-signal", code: "RDV-BBBB" },
    ],
  })
  assert.deepEqual(merged.rooms?.map((room) => room.code), ["RDV-AAAA", "RDV-BBBB"])
  assert.deepEqual(
    merged.rooms?.map((room) => room.slug),
    ["harbor-lantern-ember", "copper-meadow-signal"],
    "the merge must neither reorder nor drop rows",
  )

  const noMeta = mergeRoomCodes(payload, undefined)
  assert.deepEqual(
    noMeta.rooms?.map((room) => room.code),
    [undefined, undefined],
    "a host that forwards no _meta leaves rows code-less — an honest degrade, never an invented code",
  )
})

test("the panel says the ambiguity out loud, in words, at the top", () => {
  const html = rosterPanelHtml({ provider: "whatsapp", contactRef: "+1", displayName: "Alice" }, "https://example.test")
  assert.ok(/more than one room/i.test(html), "the banner must say what is wrong in words")
  assert.ok(/broken invariant/i.test(html), "and name it as a broken invariant, not a quirk")
})

test("the panel sends through the host, and fetches only the auth-free spectator projection", () => {
  const html = rosterPanelHtml({ provider: "whatsapp", contactRef: "+1", displayName: "Alice" }, "https://example.test")
  assert.ok(/callTool\(\{\s*\n?\s*name: "rendezvous_send"/.test(html), "the send must go through the host's tool call")
  assert.ok(html.includes('hostRequest("tools/call"'), "which is a tools/call forwarded to the server")
  assert.ok(!/\/rooms\/.*\/send/.test(html), "never a direct fetch of the member send route")

  const fetches = html.match(/\bfetch\(/g) ?? []
  assert.equal(fetches.length, 1, `the panel makes exactly one fetch, got ${fetches.length}`)
  const line = html.split("\n").find((candidate) => /\bfetch\(/.test(candidate)) ?? ""
  assert.ok(line.includes('PUBLIC_URL + "/r/"'), `the one fetch must be the spectator projection, got: ${line.trim()}`)
  assert.ok(line.includes('"/state"'), `…/state and nothing else, got: ${line.trim()}`)
})

// --- FIX 1: a request is not a response. The panel's own `ui/initialize`
// echoed back to it in standalone mode must never settle the pending call —
// otherwise its own question is read as a successful empty answer. ---

test("an echoed request is never read as its answer: the pending call stays pending", () => {
  const ownRequest = { jsonrpc: "2.0", id: 7, method: "ui/initialize", params: {} }
  assert.equal(isHostResponse(ownRequest), false, "a message carrying a method is a REQUEST, not the response")

  const notification = { jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }
  assert.equal(isHostResponse(notification), false, "a notification has no id and can settle nothing")

  // The consequence in the shipped listener: the waiter keyed by the id it
  // would otherwise resolve is never touched, so the 15s timeout is what
  // ends this call — an honest failure, not a fabricated success.
  const pending = new Map<number, string>([[7, "waiter for ui/initialize"]])
  if (isHostResponse(ownRequest)) pending.delete(ownRequest.id)
  assert.equal(pending.has(7), true, "the panel's own question must not be consumed as its answer")

  // The real response shapes still settle (and a host refusal still rejects).
  const response = { jsonrpc: "2.0", id: 7, result: { ok: true } }
  assert.equal(isHostResponse(response), true)
  const refusal = { jsonrpc: "2.0", id: 7, error: { message: "refused" } }
  assert.equal(isHostResponse(refusal), true, "an error response is still a response")

  assert.equal(isHostResponse(null), false)
  const wrongVersion = { jsonrpc: "1.0", id: 7 }
  assert.equal(isHostResponse(wrongVersion), false, "not JSON-RPC 2.0")
})
