/**
 * The `rendezvous/roster` MCP App panel (BRIEF-19): every room ONE PERSON is
 * in, on one screen — the ICQ-shaped directory Jeremy asked for. Served as
 * `ui://rendezvous/roster` from `POST /mcp` (`mcp-personal.ts`), a deliberate
 * sibling of `room-view.html.ts`: inline CSS, inline vanilla JS, no build
 * step, the same `escapeHtml`/`embedJson` so there is one escaping story in
 * this repo, and the same `ResizeObserver` → `ui/notifications/size-changed`
 * report (omitting it renders the panel as a ~20px strip — BRIEF-05).
 *
 * Three things it does differently from `room_view`, each for a reason:
 *
 * 1. It is PERSON-scoped, so `resources/read` bakes in the principal the
 *    bearer resolved to — never a room code, never a query parameter, never
 *    a token. The panel's identity is settled before its first paint.
 *
 * 2. Its main data source is a TOOL, not a fetch: `POST /mcp` is
 *    credentialed and therefore deliberately has no CORS header
 *    (`http.ts`'s `setPublicCorsHeader` doc), so the panel asks the HOST to
 *    call `rendezvous_list`/`rendezvous_send` with the credential the host
 *    already holds. That is what `CallToolRequest`-in-`AppRequest` is for in
 *    `@modelcontextprotocol/ext-apps`. No token ever enters this iframe, no
 *    second write path exists, and `/rooms/:code/send` stays exactly as it
 *    is. The bridge below is hand-rolled for the same reason the MCP servers
 *    in this repo are: it is a handshake and two message shapes, and the
 *    build brief forbids new dependencies. It is ground-truthed against
 *    `ext-apps`' own `App`/`PostMessageTransport`: a JSON-RPC 2.0
 *    `ui/initialize` request to `window.parent`, then the
 *    `ui/notifications/initialized` notification, then `tools/call`.
 *
 * 3. The per-room ROSTER ("who is there") is a second, AUTH-FREE fetch of
 *    `GET /r/:code/state` — the spectator projection that already carries
 *    members and already has the CORS header for exactly this
 *    (`http.ts`'s two-route allowlist). `rendezvous_list` returns counts on
 *    purpose; expanding a row is what asks for names. No new route, no new
 *    credential.
 *
 * The pure view functions below are embedded into the browser script via
 * `toString()` — `src/web/page.ts`'s established pattern, so the shipped
 * panel and the tests run the SAME code. Each must survive `toString()`
 * with no free references except the other functions the script defines
 * alongside it.
 */
import { SIZE_CHANGED_METHOD, embedJson, escapeHtml } from "../web/page.ts"

/** The MCP Apps protocol version this panel handshakes with, matching
 *  `ext-apps`' own `LATEST_PROTOCOL_VERSION`. A host that negotiates a
 *  different one still answers `ui/initialize`; nothing below depends on the
 *  value coming back. */
const APP_PROTOCOL_VERSION = "2026-01-26"

const LOADING_TEXT = "Loading…"
const NO_ROOMS_TEXT = "You are in no rooms yet."
const ROSTER_LOADING_TEXT = "asking the room who is there…"
const ROSTER_UNREACHABLE_TEXT = "could not reach that room — no roster to show"

/** Surfaced verbatim, at the top, in words (BRIEF-19): one address holding a
 *  membership in more than one room at once is BRIEF-13's R1 invariant
 *  broken. The panel says so rather than sorting it away — an ambiguity
 *  rendered as a tidy list is the same silent pick this project exists to
 *  end. */
const AMBIGUOUS_TEXT =
  "This address is in more than one room at once. That is a broken invariant, not a feature: no room below is marked active, because there is no honest way to pick one."

/** Absence must never read as delivery: a poll that fails must be VISIBLE,
 *  not silently skipped on the next tick. Same rule and same threshold as
 *  `room-view.html.ts` — one dropped poll is noise on a 3s cadence, three in
 *  a row is the panel actually losing contact — and cleared on the very next
 *  success. */
export const FAILURES_BEFORE_WARNING = 3
const LOST_CONTACT_TEXT = "lost contact with the host — this list may be stale"

/** The class that REVEALS a banner the stylesheet hides by default; `""`
 *  leaves it hidden. This is not a style preference: `el.style.display = ""`
 *  does NOT show an element the stylesheet declares `display: none` — it only
 *  removes the inline declaration, so the stylesheet's `none` wins and the
 *  banner could never draw. Visibility must be a class the stylesheet knows
 *  how to reveal (`#ambiguous.visible`, `#connection-lost.visible`). */
export const bannerVisibilityClass = (visible: boolean): string => (visible ? "visible" : "")

/** The banner class for a plan: the payload's `ambiguous` carried straight
 *  through, never re-derived. */
export const planBannerClass = (plan: { readonly ambiguous: boolean }): string => bannerVisibilityClass(plan.ambiguous)

/** Whether the "lost contact" banner has earned its place after this many
 *  consecutive failed polls. */
export const lostContactVisible = (consecutiveFailures: number): boolean => consecutiveFailures >= FAILURES_BEFORE_WARNING

