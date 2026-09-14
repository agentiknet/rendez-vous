/**
 * The tier-3 room web view: one static HTML page per room, inline CSS and
 * inline vanilla JS, no framework and no build step (build brief
 * constraint 3, architecture.md §2.1). The browser talks only to our
 * service — never the daemon directly (R6, architecture.md §4.2).
 *
 * The page server-renders the room's current state (code, state pill,
 * members with tier badges, agent status, artifact) so it is never blank
 * before JS, then a small polling loop patches the DOM from
 * `GET /r/:code/state` every 3 s — never a full reload, which would wipe
 * the live transcript mid-demo.
 *
 * Spectator and member are two roles (PLAN-02 §3-D5): the transcript stream
 * above takes no name and no credential — that is what a projected display
 * is. A tab becomes a member by claiming a name (`POST /rooms/:code/claim`,
 * the one-time join secret in localStorage), after which it drains its own
 * outbox (`GET /rooms/:code/outbox`, bearer-authenticated, server-scoped).
 * A fresh tab with no name claimed is a pure spectator and works fully; it
 * receives no member token and no addressed traffic.
 */
import type { JoinLinks } from "../links/index.ts"
import { qrSvg } from "../links/index.ts"
import { type Member, type Room, deliveryModeOf, pullMemberStale } from "../rooms/types.ts"
// BRIEF-15 step 2: the two CUSTOM event names the AG-UI drain keys on, taken
// from the translation that emits them rather than re-spelled here — a typo
// in a string literal would read as "no gap" and "no kind", which is to say
// as silence.
import { GAP_EVENT_NAME, KIND_EVENT_NAME } from "../audience/agui.ts"

// Exported: the room_view MCP App panel (src/service/room-view.html.ts) is a
// sibling render with the same escaping story — one copy, two callers.
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** JSON embedded inside a `<script>` tag: escape `<` so a value containing
 *  literal `</script>` can never break out of the tag. */
export function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c")
}

// Exported: the render_artifact MCP App panel (src/service/artifact-view.html.ts,
// BRIEF-02) shows the same paused text rather than retyping the string.
export const ARTIFACT_PAUSED_TEXT = "artifact paused, the link will come back when the room wakes"

// Exported: both MCP App panels (room-view.html.ts, artifact-view.html.ts,
// BRIEF-05) hand-roll this one JSON-RPC notification method name — no
// @modelcontextprotocol/ext-apps dependency, so the exact string (read from
// that package's installed dist in the harness) lives in one place.
export const SIZE_CHANGED_METHOD = "ui/notifications/size-changed"

/** The gap notice (PLAN-02 §3-D6): a `pruned: true` outbox response means the
 *  server destroyed records the tab's cursor still points at. Never let that
 *  read as silence — rendered as its own line in the transcript. */
const OUTBOX_GAP_TEXT =
  "Some earlier messages were lost while this tab was away — the room no longer holds them."

/** Brief 14, defect 1: a tab with no name claimed is a genuine spectator —
 *  it is not a recipient and never will be until it has a name — and must
 *  say so rather than sitting there looking exactly like a live member. */
const OUTBOX_NOT_MEMBER_TEXT = "Not receiving private replies — enter your name below to join as a member."

/** Brief 14, defect 4: a `catch (e) {}` that calls the failure transient is
 *  indistinguishable from a permanent one — which is what every pull
 *  member's outbox has been, for the life of the project (docs/OUTBOX.md
 *  §1's table, last row). Surfaced once the tick has failed enough times in
 *  a row that it is no longer plausibly a single dropped packet. */
const OUTBOX_FAILURE_TEXT = "This tab can't confirm it's receiving mail — retrying, but replies may be delayed."

/** Bounded backoff for re-claiming after a lost token (brief 14, defect 2):
 *  doubles on every failed attempt so a downed service is not hammered with
 *  a `/claim` POST every 2 s forever, capped well under `PULL_STALE_MS`
 *  (types.ts) so a real recovery still lands before the floor would release. */
const CLAIM_RETRY_BASE_MS = 1000
const CLAIM_RETRY_MAX_MS = 30_000

/** Consecutive failed ticks (claim, drain, or ack) before defect 4's banner
 *  shows — enough to rule out one dropped packet, short enough that it still
 *  fires long before `PULL_STALE_MS` would silently declare the tab away. */
const OUTBOX_FAILURE_VISIBLE_AFTER = 3

/** BRIEF-21: `GET /rooms/:code/stream` answering `409 {"error":"no_session"}`
 *  is a NAMED, known state — the room's agent session died (or never
 *  started) and nobody has sent it a message yet — not a network blip. It is
 *  rendered immediately, not gated behind a failure count, because unlike a
 *  dropped packet this is not transient: the console repeats it forever
 *  until acted on, and the incident this brief fixes was exactly that repeat
 *  going unseen. Actionable, not just diagnostic: writing to a paused room
 *  already triggers `doResume` (`room-service.ts`), so "send a message"
 *  is true today, not a promise. */
const STREAM_NO_SESSION_TEXT = "This room has no live agent right now — send a message to wake it."

/** BRIEF-21, non-negotiable 4: branch on the `error` field the server named,
 *  never on the status code that carried it — the SAME 409 the stream uses
 *  for `no_session` is what `/claim` uses for an unrelated `name_claimed`,
 *  and a page that keyed off the number alone could not tell them apart
 *  (which is exactly how the incident this brief fixes was misread once
 *  already, by a human). `undefined` for anything else: an unrecognised or
 *  transient failure has no sentence to show here, and stays covered by the
 *  reused repeated-failure banner instead (`outboxFailureVisible`). */
export function streamFailureText(errorCode: string | undefined): string | undefined {
  return errorCode === "no_session" ? STREAM_NO_SESSION_TEXT : undefined
}

/** The member-facing artifact is live only when the room is active and the
 *  last boot/liveness probe confirmed the box is actually serving it —
 *  `artifactReady: false` or a paused room means NO iframe and NO clickable
 *  link, ever (the dead-artifact-URL finding, architecture.md §9.3b). */
function artifactLive(room: Room): boolean {
  return room.state !== "paused" && room.artifactUrl !== undefined && room.artifactReady !== false
}

function memberHtml(member: Member): string {
  // Brief D: a stale pull member is shown away — nobody is there to read.
  // The member is never removed from the roster; only its presence claim goes.
  const away =
    deliveryModeOf(member) === "pull" && pullMemberStale(member, Date.now())
      ? `<span class="member-away">away</span>`
      : ""
  return (
    `<span class="member"><span class="member-name">${escapeHtml(member.displayName)}</span>` +
    `<span class="tier-badge tier-${escapeHtml(member.tier)}">${escapeHtml(member.tier)}</span>` +
    `${away}<span class="member-joined">joined ${escapeHtml(member.joinedAt)}</span></span>`
  )
}

function membersHtml(room: Room): string {
  if (room.members.length === 0) return "No one here yet."
  return room.members.map(memberHtml).join(", ")
}

