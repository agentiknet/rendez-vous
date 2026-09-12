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
 */
import type { JoinLinks } from "../links/index.ts"
import { qrSvg } from "../links/index.ts"
import type { Member, Room } from "../rooms/types.ts"

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** JSON embedded inside a `<script>` tag: escape `<` so a value containing
 *  literal `</script>` can never break out of the tag. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c")
}

const ARTIFACT_PAUSED_TEXT = "artifact paused, the link will come back when the room wakes"

/** The member-facing artifact is live only when the room is active and the
 *  last boot/liveness probe confirmed the box is actually serving it —
 *  `artifactReady: false` or a paused room means NO iframe and NO clickable
 *  link, ever (the dead-artifact-URL finding, architecture.md §9.3b). */
function artifactLive(room: Room): boolean {
  return room.state !== "paused" && room.artifactUrl !== undefined && room.artifactReady !== false
}

function memberHtml(member: Member): string {
  return (
    `<span class="member"><span class="member-name">${escapeHtml(member.displayName)}</span>` +
    `<span class="tier-badge tier-${escapeHtml(member.tier)}">${escapeHtml(member.tier)}</span>` +
    `<span class="member-joined">joined ${escapeHtml(member.joinedAt)}</span></span>`
  )
}

function membersHtml(room: Room): string {
  if (room.members.length === 0) return "No one here yet."
  return room.members.map(memberHtml).join(", ")
}

const STYLE = `
  :root { --accent: #3a6df0; --border: #e2e4ea; --bg: #fafafc; --grey: #6b7280; }
  * { box-sizing: border-box; }
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
  #members { font-size: 13px; color: var(--grey); max-width: 640px; }
  .member { display: inline-flex; align-items: center; gap: 5px; }
  .member-name { font-weight: 600; color: #1a1c23; }
  .tier-badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border); background: #fff; color: var(--grey); font-weight: 600; }
  .member-joined { font-size: 11px; }
  main { display: flex; height: calc(100vh - 260px); }
  #transcript-pane { flex: 1 1 55%; overflow-y: auto; padding: 12px; border-right: 1px solid var(--border); }
  #artifact-pane { flex: 1 1 45%; display: flex; align-items: stretch; justify-content: center; }
  #artifact-frame { width: 100%; height: 100%; border: 0; }
  #artifact-placeholder { margin: auto; color: var(--grey); font-size: 14px; text-align: center; padding: 0 12px; }
  .bubble { max-width: 90%; margin: 0 0 10px; padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; }
  .bubble.user { background: #eef2ff; margin-left: auto; }
  .bubble.assistant { background: #fff; border: 1px solid var(--border); }
  .badge { display: inline-block; font-size: 11px; font-weight: 600; color: var(--accent); margin-bottom: 4px; }
  details.thought { margin-top: 6px; font-size: 12px; color: var(--grey); }
  details.thought summary { cursor: pointer; }
  .tool-row { font-size: 12px; color: var(--grey); margin-top: 4px; }
  footer { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--border); background: #fff; }
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

    const transcriptEl = document.getElementById("transcript");
    const artifactFrame = document.getElementById("artifact-frame");
    const artifactPlaceholder = document.getElementById("artifact-placeholder");
    const nameInput = document.getElementById("name-input");
    const textInput = document.getElementById("text-input");

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

    let currentMembers = INITIAL_ROOM.members;

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
      currentMembers = members;
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
        span.appendChild(joined);
        el.appendChild(span);
      });
    }

    function findMemberByName(name) {
      const needle = name.trim().toLowerCase();
      return currentMembers.find(function (m) { return m.displayName.toLowerCase() === needle; });
    }

    // Same convention the service's fan-out understands (src/fanout/whisper.ts):
    // a "[[whisper to <name>]]" / "[[/whisper]]" pair, each delimiter on its
    // own line. This page reads the raw daemon transcript directly, so it does
    // its own parsing rather than the already-resolved per-member text the
    // fan-out sends to messenger/email members.
    function parseWhisperBlocks(text) {
      const lines = text.split("\\n");
      const segments = [];
      let broadcastLines = [];
      let i = 0;
      function flush() {
        const joined = broadcastLines.join("\\n");
        if (joined.length > 0) segments.push({ kind: "broadcast", text: joined });
        broadcastLines = [];
      }
      while (i < lines.length) {
        const line = lines[i];
        const open = /^\\[\\[whisper to (.+)\\]\\]$/.exec(line.trim());
        if (!open) {
          broadcastLines.push(line);
          i += 1;
          continue;
        }
        let closeIndex = -1;
        for (let j = i + 1; j < lines.length; j++) {
          if (/^\\[\\[\\/whisper\\]\\]$/.test(lines[j].trim())) { closeIndex = j; break; }
        }
        if (closeIndex === -1) {
          broadcastLines = broadcastLines.concat(lines.slice(i));
          break;
        }
        flush();
        segments.push({ kind: "whisper", targetName: open[1].trim(), text: lines.slice(i + 1, closeIndex).join("\\n") });
        i = closeIndex + 1;
      }
      flush();
      return segments;
    }

    function renderTurnBody(turn) {
      turn.textEl.innerHTML = "";
      parseWhisperBlocks(turn.raw).forEach(function (segment) {
        if (segment.kind === "broadcast") {
          if (segment.text.length === 0) return;
          const span = document.createElement("span");
          span.textContent = segment.text;
          turn.textEl.appendChild(span);
          return;
        }
        const target = findMemberByName(segment.targetName);
        const marker = document.createElement("div");
        marker.className = "whisper-marker";
        marker.textContent = "whispered to " + (target ? target.displayName : segment.targetName);
        turn.textEl.appendChild(marker);

        const details = document.createElement("details");
        details.className = "whisper-toggle";
        const summary = document.createElement("summary");
        summary.textContent = "private, visible here because the web room has no member auth yet";
        const content = document.createElement("div");
        content.className = "whisper-content";
        content.textContent = segment.text;
        details.appendChild(summary);
        details.appendChild(content);
        turn.textEl.appendChild(details);
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

    let since = 0;
    let source = null;
    function connectStream() {
      if (source) source.close();
      source = new EventSource("/rooms/" + ROOM_CODE + "/stream?since=" + since);
      source.onmessage = function (event) {
        let record;
        try { record = JSON.parse(event.data); } catch (e) { return; }
        if (typeof record.seq === "number") since = record.seq;
        render(record);
      };
      source.onerror = function () {
        source.close();
        setTimeout(connectStream, 1000);
      };
    }

    async function sendMessage() {
      const displayName = nameInput.value.trim();
      const text = textInput.value.trim();
      if (!displayName || !text) return;
      localStorage.setItem("rdv-name", displayName);
      textInput.value = "";
      await fetch("/rooms/" + ROOM_CODE + "/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: displayName, text: text }),
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
    setInterval(function () {
      updatedEl.textContent = lastGoodPollAt
        ? "updated " + Math.max(0, Math.round((Date.now() - lastGoodPollAt) / 1000)) + "s ago"
        : "";
    }, 1000);

    renderState(INITIAL_STATE);
    connectStream();
    pollState();
  `
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