/** The pieces of a DOM element the shared row renderer is allowed to touch.
 *  Deliberately narrow: a real `HTMLElement` satisfies it, and the test's
 *  fake document can record every call. `setAttribute` is present so the
 *  amendment-1 test can assert it is NEVER called for the room identity —
 *  a guarantee an absent method would only make invisibly. */
export interface PanelElement {
  className: string
  textContent: string
  appendChild(child: PanelElement): void
  setAttribute(name: string, value: string): void
}

export interface PanelDocument {
  createElement(tag: string): PanelElement
}

/** One room as `rendezvous_list` reports it. Every field optional: this is
 *  parsed from a tool result that crossed a host, and a missing field must
 *  degrade to a visible "we do not know", never to a confident wrong value. */
export interface RosterListRoom {
  readonly code?: string
  /** BRIEF-20: the room's NAME. This is the only room identifier the panel
   *  may render; `code` above is the join capability and stays in JS values. */
  readonly slug?: string
  readonly memberId?: string
  readonly displayName?: string
  readonly tier?: string
  readonly presence?: string
  readonly presenceBasis?: string
  readonly memberCount?: number
  readonly unread?: number
  readonly active?: boolean
  readonly lastActivityAt?: string
}

export interface RosterListPayload {
  readonly rooms?: readonly RosterListRoom[]
  readonly ambiguous?: boolean
}

/** How one room's presence renders. `kind` drives the CSS class, `label`
 *  is the word next to the marker — they move together on purpose. */
export interface PresenceView {
  readonly kind: string
  readonly label: string
}

export interface RosterRowView {
  /** The room CODE: the capability. Used to fetch the room's roster from
   *  `/r/:code/state` — NEVER rendered, never written into the DOM. It stays
   *  in a JS value, which is why amendment 1 survives a screenshot. It is
   *  supplied by the host-only `_meta` (BRIEF-24), never by the model-visible
   *  text payload, and is NO LONGER what addresses a send. */
  readonly code: string
  /** The room SLUG: the name. This is what `rendezvous_send` takes (BRIEF-24)
   *  — a send addresses the room by name, never by the join capability. */
  readonly slug: string
  /** What the row SHOWS for this room — see `roomIdentityLabel`. */
  readonly identity: string
  readonly presence: PresenceView
  readonly memberCount: number
  /** "" when there is nothing unread: 0 renders as NOTHING, not as "0". */
  readonly unreadLabel: string
  readonly active: boolean
  /** Your own display name in that room — whose voice a send would use. */
  readonly displayName: string
}

export interface RosterPlan {
  readonly ambiguous: boolean
  readonly rows: readonly RosterRowView[]
}

/**
 * AMENDMENT 1 — the SINGLE accessor for a room's on-screen identity, and the
 * only place in this panel that decides what a room is CALLED.
 *
 * A room code is today both the room's name and the capability to enter it;
 * that is why no `/rooms` index exists. A screenshot of a panel that lists
 * your room codes hands out entry to every one of those rooms. The panel is
 * a directory, and it must not be a keyring.
 *
 * BRIEF-20 splits the two into a non-secret `slug` (the name) and a
 * rotatable `code` (the entry capability). When it lands, this function's
 * BODY becomes `return room.slug ?? ""` and NOTHING else in this file
 * changes — that is the whole point of routing every render through here.
 *
 * The other half of amendment 1 lives in `renderRosterRow`: whatever this
 * returns is rendered as plain text and nothing else. No copy button, no
 * link, no QR, no `href`, no `data-` attribute — those affordances are
 * exactly what turns a displayed identity into a one-click join.
 */
export const roomIdentityLabel = (room: { readonly slug?: string }): string => {
  // BRIEF-20 swapped this body, as this comment block anticipated. It reads
  // the SLUG — the room's name, safe to print, forward and screenshot — and
  // deliberately does NOT fall back to `code` when the slug is missing: a
  // fallback would restore the very leak the split removed, silently, on
  // exactly the rooms whose data is oldest. A room with no slug renders as
  // unnamed, which is visibly wrong and therefore gets fixed.
  return typeof room.slug === "string" ? room.slug : ""
}

/**
 * THE HONEST DOT.
 *
 * `presenceBasis: "never-acked"` means the member has never acknowledged
 * anything, so their `presence` is dated from when they joined and is not a
 * reading of anything. It renders as UNKNOWN — a hollow marker and the word
 * "unknown" — never as a grey "away" dot. A grey dot that means "we have no
 * idea" is an absence of information wearing the costume of a measurement,
 * the exact defect this project has spent its whole life removing.
 *
 * BRIEF-14 landed, so members really do ack and this arm should rarely fire
 * in practice. It stays as the regression test, not as dead code: do not
 * delete it because you cannot make it appear by hand.
 *
 * Anything that is not an explicit `"acked"` — including a missing field
 * from an older server — is unknown too, deliberately. The degradation
 * direction for "we are not sure" is never "present" and never "away".
 */
export const presenceViewOf = (room: { readonly presence?: string; readonly presenceBasis?: string }): PresenceView => {
  if (room.presenceBasis !== "acked") return { kind: "unknown", label: "unknown" }
  if (room.presence === "away") return { kind: "away", label: "away" }
  return { kind: "present", label: "present" }
}