const STYLE = `
  :root { --accent: #3a6df0; --border: #e2e4ea; --bg: #fafafc; --grey: #6b7280; }  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; color: #1a1c23; background: var(--bg); }
  header { padding: 14px; border-bottom: 1px solid var(--border); background: #fff; display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center; }
  .join-code { font-size: 26px; font-weight: 700; }
  .join-code .code { color: var(--accent); font-family: ui-monospace, monospace; }
  .join-body { display: flex; flex-direction: column; align-items: center; gap: 10px; width: 100%; max-width: 320px; }
  .join-qr { width: 128px; height: 128px; flex: 0 0 auto; }
  .join-qr svg { width: 100%; height: 100%; display: block; }
  .join-web-link { font-size: 12px; color: var(--grey); text-decoration: none; word-break: break-all; }
  .join-web-link:hover { text-decoration: underline; }
  .join-buttons { display: flex; flex-direction: column; gap: 6px; width: 100%; }
  .join-btn { display: block; width: 100%; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border); background: #f3f5fb; color: #1a1c23; text-decoration: none; font-size: 14px; text-align: center; cursor: pointer; font-family: inherit; }
  .join-btn:hover { background: #eef1fb; }
  .join-btn-stay { background: var(--accent); color: #fff; border-color: var(--accent); }
  .state-row { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--grey); flex-wrap: wrap; justify-content: center; }
  .pill { padding: 2px 10px; border-radius: 999px; font-weight: 700; font-size: 12px; }
  .pill.live { background: #e6f6ec; color: #1a7f37; }
  .pill.paused { background: #fdeaea; color: #b42318; }
  .agent-status { font-weight: 600; color: #1a1c23; }
  #updated-ago { font-size: 11px; }
  #connection-lost { color: #b42318; font-weight: 600; display: none; }
  #member-status { color: var(--grey); font-weight: 600; display: none; }
  #outbox-failure { color: #b42318; font-weight: 600; display: none; }
  #stream-status { color: #b42318; font-weight: 600; display: none; }
  #members { font-size: 13px; color: var(--grey); max-width: 640px; }
  .member { display: inline-flex; align-items: center; gap: 5px; }
  .member-name { font-weight: 600; color: #1a1c23; }
  .tier-badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border); background: #fff; color: var(--grey); font-weight: 600; }
  .member-joined { font-size: 11px; }
  .member-away { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: #fdeaea; color: #b42318; font-weight: 700; }
  main { display: flex; height: calc(100vh - 260px); }
  #transcript-pane { flex: 1 1 55%; overflow-y: auto; padding: 12px; border-right: 1px solid var(--border); }
  #artifact-pane { flex: 1 1 45%; display: flex; align-items: stretch; justify-content: center; }
  #artifact-frame { width: 100%; height: 100%; border: 0; }
  #artifact-placeholder { margin: auto; color: var(--grey); font-size: 14px; text-align: center; padding: 0 12px; }
  .bubble { max-width: 90%; margin: 0 0 10px; padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; }
  .bubble.user { background: #eef2ff; margin-left: auto; }
  .bubble.assistant { background: #fff; border: 1px solid var(--border); }
  .bubble.whisper { border-color: #d8c9f0; background: #f6f1fd; }
  .bubble.system { border-color: #c9dcef; background: #eef6fd; }
  .bubble.tool { border-color: #cfe3d4; background: #f1f8f3; font-style: italic; }
  .outbox-gap { font-size: 12px; color: #b42318; background: #fdeaea; border: 1px solid #f2c4c0; border-radius: 6px; padding: 6px 10px; margin: 0 0 10px; }
  #name-error { color: #b42318; font-size: 12px; font-weight: 600; display: none; width: 100%; }
  .badge { display: inline-block; font-size: 11px; font-weight: 600; color: var(--accent); margin-bottom: 4px; }
  details.thought { margin-top: 6px; font-size: 12px; color: var(--grey); }
  details.thought summary { cursor: pointer; }
  .tool-row { font-size: 12px; color: var(--grey); margin-top: 4px; }
  footer { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--border); background: #fff; }
  footer input { padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 14px; }
  #name-input { flex: 0 0 120px; }
  #text-input { flex: 1 1 auto; }
  footer button { padding: 8px 16px; border: 0; border-radius: 6px; background: var(--accent); color: #fff; font-size: 14px; cursor: pointer; }
  @media (max-width: 720px) {
    main { flex-direction: column; height: auto; }
    #transcript-pane { border-right: 0; border-bottom: 1px solid var(--border); max-height: 50vh; }
    #artifact-pane { min-height: 40vh; }
    #name-input { flex: 0 0 90px; }
  }
  @media (min-width: 640px) {
    header { flex-direction: row; align-items: center; justify-content: space-between; text-align: left; flex-wrap: wrap; }
    .join-body { flex-direction: row; max-width: none; }
    .join-buttons { flex-direction: row; width: auto; }
    .join-btn { width: auto; }
    main { height: calc(100vh - 128px); }
  }
`

