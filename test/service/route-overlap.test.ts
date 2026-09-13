/**
 * Empirical answer to the route-overlap hypothesis: agentpush prod's
 * `rendez-vous` inbound route has `channel: null` (catch-all across every
 * channel), while `rendez-vous-mail` has `channel: "mail"`, both priority 0.
 *
 * Ground-truthed on the dispatch side (read-only checkout at
 * /Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/projects/agentpush,
 * never edited):
 *
 *   - `matchesInboundRoute` (packages/core/src/domain/inbound-route/evaluate.ts:56)
 *     gates every match type on `route.channel !== null && route.channel !== channel`.
 *     For a `channel: null` route this is `null !== null` (false) short-
 *     circuiting the `&&` to false, so the channel gate never rejects a
 *     catch-all route — a `channel: null` route DOES match a `mail`-channel
 *     inbound. Confirmed further by the module doc comment (evaluate.ts:13,
 *     "NULL applies everywhere") and by `pollAccount` (apps/worker/src/
 *     poll-inbound.ts:190-191) evaluating every enabled route — not just
 *     mail-scoped ones — against `MAIL_CHANNEL = "mail"`, and by
 *     `dispatchMessagingInbound`/`pollAccount`'s shared doc comment
 *     (evaluate.ts:11, "A route may match 0, 1, or several messages — routes
 *     are independent, not first-match-wins"). So both `rendez-vous`
 *     (channel: null) and `rendez-vous-mail` (channel: "mail") match the same
 *     inbound email and each gets its own journaled DeliveryEvent + notify
 *     dispatch.
 *   - The envelope POSTed is always the `inbound_mail` event shape
 *     (`buildNotifyPayload`, poll-inbound.ts:125-144) — the mail poll path
 *     builds this same shape for EVERY route it matches, regardless of that
 *     route's own `channel` column. There is no per-route envelope
 *     translation: a `channel: null` route configured for messenger traffic
 *     still receives the mail-shaped envelope when it matches a mail inbound,
 *     not `MessagingInboundEnvelope`.
 *
 * This file proves the receiving side empirically: POST the real
 * `inbound_mail` envelope shape (docs/AGENTPUSH.md §8.2) to BOTH of our
 * routes' `notify_url`s — `/inbound/agentpush` (the `rendez-vous` route,
 * channel: null) and `/inbound/agentpush-mail` (the `rendez-vous-mail`
 * route, channel: "mail") — and asserts what each handler actually does with
 * a shape it wasn't built for.
 */
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { MediaStore } from "../../src/service/media-store.ts"
import type { RoomService } from "../../src/service/room-service.ts"
import { startExtendedFakeDaemon, type ExtendedFakeDaemon } from "./fake-daemon-extra.ts"

const AGENTPUSH_SECRET = "test-route-overlap-agentpush-secret"
const EMAIL_SECRET = "test-route-overlap-email-secret"
process.env.RDV_AGENTPUSH_WEBHOOK_SECRET = AGENTPUSH_SECRET
process.env.RDV_EMAIL_WEBHOOK_SECRET = EMAIL_SECRET

const { DaemonClient } = await import("../../src/daemon/client.ts")
const { RoomStore } = await import("../../src/rooms/store.ts")
const { LocalBooter } = await import("../../src/service/booter.ts")
const { createHttpServer } = await import("../../src/service/http.ts")
const { RoomService: RoomServiceCtor } = await import("../../src/service/room-service.ts")
const { MemoryTransport } = await import("../../src/service/transports.ts")

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAddressInfo(value: string | AddressInfo | null): value is AddressInfo {
  return value !== null && typeof value === "object"
}

const dirs: string[] = []
const daemons: ExtendedFakeDaemon[] = []
const services: RoomService[] = []
const servers: { close(): Promise<void> }[] = []

after(async () => {
  await Promise.all(servers.map((server) => server.close()))
  await Promise.all(services.map((service) => service.stop()))
  await Promise.all(daemons.map((daemon) => daemon.close()))
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rdv-route-overlap-"))
  dirs.push(dir)
  return dir
}

async function buildServer(): Promise<{ baseUrl: string; daemon: ExtendedFakeDaemon }> {
  const dir = await freshDir()
  const daemon = await startExtendedFakeDaemon()
  daemons.push(daemon)
  const store = await RoomStore.open(dir)
  const client = new DaemonClient({ baseUrl: daemon.url, token: undefined })
  const booter = new LocalBooter(client, { baseUrl: daemon.url, token: undefined })
  // RoomService falls back to env.mediaDir (the LIVE store) when no
  // mediaStore is given, and a "new" command mints a join QR unconditionally.
  // createHttpServer falls back the same way for mediaStore/renders when no
  // hooks are given — both must be pointed at the same temp dir.
  const mediaStore = new MediaStore(await freshDir())
  const service = new RoomServiceCtor({
    store,
    client,
    booter,
    transport: new MemoryTransport(),
    daemon: { baseUrl: daemon.url, token: undefined },
    mediaStore,
  })
  services.push(service)

  const { ArtifactRenderStore } = await import("../../src/service/artifact-renders.ts")
  const server = createHttpServer(service, { mediaStore, renders: new ArtifactRenderStore(dir) })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!isAddressInfo(address)) throw new Error("failed to bind http server")
  servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })

  return { baseUrl: `http://127.0.0.1:${address.port}`, daemon }
}