/** 0 unread renders as NOTHING, not as "0" (BRIEF-19). A zero badge is
 *  visual noise that says the same thing as blank space, and a non-number
 *  (a field an older server did not send) is not a zero — it is also
 *  nothing, because we do not know. */
export const unreadLabelOf = (unread: number | undefined): string => {
  if (typeof unread !== "number" || !(unread > 0)) return ""
  return String(unread)
}

/** The panel's whole view model, derived in one place from one tool result.
 *  `ambiguous` is carried through untouched — the banner is the payload's,
 *  not a heuristic. */
export const planRosterRows = (payload: RosterListPayload): RosterPlan => {
  const rooms = payload.rooms === undefined || payload.rooms === null ? [] : payload.rooms
  const rows: RosterRowView[] = []
  for (const room of rooms) {
    if (room === undefined || room === null) continue
    if (typeof room.code !== "string" || room.code.length === 0) continue
    rows.push({
      code: room.code,
      // BRIEF-24: the slug addresses a send; it arrives in the text payload.
      slug: typeof room.slug === "string" ? room.slug : "",
      // AMENDMENT 1: the one and only call site per render.
      identity: roomIdentityLabel(room),
      presence: presenceViewOf(room),
      memberCount: typeof room.memberCount === "number" ? room.memberCount : 0,
      unreadLabel: unreadLabelOf(room.unread),
      active: room.active === true,
      displayName: typeof room.displayName === "string" ? room.displayName : "",
    })
  }
  return { ambiguous: payload.ambiguous === true, rows }
}

/** BRIEF-24: the room join CODE is the capability, so it left the
 *  model-visible `content[0].text` and moved to the tool result's `_meta`,
 *  which reaches the HOST's app and not the model's context. This re-attaches
 *  each code to its room by slug, so the panel can still fetch
 *  `/r/:code/state`. A caller that forwards no `_meta` (or an older server's
 *  result) gets the payload back unchanged — rooms with no code, which
 *  `planRosterRows` renders as no row: an honest "cannot expand this", never a
 *  guessed code. */
export const mergeRoomCodes = (
  payload: RosterListPayload,
  meta: { readonly rooms?: readonly RosterListRoom[] } | undefined,
): RosterListPayload => {
  const rooms = payload.rooms
  if (rooms === undefined || rooms === null) return payload
  const metaRooms = meta === undefined || meta.rooms === undefined || meta.rooms === null ? [] : meta.rooms
  return {
    ...payload,
    rooms: rooms.map((room) => {
      if (room === undefined || room === null) return room
      const source = metaRooms.find((candidate) => candidate !== undefined && candidate !== null && candidate.slug === room.slug)
      if (source === undefined || typeof source.code !== "string") return room
      return { ...room, code: source.code }
    }),
  }
}

/** One incoming JSON-RPC message, as far as the panel classifies it: enough
 *  to tell a RESPONSE (an `id`, no `method`) from a REQUEST or notification
 *  (a `method`). Every field optional because this is `event.data` off a
 *  postMessage boundary, which is not this panel's to trust. */
export interface HostMessage {
  readonly jsonrpc?: string
  readonly id?: number | null
  readonly method?: string | null
}

/**
 * FIX 1 — a request is not a response.
 *
 * A JSON-RPC message carrying a `method` is a REQUEST (or a notification);
 * only a message with an `id` and no `method` may settle a pending call.
 * `hostRequest` posts `ui/initialize` to `window.parent`; in standalone mode
 * `window.parent === window`, so that request echoed straight back into this
 * panel's own listener, every old guard passed, and `message.result` — which
 * is `undefined` on a request — was resolved as a successful answer. The
 * list then read as "You are in no rooms yet." with zero errors.
 *
 * agentproto's own bridge requires the same: `panel-bridge.ts`'s
 * `if (msg.id != null && msg.method == null)` before it looks up the waiter.
 * A message that is not a response returns `false`, the waiter stays
 * pending, and the poll loop fails visibly.
 */
export const isHostResponse = (message: HostMessage | null): boolean => {
  if (message === null || typeof message !== "object") return false
  if (message.jsonrpc !== "2.0") return false
  if (message.id === undefined || message.id === null) return false
  return message.method === undefined || message.method === null
}

/** One content block of a `CallToolResult`, as far as this panel reads it. */
export interface ToolContentBlock {
  readonly text?: string
}

/** The slice of a `CallToolResult` the panel unwraps: the first text block is
 *  the tools' JSON, and `_meta` is the host-only channel that carries each
 *  room's join code (BRIEF-24). The whole envelope — including `_meta` — is
 *  what the standalone REST bridge resolves with, verbatim. */
export interface ToolCallResult {
  readonly isError?: boolean
  readonly content?: readonly ToolContentBlock[]
  readonly _meta?: { readonly rooms?: readonly RosterListRoom[] }
}

/** FIX 2 — the object the standalone REST bridge resolves
 *  (`app-ui-apps.ts`'s STANDALONE_REST_BRIDGE_SCRIPT). Its `callTool` takes
 *  TWO POSITIONALS, `(name, args)` — unlike this panel's own single
 *  `{name, arguments}` object. Getting that translation wrong is how the
 *  standalone path stays broken while looking wired. */