function script(code: string, room: Room, agentBusy: boolean): string {
  return `
    const ROOM_CODE = ${embedJson(code)};
    const INITIAL_ROOM = ${embedJson(room)};
    const INITIAL_AGENT_BUSY = ${embedJson(agentBusy)};
    const PAUSED_ARTIFACT_TEXT = ${embedJson(ARTIFACT_PAUSED_TEXT)};
    const OUTBOX_GAP_TEXT = ${embedJson(OUTBOX_GAP_TEXT)};
    // The SAME pure function the tests exercise, embedded via its own
    // JavaScript source: one outbox-to-render plan, tested and shipped from
    // one source.
    // one outbox-to-render plan, tested and shipped from one source.
    const planOutboxRender = ${planOutboxRender.toString()};

    const transcriptEl = document.getElementById("transcript");
    const artifactFrame = document.getElementById("artifact-frame");
    const artifactPlaceholder = document.getElementById("artifact-placeholder");
    const nameInput = document.getElementById("name-input");
    const textInput = document.getElementById("text-input");
    const nameErrorEl = document.getElementById("name-error");

    nameInput.value = localStorage.getItem("rdv-name") || "";

    // The initial state, server-rendered into the HTML and re-derived here so
    // the very first paint matches what the first poll will return.
    const INITIAL_STATE = {
      code: ROOM_CODE,
      state: INITIAL_ROOM.state,
      artifact: {
        url: (INITIAL_ROOM.state !== "paused" && INITIAL_ROOM.artifactUrl !== undefined && INITIAL_ROOM.artifactReady !== false)
          ? INITIAL_ROOM.artifactUrl
          : null,
        ready: INITIAL_ROOM.state !== "paused" && INITIAL_ROOM.artifactUrl !== undefined && INITIAL_ROOM.artifactReady !== false,
      },
      members: INITIAL_ROOM.members,
      agent: { busy: INITIAL_AGENT_BUSY === true, lastActivityAt: INITIAL_ROOM.lastActivityAt },
    };

    function relTime(iso) {
      const ms = Date.now() - Date.parse(iso);
      if (!isFinite(ms)) return "";
      const s = Math.max(0, Math.round(ms / 1000));
      if (s < 60) return s + "s";
      const m = Math.round(s / 60);
      if (m < 60) return m + "m";
      return Math.round(m / 60) + "h";
    }

    let currentArtifactUrl = null;
    function showArtifact(url) {
      if (!url || url === currentArtifactUrl) return;
      currentArtifactUrl = url;
      artifactFrame.src = url;
      artifactFrame.style.display = "block";
      artifactPlaceholder.style.display = "none";
    }
    function hideArtifact(message) {
      currentArtifactUrl = null;
      artifactFrame.removeAttribute("src");
      artifactFrame.style.display = "none";
      artifactPlaceholder.style.display = "";
      artifactPlaceholder.textContent = message;
    }

    function renderState(state) {
      document.getElementById("room-code").textContent = state.code;
      const pill = document.getElementById("state-pill");
      const paused = state.state === "paused";
      pill.textContent = paused ? "paused" : "live";
      pill.className = "pill " + (paused ? "paused" : "live");

      const agentEl = document.getElementById("agent-status");
      const activity = state.agent.lastActivityAt ? " · last activity " + relTime(state.agent.lastActivityAt) + " ago" : "";
      agentEl.textContent = (state.agent.busy ? "working" : "idle") + activity;

      renderMembers(state.members);
      if (state.artifact.ready && typeof state.artifact.url === "string") {
        showArtifact(state.artifact.url);
      } else {
        hideArtifact(paused ? PAUSED_ARTIFACT_TEXT : "No artifact yet");
      }
    }

    function renderMembers(members) {
      const el = document.getElementById("members");
      el.textContent = "";
      if (members.length === 0) {
        el.textContent = "No one here yet.";
        return;
      }
      members.forEach(function (m, i) {
        if (i > 0) el.appendChild(document.createTextNode(", "));
        const span = document.createElement("span");
        span.className = "member";
        const name = document.createElement("span");
        name.className = "member-name";
        name.textContent = m.displayName;
        const tier = document.createElement("span");
        tier.className = "tier-badge tier-" + m.tier;
        tier.textContent = m.tier;
        const joined = document.createElement("span");
        joined.className = "member-joined";
        joined.textContent = "joined " + relTime(m.joinedAt) + " ago";
        span.appendChild(name);
        span.appendChild(tier);
        if (m.away === true) {
          const away = document.createElement("span");
          away.className = "member-away";
          away.textContent = "away";
          span.appendChild(away);
        }
        span.appendChild(joined);
        el.appendChild(span);
      });
    }

    function bubble(className) {
      const el = document.createElement("div");
      el.className = "bubble " + className;
      transcriptEl.appendChild(el);
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
      return el;
    }

    // Same [name · tier] attribution badge the messengers get: fan-in
    // (src/fanin/index.ts) prefixes every prompt with it, so a user-prompt
    // record parses it back out and shows it as a badge instead of raw text.
    function renderUserPrompt(text) {
      const match = /^\\[([^·\\]]+)\\s*·\\s*([^\\]]+)\\]\\s*([\\s\\S]*)$/.exec(text);
      const el = bubble("user");
      if (match) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = match[1].trim() + " · " + match[2].trim();
        const body = document.createElement("div");
        body.textContent = match[3];
        el.appendChild(badge);
        el.appendChild(body);
      } else {
        el.textContent = text;
      }
    }

    let currentTurn = null;
    function ensureAssistantTurn() {
      if (currentTurn) return currentTurn;
      const el = bubble("assistant");
      const textEl = document.createElement("div");
      textEl.className = "text";
      el.appendChild(textEl);
      currentTurn = { bubble: el, textEl: textEl, thoughtEl: null };
      return currentTurn;
    }

    function appendThought(text) {
      const turn = ensureAssistantTurn();
      if (!turn.thoughtEl) {
        const details = document.createElement("details");
        details.className = "thought";
        const summary = document.createElement("summary");
        summary.textContent = "thinking";
        const body = document.createElement("div");
        details.appendChild(summary);
        details.appendChild(body);
        turn.bubble.appendChild(details);
        turn.thoughtEl = body;
      }
      turn.thoughtEl.textContent += text;
    }

    function appendToolRow(label) {
      const turn = ensureAssistantTurn();
      const row = document.createElement("div");
      row.className = "tool-row";
      row.textContent = label;
      turn.bubble.appendChild(row);
    }

    function summarize(value) {
      if (typeof value === "string") return value.slice(0, 200);
      try { return JSON.stringify(value).slice(0, 200); } catch (e) { return String(value); }
    }

    function render(record) {
      if (record.kind === "user-prompt") {
        renderUserPrompt(record.text || "");
      } else if (record.kind === "text-delta") {
        ensureAssistantTurn().textEl.textContent += record.text || "";
      } else if (record.kind === "thought") {
        appendThought(record.text || "");
      } else if (record.kind === "tool-call") {
        appendToolRow("🔧 " + (record.toolName || "tool"));
      } else if (record.kind === "tool-result") {
        appendToolRow((record.isError ? "⚠️ " : "→ ") + summarize(record.result));
      } else if (record.kind === "turn-end") {
        currentTurn = null;
      }
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }

    // --- the member half: claim a name, drain the outbox (PLAN-02 §3-D5) ---
    // Spectator and member are two roles. Watching the transcript above takes
    // no name and no credential — that is what a projected display is. A tab
    // becomes a member by claiming a name: the claim secret is minted once by
    // the server, stored here per room code + name, and exchanged for this
    // member's bearer token. The token is never in the page HTML — the server
    // hands it only across this exchange, to a visitor who presented the
    // name's claim.
    // The SAME pure functions the tests exercise, embedded via their own
    // JavaScript source (brief 14, same trick as planOutboxRender above): one
    // claim-and-drain plan, tested and shipped from one source.
    const CLAIM_RETRY_BASE_MS = ${embedJson(CLAIM_RETRY_BASE_MS)};
    const CLAIM_RETRY_MAX_MS = ${embedJson(CLAIM_RETRY_MAX_MS)};
    const OUTBOX_FAILURE_VISIBLE_AFTER = ${embedJson(OUTBOX_FAILURE_VISIBLE_AFTER)};
    const isRecord = ${isRecord.toString()};
    const GAP_EVENT_NAME = ${embedJson(GAP_EVENT_NAME)};
    const KIND_EVENT_NAME = ${embedJson(KIND_EVENT_NAME)};
    const aguiFrameOf = ${aguiFrameOf.toString()};
    const aguiSseFrames = ${aguiSseFrames.toString()};
    const aguiPayloadOf = ${aguiPayloadOf.toString()};
    const claimStorageKey = ${claimStorageKey.toString()};
    const claimMember = ${claimMember.toString()};
    // BRIEF-23: the recovery-link redemption and its per-situation failure
    // sentence — embedded from the tested source, same trick as the rest.
    const recoveryFailureText = ${recoveryFailureText.toString()};
    const redeemRecovery = ${redeemRecovery.toString()};
    const freshOutboxTickState = ${freshOutboxTickState.toString()};
    const runOutboxTick = ${runOutboxTick.toString()};
    const outboxFailureVisible = ${outboxFailureVisible.toString()};
    // BRIEF-21: the stream's own known-failure sentence and its incremental
    // SSE parser, the SAME trick as the rest of this block — one
    // tested-and-shipped source, run here verbatim.
    const streamFailureText = ${streamFailureText.toString()};
    const sseSplitFrames = ${sseSplitFrames.toString()};
    const connectStreamOnce = ${connectStreamOnce.toString()};

    const memberStatusEl = document.getElementById("member-status");
    const outboxFailureEl = document.getElementById("outbox-failure");
    const streamStatusEl = document.getElementById("stream-status");
    const OUTBOX_NOT_MEMBER_TEXT = ${embedJson(OUTBOX_NOT_MEMBER_TEXT)};
    const OUTBOX_FAILURE_TEXT = ${embedJson(OUTBOX_FAILURE_TEXT)};
    memberStatusEl.textContent = OUTBOX_NOT_MEMBER_TEXT;
    outboxFailureEl.textContent = OUTBOX_FAILURE_TEXT;

    const claimDeps = {
      roomCode: ROOM_CODE,
      // fetch MUST be wrapped, never stored bare: every reader below calls it
      // as deps.fetchImpl(...), which sets the receiver to the deps object,
      // and a browser answers that with "TypeError: Failed to execute 'fetch'
      // on 'Window': Illegal invocation". claimMember catches its own fetch
      // and returns null, so the whole send path died in silence — no
      // request, no console error, nothing. Node's fetch does not check its
      // receiver and every test injects its own fetchImpl, so only a real
      // browser ever saw it. Measured live 2026-09-14.
      fetchImpl: function (input, init) { return fetch(input, init); },
      getName: function () { return nameInput.value; },
      getStoredClaim: function (key) { return localStorage.getItem(key); },
      setStoredClaim: function (key, value) { localStorage.setItem(key, value); },
      removeStoredClaim: function (key) { localStorage.removeItem(key); },
      onNameConflict: function (message) { nameErrorEl.textContent = message; nameErrorEl.style.display = ""; },
    };
    const outboxDeps = Object.assign({ now: function () { return Date.now(); } }, claimDeps);
    const outboxState = freshOutboxTickState();

    // --- the transcript stream (PLAN-02 §3-D — BRIEF-21: a plain fetch, not
    // EventSource, because EventSource never exposes a failed response's
    // status or body, and the one thing this whole brief is about is reading
    // that body's error field instead of throwing it away). Unlike the
    // bounded AG-UI drain above, a live room's stream never ends on its own,
    // so the body is read incrementally with a reader loop instead of one
    // text() call — sseSplitFrames carries a trailing partial frame across
    // read() calls the same way the browser's own SSE parser would. ---
    let since = 0;
    async function connectStream() {
      const outcome = await connectStreamOnce(since, { roomCode: ROOM_CODE, fetchImpl: function (input, init) { return fetch(input, init); } }, outboxState);
      outboxFailureEl.style.display = outboxFailureVisible(outboxState) ? "" : "none";
      if (outcome.status === "failed" || !outcome.body) {
        const text = outcome.status === "failed" ? outcome.text : undefined;
        streamStatusEl.textContent = text || "";
        streamStatusEl.style.display = text ? "" : "none";
        setTimeout(connectStream, 1000);
        return;
      }
      streamStatusEl.style.display = "none";
      const reader = outcome.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const split = sseSplitFrames(buffer);
          buffer = split.rest;
          split.frames.forEach(function (data) {
            let record;
            try { record = JSON.parse(data); } catch (e) { return; }
            if (typeof record.seq === "number") since = record.seq;
            render(record);
          });
        }
      } catch (e) {
        // The connection dropped mid-stream — reconnect below, same as a
        // clean end; either way there is nothing more to read from this one.
      }
      setTimeout(connectStream, 1000);
    }

    // Brief 14, defect 4: an ack or drain that fails repeatedly must surface
    // in the page — the same rule the gap marker already follows. A silent
    // catch on the one mechanism that proves a recipient exists is the
    // defect this whole brief is about, wearing the costume of politeness.
    function renderOutboxOutcome(outcome) {
      memberStatusEl.style.display = outcome.status === "unclaimed" ? "" : "none";
      outboxFailureEl.style.display = outboxFailureVisible(outboxState) ? "" : "none";
      if (outcome.status !== "ok") return;
      if (outcome.gap) {
        const gapEl = document.createElement("div");
        gapEl.className = "outbox-gap";
        gapEl.textContent = outcome.gap;
        transcriptEl.appendChild(gapEl);
      }
      outcome.items.forEach(function (item) {
        if (item.kind === "tool") {
          // BRIEF-15: a tool record's text is the call's arguments as JSON.
          // The room is told THAT the agent called something, never what it
          // passed — the transcript is where humans read, and an argument
          // blob there is noise at best and a disclosure at worst. The one
          // tool the room cares about today gets a sentence; anything else
          // is named, not paraphrased, so a new tool never arrives here
          // wearing a description this code invented for it.
          const el = bubble("assistant tool");
          const badge = document.createElement("span");
          badge.className = "badge";
          badge.textContent = "the agent used a tool";
          const body = document.createElement("div");
          body.textContent =
            item.toolName === "render_artifact"
              ? "The shared document was just updated."
              : "Called " + (item.toolName ? item.toolName : "an unnamed tool") + ".";
          el.appendChild(badge);
          el.appendChild(body);
          return;
        }
        const el = bubble(item.kind === "whisper" ? "assistant whisper" : item.kind === "system" ? "assistant system" : "assistant");
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = item.kind === "whisper" ? "whisper · private, to you" : item.kind === "system" ? "room · to you" : "agent · to you";
        const body = document.createElement("div");
        body.textContent = item.text;
        el.appendChild(badge);
        el.appendChild(body);
      });
      if (outcome.items.length > 0) transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }

    async function drainOutbox() {
      const outcome = await runOutboxTick(outboxState, outboxDeps);
      renderOutboxOutcome(outcome);
    }

    async function sendMessage() {
      const displayName = nameInput.value.trim();
      const text = textInput.value.trim();
      if (!displayName || !text) return;
      // Claim BEFORE sending: the send refuses a claimed name whose secret we
      // cannot present, so the exchange (which may mint one) runs first.
      const token = await claimMember(claimDeps);
      if (token === null) return;
      outboxState.memberToken = token;
      outboxState.claimBackoffMs = CLAIM_RETRY_BASE_MS;
      outboxState.claimNotBeforeMs = 0;
      memberStatusEl.style.display = "none";
      localStorage.setItem("rdv-name", displayName);
      textInput.value = "";
      await fetch("/rooms/" + ROOM_CODE + "/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: displayName, text: text, claim: localStorage.getItem(claimStorageKey(ROOM_CODE, displayName)) || undefined }),
      });
      pollState();
    }

    document.getElementById("send-button").addEventListener("click", sendMessage);
    textInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") sendMessage();
    });

    document.getElementById("stay-here-button").addEventListener("click", function () {
      textInput.focus();
    });

    // --- live state polling: patch the DOM, never reload the page ---
    let lastGoodPollAt = null;
    const connectionEl = document.getElementById("connection-lost");
    const updatedEl = document.getElementById("updated-ago");

    async function pollState() {
      try {
        const res = await fetch("/r/" + ROOM_CODE + "/state");
        if (!res.ok) throw new Error("state fetch failed: " + res.status);
        const state = await res.json();
        lastGoodPollAt = Date.now();
        connectionEl.style.display = "none";
        renderState(state);
      } catch (e) {
        connectionEl.style.display = "";
      }
    }

    setInterval(pollState, 3000);
    setInterval(drainOutbox, 2000);
    setInterval(function () {
      updatedEl.textContent = lastGoodPollAt
        ? "updated " + Math.max(0, Math.round((Date.now() - lastGoodPollAt) / 1000)) + "s ago"
        : "";
    }, 1000);

    renderState(INITIAL_STATE);
    connectStream();
    pollState();
    // BRIEF-23: a recovery link arrives as ?recover=<token>&name=<name>.
    // Redeem it FIRST — before the ordinary claim tick — so the restored
    // claim is in localStorage by the time the first /claim POST runs, and
    // the tab comes back as the member it always was. Clearing the query
    // from the URL after redeeming keeps the one-time capability out of
    // browser history.
    async function applyRecoveryFromUrl() {
      const params = new URLSearchParams(location.search);
      const token = params.get("recover");
      if (!token) return;
      const displayName = params.get("name") || "";
      nameInput.value = displayName;
      const result = await redeemRecovery({
        roomCode: ROOM_CODE,
        token: token,
        displayName: displayName,
        // Wrapped, never bare: redeemRecovery calls this as deps.fetchImpl(...),
        // which sets the receiver to the deps object, and a browser refuses that
        // with "Illegal invocation". See the claim and stream sites above.
        fetchImpl: function (input, init) { return fetch(input, init); },
        setStoredClaim: function (key, value) { localStorage.setItem(key, value); },
      });
      history.replaceState(null, "", location.pathname);
      if (result.status === "restored") {
        nameErrorEl.style.display = "none";
      } else {
        nameErrorEl.textContent = recoveryFailureText(result.error);
        nameErrorEl.style.display = "";
      }
    }
    // Claim on load, not on first send (brief 14, defect 1): a visitor with
    // a name becomes a member and starts draining without having to speak.
    // Runs unconditionally — with no name yet, the first tick reports
    // "unclaimed" and the page says so visibly instead of looking live.
    // The recovery redemption, when the URL carries one, runs first (above).
    applyRecoveryFromUrl().then(function () { return drainOutbox(); });
  `
}

