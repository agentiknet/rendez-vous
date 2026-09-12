/**
 * The confirmed deliverable flow (docs/DELIVERABLE.md): render the room's
 * live artifact to a PDF and send it — to a member's own messenger, or by
 * email to someone who is not in the room at all. Sending to a non-member
 * is an outbound action with a real-world consequence (any member could
 * otherwise email an arbitrary third party under the room owner's agentpush
 * identity), so nothing sends until a member explicitly confirms a token.
 *
 * Two ways a delivery gets requested, both funnelling into the same
 * preview/confirm/send state machine:
 *
 * - The agent's own reply text carries a `[[deliver]] ... [[/deliver]]`
 *   block (mirrors `src/fanout/whisper.ts`'s convention, but this module
 *   never touches `src/fanout` — `DeliverableAwareTransport` below wraps
 *   the `Transport` `RoomService` hands to `RoomFanout`, the seam that
 *   module already exposes for dependency injection).
 * - A member types `send pdf to <address>` directly (any tier — messenger,
 *   email, or room-web).
 *
 * Either path produces a `PendingDelivery` with a short token, and the
 * preview (recipient, channel, subject, page count, a link to the rendered
 * PDF, and that token) reaches every member of the room. The send happens
 * only on an explicit `confirm <token>` from any current member; `cancel
 * <token>` discards it. Every outcome — request, confirm, cancel, expiry,
 * and any failure — is posted back into the room's own daemon session as a
 * `[system · delivery]` prompt, so it lands in the daemon's canonical
 * transcript (`fan-in`'s `queue: true` contract) rather than living only in
 * this process's memory.
 */

import { randomInt, randomUUID } from "node:crypto"
import { rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DaemonClient } from "../daemon/client.ts"
import { env } from "../env.ts"
import type { OutboundMessage, Transport } from "../fanout/types.ts"
import type { RoomStore } from "../rooms/store.ts"
import type { Member, Room } from "../rooms/types.ts"
import { AgentpushToolClient, isSendMessageResult, isUploadMediaResult } from "../channels/agentpush/tools-client.ts"
import { renderArtifactPdf, type RenderedPdf } from "./pdf-render.ts"
import type { MediaRecord, MediaStore } from "./media-store.ts"

const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const DEFAULT_EXPIRY_MS = 30 * 60_000

function generateToken(): string {
  let suffix = ""
  for (let i = 0; i < 4; i += 1) {
    suffix += TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)]
  }
  return `PDF-${suffix}`
}

// ---------------------------------------------------------------------------
// The `[[deliver]] ... [[/deliver]]` text convention (mirrors whisper.ts's
// OPEN_LINE/CLOSE_LINE scanning, kept independent of it).
// ---------------------------------------------------------------------------

const OPEN_LINE = /^\[\[deliver\]\]$/
const CLOSE_LINE = /^\[\[\/deliver\]\]$/
const FIELD_LINE = /^([a-zA-Z]+)\s*:\s*(.*)$/

export interface RawDeliverBlock {
  /** The exact source text from the opening to the closing delimiter line
   *  (inclusive) — used to splice the preview text into the original
   *  message verbatim. */
  readonly raw: string
  readonly fields: ReadonlyMap<string, string>
}

/**
 * Finds every `[[deliver]] ... [[/deliver]]` block in `text`. An opening
 * delimiter with no matching close before the end of the text stops the
 * scan there — same "never silently eat malformed input" posture as
 * `parseWhisperSegments`, except here the caller (`DeliverableAwareTransport`)
 * leaves unmatched trailing text untouched rather than folding it back in
 * itself, since this module only ever replaces exact `raw` spans.
 */
export function parseDeliverBlocks(text: string): RawDeliverBlock[] {
  const lines = text.split("\n")
  const blocks: RawDeliverBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ""
    if (!OPEN_LINE.test(line.trim())) {
      i += 1
      continue
    }

    let closeIndex = -1
    for (let j = i + 1; j < lines.length; j += 1) {
      if (CLOSE_LINE.test((lines[j] ?? "").trim())) {
        closeIndex = j
        break
      }
    }
    if (closeIndex === -1) break

    const fields = new Map<string, string>()
    for (const bodyLine of lines.slice(i + 1, closeIndex)) {
      const match = FIELD_LINE.exec(bodyLine.trim())
      if (match !== null) {
        fields.set((match[1] ?? "").toLowerCase(), (match[2] ?? "").trim())
      }
    }
    blocks.push({ raw: lines.slice(i, closeIndex + 1).join("\n"), fields })
    i = closeIndex + 1
  }

  return blocks
}