export interface StandaloneConnection {
  readonly callTool: (name: string, args: Readonly<Record<string, string>>) => Promise<ToolCallResult>
}

/** `window.McpApp` itself: only `connect` is read here, and it may be absent
 *  (the VS Code webview relay answers postMessage directly and defines no
 *  `McpApp`). */
export interface StandaloneApp {
  readonly connect?: () => Promise<StandaloneConnection>
}

/** Unwrap a `CallToolResult` into the JSON its tools returned, re-attaching
 *  the host-only `_meta` codes by slug (BRIEF-24). Extracted as a pure
 *  function so the shipped script and the tests run the SAME unwrap: a
 *  `_meta`-carrying body must survive the standalone `callTool` path for
 *  `mergeRoomCodes` to see it. */
export const toolPayload = (result: ToolCallResult | null | undefined): RosterListPayload => {
  // A CallToolResult's first text block is the JSON these tools return
  // (ids, counts and slugs only — mcp-personal.ts's file-top HARD RULE).
  if (result === null || result === undefined || typeof result !== "object") return {}
  const content = result.content
  if (!Array.isArray(content) || content.length === 0) return {}
  const first = content[0]
  if (first === undefined || first === null || typeof first !== "object" || typeof first.text !== "string") return {}
  let payload: RosterListPayload
  try {
    payload = JSON.parse(first.text)
  } catch {
    return {}
  }
  return mergeRoomCodes(payload, result._meta)
}

/** FIX 2 — standalone detection, exactly agentproto's two conditions
 *  (`panel-bridge.ts:92-94`): there is no host to `postMessage` (`parent` IS
 *  this window) AND the standalone REST bridge is present with the `connect`
 *  function this panel needs. `window.McpApp` alone is NOT sufficient — the
 *  direct postMessage path is real, and `parent` is the load-bearing signal.
 *  Passed the two facts rather than the window so the shipped script and the
 *  tests evaluate the identical predicate. */
export const isStandaloneBridge = (parentIsSelf: boolean, mcpApp: StandaloneApp | null | undefined): boolean => {
  if (parentIsSelf !== true) return false
  if (mcpApp === null || mcpApp === undefined) return false
  return typeof mcpApp.connect === "function"
}

/** FIX 2 — translate this panel's one `{name, arguments}` object into the
 *  standalone connection's two positionals `(name, args)`, and hand back the
 *  body whole so `_meta` survives to `toolPayload`. */
export const standaloneCallTool = (
  connection: StandaloneConnection,
  params: { readonly name: string; readonly arguments?: Readonly<Record<string, string>> },
): Promise<ToolCallResult> => {
  return connection.callTool(params.name, params.arguments === undefined ? {} : params.arguments)
}

/** Append one row's data-bearing HEAD — presence marker, identity, and the
 *  active/unread badges — to an existing container. Split out of
 *  `renderRosterRow` so a poll can REFRESH these parts in place without
 *  touching the row's live controls (the message input, the expanded roster,
 *  the send-note) — see `diffRosterRows`. Everything here is `textContent` on
 *  an element whose only other property is a `className`: no attribute is
 *  ever set, so the room identity cannot end up in an `href`, a `data-*`, or
 *  a copy target (amendment 1). */
export const appendRosterRowHead = (doc: PanelDocument, head: PanelElement, row: RosterRowView): void => {
  const dot = doc.createElement("span")
  dot.className = "dot dot-" + row.presence.kind
  head.appendChild(dot)

  const identity = doc.createElement("span")
  identity.className = "identity"
  identity.textContent = row.identity
  head.appendChild(identity)

  if (row.active) {
    const active = doc.createElement("span")
    active.className = "badge badge-active"
    active.textContent = "active"
    head.appendChild(active)
  }

  if (row.unreadLabel !== "") {
    const unread = doc.createElement("span")
    unread.className = "badge badge-unread"
    unread.textContent = row.unreadLabel
    head.appendChild(unread)
  }
}

/** Append one row's data-bearing META — the presence word, the member count,
 *  and your own display name in that room. See `appendRosterRowHead`. */
export const appendRosterRowMeta = (doc: PanelDocument, meta: PanelElement, row: RosterRowView): void => {
  const presence = doc.createElement("span")
  presence.className = "presence presence-" + row.presence.kind
  presence.textContent = "you: " + row.presence.label
  meta.appendChild(presence)

  const members = doc.createElement("span")
  members.className = "member-count"
  members.textContent = row.memberCount === 1 ? "1 member" : String(row.memberCount) + " members"
  meta.appendChild(members)

  if (row.displayName !== "") {
    const name = doc.createElement("span")
    name.className = "you-as"
    name.textContent = "as " + row.displayName
    meta.appendChild(name)
  }
}

/** One row's PRESENTATION, shared by the shipped panel and the tests. The
 *  interactive controls (expand, send) are appended by the script AFTER this,
 *  and they close over `row.code`/`row.slug` rather than reading them back out
 *  of the DOM. */