/** The outbox drain's pure half, shared between the generated page script
 *  (embedded above via `toString()`, so the shipped page and the tests run
 *  the SAME code) and test/web/page.test.ts: dedupe on `Delivery.id`
 *  (at-least-once — a reconnect repeats records), and surface the `pruned`
 *  gap marker as text instead of silence (PLAN-02 §3-D6). Kept
 *  self-contained on purpose: it must survive `toString()` with no free
 *  references except OUTBOX_GAP_TEXT, which the script defines alongside.
 *
 *  `since` and `gapState` are brief 12: the server re-reports `pruned: true`
 *  on every poll until the cursor moves past the mark (defect 2's fix does
 *  not change that — it is still correct on every one of those polls), so
 *  without this the client re-announced the SAME gap once per tick forever.
 *  A gap is identified by the `since` it was reported at; it is rendered
 *  once for that `since` and re-rendered only when a NEW, higher `since`
 *  still comes back pruned — a gap the client had not yet been told about.
 *  `gapState` defaults to a fresh object per call so callers that do not
 *  care about de-duplication (existing tests) see the old always-report
 *  behaviour unchanged. */
/** One delivery as the outbox JSON carries it. `toolName` is present on
 *  `kind: "tool"` records only (BRIEF-15). Named types rather than repeated
 *  inline literals so the tool arm could not be added to the reader without
 *  the renderer's own signature following it. */
