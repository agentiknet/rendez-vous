/**
 * The `render_artifact` MCP App panel (BRIEF-02): a self-contained HTML shell
 * for `resources/read` in mcp-canvakit.ts to hand back for
 * `ui://render_artifact/view` — a sibling of `room-view.html.ts` (BRIEF-01),
 * same reasoning, same constraints: inline CSS, inline vanilla JS, no build
 * step, reusing `escapeHtml`/`embedJson` for the one escaping story in this
 * repo.
 *
 * D1: the resource is a SHELL, not the rendered bytes. A host fetches
 * `resources/read` once, when the tool is called; the agent re-renders the
 * artifact many times over a room's life. Baking the rendered HTML into the
 * resource would freeze the panel at the first render while the room moves
 * on — absence reading as delivery, in panel form. Instead this shell polls
 * `GET /r/:code/state` (the same endpoint and 3s cadence room-view.html.ts
 * and page.ts use) for `artifact.ready`, and shows the LIVE artifact once it
 * flips true.
 *
 * How the shell shows the artifact (D1, unresolved by design until tested
 * against a real host): the MCP Apps CSP vocabulary has `connectDomains` and
 * `resourceDomains` but no `frame-src` key, so a host that sandboxes the
 * panel may block an inner `<iframe>` with no declaration able to allow it.
 * This ships the iframe as the primary path — `src` set only once the
 * artifact is ready — with a `fetch`-and-inject fallback wired to the
 * iframe's `error` event, reachable via `connect-src` (`connectDomains`).
 * Neither path is host-verified; see BRIEF-02's report.
 */
import { ARTIFACT_PAUSED_TEXT, embedJson, escapeHtml } from "../web/page.ts"

const LOADING_TEXT = "Loading…"

/** Absence must never read as delivery: a fetch that fails must be visible,
 *  not just silently skipped on the next tick. Same threshold and message as
 *  room-view.html.ts, for the same reason. */
const FAILURES_BEFORE_WARNING = 3
const LOST_CONTACT_TEXT = "lost contact with the room"
const INJECT_FAILED_TEXT = "could not load the artifact into this panel"

const STYLE = `
  :root { --accent: #3a6df0; --border: #e2e4ea; --bg: #fafafc; --grey: #6b7280; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; font-family: system-ui, -apple-system, sans-serif; color: #1a1c23; background: var(--bg); }
  header { padding: 12px 14px; border-bottom: 1px solid var(--border); background: #fff; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; flex: none; }
  .room-code { font-size: 18px; font-weight: 700; }
  .room-code .code { color: var(--accent); font-family: ui-monospace, monospace; }
  .pill { padding: 2px 10px; border-radius: 999px; font-weight: 700; font-size: 12px; }
  .pill.loading { background: #eef1fb; color: var(--grey); }
  .pill.ready { background: #e6f6ec; color: #1a7f37; }
  .pill.paused { background: #fdeaea; color: #b42318; }
  #connection-lost { color: #b42318; font-weight: 600; font-size: 12px; padding: 6px 14px; display: none; background: #fdeaea; border-bottom: 1px solid #f2c4c0; flex: none; }
  main { flex: 1; display: flex; min-height: 0; }
  #artifact-frame { flex: 1; display: flex; }
  #artifact-frame iframe { flex: 1; border: 0; width: 100%; height: 100%; }
  .artifact-paused { margin: auto; color: var(--grey); font-size: 13px; }
`

function script(code: string, publicUrl: string): string {
  return `
    const ROOM_CODE = ${embedJson(code)};
    const PUBLIC_URL = ${embedJson(publicUrl)};
    const ARTIFACT_URL = PUBLIC_URL + "/r/" + ROOM_CODE + "/artifact/";
    const ARTIFACT_PAUSED_TEXT = ${embedJson(ARTIFACT_PAUSED_TEXT)};
    const LOST_CONTACT_TEXT = ${embedJson(LOST_CONTACT_TEXT)};
    const INJECT_FAILED_TEXT = ${embedJson(INJECT_FAILED_TEXT)};
    const FAILURES_BEFORE_WARNING = ${embedJson(FAILURES_BEFORE_WARNING)};

    const pillEl = document.getElementById("state-pill");
    const frameEl = document.getElementById("artifact-frame");
    const connectionEl = document.getElementById("connection-lost");

    let shown = false;

    // D1 fallback: an inner iframe may be blocked by a host's sandbox with
    // no CSP declaration able to allow it (no frame-src key in the MCP Apps
    // vocabulary). If it fires "error", fetch the artifact ourselves —
    // reachable via connect-src (connectDomains) — and inject its markup.
    async function injectByFetch() {
      try {
        const res = await fetch(ARTIFACT_URL);
        if (!res.ok) throw new Error("artifact fetch failed: " + res.status);
        const html = await res.text();
        frameEl.innerHTML = html;
      } catch (e) {
        frameEl.textContent = INJECT_FAILED_TEXT;
      }
    }

    function showArtifact() {
      if (shown) return;
      shown = true;
      frameEl.textContent = "";
      const iframe = document.createElement("iframe");
      iframe.src = ARTIFACT_URL;
      iframe.title = "Artifact";
      iframe.addEventListener("error", injectByFetch);
      frameEl.appendChild(iframe);
    }

    function showPaused() {
      shown = false;
      frameEl.textContent = "";
      const span = document.createElement("span");
      span.className = "artifact-paused";
      span.textContent = ARTIFACT_PAUSED_TEXT;
      frameEl.appendChild(span);
    }

    function renderState(state) {
      const ready = state.artifact.ready === true;
      pillEl.textContent = ready ? "ready" : "paused";
      pillEl.className = "pill " + (ready ? "ready" : "paused");
      if (ready) {
        showArtifact();
      } else {
        showPaused();
      }
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

/** Renders `render_artifact`'s panel (D1: a shell, not the rendered bytes).
 *  `publicUrl` is `env.publicUrl` (baked in, not looked up client-side): a
 *  host's sandboxed iframe cannot resolve a bare path, and the CSP
 *  `connectDomains` its host wraps around this document must name the exact
 *  origin the script below fetches. */
export function artifactViewHtml(code: string, publicUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Rendez-vous — artifact ${escapeHtml(code)}</title>
<style>${STYLE}</style>
</head>
<body>
<div id="connection-lost">${escapeHtml(LOST_CONTACT_TEXT)}</div>
<header>
  <div class="room-code">Artifact <span class="code">${escapeHtml(code)}</span></div>
  <span id="state-pill" class="pill loading">${LOADING_TEXT}</span>
</header>
<main>
  <div id="artifact-frame">${LOADING_TEXT}</div>
</main>
<script>${script(code, publicUrl)}</script>
</body>
</html>
`
}
