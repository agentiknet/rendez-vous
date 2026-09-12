/**
 * The tier-3 room web view: one static HTML page per room, inline CSS and
 * inline vanilla JS, no framework and no build step (build brief
 * constraint 3, architecture.md §2.1). The browser talks only to our
 * service — never the daemon directly (R6, architecture.md §4.2).
 */
import type { JoinLinks } from "../links/index.ts"
import { qrSvg } from "../links/index.ts"
import type { Room } from "../rooms/types.ts"

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

function rosterHtml(room: Room): string {
  if (room.members.length === 0) return "No one here yet."
  return room.members.map((member) => `${escapeHtml(member.displayName)} (${escapeHtml(member.tier)})`).join(", ")
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
  #roster { font-size: 13px; color: var(--grey); }
  main { display: flex; height: calc(100vh - 260px); }
  #transcript-pane { flex: 1 1 55%; overflow-y: auto; padding: 12px; border-right: 1px solid var(--border); }
  #artifact-pane { flex: 1 1 45%; display: flex; align-items: stretch; justify-content: center; }
  #artifact-frame { width: 100%; height: 100%; border: 0; }
  #artifact-placeholder { margin: auto; color: var(--grey); font-size: 14px; }
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

function script(code: string, room: Room): string {
  return `
    const ROOM_CODE = ${embedJson(code)};
    const INITIAL_ROOM = ${embedJson(room)};

    const transcriptEl = document.getElementById("transcript");
    const rosterEl = document.getElementById("roster");
    const artifactFrame = document.getElementById("artifact-frame");
    const artifactPlaceholder = document.getElementById("artifact-placeholder");
    const nameInput = document.getElementById("name-input");
    const textInput = document.getElementById("text-input");

    nameInput.value = localStorage.getItem("rdv-name") || "";

    let currentArtifactUrl = null;
    function updateArtifact(url) {
      if (!url || url === currentArtifactUrl) return;
      currentArtifactUrl = url;
      artifactFrame.src = url;
      artifactFrame.style.display = "block";
      artifactPlaceholder.style.display = "none";
    }

    let currentMembers = INITIAL_ROOM.members;
    function renderRoster(members) {
      currentMembers = members;
      rosterEl.textContent = members.length === 0
        ? "No one here yet."
        : members.map((m) => m.displayName + " (" + m.tier + ")").join(", ");
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

    async function refreshRoom() {
      try {
        const res = await fetch("/rooms/" + ROOM_CODE);
        if (!res.ok) return;
        const room = await res.json();
        renderRoster(room.members);
        updateArtifact(room.artifactUrl);
      } catch (e) {
        // transient — the next poll or send will retry
      }
    }

    function bubble(className) {
      const el = document.createElement("div");
      el.className = "bubble " + className;
      transcriptEl.appendChild(el);
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
      return el;
    }

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
      refreshRoom();
    }

    document.getElementById("send-button").addEventListener("click", sendMessage);
    textInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") sendMessage();
    });

    document.getElementById("stay-here-button").addEventListener("click", function () {
      textInput.focus();
    });

    renderRoster(INITIAL_ROOM.members);
    updateArtifact(INITIAL_ROOM.artifactUrl);
    connectStream();
    setInterval(refreshRoom, 10000);
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

export function renderRoomPage(room: Room, links: JoinLinks): string {
  const code = room.code
  const artifactHidden = room.artifactUrl === undefined
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
  <div class="join-code">Room <span class="code">${escapeHtml(code)}</span></div>
  <div class="join-body">
    <div class="join-qr" title="Scan to join ${escapeHtml(code)}">${qrSvg(links.web)}</div>
    <a class="join-web-link" href="${escapeHtml(links.web)}">${escapeHtml(links.web)}</a>
    <div class="join-buttons">${joinButtonsHtml(links)}</div>
  </div>
  <div id="roster">${rosterHtml(room)}</div>
</header>
<main>
  <section id="transcript-pane">
    <div id="transcript"></div>
  </section>
  <section id="artifact-pane">
    <div id="artifact-placeholder" style="${artifactHidden ? "" : "display:none"}">No artifact yet</div>
    <iframe id="artifact-frame" style="${artifactHidden ? "display:none" : ""}" title="room artifact" src="${
      room.artifactUrl !== undefined ? escapeHtml(room.artifactUrl) : ""
    }"></iframe>
  </section>
</main>
<footer>
  <input id="name-input" placeholder="Your name" autocomplete="off" />
  <input id="text-input" placeholder="Say something…" autocomplete="off" />
  <button id="send-button">Send</button>
</footer>
<script>${script(code, room)}</script>
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