export interface OutboxRecord {
  readonly id: string
  readonly kind: string
  readonly text: string
  readonly toolName?: string
}

/** One transcript entry, after `planOutboxRender` has decided how it reads.
 *  `kind` is narrowed to the four the page knows how to draw — the mapping
 *  is total, with no catch-all. */
export interface OutboxItem {
  readonly id: string
  readonly kind: "say" | "whisper" | "system" | "tool"
  readonly text: string
  readonly toolName?: string
}

export const planOutboxRender = (
  payload: { pruned?: boolean; deliveries?: readonly OutboxRecord[] },
  seenIds: Record<string, boolean>,
  since = 0,
  gapState: { lastReportedSince?: number } = {},
): { gap: string | undefined; items: OutboxItem[] } => {
  const items: OutboxItem[] = []
  const deliveries = payload.deliveries === undefined || payload.deliveries === null ? [] : payload.deliveries
  for (const record of deliveries) {
    if (record === undefined || record === null) continue
    if (typeof record.id !== "string") continue
    if (seenIds[record.id] === true) continue
    seenIds[record.id] = true
    // Brief B: the room's own voice is NOT the agent speaking. `system` (a
    // join link, a resume notice, the fan-out's turn text to this tab) is
    // per-member but not secret, and renders distinctly from both a `say`
    // and a `whisper`.
    //
    // BRIEF-15: `tool` is named EXPLICITLY here rather than falling into the
    // `say` arm. Its `text` is the call's arguments as JSON, so the default
    // arm would put a serialised object in the transcript attributed to the
    // agent — the same shape of lie as a join link signed by the agent, and
    // the reason this chain has no catch-all.
    items.push({
      id: record.id,
      kind:
        record.kind === "whisper"
          ? "whisper"
          : record.kind === "system"
            ? "system"
            : record.kind === "tool"
              ? "tool"
              : "say",
      text: record.text === undefined ? "" : record.text,
      // Written only when present (`exactOptionalPropertyTypes`), so a
      // non-tool item carries no `toolName` key at all rather than an
      // explicit `undefined` the renderer would have to test for twice.
      ...(record.toolName !== undefined ? { toolName: record.toolName } : {}),
    })
  }
  const isNewGap = payload.pruned === true && (gapState.lastReportedSince === undefined || since > gapState.lastReportedSince)
  if (isNewGap) gapState.lastReportedSince = since
  return { gap: isNewGap ? OUTBOX_GAP_TEXT : undefined, items }
}

/** Storage key for a room-web member's one-time join secret (PLAN-02
 *  §3-D3 amended): opaque, keyed by room code + the claimed name (lower-
 *  cased/trimmed, matching `slugify`'s identity) so two rooms or two names
 *  in the same browser never collide. */
export function claimStorageKey(roomCode: string, name: string): string {
  return "rdv-claim:" + roomCode + ":" + name.trim().toLowerCase()
}

/** `res.json()` answers `unknown`, not `any` — these read it back into the
 *  shapes `claimMember` and `planOutboxRender` need without ever asserting
 *  the shape with `as`. A field that isn't what it should be is dropped or
 *  defaulted, exactly like the inline validation these replace used to do. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** One AG-UI frame, narrowed to the fields this client reads. Everything
 *  else in the vocabulary (`RUN_STARTED`, `TEXT_MESSAGE_START/END`,
 *  `STATE_SNAPSHOT`, `RUN_FINISHED`) rides past unread: the bracket carries
 *  no delivery of its own, and `STATE_SNAPSHOT.cursor` is deliberately NOT
 *  consulted — see `aguiPayloadOf`. */
export interface AguiFrame {
  type: string
  name?: string
  messageId?: string
  toolCallId?: string
  toolCallName?: string
  delta?: string
  /** `CUSTOM.value`, narrowed to the two fields the kind event carries. The
   *  gap event's own payload is not read: its PRESENCE is the whole signal. */
  value?: { messageId?: string; kind?: string }
}

function aguiFrameOf(value: unknown): AguiFrame | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined
  const custom = isRecord(value.value) ? value.value : undefined
  const messageId = custom !== undefined && typeof custom.messageId === "string" ? custom.messageId : undefined
  const kind = custom !== undefined && typeof custom.kind === "string" ? custom.kind : undefined
  return {
    type: value.type,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.messageId === "string" ? { messageId: value.messageId } : {}),
    ...(typeof value.toolCallId === "string" ? { toolCallId: value.toolCallId } : {}),
    ...(typeof value.toolCallName === "string" ? { toolCallName: value.toolCallName } : {}),
    ...(typeof value.delta === "string" ? { delta: value.delta } : {}),
    ...(messageId !== undefined || kind !== undefined
      ? { value: { ...(messageId !== undefined ? { messageId } : {}), ...(kind !== undefined ? { kind } : {}) } }
      : {}),
  }
}

/** Split an SSE body into its `data:` payloads, parsed. Tolerates the
 *  `event: <name>` line the outbox arm writes, blank padding, and a trailing
 *  partial frame (dropped — half a frame is not a delivery). Written against
 *  the bytes rather than `EventSource` because the AG-UI run is BOUNDED: the
 *  whole body arrives and ends, so there is nothing to subscribe to. */
export function aguiSseFrames(body: string): AguiFrame[] {
  const frames: AguiFrame[] = []
  for (const block of body.split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("")
    if (data === "") continue
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch (e) {
      continue
    }
    const frame = aguiFrameOf(parsed)
    if (frame !== undefined) frames.push(frame)
  }
  return frames
}

/** BRIEF-21: incremental sibling of `aguiSseFrames` above, for the ONE stream
 *  in this page that is genuinely unbounded (`GET /rooms/:code/stream`) and
 *  so cannot be read with a single `.text()` the way the bounded AG-UI run
 *  can — a live room never ends the response. `buffer` is whatever bytes
 *  have arrived so far (this call's leftover `rest` plus the newest chunk);
 *  every COMPLETE `\n\n`-terminated frame is parsed out, and a trailing
 *  partial frame is carried forward in `rest` rather than dropped — a chunk
 *  boundary landing mid-record must not lose it, unlike `aguiSseFrames`'s
 *  bounded case where a partial frame at the very end is genuinely never
 *  coming. */
export function sseSplitFrames(buffer: string): { frames: string[]; rest: string } {
  const blocks = buffer.split("\n\n")
  const rest = blocks.pop() ?? ""
  const frames = blocks
    .map((block) =>
      block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join(""),
    )
    .filter((data) => data !== "")
  return { frames, rest }
}

/** BRIEF-21: what `connectStreamOnce` needs from its environment — the same
 *  shape of dependency object `ClaimDeps`/`OutboxTickDeps` use, so this can
 *  be driven against a REAL http server in a test exactly the way
 *  `runOutboxTick` already is, instead of leaving the one place that reads
 *  the stream's 409 body untested. */