export const renderRosterRow = (doc: PanelDocument, row: RosterRowView): PanelElement => {
  const el = doc.createElement("div")
  el.className = row.active ? "room active" : "room"

  const head = doc.createElement("div")
  head.className = "room-head"
  appendRosterRowHead(doc, head, row)
  el.appendChild(head)

  const meta = doc.createElement("div")
  meta.className = "room-meta"
  appendRosterRowMeta(doc, meta, row)
  el.appendChild(meta)
  return el
}

/** Whether a kept room's RENDERED fields moved between two polls. `code` is
 *  not rendered and `slug` IS the identity, so neither repaint; everything
 *  `appendRosterRowHead`/`appendRosterRowMeta` draw does. */
export const rosterRowDataChanged = (previous: RosterRowView, next: RosterRowView): boolean => {
  return (
    previous.identity !== next.identity ||
    previous.presence.kind !== next.presence.kind ||
    previous.presence.label !== next.presence.label ||
    previous.memberCount !== next.memberCount ||
    previous.unreadLabel !== next.unreadLabel ||
    previous.active !== next.active ||
    previous.displayName !== next.displayName
  )
}

/** A kept room: its row element is REUSED, its data parts repainted only when
 *  `dataChanged`. */
export interface KeptRosterRow {
  readonly row: RosterRowView
  readonly dataChanged: boolean
}

/** The pure diff between the previous and next plans, keyed by room SLUG
 *  (BRIEF-20: the slug identifies the room; the code admits). The script uses
 *  this to update the list rather than rebuild it, so a poll cannot destroy
 *  the input a person is typing in, collapse an expanded roster, or wipe a
 *  send-note. A gone room is removed — its draft is lost, which is correct:
 *  keeping a stale row to preserve a draft would let an unsent message LOOK
 *  sent. */
export interface RosterRowDiff {
  readonly removed: readonly string[]
  readonly added: readonly RosterRowView[]
  readonly kept: readonly KeptRosterRow[]
}

export const diffRosterRows = (previous: readonly RosterRowView[], next: readonly RosterRowView[]): RosterRowDiff => {
  const previousBySlug = new Map<string, RosterRowView>()
  for (const row of previous) previousBySlug.set(row.slug, row)

  const nextSlugs = new Set<string>()
  for (const row of next) nextSlugs.add(row.slug)

  const removed: string[] = []
  for (const row of previous) {
    if (!nextSlugs.has(row.slug)) removed.push(row.slug)
  }

  const added: RosterRowView[] = []
  const kept: KeptRosterRow[] = []
  for (const row of next) {
    const before = previousBySlug.get(row.slug)
    if (before === undefined) added.push(row)
    else kept.push({ row, dataChanged: rosterRowDataChanged(before, row) })
  }
  return { removed, added, kept }
}

const STYLE = `
  :root { --accent: #3a6df0; --border: #e2e4ea; --bg: #fafafc; --grey: #6b7280; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; color: #1a1c23; background: var(--bg); }
  header { padding: 12px 14px; border-bottom: 1px solid var(--border); background: #fff; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  header h1 { margin: 0; font-size: 16px; font-weight: 700; }
  .principal { font-size: 12px; color: var(--grey); font-weight: 600; }
  #connection-lost { color: #b42318; font-weight: 600; font-size: 12px; padding: 6px 14px; display: none; background: #fdeaea; border-bottom: 1px solid #f2c4c0; }
  #ambiguous { color: #92400e; font-weight: 600; font-size: 12px; padding: 8px 14px; display: none; background: #fef3c7; border-bottom: 1px solid #fcd34d; }
  /* The only thing that may reveal either banner. An id+class selector so it
     beats each id's own display: none above — a bare .visible would lose
     to the id. */
  #connection-lost.visible, #ambiguous.visible { display: block; }
  main { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
  .room { border: 1px solid var(--border); border-radius: 10px; background: #fff; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
  .room.active { border-color: var(--accent); }
  .room-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .identity { font-family: ui-monospace, monospace; font-size: 15px; font-weight: 700; color: #1a1c23; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .dot-present { background: #1a7f37; }
  .dot-away { background: #b42318; }
  /* The honest dot: hollow, never filled — "we have no idea" must not look
     like a reading. Paired with the word "unknown" in .presence. */
  .dot-unknown { background: transparent; border: 1px dashed var(--grey); }
  .badge { font-size: 10px; padding: 1px 7px; border-radius: 999px; font-weight: 700; }
  .badge-active { background: #eef1fb; color: var(--accent); }
  .badge-unread { background: #1a1c23; color: #fff; }
  .room-meta { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--grey); }
  .presence-unknown { font-style: italic; }
  .room-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .room-actions button { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border); background: #fff; color: #1a1c23; cursor: pointer; }
  .room-actions input { font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--border); flex: 1 1 160px; min-width: 120px; }
  .room-roster { font-size: 12px; color: var(--grey); }
  .room-roster .peer { display: inline-flex; align-items: center; gap: 4px; margin: 0 10px 4px 0; }
  .room-roster .peer-name { font-weight: 600; color: #1a1c23; }
  .room-roster .peer-away { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: #fdeaea; color: #b42318; font-weight: 700; }
  .send-note { font-size: 12px; font-weight: 600; }
  .send-note.bad { color: #b42318; }
  .send-note.good { color: #1a7f37; }
  #empty { font-size: 13px; color: var(--grey); }
`