function signWith(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`
}

/** The exact `inbound_mail` envelope shape agentpush's Gmail poll path builds
 *  (docs/AGENTPUSH.md §8.2, `buildNotifyPayload`) — this is what would be
 *  POSTed to BOTH `notify_url`s once the dispatch-side analysis above proves
 *  a `channel: null` route matches a mail inbound alongside the `channel:
 *  "mail"` route. */
function mailEnvelope(): string {
  return JSON.stringify({
    event: "inbound_mail",
    route: { name: "rendez-vous", dispatch_tag: "rendez-vous" },
    message: {
      message_id: "route-overlap-mail-1",
      from: "alice@example.com",
      subject: "the room",
      text: "sounds good",
      timestamp: "2026-09-12T00:00:00.000Z",
    },
    workspace_id: "acme",
  })
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) throw new Error(`expected a JSON object, got: ${text}`)
  return parsed
}

test("an inbound_mail envelope POSTed to /inbound/agentpush (the channel:null route's notify_url) is rejected 400, not silently dropped or double-processed", async () => {
  const { baseUrl, daemon } = await buildServer()
  const rawBody = mailEnvelope()

  const res = await fetch(`${baseUrl}/inbound/agentpush`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agentpush-signature": signWith(AGENTPUSH_SECRET, rawBody) },
    body: rawBody,
  })

  // parseAgentpushWebhook requires a "channel" field restricted to
  // whatsapp/telegram/sms; the inbound_mail envelope has no "channel" field
  // at all, so this is a 400 (missing_source) — a non-2xx agentpush's
  // push.dispatch() will journal "failed" and its worker retry pass will
  // re-attempt (packages/sdk/src/push.ts:504-531, res.ok gate).
  assert.equal(res.status, 400)
  const body = await readJson(res)
  assert.equal(body.error, "missing_source")

  // Nothing was fanned in: no session was ever spawned for this "message".
  const spawnCalls = daemon.requestsReceived.filter((r) => r.path === "/sessions/agent").length
  assert.equal(spawnCalls, 0, "the mismatched envelope must not create a room or fan in a turn")
})

test("the same inbound_mail envelope POSTed to /inbound/agentpush-mail (the channel:mail route's notify_url) is accepted 200 and processed exactly once", async () => {
  const { baseUrl } = await buildServer()
  const rawBody = mailEnvelope()
  const headers = { "content-type": "application/json", "x-agentpush-signature": signWith(EMAIL_SECRET, rawBody) }

  const first = await fetch(`${baseUrl}/inbound/agentpush-mail`, { method: "POST", headers, body: rawBody })
  assert.equal(first.status, 200)
  const firstBody = await readJson(first)
  // No roomCodeHint in the subject and the sender isn't a member of any room
  // yet, so this is the "accepted but nobody to route to" outcome — the
  // point here is that it is 200 (parsed, not rejected), not what
  // `handleInbound` does with it downstream.
  assert.equal(firstBody.kind, "unknown-sender")

  // Replaying the identical envelope proves `parseEmailInbound` genuinely
  // extracted `messageId` and it landed in `MessageDedup` — i.e. this was a
  // real parse, not an accidental 200 on an envelope it doesn't understand.
  const second = await fetch(`${baseUrl}/inbound/agentpush-mail`, { method: "POST", headers, body: rawBody })
  assert.equal(second.status, 200)
  const secondBody = await readJson(second)
  assert.deepEqual(secondBody, { deduped: true })
})

test("conclusion: the overlap does not double-process or silently drop the email — it produces one extra 400 that agentpush will retry against the channel:null route's notify_url", async () => {
  const { baseUrl: agentpushBaseUrl } = await buildServer()
  const { baseUrl: mailBaseUrl } = await buildServer()
  const rawBody = mailEnvelope()

  const [wrongRoute, rightRoute] = await Promise.all([
    fetch(`${agentpushBaseUrl}/inbound/agentpush`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentpush-signature": signWith(AGENTPUSH_SECRET, rawBody) },
      body: rawBody,
    }),
    fetch(`${mailBaseUrl}/inbound/agentpush-mail`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentpush-signature": signWith(EMAIL_SECRET, rawBody) },
      body: rawBody,
    }),
  ])

  // Exactly one 2xx (the real turn) and one non-2xx (the spurious match on
  // the catch-all route) — never two 2xxs (double turn) and never two
  // non-2xxs or a silent 2xx-drop on both sides.
  assert.equal(rightRoute.status, 200)
  assert.equal(wrongRoute.status, 400)
})