export interface StreamConnectDeps {
  roomCode: string
  fetchImpl: typeof fetch
}

export type StreamConnectOutcome =
  | { status: "failed"; text: string | undefined }
  | { status: "connected"; body: ReadableStream<Uint8Array> | null }

/** One connection attempt for the transcript stream, factored out of the
 *  embedded script exactly like `runOutboxTick` was for the outbox drain
 *  (brief 14) — testable in isolation, and shared by both the shipped page
 *  and its tests from the one source. Only the CONNECT decision lives here:
 *  a stream that opens successfully hands its body back for the caller's
 *  own reader loop to keep rendering records from for as long as the room
 *  stays live — that part has no single outcome to return, since it renders
 *  forever until the connection ends, so it is not this function's job. */
export async function connectStreamOnce(
  since: number,
  deps: StreamConnectDeps,
  state: OutboxTickState,
): Promise<StreamConnectOutcome> {
  let res: Response
  try {
    res = await deps.fetchImpl("/rooms/" + deps.roomCode + "/stream?since=" + since)
  } catch (e) {
    state.streamFailureStreak += 1
    return { status: "failed", text: undefined }
  }
  if (!res.ok) {
    let body: unknown
    try {
      body = await res.json()
    } catch (e) {
      body = undefined
    }
    // BRIEF-21, non-negotiable 4: the `error` field decides the sentence,
    // never the status code — a 409 here means `no_session`, a 409 on
    // `/claim` means something unrelated, and this function must not read
    // "409" as either one.
    const errorCode = isRecord(body) && typeof body.error === "string" ? body.error : undefined
    state.streamFailureStreak += 1
    return { status: "failed", text: streamFailureText(errorCode) }
  }
  state.streamFailureStreak = 0
  return { status: "connected", body: res.body }
}

/** BRIEF-15 step 2: an AG-UI run read back into the SAME `{pruned,
 *  deliveries}` shape `outboxPayloadOf` produces, so `planOutboxRender` —
 *  and with it the gap de-duplication, the `seenDeliveries` dedupe and the
 *  whole renderer — stays the one implementation. A second rendering path
 *  for the second transport is how the two would drift.
 *
 *  Three mappings, and one deliberate omission:
 *
 *  - `CUSTOM rdv.outbox.gap` → `pruned: true`. Its ABSENCE is the `false`
 *    (docs/OUTBOX.md §8): there is no reassurance event to look for.
 *  - `CUSTOM rdv.outbox.kind` → the record's kind, which is authoritative.
 *    `TEXT_MESSAGE_START.role` is not consulted: `say` and `whisper` both
 *    arrive as `assistant` there, and a whisper rendered as a `say` is a
 *    private message shown with a public badge.
 *  - `TOOL_CALL_START/ARGS` → a `kind: "tool"` record carrying `toolName`.
 *
 *  The omission: `STATE_SNAPSHOT.cursor` is never read. It is the room-wide
 *  `deliverySeq`, which can sit past records still pending for this member;
 *  the caller advances its cursor from the ids it ACTUALLY rendered, which
 *  is brief F's rule and the reason the JSON drain ignores `payload.cursor`
 *  too. Taking the snapshot here would skip a member's own pending record —
 *  §1's table, row five. */
export function aguiPayloadOf(frames: readonly AguiFrame[]): {
  pruned?: boolean
  deliveries?: OutboxRecord[]
} {
  let pruned = false
  const kinds: Record<string, string> = {}
  const names: Record<string, string> = {}
  const texts: Record<string, string> = {}
  const order: string[] = []

  // First seen wins the position, so records render in the order the run
  // sent them — the outbox's own order (D1), not the order a `kind` event
  // happened to arrive in.
  const remember = (id: string): void => {
    if (!Object.prototype.hasOwnProperty.call(texts, id)) {
      texts[id] = ""
      order.push(id)
    }
  }

  for (const frame of frames) {
    if (frame.type === "CUSTOM" && frame.name === GAP_EVENT_NAME) {
      pruned = true
      continue
    }
    // The kind event is authoritative and arrives BEFORE the record it
    // describes, so it is recorded without creating one: a kind with no
    // content following it is not a delivery.
    if (frame.type === "CUSTOM" && frame.name === KIND_EVENT_NAME) {
      const custom = frame.value
      if (custom !== undefined && custom.messageId !== undefined && custom.kind !== undefined) {
        kinds[custom.messageId] = custom.kind
      }
      continue
    }
    if (frame.type === "TEXT_MESSAGE_CONTENT" && frame.messageId !== undefined) {
      remember(frame.messageId)
      texts[frame.messageId] = (texts[frame.messageId] ?? "") + (frame.delta ?? "")
      continue
    }
    if (frame.type === "TOOL_CALL_START" && frame.toolCallId !== undefined) {
      remember(frame.toolCallId)
      // Set here as well as from the kind event: a TOOL_CALL_START is a tool
      // call whatever the CUSTOM event said, and a kind event lost to a
      // truncated frame must not turn one into agent prose.
      kinds[frame.toolCallId] = "tool"
      if (frame.toolCallName !== undefined) names[frame.toolCallId] = frame.toolCallName
      continue
    }
    if (frame.type === "TOOL_CALL_ARGS" && frame.toolCallId !== undefined) {
      remember(frame.toolCallId)
      texts[frame.toolCallId] = (texts[frame.toolCallId] ?? "") + (frame.delta ?? "")
    }
  }

  const deliveries: OutboxRecord[] = order.map((id) => {
    const toolName = names[id]
    return {
      id,
      kind: kinds[id] ?? "say",
      text: texts[id] ?? "",
      ...(toolName !== undefined ? { toolName } : {}),
    }
  })
  return { pruned, deliveries }
}

/** What claiming needs from its environment: real `fetch` and real
 *  `localStorage` in the page, fakes of both in tests — an explicit
 *  dependency object rather than a closure over page globals, so
 *  `claimMember` and `runOutboxTick` below survive `toString()` AND run
 *  against a real test server with no DOM at all (same reasoning as
 *  `planOutboxRender`'s doc comment). */
export interface ClaimDeps {
  roomCode: string
  fetchImpl: typeof fetch
  getName: () => string
  getStoredClaim: (key: string) => string | null
  setStoredClaim: (key: string, value: string) => void
  removeStoredClaim: (key: string) => void
  /** BRIEF-21: the server names WHICH `name_claimed` situation this is (a
   *  real conflict, or this browser's own stale proof) and hands over the
   *  sentence that says so in `message` — passed straight through here
   *  rather than re-derived, so the two situations can never drift onto the
   *  same hard-wired string on the client side. */
  onNameConflict: (message: string) => void
}

/** Fallback for a `name_claimed` refusal whose body carried no `message` —
 *  should not happen against this project's own server, but a page that
 *  renders nothing here on a malformed body is the exact silence this brief
 *  exists to remove. */
const NAME_CLAIMED_FALLBACK_TEXT = "This name is already in use in this room — choose another."

/** `POST /rooms/:code/claim` — mints or confirms this browser's bearer
 *  token for the name currently typed. Returns `null` on every failure (no
 *  name, network error, 409, unparseable response): the caller decides what
 *  "no token yet" means. Brief 14 defects 1 and 2 both resolve to exactly
 *  this one call — the first claim on load, and every reclaim after a
 *  401 — which is why both now share it instead of the old two divergent
 *  paths (`ensureClaimed` on load only, nothing at all after a 401). */