export interface DeliverBlockRequest {
  readonly to: string
  readonly subject: string
}

export function readDeliverBlockRequest(fields: ReadonlyMap<string, string>): DeliverBlockRequest | { error: string } {
  const to = fields.get("to")
  if (to === undefined || to.length === 0) return { error: "missing to" }
  const artifact = fields.get("artifact") ?? "pdf"
  if (artifact.toLowerCase() !== "pdf") return { error: `unsupported artifact: ${artifact}` }
  return { to, subject: fields.get("subject") ?? "Rendez-vous deliverable" }
}

// ---------------------------------------------------------------------------
// The member command: `send pdf to <address>`, `confirm <token>`, `cancel <token>`.
// ---------------------------------------------------------------------------

const SEND_PATTERN = /^send\s+pdf\s+to\s+(.+)$/i
const CONFIRM_PATTERN = /^confirm\s+(\S+)$/i
const CANCEL_PATTERN = /^cancel\s+(\S+)$/i

export type DeliverableCommand =
  | { readonly kind: "send"; readonly to: string }
  | { readonly kind: "confirm"; readonly token: string }
  | { readonly kind: "cancel"; readonly token: string }

export function parseDeliverableCommand(text: string): DeliverableCommand | undefined {
  const trimmed = text.trim()

  const send = SEND_PATTERN.exec(trimmed)
  if (send !== null) return { kind: "send", to: (send[1] ?? "").trim() }

  const confirm = CONFIRM_PATTERN.exec(trimmed)
  if (confirm !== null) return { kind: "confirm", token: (confirm[1] ?? "").trim().toUpperCase() }

  const cancel = CANCEL_PATTERN.exec(trimmed)
  if (cancel !== null) return { kind: "cancel", token: (cancel[1] ?? "").trim().toUpperCase() }

  return undefined
}

// ---------------------------------------------------------------------------
// Delivery targets: a member's own messenger, or an external email address.
// ---------------------------------------------------------------------------

export type DeliveryTarget =
  | { readonly kind: "messenger"; readonly member: Member }
  | { readonly kind: "email"; readonly address: string }

