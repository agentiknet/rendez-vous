/**
 * BRIEF-19's panel, tested against the code that actually ships: every view
 * function below is embedded into the browser script via `toString()`
 * (src/service/roster-panel.html.ts), so these assertions are about the
 * rendered panel, not about a parallel implementation of it.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  FAILURES_BEFORE_WARNING,
  TRANSCRIPT_JUST_ATTACHED_TEXT,
  TRANSCRIPT_UNREACHABLE_TEXT,
  bannerVisibilityClass,
  diffRosterRows,
  highestRenderedSeq,
  isHostResponse,
  isStandaloneBridge,
  lostContactVisible,
  mergeRoomCodes,
  planBannerClass,
  planRosterRows,
  presenceViewOf,
  renderRosterRow,
  rosterRowDataChanged,
  roomIdentityLabel,
  rosterPanelHtml,
  standaloneCallTool,
  toolPayload,
  transcriptItemsOf,
  transcriptSeqOf,
  transcriptStatusText,
  unreadLabelOf,
  type PanelDocument,
  type PanelElement,
  type RosterListPayload,
  type RosterListRoom,
  type RosterRowView,
  type StandaloneConnection,
} from "../../src/service/roster-panel.html.ts"

/** A DOM stand-in that records everything the row renderer does to it —
 *  including every `setAttribute`, which amendment 1 says must be NONE. */