function script(principalLabel: string, publicUrl: string): string {
  return `
    const PRINCIPAL_LABEL = ${embedJson(principalLabel)};
    const PUBLIC_URL = ${embedJson(publicUrl)};
    const APP_PROTOCOL_VERSION = ${embedJson(APP_PROTOCOL_VERSION)};
    const SIZE_CHANGED_METHOD = ${embedJson(SIZE_CHANGED_METHOD)};
    const AMBIGUOUS_TEXT = ${embedJson(AMBIGUOUS_TEXT)};
    const NO_ROOMS_TEXT = ${embedJson(NO_ROOMS_TEXT)};
    const ROSTER_LOADING_TEXT = ${embedJson(ROSTER_LOADING_TEXT)};
    const ROSTER_UNREACHABLE_TEXT = ${embedJson(ROSTER_UNREACHABLE_TEXT)};
    const LOST_CONTACT_TEXT = ${embedJson(LOST_CONTACT_TEXT)};
    const FAILURES_BEFORE_WARNING = ${embedJson(FAILURES_BEFORE_WARNING)};

    // Embedded from this module via toString() (src/web/page.ts's pattern):
    // the shipped panel and test/service/roster-panel.test.ts run the SAME
    // code, so a test that proves "never-acked renders unknown" proves it
    // about what actually ships.
    const roomIdentityLabel = ${roomIdentityLabel.toString()};
    const presenceViewOf = ${presenceViewOf.toString()};
    const unreadLabelOf = ${unreadLabelOf.toString()};
    const planRosterRows = ${planRosterRows.toString()};
    const mergeRoomCodes = ${mergeRoomCodes.toString()};
    const bannerVisibilityClass = ${bannerVisibilityClass.toString()};
    const planBannerClass = ${planBannerClass.toString()};
    const lostContactVisible = ${lostContactVisible.toString()};
    const isHostResponse = ${isHostResponse.toString()};
    const toolPayload = ${toolPayload.toString()};
    const isStandaloneBridge = ${isStandaloneBridge.toString()};
    const standaloneCallTool = ${standaloneCallTool.toString()};
    const appendRosterRowHead = ${appendRosterRowHead.toString()};
    const appendRosterRowMeta = ${appendRosterRowMeta.toString()};
    const rosterRowDataChanged = ${rosterRowDataChanged.toString()};
    const diffRosterRows = ${diffRosterRows.toString()};
    const renderRosterRow = ${renderRosterRow.toString()};

    const roomsEl = document.getElementById("rooms");
    const emptyEl = document.getElementById("empty");
    const ambiguousEl = document.getElementById("ambiguous");
    const connectionEl = document.getElementById("connection-lost");

    // --- The host bridge. JSON-RPC 2.0 over postMessage to window.parent,
    // the transport @modelcontextprotocol/ext-apps' own PostMessageTransport
    // speaks. Hand-rolled for the same reason this repo's MCP servers are:
    // a handshake and two message shapes do not justify a dependency, and
    // the build brief forbids new ones.
    const pending = new Map();
    let nextRequestId = 1;

    window.addEventListener("message", function (event) {
      if (event.source !== window.parent) return;
      const message = event.data;
      // FIX 1: a message carrying a "method" is a REQUEST, never a response.
      // In standalone mode (window.parent === window) this panel's own
      // request echoes back here; the old guard read it as a successful
      // empty answer. See isHostResponse.
      if (!isHostResponse(message)) return;
      const waiter = pending.get(message.id);
      if (waiter === undefined) return;
      pending.delete(message.id);
      if (message.error) {
        // The host forwards the server's refusal verbatim — a membership
        // refusal must reach the person who typed, never be swallowed into
        // a generic "failed".
        waiter.reject(new Error(message.error.message || "the host refused the call"));
        return;
      }
      waiter.resolve(message.result);
    });

    function hostNotify(method, params) {
      window.parent.postMessage({ jsonrpc: "2.0", method: method, params: params }, "*");
    }

    function hostRequest(method, params) {
      const id = nextRequestId++;
      return new Promise(function (resolve, reject) {
        pending.set(id, { resolve: resolve, reject: reject });
        window.parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params }, "*");
        // A host that never answers must surface as a failure, not as a
        // panel that sits on "Loading…" forever.
        setTimeout(function () {
          if (pending.delete(id)) reject(new Error("the host did not answer " + method));
        }, 15000);
      });
    }

    let standaloneConnection = null;

    const app = {
      connect: async function () {
        // FIX 2: in standalone mode there is no host to handshake with.
        // window.McpApp IS the bridge; take its connect() and send NOTHING —
        // no ui/initialize, no ui/notifications/initialized, nobody to
        // receive either.
        if (isStandaloneBridge(window.parent === window, window.McpApp)) {
          standaloneConnection = await window.McpApp.connect();
          return;
        }
        await hostRequest("ui/initialize", {
          appInfo: { name: "rendezvous-roster", version: "1.0.0" },
          appCapabilities: {},
          protocolVersion: APP_PROTOCOL_VERSION,
        });
        hostNotify("ui/notifications/initialized", {});
      },
      // The server call the host makes on our behalf, with the credential it
      // already holds: no token in this iframe, no CORS to open, no second
      // write path. This is CallToolRequest-in-AppRequest. In standalone mode
      // the same call routes through window.McpApp, whose callTool takes two
      // positionals (name, args) — standaloneCallTool does that translation.
      callTool: function (params) {
        if (standaloneConnection !== null) {
          return standaloneCallTool(standaloneConnection, params);
        }
        return hostRequest("tools/call", params);
      },
    };

    // --- Per-room roster: the SECOND fetch, auth-free, straight at the
    // spectator projection. It uses the room CODE because the code IS the
    // capability to read that room — correct, and untouched by amendment 1,
    // which is about what is DISPLAYED, not about what addresses a request.
    async function loadRoster(code, target) {
      target.textContent = ROSTER_LOADING_TEXT;
      try {
        const res = await fetch(PUBLIC_URL + "/r/" + encodeURIComponent(code) + "/state");
        if (!res.ok) throw new Error("state fetch failed: " + res.status);
        const state = await res.json();
        const members = Array.isArray(state.members) ? state.members : [];
        target.textContent = "";
        if (members.length === 0) {
          target.textContent = "No one here yet.";
          return;
        }
        members.forEach(function (m) {
          const peer = document.createElement("span");
          peer.className = "peer";
          const name = document.createElement("span");
          name.className = "peer-name";
          name.textContent = typeof m.displayName === "string" ? m.displayName : "?";
          peer.appendChild(name);
          const tier = document.createElement("span");
          tier.textContent = typeof m.tier === "string" ? m.tier : "";
          peer.appendChild(tier);
          if (m.away === true) {
            const away = document.createElement("span");
            away.className = "peer-away";
            away.textContent = "away";
            peer.appendChild(away);
          }
          target.appendChild(peer);
        });
      } catch (e) {
        // Visible, not silent: a roster we could not read is not an empty
        // room.
        target.textContent = ROSTER_UNREACHABLE_TEXT;
      }
    }

    function addActions(el, row) {
      const actions = document.createElement("div");
      actions.className = "room-actions";

      const roster = document.createElement("div");
      roster.className = "room-roster";

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.textContent = "who is there";
      let open = false;
      toggle.addEventListener("click", function () {
        open = !open;
        if (!open) {
          roster.textContent = "";
          return;
        }
        // row.code, from the closure — never read back out of the DOM.
        loadRoster(row.code, roster);
      });
      actions.appendChild(toggle);

      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "send a message…";
      actions.appendChild(input);

      const note = document.createElement("div");
      note.className = "send-note";

      const send = document.createElement("button");
      send.type = "button";
      send.textContent = "send";
      const doSend = async function () {
        const text = input.value.trim();
        if (text.length === 0) return;
        send.disabled = true;
        note.className = "send-note";
        note.textContent = "sending…";
        try {
          const result = await app.callTool({
            name: "rendezvous_send",
            // BRIEF-24: the send addresses the room by SLUG, never by the
            // join code — the code is read-only here, for the state fetch.
            arguments: { roomSlug: row.slug, text: text },
          });
          const payload = toolPayload(result);
          if (result && result.isError === true) throw new Error("the room refused that message");
          input.value = "";
          note.className = "send-note good";
          note.textContent = "sent" + (typeof payload.outcome === "string" ? " (" + payload.outcome + ")" : "");
        } catch (e) {
          // The refusal is shown WORD FOR WORD. A read-only credential and
          // a room you are not in are different answers, and collapsing
          // them into "could not send" is how a person learns nothing.
          note.className = "send-note bad";
          note.textContent = e && e.message ? e.message : "could not send";
        } finally {
          send.disabled = false;
        }
      };
      send.addEventListener("click", doSend);
      input.addEventListener("keydown", function (event) {
        if (event.key === "Enter") doSend();
      });
      actions.appendChild(send);

      el.appendChild(actions);
      el.appendChild(note);
      el.appendChild(roster);
    }

    // FIX: the poll UPDATES the list instead of rebuilding it. Rebuilding
    // destroyed the input a person was typing in, collapsed the "who is there"
    // roster, and wiped any send-note — every 3 seconds. Each row keeps its
    // live DOM in a record keyed by room SLUG (BRIEF-20: the slug identifies
    // the room); only the data-bearing head and meta are repainted, and only
    // when the data actually changed. A gone room's row is removed outright —
    // an unsent draft must never be kept alive to look sent.
    const rowRecords = new Map();

    function createRowRecord(row) {
      const el = renderRosterRow(document, row);
      // renderRosterRow appends head then meta; keep them so a later poll can
      // refresh those two parts without touching the interactive children.
      const head = el.children[0];
      const meta = el.children[1];
      addActions(el, row);
      const record = { el: el, head: head, meta: meta, row: row };
      rowRecords.set(row.slug, record);
      return record;
    }

    function refreshRowRecord(record, row) {
      record.el.className = row.active ? "room active" : "room";
      record.head.textContent = "";
      appendRosterRowHead(document, record.head, row);
      record.meta.textContent = "";
      appendRosterRowMeta(document, record.meta, row);
      record.row = row;
    }

    function applyPlan(plan) {
      const previousRows = [];
      rowRecords.forEach(function (record) {
        previousRows.push(record.row);
      });
      const diff = diffRosterRows(previousRows, plan.rows);

      diff.removed.forEach(function (slug) {
        const record = rowRecords.get(slug);
        if (record === undefined) return;
        if (record.el.parentNode) record.el.parentNode.removeChild(record.el);
        rowRecords.delete(slug);
      });

      diff.kept.forEach(function (kept) {
        const record = rowRecords.get(kept.row.slug);
        if (record === undefined) return;
        if (kept.dataChanged) refreshRowRecord(record, kept.row);
        else record.row = kept.row;
      });

      diff.added.forEach(function (row) {
        createRowRecord(row);
      });

      // Order the rows to the plan WITHOUT moving one that is already in
      // place: re-inserting the element that holds the focused input would
      // blur it and drop the caret. Only an actual order change moves a node.
      let anchor = roomsEl.firstChild;
      plan.rows.forEach(function (row) {
        const record = rowRecords.get(row.slug);
        if (record === undefined) return;
        if (record.el !== anchor) roomsEl.insertBefore(record.el, anchor);
        anchor = record.el.nextSibling;
      });
    }

    function renderPlan(plan) {
      ambiguousEl.className = planBannerClass(plan);
      emptyEl.textContent = plan.rows.length === 0 ? NO_ROOMS_TEXT : "";
      applyPlan(plan);
    }

    let consecutiveFailures = 0;

    async function pollRooms() {
      try {
        const result = await app.callTool({ name: "rendezvous_list", arguments: {} });
        consecutiveFailures = 0;
        connectionEl.className = bannerVisibilityClass(false);
        renderPlan(planRosterRows(toolPayload(result)));
      } catch (e) {
        consecutiveFailures += 1;
        if (lostContactVisible(consecutiveFailures)) {
          connectionEl.className = bannerVisibilityClass(true);
        }
      }
    }

    // BRIEF-05: this panel's content is its own DOM, so it measures itself.
    // Omitting this is not cosmetic — it renders the panel as a ~20px strip.
    // A host that ignores or blocks the notification must be no worse off
    // than today, so the send is guarded.
    let lastWidth;
    let lastHeight;
    function reportSize() {
      const width = Math.ceil(document.documentElement.getBoundingClientRect().width);
      const height = Math.ceil(document.documentElement.scrollHeight);
      if (width === lastWidth && height === lastHeight) return;
      lastWidth = width;
      lastHeight = height;
      try {
        window.parent.postMessage({ jsonrpc: "2.0", method: SIZE_CHANGED_METHOD, params: { width: width, height: height } }, "*");
      } catch (e) {
        // guarded: see the comment above.
      }
    }

    let resizeScheduled = false;
    function scheduleReportSize() {
      if (resizeScheduled) return;
      resizeScheduled = true;
      requestAnimationFrame(function () {
        resizeScheduled = false;
        reportSize();
      });
    }

    new ResizeObserver(scheduleReportSize).observe(document.body);
    scheduleReportSize();

    // The handshake must complete before any tools/call — ext-apps' own App
    // refuses callServerTool before ui/initialize resolves. A handshake that
    // never lands leaves the poll loop running and failing VISIBLY, which is
    // the honest outcome, so the loop is started either way.
    app.connect().catch(function () {});
    setInterval(pollRooms, 3000);
    pollRooms();
  `
}