export async function claimMember(deps: ClaimDeps): Promise<string | null> {
  const name = deps.getName().trim()
  if (name === "") return null
  const key = claimStorageKey(deps.roomCode, name)
  const stored = deps.getStoredClaim(key)
  let res: Response
  try {
    res = await deps.fetchImpl("/rooms/" + deps.roomCode + "/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(stored !== null ? { displayName: name, claim: stored } : { displayName: name }),
    })
  } catch (e) {
    return null
  }
  let rawBody: unknown
  try {
    rawBody = await res.json()
  } catch (e) {
    rawBody = undefined
  }
  const body = isRecord(rawBody) ? rawBody : undefined
  // BRIEF-21, non-negotiable 4: branch on `error`, never on the status code
  // — a `name_claimed` body is what this means, whatever number carried it,
  // and a 409 with a DIFFERENT `error` (there is one: `/stream`'s
  // `no_session`) must never be read as a name conflict here.
  if (body !== undefined && body.error === "name_claimed") {
    // The name is claimed and we could not prove it is ours: say so,
    // visibly, with the sentence naming WHICH situation this is, and forget
    // the stale secret either way.
    deps.removeStoredClaim(key)
    deps.onNameConflict(typeof body.message === "string" ? body.message : NAME_CLAIMED_FALLBACK_TEXT)
    return null
  }
  if (!res.ok) return null
  if (body === undefined) return null
  if (typeof body.claim === "string") deps.setStoredClaim(key, body.claim)
  return typeof body.memberToken === "string" ? body.memberToken : null
}

/** What redeeming a recovery link needs from its environment (BRIEF-23),
 *  the same dependency-object shape as `ClaimDeps` so it survives
 *  `toString()` and can be driven against a real server with no DOM. */
export interface RedeemDeps {
  roomCode: string
  token: string
  displayName: string
  fetchImpl: typeof fetch
  setStoredClaim: (key: string, value: string) => void
}

/** The failure sentence a recovery link's own error field earns (BRIEF-23):
 *  named per situation, never one generic apology — an expired link and a
 *  link aimed at another name are different problems with different fixes. */
export function recoveryFailureText(errorCode: string | undefined): string {
  if (errorCode === "expired_token") return "This recovery link has expired — ask the room for a new one."
  if (errorCode === "wrong_member") return "This recovery link restores a different name, not the one entered."
  return "This recovery link is no longer valid — ask the room for a new one."
}

/** `POST /rooms/:code/recover` (BRIEF-23) — redeem the one-time link and
 *  install the restored claim under the SAME `rdv-claim` key a first claim
 *  would use, so every later step is the ordinary claim path. Returns the
 *  name the link restored on success, or an error code for the page to render
 *  (`undefined` for a network/unparseable failure). */
export async function redeemRecovery(deps: RedeemDeps): Promise<
  { status: "restored"; displayName: string } | { status: "failed"; error: string | undefined }
> {
  let res: Response
  try {
    res = await deps.fetchImpl("/rooms/" + deps.roomCode + "/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: deps.token, displayName: deps.displayName }),
    })
  } catch (e) {
    return { status: "failed", error: undefined }
  }
  let rawBody: unknown
  try {
    rawBody = await res.json()
  } catch (e) {
    rawBody = undefined
  }
  const body = isRecord(rawBody) ? rawBody : undefined
  if (!res.ok) {
    return { status: "failed", error: body !== undefined && typeof body.error === "string" ? body.error : undefined }
  }
  if (body === undefined || typeof body.claim !== "string" || typeof body.displayName !== "string") {
    return { status: "failed", error: undefined }
  }
  deps.setStoredClaim(claimStorageKey(deps.roomCode, body.displayName), body.claim)
  return { status: "restored", displayName: body.displayName }
}

/** One tab's outbox drain state (brief 14). `claimBackoffMs` /
 *  `claimNotBeforeMs` are defect 2's bounded backoff; `drainFailureStreak`
 *  is defect 4's failure-visibility counter — incremented by ANY tick that
 *  fails to get all the way through (a failed claim, a failed drain fetch,
 *  or a failed ack) and reset only by one that does.
 *
 *  `streamFailureStreak` (BRIEF-21) is the SAME kind of counter for the
 *  transcript stream's own reconnect loop, kept SEPARATE from
 *  `drainFailureStreak` rather than folded into it: the outbox drain
 *  (`/agui`) does not depend on the room having a live session, so a room
 *  with no live agent fails the stream every attempt while the drain keeps
 *  succeeding — a shared counter would have the drain's successes erase the
 *  stream's failures and the banner would never reach `outboxFailureVisible`
 *  no matter how long the stream kept failing. Both counters drive the ONE
 *  reused banner (`outboxFailureVisible` below), which is the reuse the
 *  brief asks for: one visible escalation, not a second banner. */
export interface OutboxTickState {
  memberToken: string | null
  outboxSince: number
  seenDeliveries: Record<string, boolean>
  gapState: { lastReportedSince?: number }
  claimBackoffMs: number
  claimNotBeforeMs: number
  drainFailureStreak: number
  streamFailureStreak: number
}

export function freshOutboxTickState(): OutboxTickState {
  return {
    memberToken: null,
    outboxSince: 0,
    seenDeliveries: {},
    gapState: {},
    claimBackoffMs: CLAIM_RETRY_BASE_MS,
    claimNotBeforeMs: 0,
    drainFailureStreak: 0,
    streamFailureStreak: 0,
  }
}

export interface OutboxTickDeps extends ClaimDeps {
  now: () => number
}

export type OutboxTickOutcome =
  | { status: "unclaimed" }
  | { status: "claim-backoff" }
  | { status: "claim-failed" }
  | { status: "auth-lost" }
  | { status: "drain-failed" }
  | { status: "ok"; gap: string | undefined; items: OutboxItem[] }

/** One 2 s drain tick (brief 14) — the single place that claims-if-needed,
 *  drains, and acks, replacing three functions that used to fail
 *  independently and silently: `ensureClaimed` (ran on load only),
 *  `drainOutbox` (no path back from a 401), `ackOutbox` (gated on a
 *  non-empty outbox, so it could never be the liveness signal §5 asks for).
 *
 *  A member with a name and no token — whether it never claimed at all or
 *  just lost its token to a 401 — takes the exact same branch below: try to
 *  claim, subject to backoff, and on success fall straight through to the
 *  drain in the SAME tick. That is defect 2's "recover from 401": nulling
 *  the token here is enough, because the next tick (or this one, once
 *  backoff clears) tries to claim again instead of giving up forever.
 *
 *  The ack is unconditional (defect 3): even an outbox with nothing new
 *  still re-posts its cursor — `0` is a legitimate cursor — because the ack
 *  IS the liveness signal (docs/OUTBOX.md §5), not a side effect of having
 *  something to render. */
