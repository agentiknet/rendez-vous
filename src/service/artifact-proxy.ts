/**
 * Room-scoped artifact proxy (architecture.md §9.3b). The raw e2b URL
 * (`https://<port>-<sandboxId>.e2b.app`) is a pure function of sandbox id
 * and port — stable for one box, dead the moment that box is replaced. This
 * module gives every room a URL keyed on its code instead, which never
 * changes: `GET /r/:code/artifact/` reverse-proxies to whatever
 * `room.artifactUrl` currently is, so a box swap heals the link in place
 * rather than stranding whoever already has it open or pasted in a thread.
 *
 * Reverse-proxy, not redirect: a `302` would put the ephemeral e2b origin in
 * the browser bar, so the tab goes stale the instant the box changes. This
 * keeps the stable `/r/:code/artifact/...` URL in the bar for the whole
 * session.
 *
 * Known limit: nothing here rewrites the proxied HTML. An absolute path
 * (`/foo.js`) or an absolute `Location:` header emitted by the artifact app
 * resolves against the room-scoped prefix's *origin*, not its *path* — it
 * reaches this service at `/foo.js`, not `/r/:code/artifact/foo.js`, and 404s
 * unless the artifact app only ever uses relative references. Acceptable for
 * `apps/room-artifact`'s single-page layout; would need path rewriting for a
 * multi-asset app that hardcodes absolute paths.
 */
import type { ServerResponse } from "node:http"
import { Readable } from "node:stream"
import { env } from "../env.ts"

const UPSTREAM_TIMEOUT_MS = 15_000
const REFRESH_SECONDS = 10

/** RFC 7230 §6.1 hop-by-hop headers, meaningful only for one transport hop
 *  and never valid to forward across a proxy. */
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

/** The stable, room-scoped URL members are given everywhere instead of the
 *  raw box URL — never changes for a room, so re-sending it on box
 *  replacement is unnecessary (src/fanout/reader.ts keys its "artifact
 *  changed" check on this same value). */
export function publicArtifactUrl(code: string): string {
  return `${env.publicUrl}/r/${code}/artifact/`
}

/** The public, stable URL for one stored media record — `GET /r/:code/media/:id`.
 *
 *  This is not only a convenience for links in text. It is the ONLY way an
 *  image reaches a Telegram member: that driver has no buffer or base64
 *  upload path and can send media exclusively by public URL
 *  (`src/channels/agentpush/outbound.ts`). Bytes we hold locally are
 *  unsendable there until they have one of these. */
export function publicMediaUrl(roomCode: string, mediaId: string): string {
  return `${env.publicUrl}/r/${roomCode}/media/${mediaId}`
}

function unavailablePage(): string {
  return (
    "<!doctype html>\n" +
    '<html lang="en"><head><meta charset="utf-8">' +
    `<meta http-equiv="refresh" content="${REFRESH_SECONDS}">` +
    "<title>Rendez-vous — artifact</title></head>" +
    "<body>Artifact not available yet, this page refreshes.</body></html>\n"
  )
}

function sendUnavailable(res: ServerResponse): void {
  const body = unavailablePage()
  res.writeHead(503, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  })
  res.end(body)
}

/** Append the request's own sub-path and query to the room's current
 *  artifact base URL: `/r/:code/artifact/foo?bar=1` against
 *  `https://3210-x.e2b.app` becomes `https://3210-x.e2b.app/foo?bar=1`. */
function buildUpstreamUrl(artifactUrl: string, subPath: string, search: string): URL | undefined {
  try {
    const base = artifactUrl.endsWith("/") ? artifactUrl : `${artifactUrl}/`
    const relative = subPath.startsWith("/") ? subPath.slice(1) : subPath
    const url = new URL(relative, base)
    url.search = search
    return url
  } catch {
    return undefined
  }
}

export interface ProxyArtifactRequest {
  /** The room's current artifact URL, or undefined when it has none yet. */
  readonly artifactUrl: string | undefined
  readonly method: string | undefined
  /** Everything after `/r/:code/artifact` in the request path, e.g. `""` or `"/foo/bar"`. */
  readonly subPath: string
  /** The request's own query string, including its leading `?`, or `""`. */
  readonly search: string
  /** The room's stored canvakit render (the `render_artifact` tool's output,
   *  `ArtifactRenderStore`), when one exists. When set and the request is for
   *  the index (no sub-path), it is served directly instead of proxying — the
   *  box cannot produce the branded page, this service already has it. Every
   *  other path still proxies to the box, so the app's own assets keep
   *  working. */
  readonly renderedIndex?: Buffer
  /** Upstream fetch timeout in ms. Defaults to 15s (the brief's number);
   *  overridable so a test can prove the timeout path without a real 15s wait. */
  readonly timeoutMs?: number
}

/** The index paths a browser hits when opening the artifact URL. */
function isIndexPath(subPath: string): boolean {
  return subPath === "" || subPath === "/"
}

/**
 * Reverse-proxy one request to the room's current artifact URL. GET and HEAD
 * only, no redirect following, a 15s upstream timeout, hop-by-hop headers
 * stripped, everything else (content-type, cache headers, etc.) copied
 * through unchanged. A missing `artifactUrl` or an unreachable/timed-out
 * upstream both self-heal the same way: a 503 page that refreshes itself,
 * so a momentarily dead box (mid-resume, mid-boot) never needs a human to
 * reload.
 *
 * Index exception: when the room has a stored render, the index comes from
 * this service, not the box — so members see the branded page even before
 * the box is serving, and after its box has died (the render outlives the
 * box; the dead-box gating for the LINK lives in http.ts's
 * `toPublicRoom`/`roomStatePayload`, which only advertise the URL when
 * something is actually servable).
 */
export async function proxyArtifact(req: ProxyArtifactRequest, res: ServerResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" })
    res.end()
    return
  }

  if (req.renderedIndex !== undefined && isIndexPath(req.subPath)) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": req.renderedIndex.length,
    })
    res.end(req.method === "HEAD" ? undefined : req.renderedIndex)
    return
  }

  if (req.artifactUrl === undefined) {
    sendUnavailable(res)
    return
  }

  const upstream = buildUpstreamUrl(req.artifactUrl, req.subPath, req.search)
  if (upstream === undefined) {
    sendUnavailable(res)
    return
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? UPSTREAM_TIMEOUT_MS)
  let upstreamRes: Response
  try {
    upstreamRes = await fetch(upstream, {
      method: req.method,
      redirect: "manual",
      signal: controller.signal,
    })
  } catch {
    sendUnavailable(res)
    return
  } finally {
    clearTimeout(timer)
  }

  const headers: Record<string, string> = {}
  upstreamRes.headers.forEach((value, name) => {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers[name] = value
  })
  res.writeHead(upstreamRes.status, headers)

  if (req.method === "HEAD" || upstreamRes.body === null) {
    res.end()
    return
  }
  await new Promise<void>((resolve, reject) => {
    const body = Readable.fromWeb(upstreamRes.body as import("node:stream/web").ReadableStream<Uint8Array>)
    body.on("error", reject)
    res.on("error", reject)
    res.on("close", resolve)
    res.on("finish", resolve)
    body.pipe(res)
  })
}
