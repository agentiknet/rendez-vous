/**
 * The `room_view` MCP App panel (BRIEF-01): the SPECTATOR projection of a
 * room, rendered as a self-contained HTML string for a host to serve in a
 * sandboxed iframe (`resources/read` in mcp-room.ts hands this back for
 * `ui://room_view/view`). A sibling of `src/web/page.ts`'s spectator half —
 * inline CSS, inline vanilla JS, no build step, reusing its `escapeHtml` /
 * `embedJson` so there is exactly one escaping story in this repo — but this
 * panel is narrower on purpose (D1): no name claim, no outbox drain, no
 * transcript, no member token. It shows only what `GET /r/:code/state`
 * (unauthenticated, the spectator endpoint) already answers to anybody who
 * knows the room code.
 *
 * A host opens this panel cold with nothing server-rendered beyond the room
 * code (D3): there is no room snapshot to bake in, only the code and the
 * base URL to poll. So the first paint is an explicit "loading" state, never
 * a blank panel, and the poll loop (same 3s cadence as page.ts, same reason:
 * the host cannot afford a full reload wiping the panel mid-conversation)
 * fills it in from the first successful fetch.
 */
import { embedJson, escapeHtml } from "../web/page.ts"

const ARTIFACT_PAUSED_TEXT = "artifact paused, the link will come back when the room wakes"
const ARTIFACT_NONE_TEXT = "No artifact yet"
const LOADING_TEXT = "Loading…"

/** Absence must never read as delivery: a fetch that fails must be visible,
 *  not just silently skipped on the next tick. Shown only after this many
 *  CONSECUTIVE failures (one dropped poll is noise on a 3s cadence; three in
 *  a row is the panel actually losing contact), and cleared on the very next
 *  success — never sticky once the room is reachable again. */
const FAILURES_BEFORE_WARNING = 3
const LOST_CONTACT_TEXT = "lost contact with the room"

const STYLE = `
  :root { --accent: #3a6df0; --border: #e2e4ea; --bg: #fafafc; --grey: #6b7280; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; color: #1a1c23; background: var(--bg); }
  header { padding: 12px 14px; border-bottom: 1px solid var(--border); background: #fff; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .room-code { font-size: 18px; font-weight: 700; }
  .room-code .code { color: var(--accent); font-family: ui-monospace, monospace; }
  .pill { padding: 2px 10px; border-radius: 999px; font-weight: 700; font-size: 12px; }
  .pill.loading { background: #eef1fb; color: var(--grey); }
  .pill.live { background: #e6f6ec; color: #1a7f37; }
  .pill.paused { background: #fdeaea; color: #b42318; }
  .agent-status { font-size: 12px; color: var(--grey); font-weight: 600; }
  #connection-lost { color: #b42318; font-weight: 600; font-size: 12px; padding: 6px 14px; display: none; background: #fdeaea; border-bottom: 1px solid #f2c4c0; }
  main { padding: 14px; display: flex; flex-direction: column; gap: 16px; }
  h2 { margin: 0 0 6px; font-size: 13px; color: var(--grey); text-transform: uppercase; letter-spacing: 0.04em; }
  #members { font-size: 13px; color: var(--grey); }
  .member { display: inline-flex; align-items: center; gap: 5px; margin: 0 10px 6px 0; }
  .member-name { font-weight: 600; color: #1a1c23; }
  .tier-badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border); background: #fff; color: var(--grey); font-weight: 600; }
  .member-away { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: #fdeaea; color: #b42318; font-weight: 700; }
  #artifact a { color: var(--accent); font-weight: 600; }
  #artifact .artifact-paused { color: var(--grey); font-size: 13px; }
`