const SELF_PATTERN = /^(messenger\s+self|me|self|myself)$/i
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * `requester` is the member who typed `send pdf to ...` — undefined for the
 * agent's own `[[deliver]]` block, which has no member attached at the
 * point `DeliverableAwareTransport` intercepts it. `to: messenger self`
 * with no requester resolves to every current messenger-tier member of the
 * room (the room's phone(s)); with a requester, it resolves to that
 * member's own address and requires their own tier to actually be
 * `messenger` — "send pdf to me" from the room-web view has no messenger
 * address to send to, and says so rather than silently doing nothing.
 */
export function resolveDeliveryTargets(
  room: Room,
  toRaw: string,
  requester: Member | undefined,
): DeliveryTarget[] | { error: string } {
  const trimmed = toRaw.trim()

  if (SELF_PATTERN.test(trimmed)) {
    if (requester !== undefined) {
      if (requester.tier !== "messenger") {
        return { error: `${requester.displayName} has no messenger address to deliver to` }
      }
      return [{ kind: "messenger", member: requester }]
    }
    const messengers = room.members.filter((member) => member.tier === "messenger")
    if (messengers.length === 0) return { error: "no messenger member in this room to deliver to" }
    return messengers.map((member) => ({ kind: "messenger", member }))
  }

  if (EMAIL_PATTERN.test(trimmed)) {
    return [{ kind: "email", address: trimmed }]
  }

  return { error: `not a valid delivery target: "${toRaw}"` }
}

function describeTarget(target: DeliveryTarget): string {
  return target.kind === "email"
    ? `${target.address} (mail)`
    : `${target.member.displayName}'s ${target.member.address.provider}`
}

function describeTargets(targets: readonly DeliveryTarget[]): string {
  return targets.map(describeTarget).join(", ")
}

// ---------------------------------------------------------------------------
// Sending a confirmed delivery through agentpush. The PDF is already stored
// under a public route (`GET /r/:code/media/:id`), so every channel can use
// a plain `content.media[].url` attachment — verified against agentpush's
// real `send_message`/`upload_media` zod schemas (the read-only checkout
// cited throughout docs/AGENTPUSH.md): `data`/`url`-based media needs no
// provider upload step at all, and mail specifically rejects
// `providerMediaId` outright. WhatsApp gets the richer `upload_media` +
// `providerMediaId` two-call flow instead (matching the existing QR-PNG
// path in `src/channels/agentpush/outbound.ts`) because a provider-native
// media id renders more reliably in-app than a bare link — its `upload_media`
// call must pass an explicit `mimeType`, or the upload's own type→mime
// default guess is not `application/pdf` for `type: "document"` (the "known
// gotcha" this module was briefed on).
// ---------------------------------------------------------------------------

export type SendOutcome =
  | { readonly ok: true; readonly channel: string; readonly address: string; readonly providerMessageId: string }
  | { readonly ok: false; readonly channel: string; readonly address: string; readonly error: string }

interface SendContext {
  readonly mediaUrl: string
  readonly filename: string
  readonly subject: string
  readonly pdf: Buffer
}

function outcomeFromToolResult(result: unknown, channel: string, address: string): SendOutcome {
  if (!isSendMessageResult(result)) {
    return { ok: false, channel, address, error: "no usable response from agentpush" }
  }
  switch (result.status) {
    case "sent":
    case "queued":
      return { ok: true, channel, address, providerMessageId: result.message_id }
    case "blocked":
      return { ok: false, channel, address, error: result.blocked_reason }
    case "failed":
      return { ok: false, channel, address, error: result.error }
  }
}

async function sendToTarget(
  agentpush: AgentpushToolClient | undefined,
  target: DeliveryTarget,
  ctx: SendContext,
): Promise<SendOutcome> {
  const channel = target.kind === "email" ? "mail" : target.member.address.provider
  const address = target.kind === "email" ? target.address : target.member.address.contactRef

  if (agentpush === undefined) {
    return { ok: false, channel, address, error: "agentpush is not configured (RDV_AGENTPUSH_URL/RDV_AGENTPUSH_KEY unset)" }
  }

  if (target.kind === "email") {
    const result = await agentpush.call(`email ${address}`, "send_message", {
      to: { channel: "mail", address },
      content: {
        subject: ctx.subject,
        text: ctx.subject,
        media: [{ type: "document", url: ctx.mediaUrl, filename: ctx.filename, mimeType: "application/pdf", caption: ctx.subject }],
      },
    })
    return outcomeFromToolResult(result, channel, address)
  }

  if (channel === "whatsapp") {
    const uploaded = await agentpush.call(`member ${target.member.id}`, "upload_media", {
      channel: "whatsapp",
      type: "document",
      data: ctx.pdf.toString("base64"),
      filename: ctx.filename,
      mimeType: "application/pdf",
    })
    if (isUploadMediaResult(uploaded)) {
      const result = await agentpush.call(`member ${target.member.id}`, "send_message", {
        to: { channel, address },
        content: { text: ctx.subject, media: [{ type: "document", providerMediaId: uploaded.media_id, filename: ctx.filename, caption: ctx.subject }] },
      })
      return outcomeFromToolResult(result, channel, address)
    }
    // Fall through to the url-based path below when the upload itself
    // didn't come back with a usable media id.
  }

  const result = await agentpush.call(`member ${target.member.id}`, "send_message", {
    to: { channel, address },
    content: { text: ctx.subject, media: [{ type: "document", url: ctx.mediaUrl, filename: ctx.filename, caption: ctx.subject }] },
  })
  return outcomeFromToolResult(result, channel, address)
}

// ---------------------------------------------------------------------------
// The state machine.
// ---------------------------------------------------------------------------

export interface PendingDelivery {
  readonly token: string
  readonly roomCode: string
  readonly requestedBy: string
  readonly targets: readonly DeliveryTarget[]
  readonly subject: string
  readonly mediaId: string
  readonly pages: number
  readonly createdAt: number
  readonly expiresAt: number
}

export type RequestOutcome = { readonly previewText: string }
export type CommandRequestOutcome = { readonly ok: true; readonly previewText: string } | { readonly ok: false; readonly error: string }
export type ConfirmOutcome =
  | { readonly kind: "sent"; readonly resultText: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "expired" }
export type CancelOutcome = { readonly kind: "cancelled" } | { readonly kind: "not-found" } | { readonly kind: "expired" }

type RenderPdfFn = (html: string, title: string, outPath: string) => Promise<RenderedPdf>

export interface DeliverableServiceOptions {
  readonly mediaStore: MediaStore
  readonly client: DaemonClient
  /** `undefined` when `RDV_AGENTPUSH_URL`/`RDV_AGENTPUSH_KEY` aren't set —
   *  requests and previews still work (rendering needs no agentpush), only
   *  `confirm` reports a clear per-target failure instead of a silent no-op. */
  readonly agentpush: AgentpushToolClient | undefined
  readonly publicUrl?: string
  readonly fetchHtml?: (url: string) => Promise<string>
  readonly renderPdf?: RenderPdfFn
  readonly now?: () => number
  readonly expiryMs?: number
}

function defaultFetchHtml(url: string): Promise<string> {
  return fetch(url).then((res) => {
    if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`)
    return res.text()
  })
}

export class DeliverableService {
  private readonly mediaStore: MediaStore
  private readonly client: DaemonClient
  private readonly agentpush: AgentpushToolClient | undefined
  private readonly publicUrl: string
  private readonly fetchHtml: (url: string) => Promise<string>
  private readonly renderPdf: RenderPdfFn
  private readonly now: () => number
  private readonly expiryMs: number
  private readonly pending = new Map<string, PendingDelivery>()

  constructor(opts: DeliverableServiceOptions) {
    this.mediaStore = opts.mediaStore
    this.client = opts.client
    this.agentpush = opts.agentpush
    this.publicUrl = opts.publicUrl ?? env.publicUrl
    this.fetchHtml = opts.fetchHtml ?? defaultFetchHtml
    this.renderPdf = opts.renderPdf ?? ((html, title, outPath) => renderArtifactPdf(html, title, outPath))
    this.now = opts.now ?? Date.now
    this.expiryMs = opts.expiryMs ?? DEFAULT_EXPIRY_MS
  }

  private mediaUrl(roomCode: string, mediaId: string): string {
    return `${this.publicUrl}/r/${roomCode}/media/${mediaId}`
  }

  private key(roomCode: string, token: string): string {
    return `${roomCode}:${token}`
  }

  private async postSystemNote(room: Room, text: string): Promise<void> {
    if (room.sessionId === undefined) {
      console.warn(`[deliverable] room ${room.code} has no live session — not recorded in the daemon transcript: ${text}`)
      return
    }
    const result = await this.client.prompt(room.sessionId, {
      prompt: `[system · delivery] ${text} (no reply needed)`,
      queue: true,
      origin: "rdv:system",
    })
    if (!result.ok) {
      console.error(`[deliverable] failed to record a delivery event in room ${room.code}'s transcript: ${result.message}`)
    }
  }

  private async renderAndStore(room: Room, subject: string): Promise<{ ok: true; record: MediaRecord } | { ok: false; error: string }> {
    if (room.artifactUrl === undefined) {
      return { ok: false, error: "the room has no live artifact yet" }
    }

    let html: string
    try {
      html = await this.fetchHtml(room.artifactUrl)
    } catch (err) {
      return { ok: false, error: `could not fetch the artifact: ${err instanceof Error ? err.message : String(err)}` }
    }

    const outPath = join(tmpdir(), `rdv-deliver-${randomUUID()}.pdf`)
    try {
      const rendered = await this.renderPdf(html, subject, outPath)
      const data = await readFile(outPath)
      const record = await this.mediaStore.save(room.code, data, { contentType: "application/pdf", pages: rendered.pages })
      return { ok: true, record }
    } catch (err) {
      return { ok: false, error: `could not render the PDF: ${err instanceof Error ? err.message : String(err)}` }
    } finally {
      await rm(outPath, { force: true })
    }
  }

  private async createPending(room: Room, requestedBy: string, targets: DeliveryTarget[], subject: string): Promise<RequestOutcome> {
    const stored = await this.renderAndStore(room, subject)
    if (!stored.ok) {
      await this.postSystemNote(room, `${requestedBy} asked to deliver "${subject}" but it failed: ${stored.error}`)
      return { previewText: `(delivery request failed: ${stored.error})` }
    }

    let token = generateToken()
    while (this.pending.has(this.key(room.code, token))) token = generateToken()

    const createdAt = this.now()
    const pending: PendingDelivery = {
      token,
      roomCode: room.code,
      requestedBy,
      targets,
      subject,
      mediaId: stored.record.id,
      pages: stored.record.pages,
      createdAt,
      expiresAt: createdAt + this.expiryMs,
    }
    this.pending.set(this.key(room.code, token), pending)

    const mediaUrl = this.mediaUrl(room.code, stored.record.id)
    await this.postSystemNote(
      room,
      `${requestedBy} requested a delivery, token ${token}: "${subject}" (${pending.pages} page(s)) to ${describeTargets(targets)}.`,
    )

    return {
      previewText: [
        `Delivery request from ${requestedBy}:`,
        `To: ${describeTargets(targets)}`,
        `Subject: ${subject}`,
        `Pages: ${pending.pages}`,
        `PDF: ${mediaUrl}`,
        `Confirm with \`confirm ${token}\` or cancel with \`cancel ${token}\`. Expires in 30 minutes.`,
      ].join("\n"),
    }
  }

  /** The agent's own `[[deliver]]` block — `requestedBy` is always "agent":
   *  this call site has no member attached to it (see `resolveDeliveryTargets`'s
   *  doc), and that is an honest label, not a fabricated human attribution —
   *  the confirm gate below is what actually requires a human. */
  async requestFromBlock(room: Room, block: RawDeliverBlock): Promise<RequestOutcome> {
    const parsed = readDeliverBlockRequest(block.fields)
    if ("error" in parsed) return { previewText: `(delivery request invalid: ${parsed.error})` }

    const targets = resolveDeliveryTargets(room, parsed.to, undefined)
    if ("error" in targets) return { previewText: `(delivery request invalid: ${targets.error})` }

    return this.createPending(room, "agent", targets, parsed.subject)
  }

  /** A member typing `send pdf to <address>`. */
  async requestFromCommand(room: Room, requester: Member, toRaw: string): Promise<CommandRequestOutcome> {
    const targets = resolveDeliveryTargets(room, toRaw, requester)
    if ("error" in targets) return { ok: false, error: targets.error }

    const { previewText } = await this.createPending(room, requester.displayName, targets, `Room ${room.code} deliverable`)
    return { ok: true, previewText }
  }

  /** Any current member (any tier) may confirm — enforced by the caller:
   *  `RoomService` only ever resolves `confirmedBy` from its own room
   *  membership lookup before reaching here, so a stranger's message never
   *  produces a `Member` to pass in at all. */
  async confirm(room: Room, confirmedBy: Member, token: string): Promise<ConfirmOutcome> {
    const key = this.key(room.code, token)
    const pending = this.pending.get(key)
    if (pending === undefined) return { kind: "not-found" }

    if (this.now() > pending.expiresAt) {
      this.pending.delete(key)
      await this.postSystemNote(room, `Delivery ${pending.token} ("${pending.subject}") expired before anyone confirmed it.`)
      return { kind: "expired" }
    }
    this.pending.delete(key)

    const data = await this.mediaStore.read(room.code, pending.mediaId)
    if (data === undefined) {
      await this.postSystemNote(room, `${confirmedBy.displayName} confirmed delivery ${pending.token} but the rendered PDF was no longer available — nothing sent.`)
      return { kind: "sent", resultText: "Could not send: the rendered PDF is no longer available." }
    }

    const mediaUrl = this.mediaUrl(room.code, pending.mediaId)
    const filename = `${room.code}-deliverable.pdf`
    const outcomes = await Promise.all(
      pending.targets.map((target) => sendToTarget(this.agentpush, target, { mediaUrl, filename, subject: pending.subject, pdf: data })),
    )

    const lines = outcomes.map((outcome) =>
      outcome.ok
        ? `Sent to ${outcome.address} via ${outcome.channel} (message ${outcome.providerMessageId}).`
        : `Failed to send to ${outcome.address} via ${outcome.channel}: ${outcome.error}`,
    )
    await this.postSystemNote(
      room,
      `${confirmedBy.displayName} confirmed delivery ${pending.token} ("${pending.subject}", ${pending.pages} page(s)): ${lines.join(" ")}`,
    )

    return { kind: "sent", resultText: [`Delivery ${pending.token} confirmed by ${confirmedBy.displayName}.`, ...lines].join("\n") }
  }

  async cancel(room: Room, cancelledBy: Member, token: string): Promise<CancelOutcome> {
    const key = this.key(room.code, token)
    const pending = this.pending.get(key)
    if (pending === undefined) return { kind: "not-found" }

    const expired = this.now() > pending.expiresAt
    this.pending.delete(key)
    await this.postSystemNote(room, `${cancelledBy.displayName} cancelled delivery ${pending.token} ("${pending.subject}") — nothing sent.`)
    return { kind: expired ? "expired" : "cancelled" }
  }

  /** Test/inspection helper — not used by the runtime wiring. */
  peek(roomCode: string, token: string): PendingDelivery | undefined {
    return this.pending.get(this.key(roomCode, token))
  }
}

// ---------------------------------------------------------------------------
// The Transport decorator that lets an agent-authored `[[deliver]]` block
// trigger the same flow, without this module ever importing from
// `src/fanout` (out of scope for this executor) — `RoomService` wraps
// whichever `Transport` it hands to `RoomFanout` with this, which is the
// dependency-injection seam `RoomFanout` already exposes.
// ---------------------------------------------------------------------------

export class DeliverableAwareTransport implements Transport {
  private readonly inner: Transport
  private readonly deliverable: DeliverableService
  private readonly store: RoomStore
  /** Keyed on `<room code>:<raw block text>` — dedupes the N calls
   *  `RoomFanout.flush` makes (one per room member) for what is, textually,
   *  the exact same deliver block, down to a single render/store/token. See
   *  the module doc comment on why this can't be done inside `RoomFanout`
   *  itself. Safe without an explicit lock: `Array.prototype.map` (which
   *  `RoomFanout.flush` uses via `Promise.allSettled(room.members.map(...))`)
   *  invokes each member's `send()` synchronously, in order, before any of
   *  them reach their first `await` — so the first member to see a given
   *  key always wins the race to populate this map before a second member's
   *  call even starts. */
  private readonly inFlight = new Map<string, Promise<string>>()

  constructor(inner: Transport, deliverable: DeliverableService, store: RoomStore) {
    this.inner = inner
    this.deliverable = deliverable
    this.store = store
  }

  async send(member: Member, message: OutboundMessage): Promise<void> {
    const blocks = parseDeliverBlocks(message.text)
    if (blocks.length === 0) {
      await this.inner.send(member, message)
      return
    }

    const found = this.store.findByAddress(member.address)
    if (found === undefined) {
      await this.inner.send(member, message)
      return
    }
    const { room } = found

    let text = message.text
    for (const block of blocks) {
      const key = `${room.code}:${block.raw}`
      let workPromise = this.inFlight.get(key)
      if (workPromise === undefined) {
        workPromise = this.deliverable.requestFromBlock(room, block).then((outcome) => outcome.previewText)
        this.inFlight.set(key, workPromise)
        void workPromise.finally(() => this.inFlight.delete(key))
      }
      const previewText = await workPromise
      text = text.split(block.raw).join(previewText)
    }

    await this.inner.send(member, { ...message, text })
  }
}