export async function runOutboxTick(state: OutboxTickState, deps: OutboxTickDeps): Promise<OutboxTickOutcome> {
  if (state.memberToken === null) {
    if (deps.getName().trim() === "") return { status: "unclaimed" }
    if (deps.now() < state.claimNotBeforeMs) return { status: "claim-backoff" }
    const token = await claimMember(deps)
    if (token === null) {
      state.claimBackoffMs = Math.min(state.claimBackoffMs * 2, CLAIM_RETRY_MAX_MS)
      state.claimNotBeforeMs = deps.now() + state.claimBackoffMs
      state.drainFailureStreak += 1
      return { status: "claim-failed" }
    }
    state.memberToken = token
    state.claimBackoffMs = CLAIM_RETRY_BASE_MS
    state.claimNotBeforeMs = 0
  }

  let res: Response
  try {
    // BRIEF-15 step 2: the drain is an AG-UI run. Same member bearer, same
    // per-member scoping, same records — the room page is now one AG-UI
    // client among however many others, instead of the one surface that
    // spoke a private dialect.
    //
    // The run is BOUNDED (it closes with RUN_FINISHED), so this stays a
    // tick rather than becoming a subscription: AG-UI has no resume-from-
    // cursor concept, and `since` rides `forwardedProps` on the way in (D3).
    res = await deps.fetchImpl("/rooms/" + deps.roomCode + "/agui", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: "Bearer " + state.memberToken,
      },
      // No message: a tick is a pure reconnect (D6). Typing is still
      // `POST /rooms/:code/send`, which has its own claim and name-conflict
      // handling — routing sends through here as well would duplicate it.
      body: JSON.stringify({
        threadId: deps.roomCode,
        runId: "tick-" + String(deps.now()),
        messages: [],
        forwardedProps: { since: state.outboxSince },
      }),
    })
  } catch (e) {
    state.drainFailureStreak += 1
    return { status: "drain-failed" }
  }
  if (res.status === 401) {
    // No path back used to end here (defect 2). Now: null the token and
    // report it — the very next tick re-claims, subject to backoff above.
    state.memberToken = null
    state.claimNotBeforeMs = deps.now() + state.claimBackoffMs
    state.drainFailureStreak += 1
    return { status: "auth-lost" }
  }
  if (!res.ok) {
    state.drainFailureStreak += 1
    return { status: "drain-failed" }
  }
  let frames: AguiFrame[]
  try {
    frames = aguiSseFrames(await res.text())
  } catch (e) {
    state.drainFailureStreak += 1
    return { status: "drain-failed" }
  }
  // A run that reported an error did not finish cleanly, and a partial
  // transcript rendered as a complete one is exactly what RUN_ERROR exists
  // to prevent (docs/OUTBOX.md §1). Counted as a failed tick so the banner
  // can surface it, same as a dropped fetch.
  if (frames.some((frame) => frame.type === "RUN_ERROR")) {
    state.drainFailureStreak += 1
    return { status: "drain-failed" }
  }
  // A body carrying no RUN_STARTED is not an AG-UI run — it is a proxy page,
  // a truncated response, or an endpoint that is not there. Rendering its
  // zero records as "nothing new" would be an absence reading as delivery.
  if (!frames.some((frame) => frame.type === "RUN_STARTED")) {
    state.drainFailureStreak += 1
    return { status: "drain-failed" }
  }

  const payload = aguiPayloadOf(frames)
  const plan = planOutboxRender(payload, state.seenDeliveries, state.outboxSince, state.gapState)
  // Cursor semantics (brief F): the cursor advances to the HIGHEST SEQ
  // ACTUALLY RENDERED — never to payload.cursor (the room-wide deliverySeq),
  // which can sit past records still pending for anyone.
  const deliveries = payload.deliveries ?? []
  for (const record of deliveries) {
    const m = /^d(\d+)$/.exec(record.id)
    const seq = m !== null && m[1] !== undefined ? parseInt(m[1], 10) : 0
    if (seq > state.outboxSince) state.outboxSince = seq
  }

  try {
    const ackRes = await deps.fetchImpl("/rooms/" + deps.roomCode + "/outbox/cursor", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + state.memberToken },
      body: JSON.stringify({ seq: state.outboxSince }),
    })
    if (!ackRes.ok) throw new Error("ack failed: " + ackRes.status)
    state.drainFailureStreak = 0
  } catch (e) {
    state.drainFailureStreak += 1
  }

  return { status: "ok", gap: plan.gap, items: plan.items }
}

/** Defect 4: whether the failure banner should show — enough consecutive
 *  failed ticks in a row (of EITHER kind — the outbox drain, BRIEF-21's
 *  stream reconnect, or both) that this is no longer plausibly one dropped
 *  packet. */
export function outboxFailureVisible(state: OutboxTickState): boolean {
  return state.drainFailureStreak >= OUTBOX_FAILURE_VISIBLE_AFTER || state.streamFailureStreak >= OUTBOX_FAILURE_VISIBLE_AFTER
}

/** One button per configured surface, in the fidelity-ladder order
 *  (architecture.md §2.1), plus "stay here" for someone already on this
 *  page — each surface button is the same deep link `joinLinks` already
 *  built with `join <code>` prefilled (docs/AGENTPUSH.md §9.5, architecture.md
 *  §5.3), just rendered as a tappable choice instead of a plain link. */
function joinButtonsHtml(links: JoinLinks): string {
  const buttons: string[] = []
  if (links.whatsapp !== undefined) {
    buttons.push(`<a class="join-btn" href="${escapeHtml(links.whatsapp)}">Join on WhatsApp</a>`)
  }
  if (links.telegram !== undefined) {
    buttons.push(`<a class="join-btn" href="${escapeHtml(links.telegram)}">Join on Telegram</a>`)
  }
  if (links.sms !== undefined) {
    buttons.push(`<a class="join-btn" href="${escapeHtml(links.sms)}">Join by SMS</a>`)
  }
  buttons.push(`<button type="button" id="stay-here-button" class="join-btn join-btn-stay">Stay here</button>`)
  return buttons.join("")
}

export function renderRoomPage(room: Room, links: JoinLinks, agentBusy = false): string {
  const code = room.code
  const live = artifactLive(room)
  const paused = room.state === "paused"
  const artifactMessage = paused || room.artifactReady === false ? ARTIFACT_PAUSED_TEXT : "No artifact yet"
  // The room the inline script sees must carry no dead artifact URL either:
  // a paused/not-ready room's stored URL (the raw e2b host, or a stale one)
  // is stripped before it is embedded in the page at all.
  const scriptRoom: Room = live ? room : { ...room, artifactUrl: undefined }
  const pillClass = paused ? "pill paused" : "pill live"
  const agentStatus = `${agentBusy ? "working" : "idle"} · last activity ${escapeHtml(room.lastActivityAt)}`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Rendez-vous — ${escapeHtml(code)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <div class="join-code">Room <span class="code" id="room-code">${escapeHtml(code)}</span></div>
  <div class="join-body">
    <div class="join-qr" title="Scan to join ${escapeHtml(code)}">${qrSvg(links.web)}</div>
    <a class="join-web-link" href="${escapeHtml(links.web)}">${escapeHtml(links.web)}</a>
    <div class="join-buttons">${joinButtonsHtml(links)}</div>
  </div>
  <div class="state-row" id="state-row">
    <span id="state-pill" class="${pillClass}">${paused ? "paused" : "live"}</span>
    <span id="agent-status" class="agent-status">${agentStatus}</span>
    <span id="updated-ago"></span>
    <span id="connection-lost">connection lost, retrying</span>
    <span id="member-status"></span>
    <span id="outbox-failure"></span>
    <span id="stream-status"></span>
  </div>
  <div id="members">${membersHtml(room)}</div>
</header>
<main>
  <section id="transcript-pane">
    <div id="transcript"></div>
  </section>
  <section id="artifact-pane">
    <div id="artifact-placeholder" style="${live ? "display:none" : ""}">${escapeHtml(artifactMessage)}</div>
    <iframe id="artifact-frame" style="${live ? "" : "display:none"}" title="room artifact" src="${
      live && room.artifactUrl !== undefined ? escapeHtml(room.artifactUrl) : ""
    }"></iframe>
  </section>
</main>
<footer>
  <div id="name-error"></div>
  <input id="name-input" placeholder="Your name" autocomplete="off" />
  <input id="text-input" placeholder="Say something…" autocomplete="off" />
  <button id="send-button">Send</button>
</footer>
<script>${script(code, scriptRoom, agentBusy)}</script>
</body>
</html>
`
}

export function renderRoomNotFoundPage(code: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Rendez-vous — room not found</title>
<style>${STYLE}</style>
</head>
<body>
<header><h1>Room not found</h1></header>
<main style="display:block; padding: 16px;">
  <p>No room with code <code>${escapeHtml(code)}</code>.</p>
  <p>Send <code>new</code> to start one, or double-check the code and try again.</p>
</main>
</body>
</html>
`
}