/** The principal, as one line a person recognises. Built here, once, so the
 *  header and the embedded constant can never disagree. `displayName` is the
 *  name the rooms know this address by; it is absent for an address that is
 *  in no room at all, and the provider/contactRef pair is then the only
 *  honest thing to show. */
export function principalLabelOf(principal: {
  readonly provider: string
  readonly contactRef: string
  readonly displayName: string | undefined
}): string {
  const who = principal.displayName === undefined || principal.displayName === "" ? principal.contactRef : principal.displayName
  return `${who} · ${principal.provider} · ${principal.contactRef}`
}

/**
 * Renders the roster panel. The principal is BAKED IN, resolved from the
 * bearer by `resources/read` — not a query parameter, not a postMessage
 * handshake, not a new auth surface, and above all not a token: nothing in
 * the bytes below can be replayed as a credential.
 *
 * `publicUrl` is `env.publicUrl` (baked in, not looked up client-side): a
 * host's sandboxed iframe cannot resolve a bare path, and the CSP
 * `connectDomains` its host wraps around this document must name the exact
 * origin the per-room roster fetch below targets.
 */
export function rosterPanelHtml(
  principal: { readonly provider: string; readonly contactRef: string; readonly displayName: string | undefined },
  publicUrl: string,
): string {
  const label = principalLabelOf(principal)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Rendez-vous — your rooms</title>
<style>${STYLE}</style>
</head>
<body>
<div id="connection-lost">${escapeHtml(LOST_CONTACT_TEXT)}</div>
<div id="ambiguous">${escapeHtml(AMBIGUOUS_TEXT)}</div>
<header>
  <h1>Your rooms</h1>
  <span class="principal">${escapeHtml(label)}</span>
</header>
<main>
  <div id="empty">${LOADING_TEXT}</div>
  <div id="rooms"></div>
</main>
<script>${script(label, publicUrl)}</script>
</body>
</html>
`
}
