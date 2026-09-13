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
 * How the shell shows the artifact (D1): this panel renders the live artifact
 * through an inner `<iframe>`, which `resources/read`'s `_meta.ui.csp` now
 * allows via `frameDomains` (BRIEF-03) — a host that enforces the CSP schema's
 * default of `frame-src 'none'` on an undeclared domain would otherwise block
 * it outright. This still ships the iframe as the primary path — `src` set
 * only once the artifact is ready — with a `fetch`-and-inject fallback wired
 * to the iframe's `error` event, reachable via `connect-src` (`connectDomains`),
 * for hosts stricter than the one this was verified against.
 */
import { ARTIFACT_PAUSED_TEXT, SIZE_CHANGED_METHOD, embedJson, escapeHtml } from "../web/page.ts"

const LOADING_TEXT = "Loading…"

/** A fixed height in pixels, not a measurement (BRIEF-05). This panel's
 *  artifact lives in a cross-origin inner iframe: the origin boundary that
 *  makes CSP `frame-src` necessary in the first place also blocks this
 *  panel from reading that iframe's content height (`contentWindow`/
 *  `contentDocument` are opaque across origins). There is no measurement to
 *  make here that would not silently return 0 — do not "fix" this into one. */
const ARTIFACT_PANEL_HEIGHT = 520

/** The freshness signal a `renderState` poll acts on, reduced to one
 *  comparable value (BRIEF-05, replacing the `shown` one-shot latch):
 *  `undefined` while paused/not-ready (mirrors the old reset-on-pause
 *  behaviour), `renderedAt` once a stored render exists (the store's own
 *  timestamp, never invented here), or a fixed sentinel for a room that is
 *  `ready` purely from box liveness with no stored render yet — a real case
 *  (`roomStatePayload`'s `artifactLive` can be true from `room.artifactUrl`
 *  alone) but one with no freshness signal to compare, so it shows once and
 *  is left alone until a real render lands.
 *
 *  Exported as a pure function, the same way `page.ts`'s `planOutboxRender`
 *  is: embedded into the shipped script via `toString()` below AND driven
 *  directly by tests, so "no `shown`-style latch" is proven by behaviour,
 *  not grepped out of a string. */
export const artifactShowKey = (ready: boolean, renderedAt: string | undefined): string | undefined => {
  if (!ready) return undefined
  return renderedAt === undefined ? "ready-no-stored-render" : renderedAt
}

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
    const ARTIFACT_PANEL_HEIGHT = ${embedJson(ARTIFACT_PANEL_HEIGHT)};
    const SIZE_CHANGED_METHOD = ${embedJson(SIZE_CHANGED_METHOD)};
    const artifactShowKey = ${artifactShowKey.toString()};

    const pillEl = document.getElementById("state-pill");
    const frameEl = document.getElementById("artifact-frame");
    const connectionEl = document.getElementById("connection-lost");

    // undefined = nothing currently shown (paused, or no poll answered yet).
    // Replaces the old \`shown\` one-shot latch (BRIEF-05): this is compared
    // against the freshness key on every poll, not set once and forgotten.
    let shownKey;

    // D1 fallback: an inner iframe may be blocked by a host's sandbox with
    // no CSP declaration able to allow it (no frame-src key in the MCP Apps
    // vocabulary). If it fires "error", fetch the artifact ourselves —
    // reachable via connect-src (connectDomains) — and inject its markup.
    // Takes the same cache-busted URL showArtifact used, so a fallback
    // fetch cannot itself serve stale bytes.
    async function injectByFetch(src) {
      try {
        const res = await fetch(src);
        if (!res.ok) throw new Error("artifact fetch failed: " + res.status);
        const html = await res.text();
        frameEl.innerHTML = html;
      } catch (e) {
        frameEl.textContent = INJECT_FAILED_TEXT;
      }
    }

    function showArtifact(key, renderedAt) {
      shownKey = key;
      frameEl.textContent = "";
      const iframe = document.createElement("iframe");
      // Cache-bust with the render version, but ONLY when there is one
      // (BRIEF-05): a stored render's index is served directly by
      // proxyArtifact, which ignores the query string entirely — safe by
      // construction, verified by reading that code path, and the only path
      // this panel's URL (no sub-path) ever takes once a render has landed,
      // which by the time this panel exists (it is opened from
      // render_artifact's own tool result) has always already happened. The
      // "ready, no stored render" fallback has no such guarantee — it may
      // still be proxying straight to the e2b box — so it gets the bare URL,
      // unverified query behaviour on that upstream left untouched.
      const src = renderedAt === undefined ? ARTIFACT_URL : ARTIFACT_URL + "?v=" + encodeURIComponent(renderedAt);
      iframe.src = src;
      iframe.title = "Artifact";
      iframe.addEventListener("error", function () {
        injectByFetch(src);
      });
      frameEl.appendChild(iframe);
    }

    function showPaused() {
      shownKey = undefined;
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
      const key = artifactShowKey(ready, state.artifact.renderedAt);
      if (key === undefined) {
        showPaused();
      } else if (key !== shownKey) {
        showArtifact(key, state.artifact.renderedAt);
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

    // BRIEF-05: the artifact lives in a cross-origin inner iframe (see
    // ARTIFACT_PANEL_HEIGHT's comment) — a fixed height, sent once, guarded
    // so a host that ignores or blocks it is no worse off than today.
    try {
      window.parent.postMessage(
        { jsonrpc: "2.0", method: SIZE_CHANGED_METHOD, params: { height: ARTIFACT_PANEL_HEIGHT } },
        "*",
      );
    } catch (e) {
      // guarded: see the comment above.
    }
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