class FakeElement implements PanelElement {
  readonly tag: string
  className = ""
  textContent = ""
  value = ""
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

// --- FIX 2: the standalone REST bridge (`window.McpApp`, injected by
// `app serve`) is detected on BOTH conditions, and its two-positional
// `callTool(name, args)` is fed this panel's single `{name, arguments}`. ---

test("standalone detection needs BOTH a hostless window AND McpApp.connect", () => {
  const connection: StandaloneConnection = { callTool: async () => ({ content: [] }) }
  const connect = () => Promise.resolve(connection)

  assert.equal(isStandaloneBridge(false, { connect }), false, "an iframe with a real parent host is never standalone")
  assert.equal(isStandaloneBridge(true, undefined), false, "a hostless window with no McpApp is nobody to talk to")
  assert.equal(isStandaloneBridge(true, null), false)
  assert.equal(isStandaloneBridge(true, {}), false, "McpApp without connect is not the bridge this panel needs")
  assert.equal(isStandaloneBridge(true, { connect }), true, "both conditions met IS the standalone bridge")
  assert.equal(isStandaloneBridge(false, undefined), false)
})

test("standalone callTool translates {name, arguments} into (name, args) and keeps _meta for the room codes", async () => {
  const calls: { readonly name: string; readonly args: Readonly<Record<string, string>> }[] = []
  const connection: StandaloneConnection = {
    callTool: async (name, args) => {
      calls.push({ name, args })
      return {
        content: [
          {
            text: JSON.stringify({
              rooms: [
                { slug: "harbor-lantern-ember", presenceBasis: "acked", memberCount: 2 },
                { slug: "copper-meadow-signal", presenceBasis: "acked", memberCount: 1 },
              ],
            }),
          },
        ],
        _meta: {
          rooms: [
            { slug: "harbor-lantern-ember", code: "RDV-AAAA" },
            { slug: "copper-meadow-signal", code: "RDV-BBBB" },
          ],
        },
      }
    },
  }

  const body = await standaloneCallTool(connection, { name: "rendezvous_list", arguments: {} })
  assert.deepEqual(
    calls,
    [{ name: "rendezvous_list", args: {} }],
    "window.McpApp.callTool takes (name, args), not this panel's one params object",
  )

  const plan = planRosterRows(toolPayload(body))
  assert.equal(plan.rows.length, 2, "both rooms must render once _meta re-attaches the codes")
  assert.deepEqual(plan.rows.map((r) => r.identity), ["harbor-lantern-ember", "copper-meadow-signal"])
  assert.deepEqual(plan.rows.map((r) => r.code), ["RDV-AAAA", "RDV-BBBB"], "the _meta codes must survive the standalone path")
})

// --- The panel's two truth-telling banners must actually be able to draw.
// The stylesheet hides each by default; the old `el.style.display = ""` only
// REMOVED the inline declaration, so the stylesheet's `display: none` kept
// winning and neither banner could ever appear. Visibility is a class. ---

test("the banners are revealed by a class the stylesheet honours, never by an empty inline display", () => {
  const html = rosterPanelHtml({ provider: "whatsapp", contactRef: "+1", displayName: "Alice" }, "https://example.test")

  assert.match(
    html,
    /#connection-lost\.visible\s*,\s*#ambiguous\.visible\s*\{\s*display:\s*block;?\s*\}/,
    "the stylesheet must have a rule that REVEALS the visible class (id+class, so it beats the id's display:none)",
  )
  assert.match(html, /#connection-lost \{[^}]*display:\s*none/, "the connection banner hides by default without the class")
  assert.match(html, /#ambiguous \{[^}]*display:\s*none/, "the ambiguity banner hides by default without the class")
  assert.ok(
    !/\.style\.display\s*=\s*""/.test(html),
    "an empty inline display re-hides the banner the stylesheet already hides — the bug this fix removes",
  )

  assert.equal(bannerVisibilityClass(true), "visible")
  assert.equal(bannerVisibilityClass(false), "")
})

test("a plan marked ambiguous ends up with the ambiguous banner visible", () => {
  const shown = new FakeElement("div")
  shown.className = planBannerClass({ ambiguous: true })
  assert.ok(shown.className.split(" ").includes("visible"), "ambiguous:true must leave the banner visible")

  const quiet = new FakeElement("div")
  quiet.className = planBannerClass({ ambiguous: false })
  assert.ok(!quiet.className.split(" ").includes("visible"), "an unambiguous plan must not show the banner")
})

test("after FAILURES_BEFORE_WARNING consecutive failures the connection banner ends up visible", () => {
  assert.equal(lostContactVisible(FAILURES_BEFORE_WARNING - 1), false, "one short of the threshold stays hidden")
  assert.equal(lostContactVisible(FAILURES_BEFORE_WARNING), true, "the threshold itself must show")

  const banner = new FakeElement("div")
  for (let failures = 1; failures <= FAILURES_BEFORE_WARNING; failures += 1) {
    banner.className = bannerVisibilityClass(lostContactVisible(failures))
  }
  assert.ok(banner.className.split(" ").includes("visible"), "three failed polls in a row must draw the banner")
})

// --- The poll UPDATES the list; it must not rebuild it. A rebuild destroyed
// the input a person was typing in, collapsed an expanded roster and wiped
// send-notes on every 3s tick. The diff is pure so it can be tested with no
// DOM; the script applies it to a slug-keyed store of live rows. ---

test("a poll that changes one room's data reuses that row and leaves its typed input untouched", () => {
  const before = [row({ slug: "harbor-lantern-ember", memberCount: 2 }), row({ slug: "copper-meadow-signal", memberCount: 1 })]
  const after = [row({ slug: "harbor-lantern-ember", memberCount: 9 }), row({ slug: "copper-meadow-signal", memberCount: 1 })]

  const diff = diffRosterRows(before, after)
  assert.equal(diff.removed.length, 0, "nobody left")
  assert.equal(diff.added.length, 0, "nobody arrived")
  assert.deepEqual(diff.kept.map((entry) => entry.row.slug), ["harbor-lantern-ember", "copper-meadow-signal"])
  assert.deepEqual(diff.kept.map((entry) => entry.dataChanged), [true, false], "only the changed row repaints")

  // The preservation contract, modelled on the script's slug-keyed store: a
  // kept row is the SAME element across the pass, so its live input survives.
  const input = new FakeElement("input")
  input.value = "a half-typed message"
  const record = { el: new FakeElement("div"), input }
  const store = new Map([["harbor-lantern-ember", record]])

  for (const slug of diff.removed) store.delete(slug)
  for (const entry of diff.kept) {
    const existing = store.get(entry.row.slug)
    if (existing !== undefined && entry.dataChanged) existing.el.className = "room" // data-only repaint
  }
  for (const added of diff.added) store.set(added.slug, { el: new FakeElement("div"), input: new FakeElement("input") })

  assert.equal(store.get("harbor-lantern-ember"), record, "a kept row is never removed and re-added")
  assert.equal(input.value, "a half-typed message", "the update pass must not touch the live input")
})

test("a room that disappears from the plan has its row (and any stale draft) dropped", () => {
  const diff = diffRosterRows(
    [row({ slug: "harbor-lantern-ember" }), row({ slug: "copper-meadow-signal" })],
    [row({ slug: "copper-meadow-signal" })],
  )
  assert.deepEqual(diff.removed, ["harbor-lantern-ember"])
  assert.deepEqual(diff.added, [])
  assert.deepEqual(diff.kept.map((entry) => entry.row.slug), ["copper-meadow-signal"])
})

test("a room that appears for the first time adds exactly one row", () => {
  const diff = diffRosterRows(
    [row({ slug: "harbor-lantern-ember" })],
    [row({ slug: "harbor-lantern-ember" }), row({ slug: "copper-meadow-signal" })],
  )
  assert.deepEqual(diff.added.map((added) => added.slug), ["copper-meadow-signal"])
  assert.deepEqual(diff.removed, [])
  assert.deepEqual(diff.kept.map((entry) => entry.row.slug), ["harbor-lantern-ember"])
})

test("a row repaints only when a RENDERED field actually changed", () => {
  const base = row({ slug: "harbor-lantern-ember" })
  assert.equal(rosterRowDataChanged(base, { ...base }), false, "an identical row needs no repaint")
  assert.equal(rosterRowDataChanged(base, { ...base, memberCount: base.memberCount + 1 }), true)
  assert.equal(rosterRowDataChanged(base, { ...base, unreadLabel: "3" }), true)
  assert.equal(rosterRowDataChanged(base, { ...base, presence: { kind: "away", label: "away" } }), true)
  assert.equal(rosterRowDataChanged(base, { ...base, code: "RDV-ZZZZ" }), false, "the code is a capability, never rendered")
})

// --- BRIEF-12: the panel becomes a device. It appends only what is new and
// renderable, and the cursor advances to what it ACTUALLY RENDERED. ---

test("the transcript appends only new, renderable deliveries, in seq order", () => {
  const deliveries = [
    { id: "d2", memberId: "m1", kind: "say", text: "second" },
    { id: "d1", memberId: "m1", kind: "say", text: "first" },
    { id: "d3", memberId: "m1", kind: "say" }, // fetched, but nothing to render
    null,
    { memberId: "m1", text: "no id" },
    { id: "d4", memberId: "m1", kind: "whisper", text: "secret" },
  ]
  const items = transcriptItemsOf(deliveries, { d1: true })
  assert.deepEqual(
    items.map((entry) => entry.text),
    ["second", "secret"],
    "an already-rendered or unrenderable entry is skipped, never rendered as blank",
  )
  assert.deepEqual(
    items.map((entry) => entry.seq),
    [2, 4],
    "the rest come back in seq order",
  )

  assert.equal(transcriptSeqOf("d12"), 12)
  assert.equal(transcriptSeqOf("nonsense"), 0, "an unparseable id sorts as 0, as deliverySeqOf does")
})

test("the cursor advances to the highest seq RENDERED, never to what was merely fetched", () => {
  const fetched = [
    { id: "d1", memberId: "m1", kind: "say", text: "rendered one" },
    { id: "d2", memberId: "m1", kind: "say", text: "rendered two" },
    { id: "d3", memberId: "m1", kind: "say" }, // fetched, no text — not rendered
  ]
  const items = transcriptItemsOf(fetched, {})
  assert.deepEqual(items.map((entry) => entry.seq), [1, 2])
  assert.equal(
    highestRenderedSeq(0, items),
    2,
    "d3 was fetched but not rendered; acking it would let the room prune a message nobody saw",
  )
  assert.equal(highestRenderedSeq(5, items), 5, "the rendered high-water is monotonic")
})

test("the shipped panel drains by slug, then acks the high-water it rendered", () => {
  const html = rosterPanelHtml({ provider: "whatsapp", contactRef: "+1", displayName: "Alice" }, "https://example.test")
  assert.ok(html.includes('name: "rendezvous_drain"'), "the expand drain must exist")
  assert.ok(html.includes('name: "rendezvous_ack"'), "and the ack that follows it")
  assert.ok(
    /arguments: \{ roomSlug: state\.slug, seq: state\.since \}/.test(html),
    "the ack must name the room by slug and carry the RENDERED high-water, never a fetched cursor",
  )
  assert.ok(
    html.indexOf("highestRenderedSeq(state.since, items)") < html.indexOf('name: "rendezvous_ack"'),
    "the cursor must be computed from the rendered items BEFORE the ack is sent",
  )
})

test("an open transcript with nothing rendered says WHY it is empty; quiet says nothing; a failure still says it failed", () => {
  // Just attached: its own room-web member has no backlog by construction, and
  // that is the fact the screen must carry — not a blank box.
  assert.equal(transcriptStatusText(false, 0), TRANSCRIPT_JUST_ATTACHED_TEXT)
  assert.ok(/member|screen/i.test(TRANSCRIPT_JUST_ATTACHED_TEXT), "the sentence must name what the panel is")
  assert.ok(
    /addressed to you/i.test(TRANSCRIPT_JUST_ATTACHED_TEXT) && /from now on/i.test(TRANSCRIPT_JUST_ATTACHED_TEXT),
    "…and carry the real reason: it only sees mail addressed to it from now on",
  )
  assert.notEqual(TRANSCRIPT_JUST_ATTACHED_TEXT, TRANSCRIPT_UNREACHABLE_TEXT)

  // Once at least one message has rendered, a later empty drain is silence.
  assert.equal(transcriptStatusText(false, 1), "")
  assert.equal(transcriptStatusText(false, 7), "")

  // A failed drain dominates: "could not read" is never softened into
  // "nothing addressed to you".
  assert.equal(transcriptStatusText(true, 0), TRANSCRIPT_UNREACHABLE_TEXT)
  assert.notEqual(transcriptStatusText(true, 0), TRANSCRIPT_JUST_ATTACHED_TEXT)
  assert.equal(transcriptStatusText(true, 4), TRANSCRIPT_UNREACHABLE_TEXT, "failure dominates even after messages exist")

  // And the shipped script keys its status line on exactly that decision.
  const html = rosterPanelHtml({ provider: "whatsapp", contactRef: "+1", displayName: "Alice" }, "https://example.test")
  assert.ok(html.includes("transcriptStatusText(false, state.renderedCount)"), "the success path must use it")
  assert.ok(html.includes("transcriptStatusText(true, state.renderedCount)"), "and so must the failure path")
})