function script(code: string, publicUrl: string): string {
  return `
    const ROOM_CODE = ${embedJson(code)};
    const PUBLIC_URL = ${embedJson(publicUrl)};
    const ARTIFACT_PAUSED_TEXT = ${embedJson(ARTIFACT_PAUSED_TEXT)};
    const ARTIFACT_NONE_TEXT = ${embedJson(ARTIFACT_NONE_TEXT)};
    const LOST_CONTACT_TEXT = ${embedJson(LOST_CONTACT_TEXT)};
    const FAILURES_BEFORE_WARNING = ${embedJson(FAILURES_BEFORE_WARNING)};

    const pillEl = document.getElementById("state-pill");
    const agentEl = document.getElementById("agent-status");
    const membersEl = document.getElementById("members");
    const artifactEl = document.getElementById("artifact");
    const connectionEl = document.getElementById("connection-lost");

    function renderMembers(members) {
      membersEl.textContent = "";
      if (members.length === 0) {
        membersEl.textContent = "No one here yet.";
        return;
      }
      members.forEach(function (m) {
        const span = document.createElement("span");
        span.className = "member";
        const name = document.createElement("span");
        name.className = "member-name";
        name.textContent = m.displayName;
        span.appendChild(name);
        const tier = document.createElement("span");
        tier.className = "tier-badge tier-" + m.tier;
        tier.textContent = m.tier;
        span.appendChild(tier);
        if (m.away === true) {
          const away = document.createElement("span");
          away.className = "member-away";
          away.textContent = "away";
          span.appendChild(away);
        }
        membersEl.appendChild(span);
      });
    }

    function renderArtifact(state) {
      artifactEl.textContent = "";
      if (state.artifact.ready && typeof state.artifact.url === "string") {
        const a = document.createElement("a");
        a.href = state.artifact.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = "Open artifact";
        artifactEl.appendChild(a);
        return;
      }
      const span = document.createElement("span");
      span.className = "artifact-paused";
      span.textContent = state.state === "paused" ? ARTIFACT_PAUSED_TEXT : ARTIFACT_NONE_TEXT;
      artifactEl.appendChild(span);
    }

    function renderState(state) {
      const paused = state.state === "paused";
      pillEl.textContent = paused ? "paused" : "live";
      pillEl.className = "pill " + (paused ? "paused" : "live");
      agentEl.textContent = state.agent.busy ? "agent working" : "agent idle";
      renderMembers(state.members);
      renderArtifact(state);
    }

    let consecutiveFailures = 0;

    async function pollState() {
      try {
        const res = await fetch(PUBLIC_URL + "/r/" + ROOM_CODE + "/state");
        if (!res.ok) throw new Error("state fetch failed: " + res.status);
        const state = await res.json();
        consecutiveFailures = 0;
        connectionEl.style.display = "none";
        renderState(state);
      } catch (e) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= FAILURES_BEFORE_WARNING) {
          connectionEl.style.display = "";
        }
      }
    }

    setInterval(pollState, 3000);
    pollState();
  `
}

/** Renders `room_view`'s panel. `publicUrl` is `env.publicUrl` (baked in, not
 *  looked up client-side): a host's sandboxed iframe cannot resolve a bare
 *  path, and the CSP `connectDomains` its host wraps around this document
 *  must name the exact origin the script below fetches. */
export function roomViewHtml(code: string, publicUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Rendez-vous — ${escapeHtml(code)}</title>
<style>${STYLE}</style>
</head>
<body>
<div id="connection-lost">${escapeHtml(LOST_CONTACT_TEXT)}</div>
<header>
  <div class="room-code">Room <span class="code" id="room-code">${escapeHtml(code)}</span></div>
  <span id="state-pill" class="pill loading">${LOADING_TEXT}</span>
  <span id="agent-status" class="agent-status"></span>
</header>
<main>
  <section>
    <h2>Members</h2>
    <div id="members">${LOADING_TEXT}</div>
  </section>
  <section>
    <h2>Artifact</h2>
    <div id="artifact">${LOADING_TEXT}</div>
  </section>
</main>
<script>${script(code, publicUrl)}</script>
</body>
</html>
`
}
