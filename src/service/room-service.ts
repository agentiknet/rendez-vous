import { SpawnAgentUnauthorizedError, type DaemonClient, type HealthResult, type PromptResult } from "../daemon/client.ts"
import type { TranscriptRecord } from "../daemon/records.ts"
import { randomBytes } from "node:crypto"
import { AgentpushToolClient } from "../channels/agentpush/tools-client.ts"
import { env } from "../env.ts"
import { fanIn } from "../fanin/index.ts"
import { RoomFanout, probeArtifactUrl, type ArtifactProbe } from "../fanout/reader.ts"
import type { Transport } from "../fanout/types.ts"
import { joinLinks, qrPng, type JoinLinks } from "../links/index.ts"
import { ensureMembership, handleCommand, parseCommand, type CommandResult } from "../rooms/commands.ts"
import type { AddressLookup, RoomStore } from "../rooms/store.ts"
import { UnroutedDeliveryError, deliveryModeOf, sameHumanName, type Address, type Member, type RecoveryLink, type Room, type Tier } from "../rooms/types.ts"
import { memberToken, tokensMatch } from "./mcp-room.ts"
import { publicArtifactUrl, publicMediaUrl } from "./artifact-proxy.ts"
import type { SessionBooter } from "./booter.ts"
import { BoxLivenessUnknownError, isSandboxAlive, type BoxLivenessCheck } from "./box-liveness.ts"
import { isSessionAlive, type DaemonExtraOptions } from "./daemon-extra.ts"
import { DeliverableAwareTransport, DeliverableService, parseDeliverableCommand } from "./deliverable.ts"
import { DeliveryEngine } from "./delivery.ts"
import { MemberSender } from "./member-send.ts"
import { OpenAiTtsProvider } from "../media/openai.ts"
import { MediaStore } from "./media-store.ts"
import { buildSessionRecap } from "./recap.ts"
import { hasSendMedia, type OutboundAttachment } from "./transports.ts"

/** What every member-facing surface shows instead of `room.artifactUrl`
 *  (architecture.md §9.3b): the raw e2b URL is a pure function of sandbox id
 *  and port, so it dies the moment the box is replaced. This is the stable,
 *  room-code-keyed URL that survives that — the raw URL never leaves the
 *  store. */
function memberFacingArtifactUrl(room: Room): string | undefined {
  if (room.artifactUrl === undefined || room.artifactReady === false) return undefined
  return publicArtifactUrl(room.code)
}

/** The address a principal's PANEL member carries in a room (BRIEF-12): a
 *  `room-web` pull member DERIVED from the principal's own address, so a
 *  second drain in the same room finds the same member. The contactRef is
 *  namespaced with the principal's provider so it can never collide with a
 *  browser's claimed name (`resolveRoomWebMember` keys those by
 *  `slugify(displayName)`), and `addMember`'s in-room `sameAddress` match is
 *  what makes it stable.
 *
 *  This is deliberately NOT the `claimRoomWeb` mechanism: the panel holds no
 *  claim secret (BRIEF-12 decision 3 — no token, no claim, no room CODE
 *  reaches it), and `resolveRoomWebMember` both keys identity by
 *  `slugify(displayName)` and refuses a claim-bearing member to any caller
 *  that does not present the secret, so it cannot serve a secret-less
 *  caller. Keying the membership directly by the principal (provider +
 *  contactRef) is possible precisely because the service resolves
 *  principal → membership server-side; that is the forced, and sufficient,
 *  second mechanism.
 *
 *  IDEMPOTENT on an address that is ALREADY a `room-web` screen: namespacing
 *  it again would turn `room-web:camille` into `room-web:"room-web:camille"`,
 *  which never matches the existing member's address under `addMember`'s
 *  `sameAddress` and mints a second member for the same screen on every
 *  drain. An address whose `provider` is already `"room-web"` IS its own
 *  screen, so it passes through unchanged; every other provider still gets
 *  namespaced, so `telegram:6371794295` still cannot collide with a room-web
 *  member literally named `"6371794295"`. */
function principalRoomWebAddress(address: Address): Address {
  if (address.provider === "room-web") return address
  return { provider: "room-web", source: "room-web", contactRef: `${address.provider}:${address.contactRef}` }
}

export interface InboundInput {
  address: Address
  displayName: string
  tier: Tier
  text: string
}

export type InboundOutcome =
  | { kind: "created"; room: Room; member: Member }
  | { kind: "joined"; room: Room; member: Member }
  | { kind: "moved"; room: Room; member: Member; from: string | string[] }
  | { kind: "resumed"; room: Room; member: Member }
  | { kind: "message"; room: Room; member: Member }
  | { kind: "left"; room: Room; member: Member }
  | { kind: "where"; room: Room; member: Member }
  | { kind: "not-in-room" }
  | { kind: "unknown-code" }
  | { kind: "unknown-sender" }
  /** BRIEF-20: a slug named a real room, but the sender is not a member of
   *  it — refused plainly, never a silent admission the way a code would
   *  give one. */
  | { kind: "not-a-member" }
  /** R5: `findByAddress` found the sender in more than one room — a broken
   *  invariant (R1), surfaced rather than silently resolved to whichever
   *  room happened to be inserted first. Only reachable from `where` today:
   *  every other inbound path degrades ambiguity to its own "no clean room"
   *  fallback (`unknown-sender`/`not-in-room`), since guessing which of
   *  several rooms to act on would be the same silent choice with extra
   *  steps. */
  | { kind: "ambiguous"; codes: readonly string[] }
  /** A member nobody could route to (brief D): `deliveryFromAddress` or the
   *  transport's pull arm threw `UnroutedDeliveryError` part-way through the
   *  lifecycle. Loud is right — but an uncaught throw here takes room
   *  creation down with it (the live 500 that exposed this whole bug), so
   *  the boundary catches it and answers this instead. Whatever the room
   *  lifecycle managed to persist before the throw stands; the caller can
   *  act on `reason`. */
  | { kind: "undeliverable"; reason: string }

export type RoomWebSendOutcome =
  | { kind: "sent"; member: Member; result: PromptResult }
  | { kind: "delivered"; member: Member; text: string }
  | { kind: "unknown-code" }
  | { kind: "no-session" }
  | { kind: "name-claimed"; reason: NameClaimedReason }

/** BRIEF-21: `name-claimed` was one refusal for two different situations —
 *  someone else holds the name (a real conflict), or this tab holds it and
 *  lost the proof (its stored secret is stale or was never sent). The server
 *  can tell them apart (it knows whether `presented` arrived at all and
 *  whether it matched), so it names which one rather than handing both the
 *  same pessimistic answer. */
export type NameClaimedReason = "taken" | "stale"

/** BRIEF-21: the refusal message for a name someone else holds, shared by the
 *  claim exchange, the send path and (BRIEF-23) an identity-recovery request
 *  aimed at a name that is not the requester's own — the page renders it from
 *  any of them. */
const NAME_TAKEN_MESSAGE = "ce nom est déjà pris dans cette room — choisis-en un autre"

/** BRIEF-21: the OTHER `name-claimed` situation — this browser once held the
 *  name, but the secret it presented did not match. Rendered as a different
 *  sentence from `NAME_TAKEN_MESSAGE`, because "pick another name" is the
 *  wrong instruction for someone who already owns this one; a wrong-secret
 *  refusal names the state without building the recovery path (brief 23). */
const NAME_STALE_MESSAGE =
  "ce nom est le tien, mais ce navigateur ne peut plus le prouver — choisis un autre nom pour l'instant"

export function nameClaimedMessage(reason: NameClaimedReason): string {
  return reason === "stale" ? NAME_STALE_MESSAGE : NAME_TAKEN_MESSAGE
}

/** How long an identity-recovery pointer stays redeemable (BRIEF-23). Short
 *  enough that a forwarded link is worthless within the hour; long enough
 *  that the member can act on a phone notification without rushing. The
 *  deliverable token (src/service/deliverable.ts) chose 30 minutes for a
 *  comparable capability; recovery is strictly more sensitive, so 15. */
export const RECOVERY_LINK_TTL_MS = 15 * 60_000

/** The honest line a room-web-only member gets: they have no second surface
 *  to prove against, and inventing one would be inventing an account system
 *  (BRIEF-23, deliberately out of scope). Never silence, never a link. */
const RECOVERY_NO_PROOF_TEXT =
  "I can't verify this is you: the only surface you are on in this room is the web page itself, and there is no way to prove this is you against it. Ask someone already in the room to help."

function recoveryLinkText(url: string): string {
  return (
    "Open this one-time link on the browser where you want your name back. " +
    "It restores your web identity once, and expires shortly:\n" +
    url
  )
}

/** BRIEF-23: the outcome of asking for an identity-recovery pointer. `sent`
 *  carries the URL only for tests/audit — the member receives it on their own
 *  proven surface, never here. `conflict` is a name held by someone else;
 *  `no-surface` is the room-web-only member there is genuinely nothing to
 *  prove against. */
export type IdentityRecoveryOutcome =
  | { kind: "sent"; member: Member; url: string }
  | { kind: "unknown-code" }
  | { kind: "unknown-member" }
  | { kind: "conflict"; message: string }
  | { kind: "no-surface" }

/** BRIEF-23: the outcome of redeeming a recovery link. `invalid` covers an
 *  unknown or already-burned token; `wrong-member` is the link being used to
 *  restore a name it was not issued for. */
export type IdentityRedeemOutcome =
  | { kind: "restored"; member: Member; claim: string }
  | { kind: "unknown-code" }
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "wrong-member" }

/** `POST /rooms/:code/claim`'s outcome (PLAN-02 §3-D3 amended): the browser
 *  exchanges the name it typed (plus the join secret it holds, if any) for
 *  this member's bearer token. `claim` is present ONLY when the secret was
 *  minted on this call — mint-once, hand-over-once; a returning tab that
 *  presented its stored claim gets the token and nothing more. */
export type RoomWebClaimOutcome =
  | { kind: "claimed"; member: Member; token: string; claim?: string }
  | { kind: "unknown-code" }
  | { kind: "name-claimed"; reason: NameClaimedReason }

const RESUMING_TEXT = "Resuming room, one moment…"

/** BRIEF-25: the terminal record a revive gets when it could not be brought
 *  back within the bound. Bounded, named and final — the room is never left
 *  on "one moment…". */
const REVIVE_FAILED_TEXT =
  "The room could not be resumed — nothing was started. Send another message to try again."

/** BRIEF-25: the box probe could not tell whether the box is still there. The
 *  one arm that must never be folded into either "resumed" or "booted fresh",
 *  because booting over a box that may still be alive bills two
 *  (box-liveness.ts's own header). */
const BOX_LIVENESS_UNKNOWN_TEXT =
  "I could not tell whether the room's box is still there, so I did not start a new one. Send another message to try again."

/** BRIEF-25: how long one whole revive may take — recap read, box probe,
 *  reconnect and any fresh boot together. Long enough for a genuine cold e2b
 *  boot, short enough that a leg which never settles cannot park the room on
 *  "one moment…" forever. Injectable via `reviveTimeoutMs` so tests do not
 *  wait this out. */
const DEFAULT_REVIVE_TIMEOUT_MS = 90_000

/** BRIEF-22: the one thing a member is told when `spawnAgent` 401s — the
 *  daemon rejected the bearer this service sent. Never transient (a retry
 *  will not make a stale token valid), and invisible from the member's own
 *  side without this line: the room otherwise just goes quiet. */
const SPAWN_UNAUTHORIZED_TEXT =
  "This room could not get an agent — the connection to the daemon was rejected. An operator needs to check it."

/** The one line of "how to use me" every member gets: that the room is
 *  shared, and that privacy is available by ASKING for it.
 *
 *  It used to read "Start with `@me` to get an answer only you can see",
 *  which taught a command line to someone texting on a phone — and implied
 *  that without the incantation the agent could not do it. The agent reads
 *  the request in plain language (src/service/booter.ts); `@me` survives only
 *  as a shortcut for whoever likes it, and is deliberately no longer
 *  advertised. Kept to one short line because most members read this on a
 *  phone. */
const AUDIENCE_HINT =
  "Everything you send goes to the whole room. Just ask if you want something kept between you and the agent — no commands, say it in your own words."

function welcomeText(prefix: string, room: Room): string {
  // BRIEF-20: identifies the room by its slug, never its code — this fires
  // on `resume`, an ordinary conversational reply, not a deliberate reveal.
  const lines = [`${prefix}: ${room.slug}`]
  const artifactUrl = memberFacingArtifactUrl(room)
  if (artifactUrl !== undefined) {
    lines.push(artifactUrl)
  }
  lines.push(AUDIENCE_HINT)
  return lines.join("\n")
}

function activeRoomStatusText(room: Room): string {
  const lines = [`Room ${room.slug} is already active.`]
  const artifactUrl = memberFacingArtifactUrl(room)
  if (artifactUrl !== undefined) {
    lines.push(artifactUrl)
  }
  return lines.join("\n")
}

function currentJoinLinks(code: string): JoinLinks {
  return joinLinks(code, {
    publicUrl: env.publicUrl,
    whatsappNumber: env.whatsappNumber,
    telegramBot: env.telegramBot,
    smsNumber: env.smsNumber,
  })
}

function newRoomReplyText(room: Room, links: JoinLinks): string {
  // BRIEF-20: `new` is the founder's own deliberate admission moment — the
  // join links right below already carry the code (that is the point of
  // them), so stating it plainly here hands out nothing the rest of this
  // message doesn't already. Every OTHER reply in this file names the room
  // by its slug instead.
  const lines = [`Room created: ${room.code}`]
  const artifactUrl = memberFacingArtifactUrl(room)
  if (artifactUrl !== undefined) {
    lines.push(artifactUrl)
  }
  lines.push(links.web)
  if (links.whatsapp !== undefined) lines.push(links.whatsapp)
  if (links.telegram !== undefined) lines.push(links.telegram)
  if (links.sms !== undefined) lines.push(links.sms)
  lines.push(AUDIENCE_HINT)
  return lines.join("\n")
}

function joinRoomReplyText(room: Room): string {
  // BRIEF-20: the joiner already typed the code to get here — this line
  // just names the room they're now in, and does so by slug like every
  // other identifying reply.
  const lines = [`Joined room: ${room.slug}`]
  const roster = room.members.map((member) => member.displayName).join(", ")
  if (roster.length > 0) {
    lines.push(`With: ${roster}`)
  }
  const artifactUrl = memberFacingArtifactUrl(room)
  if (artifactUrl !== undefined) {
    lines.push(artifactUrl)
  }
  lines.push(AUDIENCE_HINT)
  return lines.join("\n")
}

/** Stable, deterministic contact ref for a room-web guest: the same
 *  displayName always resolves to the same member, wherever they're
 *  currently registered — there is no browser/session id to key on
 *  instead, so a name typed into a different room's page is treated as
 *  that guest moving rooms, same rule `join` applies to a phone number or
 *  email address. */
function slugify(displayName: string): string {
  const slug = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.length > 0 ? slug : "guest"
}

/** The room-web join secret (PLAN-02 §3-D3 amended). Opaque, random, never
 *  derived from anything the roster exposes — unlike `memberToken`, which is
 *  a pure function of the (public-within-the-room) member id, this secret is
 *  what stops "anyone who typed the name" from becoming that member. */
function mintClaim(): string {
  return randomBytes(24).toString("hex")
}

/** BRIEF-23: an opaque, URL-safe capability. 18 bytes of entropy is far more
 *  than a room code's four-character alphabet and is the only thing standing
 *  between a forwarded link and an identity, so it is deliberately long. */
function mintRecoveryToken(): string {
  return randomBytes(18).toString("hex")
}

/** Drop burned and expired recovery pointers (BRIEF-23) — called on mint, so
 *  the persisted list stays a small set of live capabilities rather than a
 *  log. Redemption deliberately does NOT prune: it needs the very entry it is
 *  about to mark used. */
function pruneRecoveryLinks(links: readonly RecoveryLink[], nowMs: number): RecoveryLink[] {
  return links.filter((link) => link.usedAt === undefined && nowMs < link.expiresAt)
}

export class RoomService {
  private readonly store: RoomStore
  private readonly client: DaemonClient
  private readonly booter: SessionBooter
  private readonly transport: Transport
  private readonly daemon: DaemonExtraOptions
  readonly mediaStore: MediaStore
  private readonly deliverable: DeliverableService
  /** The delivery half of the room audience tools (PLAN §3.2/§3.3): the
   *  `say`/`whisper` MCP handlers accept into this, and it drains off the
   *  agent's turn. Public because the room MCP endpoint (src/service/http.ts)
   *  hands it to the handlers. Shares the fan-out's transport. */
  readonly deliveryEngine: DeliveryEngine
  /** The ONE send path outside the delivery engine (brief A): the room's
   *  own voice — join links, QR, join/resume/paused notices, broadcasts —
   *  routed by `deliveryModeOf(member)`: push members exactly as before,
   *  pull members as `kind: "system"` outbox records. */
  private readonly sender: MemberSender
  private readonly fanout: RoomFanout
  /** Assertion 4's fact (BRIEF-15, post-turn-assertions): the member whose
   *  inbound message the room still owes an answer, set right before
   *  `handleMessage` fans it into the session and read back by the fan-out's
   *  post-turn check via `triggeredBy`. A ONE-SHOT obligation (brief 36),
   *  not a standing property of the room, discharged by whichever comes
   *  first: a `say`/`whisper`/`system` mint addressed to this member (the
   *  delivery engine's `onMint` — the resume banner answers here, since it
   *  is minted while no reader exists and no window can ever contain it),
   *  or the first post-turn check that reads it once it is DUE. Once
   *  discharged, a later turn that member did not start (an idle sweep, a
   *  resume, another member's message) is never judged against it. The old
   *  set-and-never-cleared shape made the fact mean "who most recently
   *  sent anything, possibly long ago", so a turn the agent ended without
   *  speaking — after the member had already been answered — fired "your
   *  message did not get a reply" at someone who had just been answered:
   *  delivery reading as absence. In-process only, like `lastSeenCursor`
   *  below — a restart loses the fact, which just means the first turn
   *  after a restart skips the assertion rather than guessing.
   *
   *  Brief 40 adds WHEN the check may read it at all: prompts queue, so the
   *  next turn-end that flushes is not necessarily the turn that carries
   *  this message — judging there fires at a member whose answer is still
   *  being written. The obligation therefore carries the sequence number of
   *  the prompt that created it, and `dueAnswer` hands it over only once
   *  the reader has counted that many turn-ends. A later inbound from
   *  anyone OVERWRITES the slot (brief 40: the obligation belongs to the
   *  last of a burst — an earlier queued message from the same member is
   *  answered by the same reply, and an earlier member's message is
   *  subsumed by the later speaker's). */
  private readonly outstandingAnswer = new Map<string, { memberId: string; promptSeq: number }>()
  /** How many `queue: true` prompts this service has fanned into each
   *  room's session since its reader last (re)started — EVERY one, member
   *  messages, join announcements, unservable corrections and delivery
   *  notes alike, because each occupies exactly one turn and the
   *  due-ness comparison drifts if any escapes the count. Reset by the
   *  reader's `onReaderStart`. */
  private readonly promptSeqs = new Map<string, number>()
  /** How many turn-end records the reader has consumed per room since it
   *  last (re)started, reported back through `onTurnEnd`. The fan-out side
   *  of the brief-40 due-ness comparison. */
  private readonly turnEndsSeen = new Map<string, number>()
  private readonly idlePauseMs: number
  private readonly idleSweepMs: number
  private readonly boxProbeMs: number
  /** Cursor last observed per room, sweep to sweep — a jump means the room's
   *  own fan-out flushed something new since the last tick, which counts as
   *  activity just as much as an inbound message (R10). Cheaper and more
   *  robust than threading a callback through `RoomFanout` (outside this
   *  file's ownership): the cursor it already persists on every flush is
   *  itself the signal, sampled at sweep granularity. */
  private readonly lastSeenCursor = new Map<string, number>()
  /** Last time (`Date.now()`) each room's box was probed for liveness via the
   *  e2b API (docs/UPSTREAM.md #10) — in-process only, reset on restart, so a
   *  fresh process simply probes every active room again on its first sweep
   *  rather than waiting out the interval a second time. */
  private readonly lastBoxProbeAt = new Map<string, number>()
  private readonly checkBoxLiveness: BoxLivenessCheck
  /** Injectable clock (BRIEF-23): recovery links expire, and a test that has
   *  to wait fifteen real minutes to prove it does not exist. Defaults to the
   *  wall clock, so every production path is unchanged. */
  private readonly now: () => number
  /** Per-room-code serialization for `doResume` (see `withRoomLock`'s doc) —
   *  in-process only, and empty entries are never cleaned up eagerly; each
   *  slot holds only the tail of that room's own chain, so this stays one
   *  entry per room ever resumed, not per call. */
  private readonly roomLocks = new Map<string, Promise<unknown>>()
  /** Generation token per room, bumped at the start of every bounded revive.
   *  A revive that times out releases the room lock while its own
   *  `performResume` is still in flight; when that orphan eventually settles
   *  it sees the token moved on and declines to write, so a slow attempt
   *  cannot clobber a newer one. */
  private readonly reviveAttempts = new Map<string, number>()
  /** Every revive, whole — see `DEFAULT_REVIVE_TIMEOUT_MS`. */
  private readonly reviveTimeoutMs: number
  private idleSweepTimer: ReturnType<typeof setInterval> | undefined

  constructor(opts: {
    store: RoomStore
    client: DaemonClient
    booter: SessionBooter
    transport: Transport
    idlePauseMinutes?: number
    idleSweepSeconds?: number
    boxProbeMinutes?: number
    /** Hard ceiling on one whole revive (BRIEF-25) — recap, probe, reconnect
     *  and any fresh boot share it. Defaults to 90s; inject a small value in
     *  tests. */
    reviveTimeoutMs?: number
    /** Injectable for tests — see `BoxLivenessCheck`'s doc. Defaults to the
     *  real e2b API call. */
    checkBoxLiveness?: BoxLivenessCheck
    /** Defaults to the same daemon connection the rest of the process uses
     *  (`env.daemonUrl`/`env.daemonToken`) — override in tests to point at a
     *  fake daemon instead. Needed for the out-of-band-kill liveness check
     *  (`reviveIfSessionDied`) and the fan-out reader's own dead-session
     *  detection, neither of which can be derived from `DaemonClient` (it
     *  keeps its base URL/token private). */
    daemon?: DaemonExtraOptions
    /** Overrides the default `MediaStore`/`DeliverableService` pair for
     *  tests — inject `mediaStore` alone to point rendered PDFs at a temp
     *  dir while keeping the real render/send pipeline, or `deliverable`
     *  alone for a fully scripted delivery flow. When `deliverable` is
     *  given without `mediaStore`, the media HTTP route
     *  (`RoomService.readMedia`) reads through whichever `MediaStore` the
     *  caller built that `DeliverableService` with, not this one — pass
     *  both together in that case. */
    mediaStore?: MediaStore
    deliverable?: DeliverableService
    /** Overrides the attachment-URL probe the fan-out reader uses before
     *  delivering an `[[attach …]]` — inject a stub in tests so they never
     *  depend on whether something answers at `env.publicUrl`. */
    probeUrl?: ArtifactProbe
    /** Injectable clock (BRIEF-23) for recovery-link expiry — see the field. */
    now?: () => number
  }) {
    this.store = opts.store
    this.client = opts.client
    this.booter = opts.booter
    this.transport = opts.transport
    this.daemon = opts.daemon ?? { baseUrl: env.daemonUrl, token: env.daemonToken }
    this.idlePauseMs = (opts.idlePauseMinutes ?? env.idlePauseMinutes) * 60_000
    this.idleSweepMs = (opts.idleSweepSeconds ?? env.idleSweepSeconds) * 1000
    this.boxProbeMs = (opts.boxProbeMinutes ?? env.boxProbeMinutes) * 60_000
    this.reviveTimeoutMs = opts.reviveTimeoutMs ?? DEFAULT_REVIVE_TIMEOUT_MS
    this.checkBoxLiveness = opts.checkBoxLiveness ?? ((sandboxId) => isSandboxAlive(sandboxId))
    this.now = opts.now ?? Date.now
    // env.mediaDir is the live runtime store the running service serves
    // media from; a test must inject its own MediaStore, never rely on this.
    this.mediaStore = opts.mediaStore ?? new MediaStore(env.mediaDir)
    this.deliverable =
      opts.deliverable ??
      new DeliverableService({
        mediaStore: this.mediaStore,
        client: this.client,
        // Persist pending deliveries on the room record so they survive a
        // restart (docs/DELIVERABLE.md) — the minimal wiring hook.
        store: this.store,
        agentpush:
          env.agentpushUrl !== undefined ? new AgentpushToolClient({ baseUrl: env.agentpushUrl, apiKey: env.agentpushKey }) : undefined,
        // Brief 40: the delivery note occupies one of the session's turns,
        // so it must join the prompt count the assertion-4 due-ness check
        // compares against.
        onPromptQueued: (roomCode) => {
          this.countPrompt(roomCode)
        },
      })
    // TTS is optional: without a key, `[[say …]]` degrades to the sentence as
    // text rather than disappearing (src/fanout/reader.ts's `renderSpeech`).
    const openaiKey = env.openaiApiKey
    // One transport instance shared by the reader AND the delivery engine:
    // "the SAME transport RoomFanout uses" (PLAN §3.2) is literal, not
    // structural — deliverable interception must apply to both paths alike.
    const fanoutTransport = new DeliverableAwareTransport(this.transport, this.deliverable, this.store)
    // The delivery half of the room audience tools (PLAN §3.2/§3.3): the
    // `say`/`whisper` MCP handlers accept into this, and it drains off the
    // agent's turn. Built BEFORE the fan-out, because the member-send helper
    // (brief A) needs it to write pull members' records.
    this.deliveryEngine = new DeliveryEngine({
      store: this.store,
      transport: fanoutTransport,
      reportFailure: (code, correction) => this.reportToSession(code, correction),
      // BRIEF 46: the SAME probe the fanout reader uses (one implementation,
      // src/service/probe.ts — never a second one) now gates the engine's
      // attachment hand too, so the tool path and the boot replay inherit
      // the fanout's "confirmed 2xx or nothing" rule.
      probeUrl: opts.probeUrl ?? probeArtifactUrl,
      // Assertion 4 (BRIEF-15, post-turn-assertions): the trigger obligation
      // discharges at MINT time (brief 36) — a say/whisper/system record
      // addressed to the member who started the turn answers them, whenever
      // it is minted. The resume banner is minted while no fan-out reader
      // exists and is swallowed into the next baseline, so a window can
      // never witness it; the mint itself is the only reliable witness.
      onMint: (code, kind, memberIds) => {
        // BRIEF 46: an `attachment` mint discharges the obligation too — a
        // file delivered to the member who started the turn IS the reply
        // (the same line `turnAnsweredNobody` draws since BRIEF 46).
        if (kind !== "say" && kind !== "whisper" && kind !== "system" && kind !== "attachment") return
        const entry = this.outstandingAnswer.get(code)
        if (entry === undefined || !memberIds.includes(entry.memberId)) return
        this.outstandingAnswer.delete(code)
      },
    })
    // The ONE send path outside DeliveryEngine (brief A): the room's own
    // voice — join links, QR, join/resume notices, broadcasts — routed by
    // the member's delivery mode instead of hitting the transport directly
    // (which was the console-fallback swallow this whole bug came from).
    this.sender = new MemberSender({ store: this.store, transport: this.transport, engine: this.deliveryEngine })
    this.fanout = new RoomFanout({
      store: this.store,
      transport: fanoutTransport,
      // The reader's sends go through the same one-send-path helper, over
      // the fan-out's own transport (deliverable interception applies).
      sender: new MemberSender({ store: this.store, transport: fanoutTransport, engine: this.deliveryEngine }),
      source: (sessionId, since, signal) => this.client.events(sessionId, since, signal),
      isAlive: (sessionId) => isSessionAlive(this.daemon, sessionId),
      // An attachment that probed dead is fed back into the room's session
      // over the ordinary fan-in path (queue: true — the agent may be
      // mid-turn; omitting it loses the message, STATE.md finding #1).
      reportUnservable: (code, correction) => this.reportUnservableArtifact(code, correction),
      // Assertion 4 (BRIEF-15, post-turn-assertions): who the room still
      // owes an answer, IF one is due (brief 40). The next turn-end that
      // flushes is not necessarily the turn that carries the member's
      // message — prompts queue — so the wiring answers `undefined` while
      // the reader has not yet counted up to the member's prompt, WITHOUT
      // discharging: the obligation stays armed for the turn that is
      // actually theirs. One-shot (brief 36) once due; the mint path
      // (`onMint` above) discharges it first when a delivery already
      // answered the member, because a delivery minted outside any window
      // (the resume banner) is invisible to this check. The obligation is
      // asked once per inbound and never re-asked on a later turn that
      // member did not start.
      triggeredBy: (code) => this.dueAnswer(code),
      // Brief 40: the two sides of the due-ness comparison. The reader
      // counts every turn-end it consumes (flushing or not); the service
      // counts every prompt it queues; an obligation is due only when the
      // turn that carries it has ended. A reader (re)start resets both —
      // and drops the outstanding obligation, the established restart
      // posture.
      onTurnEnd: (code) => {
        this.turnEndsSeen.set(code, (this.turnEndsSeen.get(code) ?? 0) + 1)
      },
      onReaderStart: (code) => {
        this.promptSeqs.delete(code)
        this.turnEndsSeen.delete(code)
        this.outstandingAnswer.delete(code)
      },
      ...(opts.probeUrl !== undefined ? { probeUrl: opts.probeUrl } : {}),
      ...(openaiKey !== undefined ? { tts: new OpenAiTtsProvider(openaiKey), mediaStore: this.mediaStore } : {}),
    })
  }

  /** Fan an attachment-verification failure back into the room's session,
   *  the same way `DeliverableService.postSystemNote` records delivery
   *  events: an attributed system prompt with `queue: true`, so it lands on
   *  the transcript even when the agent is mid-turn. */
  /** The one reactive fan-in path into a room's session (queue: true, so it
   *  queues mid-turn instead of being lost) — shared by the unservable-
   *  artifact correction and the delivery engine's final-failure report. */
  private async reportToSession(code: string, correction: string): Promise<void> {
    const room = this.store.get(code)
    if (room === undefined || room.sessionId === undefined) {
      console.warn(`[fanout] room ${code} has no live session — not reporting: ${correction}`)
      return
    }
    this.countPrompt(code)
    const result = await this.client.prompt(room.sessionId, {
      prompt: correction,
      queue: true,
      origin: "rdv:system",
    })
    if (!result.ok) {
      console.error(`[fanout] failed to report in room ${code}'s transcript: ${result.message}`)
    }
  }

  /** Count one `queue: true` prompt against the room's session (brief 40):
   *  every prompt — a member's message, a join announcement, an unservable
   *  correction, a delivery note — occupies exactly one turn, and the
   *  assertion-4 due-ness comparison drifts by one turn for every prompt
   *  that escapes the count. Returns the prompt's sequence number, which
   *  the ordinary inbound path records on the obligation it creates. */
  private countPrompt(code: string): number {
    const seq = (this.promptSeqs.get(code) ?? 0) + 1
    this.promptSeqs.set(code, seq)
    return seq
  }

  /** Assertion 4's read side (brief 40): the outstanding obligation, but
   *  only once DUE — the reader must have counted at least as many
   *  turn-ends as the prompt that created it, i.e. the turn that carries
   *  the member's message has actually ended. Reading a due obligation
   *  discharges it (brief 36's one-shot); reading an UNDUE one discharges
   *  nothing, so the judgement simply waits for the turn that is theirs. */
  private dueAnswer(code: string): string | undefined {
    const entry = this.outstandingAnswer.get(code)
    if (entry === undefined) return undefined
    if ((this.turnEndsSeen.get(code) ?? 0) < entry.promptSeq) return undefined
    this.outstandingAnswer.delete(code)
    return entry.memberId
  }

  private async reportUnservableArtifact(code: string, correction: string): Promise<void> {
    const room = this.store.get(code)
    if (room === undefined || room.sessionId === undefined) {
      console.warn(`[fanout] room ${code} has no live session — not reporting an unserved attachment: ${correction}`)
      return
    }
    await this.reportToSession(code, correction)
  }

  /** Start fan-out for every active room with a live session, the boot-time
   *  retry of `pending` deliveries, and the idle sweep. */
  start(): void {
    for (const room of this.store.list()) {
      if (room.sessionId !== undefined && room.state === "active") {
        this.fanout.start(room.code)
      }
    }
    // PLAN §3.3: a process that died between accepting a say/whisper and
    // delivering it left `pending` records — re-attempt them once, here.
    void this.deliveryEngine.drainAll().catch((error: unknown) => {
      console.error(`delivery retry on boot failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    this.idleSweepTimer = setInterval(() => {
      this.sweepIdleRooms().catch((error: unknown) => {
        console.error(`idle sweep failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, this.idleSweepMs)
    this.idleSweepTimer.unref()
  }

  /** Stopped means stopped: when this resolves, nothing this service owns is
   *  still writing. The fan-out and the sweep timer were always the obvious
   *  half; the delivery engine is the quiet one — `accept` schedules its
   *  drain with `void` so the agent's turn is not held behind provider
   *  latency, which leaves a store write in flight that no caller is
   *  awaiting. Draining it here, and then flushing the store's own write
   *  chain, is what makes "the service is down" a fact a caller can act on
   *  (a process exiting, or a test removing the directory the store lives
   *  in). */
  async stop(): Promise<void> {
    if (this.idleSweepTimer !== undefined) {
      clearInterval(this.idleSweepTimer)
      this.idleSweepTimer = undefined
    }
    await this.fanout.stopAll()
    await this.deliveryEngine.whenIdle()
    await this.store.flush()
  }

  getRoom(code: string): Room | undefined {
    return this.store.get(code)
  }

  /** Every room in the store — what the room MCP endpoint's token resolver
   *  iterates to bind a bearer token to its room (src/service/mcp-room.ts). */
  listRooms(): Room[] {
    return this.store.list()
  }

  roomCount(): number {
    return this.store.list().length
  }

  /** BRIEF-13's roster query, exposed unchanged for BRIEF-18's principal
   *  surface (src/service/mcp-personal.ts): "which rooms hold this address"
   *  — never a second scan over `this.store.list()`. */
  findByAddress(address: Address): AddressLookup {
    return this.store.findByAddress(address)
  }

  /** The stable `room-web` pull member a principal's panel drains in a room
   *  (BRIEF-12). Called ONLY by `rendezvous_drain` (and the ack that follows
   *  it) — never by `rendezvous_list`, never at panel load: opening a
   *  directory must not join the person to every room it lists.
   *
   *  Uses `store.addMember` directly, NOT `ensureMembership`: the latter
   *  MOVES a member off whatever other room its address is in, which is right
   *  for a person joining by code but wrong here — the same principal may
   *  drain several rooms at once, and each room needs its own stable screen
   *  member (BRIEF-12 decision 1: one per (principal, room)). `addMember`
   *  matches within THIS room by address, so repeated drains find the same
   *  member and no cross-room move ever happens. */
  async ensureRoomWebMember(code: string, address: Address, displayName: string): Promise<Member> {
    const room = this.store.get(code)
    if (room === undefined) throw new Error(`unknown room: ${code}`)
    return this.store.addMember(room.code, {
      displayName,
      tier: "room-web",
      address: principalRoomWebAddress(address),
    })
  }


  /** Whether some room already has a member at this provider+contactRef,
   *  regardless of which room's code that member joined under (a member's
   *  stored `address.source` is the room code it joined, so an exact-address
   *  lookup would miss them unless the caller already knows the code). Used
   *  by the tier-2 mail webhook (docs/AGENTPUSH.md §8.5) to decide whether a
   *  subject-line room code hint should be treated as an implicit `join`. */
  hasMemberAcrossRooms(provider: string, contactRef: string): boolean {
    for (const room of this.store.list()) {
      if (room.members.some((member) => member.address.provider === provider && member.address.contactRef === contactRef)) {
        return true
      }
    }
    return false
  }

  /** `GET /r/:code/media/:id` (docs/DELIVERABLE.md) — `undefined` for an
   *  unknown room or an unknown/missing media id, never throws. */
  async readMedia(code: string, id: string): Promise<Buffer | undefined> {
    const room = this.store.get(code)
    if (room === undefined) return undefined
    return this.mediaStore.read(room.code, id)
  }

  /** Deliver a voice-note attachment (from `[[say …]]` marker rendering in
   *  a say/whisper call) to one member, through the same ONE send path every
   *  other room-authored message uses (MemberSender). BRIEF-44: for a push
   *  member that path now mints a `kind: "attachment"` delivery record
   *  through the engine — status, retry, `lastError`, the agent told, the
   *  member told — instead of calling the transport and believing. */
  async deliverAttachment(code: string, memberId: string, attachment: OutboundAttachment): Promise<void> {
    const room = this.store.get(code)
    if (room === undefined) return
    const member = room.members.find((candidate) => candidate.id === memberId)
    if (member === undefined) return
    await this.sender.sendAttachment(code, member, attachment)
  }

  async daemonHealth(): Promise<HealthResult | "unreachable"> {
    try {
      return await this.client.health()
    } catch {
      return "unreachable"
    }
  }

  /** Raw transcript passthrough for the tier-3 web view's own SSE reader (R6:
   *  the browser talks only to us, never the daemon — this is the one seam
   *  that keeps the bearer inside the service). */
  events(sessionId: string, since: number, signal: AbortSignal): AsyncIterable<TranscriptRecord> {
    return this.client.events(sessionId, since, signal)
  }

  /** Pause a room right now, regardless of idle time — the idle sweep's own
   *  early exit, exposed so callers (the no-phone e2b proof) can force the
   *  same path without waiting out the real threshold. A no-op for a room
   *  that's already paused or doesn't exist. Tells every current member
   *  through the room's own system voice. */
  async pauseRoom(code: string): Promise<void> {
    const room = this.store.get(code)
    if (room === undefined || room.state !== "active") return
    await this.doPause(room)
    await Promise.allSettled(
      room.members.map((member) => this.sender.send(code, member, { text: "Room paused.", artifactUrl: undefined })),
    )
  }

  /** Checked every `idleSweepSeconds`; pauses any active room whose cursor
   *  hasn't moved and whose `lastActivityAt` is older than `idlePauseMinutes`
   *  (R10 — nothing upstream enforces this, so the room service must). Also
   *  probes each active room's own box for liveness (docs/UPSTREAM.md #10),
   *  independent of idle time — a box can vanish mid-conversation. */
  async sweepIdleRooms(): Promise<void> {
    const now = Date.now()
    for (const room0 of this.store.list()) {
      const room = room0.state === "active" ? await this.probeBoxLiveness(room0, now) : room0

      const previousCursor = this.lastSeenCursor.get(room.code)
      if (room.cursor !== previousCursor) {
        this.lastSeenCursor.set(room.code, room.cursor)
        if (previousCursor !== undefined) {
          await this.store.update(room.code, { lastActivityAt: new Date().toISOString() })
        }
        continue
      }

      if (room.state !== "active" || room.sessionId === undefined) continue
      const lastActivityMs = Date.parse(room.lastActivityAt)
      if (!Number.isFinite(lastActivityMs)) continue
      if (now - lastActivityMs >= this.idlePauseMs) {
        await this.doPause(room)
      }
    }
  }

  /** At most once per `boxProbeMinutes`, ask e2b directly whether this room's
   *  box still exists. A box confirmed GONE marks the room `artifactReady:
   *  false` and pauses it — the same shape as `doPause` — so the web page and
   *  fan-out stop claiming the artifact is live, and the next message (or an
   *  explicit `resume`) drives it through `reviveIfSessionDied`/`doResume`,
   *  which boot a fresh box (`E2bBooter.resume`'s own liveness gate). A room
   *  with no `sandboxId` (`LocalBooter`) or a probe result of `"alive"`,
   *  `"paused"`, or `"unknown"` returns the room unchanged — `"unknown"` (a
   *  network error reaching e2b) must never be treated as gone. */
  private async probeBoxLiveness(room: Room, now: number): Promise<Room> {
    if (room.sandboxId === undefined) return room
    const lastProbe = this.lastBoxProbeAt.get(room.code)
    if (lastProbe !== undefined && now - lastProbe < this.boxProbeMs) return room
    this.lastBoxProbeAt.set(room.code, now)

    const liveness = await this.checkBoxLiveness(room.sandboxId)
    if (liveness !== "gone") return room

    await this.doPause(room, { artifactReady: false })
    return this.store.get(room.code) ?? room
  }

  /** Resolve (or first-claim) the room-web member a displayName names, under
   *  the claim protocol. The claim is checked against THIS room's member
   *  only: a room-web member moved to another room gets a fresh record there
   *  (the move deletes the old one), so a per-room secret is exactly as
   *  stable as the member it protects. Rules:
   *
   *  - member already has a `claim` → `presented` must match, constant-time;
   *    absent or wrong is a refusal — the name is taken by someone else's tab.
   *  - member exists without a `claim` (pre-claim persisted member, or one
   *    created by a non-browser path) → the DELIBERATE one-time grandfather:
   *    the join that presents no claim IS the same human coming back; mint
   *    once, adopt it, hand it back once.
   *  - no member at all → mint once on creation, hand it back once.
   *
   *  Messenger/email members never reach here — their address is already a
   *  credential a third party verified. */
  private async resolveRoomWebMember(
    code: string,
    displayName: string,
    presented: string | undefined,
  ): Promise<RoomWebClaimOutcome> {
    const room = this.store.get(code)
    if (room === undefined) return { kind: "unknown-code" }
    const contactRef = slugify(displayName)
    const address: Address = { provider: "room-web", source: "room-web", contactRef }
    const local = room.members.find(
      (member) => member.address.provider === "room-web" && member.address.contactRef === contactRef,
    )

    if (local !== undefined && local.claim !== undefined) {
      if (presented === undefined || !tokensMatch(presented, local.claim)) {
        // No secret sent at all → this browser never held the name: a real
        // conflict, someone else has it. A secret that was sent and did not
        // match → this browser once held it and its proof is stale — a
        // different situation the server can name because it saw `presented`.
        return { kind: "name-claimed", reason: presented === undefined ? "taken" : "stale" }
      }
      const { member } = await ensureMembership(this.store, code, {
        displayName,
        tier: "room-web",
        address,
        claim: local.claim,
      })
      return { kind: "claimed", member, token: memberToken(code, member.id, env.roomTokenSecret) }
    }

    // Unclaimed: adopt what was presented (first-claim wins over a claim-less
    // member) or mint fresh, and let `addMember` persist it — including
    // across the cross-room move `ensureMembership` may perform.
    const claim = presented ?? mintClaim()
    const { member } = await ensureMembership(this.store, code, {
      displayName,
      tier: "room-web",
      address,
      claim,
    })
    return {
      kind: "claimed",
      member,
      token: memberToken(code, member.id, env.roomTokenSecret),
      ...(presented === undefined ? { claim } : {}),
    }
  }

  /** `POST /rooms/:code/claim` — the browser's join handshake. See
   *  `resolveRoomWebMember` for the credential rules. */
  async claimRoomWeb(code: string, displayName: string, presented: string | undefined): Promise<RoomWebClaimOutcome> {
    return this.resolveRoomWebMember(code, displayName, presented)
  }

  /** The send-once key behind `POST /rooms/:code/agui` (D6): record that one
   *  member has sent this AG-UI message id into the room, answering whether
   *  it was new. Delegates to the store where the member's own field lives
   *  (`Member.aguiSentMessageIds`), the same home `ackedSeq` has — the
   *  endpoint resolves the member from the bearer and passes its id, so the
   *  key can never be set for a member the caller does not hold a token
   *  for. */
  async recordAguiMessage(code: string, memberId: string, messageId: string): Promise<"new" | "seen"> {
    return this.store.recordAguiMessage(code, memberId, messageId)
  }

  /** BRIEF-23: issue a one-time pointer that lets a member who can prove
   *  themselves on a push surface re-claim their own web name after losing
   *  the browser's secret.
   *
   *  `requesterId` is the member the agent resolved from the conversation —
   *  the link is sent to that member's OWN proven surface, never to an
   *  address supplied in the request (PLAN-03 §4's consent gate applied to
   *  recovery: the agent composes, it does not choose the recipient).
   *
   *  `targetName` lets the agent say which name is being recovered, but it is
   *  NOT an authorization: a name other than the requester's own is someone
   *  else's, and the genuine conflict is unchanged — refused with brief 21's
   *  message, no link issued. Without `Principal` (PLAN-03 §7, out of scope)
   *  the requester's own display name is the only identity the push surface
   *  can be tied to, and the matching room-web member is the one the link
   *  restores (or creates, if the web identity was never made).
   *
   *  A room-web-only requester has no push surface at all: there is
   *  genuinely nothing to prove against, so the honest line is said rather
   *  than a link minted (BRIEF-23's explicit out-of-scope). */
  async requestIdentityRecovery(
    code: string,
    requesterId: string,
    targetName?: string,
  ): Promise<IdentityRecoveryOutcome> {
    const room = this.store.get(code)
    if (room === undefined) return { kind: "unknown-code" }
    const requester = room.members.find((member) => member.id === requesterId)
    if (requester === undefined) return { kind: "unknown-member" }

    const displayName = (targetName ?? requester.displayName).trim()
    if (slugify(displayName) !== slugify(requester.displayName)) {
      const message = nameClaimedMessage("taken")
      await this.sender.send(code, requester, { text: message, artifactUrl: undefined })
      return { kind: "conflict", message }
    }

    if (deliveryModeOf(requester) !== "push") {
      await this.sender.send(code, requester, { text: RECOVERY_NO_PROOF_TEXT, artifactUrl: undefined })
      return { kind: "no-surface" }
    }

    const now = this.now()
    const link: RecoveryLink = {
      token: mintRecoveryToken(),
      displayName,
      requestedBy: requester.id,
      createdAt: now,
      expiresAt: now + RECOVERY_LINK_TTL_MS,
    }
    await this.store.update(code, { recoveries: [...pruneRecoveryLinks(room.recoveries ?? [], now).filter((candidate) => candidate.requestedBy !== requester.id), link] })

    const url = `${env.publicUrl}/r/${room.code}?recover=${encodeURIComponent(link.token)}&name=${encodeURIComponent(displayName)}`
    await this.sender.send(code, requester, { text: recoveryLinkText(url), artifactUrl: undefined })
    return { kind: "sent", member: requester, url }
  }

  /** BRIEF-23: burn a recovery link and hand back the web identity's claim.
   *
   *  The link is the capability, and it restores exactly ONE name: a
   *  redemption presenting any other `displayName` is refused, so it is not
   *  a room code with a nicer name. Single-use (the burn and the claim land
   *  in one store write, so a second redemption can never race the first)
   *  and short-lived. The claim returned is the member's EXISTING secret when
   *  one exists — recovery restores an identity, it does not rotate it — and
   *  a fresh one only when the web identity never had a claim. */
  async redeemIdentityRecovery(code: string, token: string, displayName: string): Promise<IdentityRedeemOutcome> {
    const room = this.store.get(code)
    if (room === undefined) return { kind: "unknown-code" }
    const link = (room.recoveries ?? []).find((candidate) => candidate.token === token)
    if (link === undefined || link.usedAt !== undefined) return { kind: "invalid" }

    const now = this.now()
    if (now >= link.expiresAt) return { kind: "expired" }
    if (slugify(displayName) !== slugify(link.displayName)) return { kind: "wrong-member" }

    // Restore FIRST — the claim is idempotent (docs/OUTBOX.md §7.1), so
    // re-running it yields the same claim. Doing it before the burn turns
    // a permanent loss into, at worst, a link that stays redeemable slightly
    // longer.
    const contactRef = slugify(link.displayName)
    const existing = (room.members ?? []).find(
      (member) => member.address.provider === "room-web" && member.address.contactRef === contactRef,
    )
    const claim = existing?.claim ?? mintClaim()
    const { member } = await ensureMembership(this.store, code, {
      displayName: link.displayName,
      tier: "room-web",
      address: { provider: "room-web", source: "room-web", contactRef },
      claim,
    })

    // Re-read the room after the await. A concurrent caller may have burned
    // the token while we were restoring — if so, the restore was idempotent
    // and we return the same result without burning again.
    const refreshed = this.store.get(code)
    const stillLive = (refreshed?.recoveries ?? []).find((candidate) => candidate.token === token)
    if (stillLive === undefined || stillLive.usedAt !== undefined) {
      return { kind: "restored", member, claim: member.claim ?? claim }
    }
    const burned = (refreshed?.recoveries ?? []).map((candidate) =>
      candidate.token === token ? { ...candidate, usedAt: now } : candidate,
    )
    await this.store.update(code, { recoveries: burned })
    return { kind: "restored", member, claim: member.claim ?? claim }
  }

  /** A plain message from the room-web tier: no `new`/`join`/`resume`
   *  commands accepted here, the caller already knows the room. The caller
   *  presents the name's `claim` when it holds one (PLAN-02 §3-D3 amended):
   *  a member whose name is claimed refuses any join that doesn't present
   *  the secret. */
  async sendFromRoomWeb(code: string, displayName: string, text: string, claim?: string): Promise<RoomWebSendOutcome> {
    let room = this.store.get(code)
    if (room === undefined) {
      return { kind: "unknown-code" }
    }
    room = await this.reviveIfSessionDied(room)
    if (room.sessionId === undefined && room.state !== "paused") {
      return { kind: "no-session" }
    }

    const resolved = await this.resolveRoomWebMember(code, displayName, claim)
    if (resolved.kind === "unknown-code") {
      return { kind: "unknown-code" }
    }
    if (resolved.kind === "name-claimed") {
      return { kind: "name-claimed", reason: resolved.reason }
    }
    const { member } = resolved

    // This is a member speaking into the room through the personal MCP —
    // the prompt occupies a turn, so it must join the brief-40 count even
    // though the assertion-4 obligation itself is only written on the
    // ordinary inbound path.
    this.countPrompt(room.code)
    const deliverableText = await this.resolveDeliverableText(room, member, text)
    if (deliverableText !== undefined) {
      await this.broadcast(room, deliverableText)
      return { kind: "delivered", member, text: deliverableText }
    }

    if (room.state === "paused") {
      await this.sender.send(code, member, { text: RESUMING_TEXT, artifactUrl: memberFacingArtifactUrl(room) })
      room = await this.doResume(room)
    }
    if (room.sessionId === undefined) {
      return { kind: "no-session" }
    }

    // `channel` so the attribution names the SURFACE, not the tier: one
    // human in the room on both Telegram and WhatsApp is otherwise two
    // identical `[Name · messenger]` senders (src/fanin/index.ts).
    const result = await fanIn(this.client, room.sessionId, { ...member, channel: member.address.provider }, text)
    await this.touchActivity(room.code)
    return { kind: "sent", member, result }
  }

  async handleInbound(input: InboundInput): Promise<InboundOutcome> {
    // The room lifecycle boundary (brief D): `deliveryFromAddress` and the
    // transport's pull arm throw `UnroutedDeliveryError` for a genuinely
    // unroutable member, and `handleInboundSimulated` is not the only entry
    // point here. Loud stays loud — the error names the member and the
    // fault — but it is answered as an outcome, never allowed to 500 a room
    // into nonexistence.
    try {
      return await this.handleInboundRouted(input)
    } catch (error) {
      if (error instanceof UnroutedDeliveryError) {
        return { kind: "undeliverable", reason: error.message }
      }
      throw error
    }
  }

  private async handleInboundRouted(input: InboundInput): Promise<InboundOutcome> {
    const sender = { displayName: input.displayName, tier: input.tier, address: input.address }
    const command = parseCommand(input.text)

    if (command !== undefined) {
      switch (command.kind) {
        case "new":
          return this.handleNew(sender)
        case "join":
          return this.handleJoin(command.code, sender, input)
        case "join-by-slug":
          return this.handleJoinBySlug(command.slug, sender, input)
        case "resume":
          return this.handleResume(command.code, sender, input)
        case "resume-by-slug":
          return this.handleResumeBySlug(command.slug, sender, input)
        case "leave":
          return this.handleLeave(sender, input, command.code)
        case "where":
          return this.handleWhere(sender, input)
      }
    }

    return this.handleMessage(input)
  }

  private async handleNew(sender: Omit<Member, "id" | "joinedAt">): Promise<InboundOutcome> {
    const result = await handleCommand(this.store, { kind: "new" }, sender)
    if (!result.ok) {
      // "new" never fails at the command layer; this branch only exists for exhaustiveness.
      return { kind: "unknown-code" }
    }
    let booted
    try {
      booted = await this.booter.boot(result.room, { label: `rdv-${result.room.code}` })
    } catch (error) {
      if (!(error instanceof SpawnAgentUnauthorizedError)) throw error
      // BRIEF-22: the room row exists (the command layer already created
      // it) but never got a working session — say so plainly rather than
      // sending the "Room created" reply with join links nothing yet backs.
      await this.notifySpawnUnauthorized(result.room)
      return { kind: "created", room: result.room, member: result.member }
    }
    const room = await this.store.update(result.room.code, {
      sessionId: booted.sessionId,
      sandboxId: booted.sandboxId,
      artifactUrl: booted.artifactUrl,
      artifactReady: booted.artifactReady,
      state: "active",
      lastActivityAt: new Date().toISOString(),
      // Set at boot from what the room was actually given, never changed in
      // place (PLAN §3.5): step 2 gates marker parsing on it.
      ...(booted.protocol !== undefined ? { protocol: booted.protocol } : {}),
    })
    this.fanout.start(room.code)

    const links = currentJoinLinks(room.code)
    await this.sender.send(room.code, result.member, { text: newRoomReplyText(room, links), artifactUrl: memberFacingArtifactUrl(room) })
    await this.sendJoinQr(result.member, room, links)

    return { kind: "created", room, member: result.member }
  }

  private async handleJoin(
    code: string,
    sender: Omit<Member, "id" | "joinedAt">,
    input: InboundInput,
  ): Promise<InboundOutcome> {
    // BRIEF-37: `addMember` dedupes on exact address, so a second join from
    // the same address returns the member already here — that rejoin must
    // not fan a second join line. Read the roster BEFORE the join so the
    // rejoin is a fact the service saw itself, not one it inferred after.
    const membersBefore = new Set(this.store.get(code)?.members.map((member) => member.id) ?? [])
    const result = await handleCommand(this.store, { kind: "join", code }, sender)
    if (!result.ok) {
      await this.replyGuidance(input, "That room code isn't known. Send `new` to start one.")
      return { kind: "unknown-code" }
    }
    this.fanout.start(result.room.code)
    await this.touchActivity(result.room.code)

    if (result.movedFrom !== undefined) {
      // BRIEF-20: identifies both rooms by slug — the destination code was
      // just typed by the sender themselves (an explicit admission act), but
      // an ordinary "here's where you ended up" confirmation is not that,
      // and neither is naming the room they came from.
      // BRIEF-27: movedFrom may name one room (a clean single-room move) or
      // several (the address was in multiple rooms). Name every room left.
      const fromSlugs = (Array.isArray(result.movedFrom) ? result.movedFrom : [result.movedFrom])
        .map((code) => this.store.get(code)?.slug ?? code)
      // BRIEF-37: the move arm is a join too — the mover is genuinely new to
      // THIS room, so the same line fans (same-human check included: the
      // mover may already be here on another device), unless the address was
      // also already on this roster, in which case nothing joined.
      if (!membersBefore.has(result.member.id)) {
        await this.announceJoin(result.room, result.member)
      }
      await this.sender.send(result.room.code, result.member, {
        text: `Moved from ${fromSlugs.join(", ")} to ${result.room.slug}.`,
        artifactUrl: memberFacingArtifactUrl(result.room),
      })
      return { kind: "moved", room: result.room, member: result.member, from: result.movedFrom }
    }

    if (membersBefore.has(result.member.id)) {
      // Same address, already on this roster: nothing joined, so nothing is
      // announced — one join produces one line, and a rejoin produces none.
      await this.sender.send(result.room.code, result.member, {
        text: joinRoomReplyText(result.room),
        artifactUrl: memberFacingArtifactUrl(result.room),
      })
      return { kind: "joined", room: result.room, member: result.member }
    }

    await this.announceJoin(result.room, result.member)
    await this.sender.send(result.room.code, result.member, {
      text: joinRoomReplyText(result.room),
      artifactUrl: memberFacingArtifactUrl(result.room),
    })
    return { kind: "joined", room: result.room, member: result.member }
  }

  /** BRIEF-37: the join fact, pushed into the agent's session at the moment
   *  it happens — the thing `booter.ts`'s arrival instruction always assumed
   *  existed and nothing ever supplied. The room speaks, not a member, so it
   *  is a bare `rdv:system` prompt with NO `[Name · surface]` attribution:
   *  nobody said this sentence. Queued (`queue: true`, the same fan-in
   *  posture as every inbound) rather than forced, so a mid-turn join lands
   *  after the current turn instead of tearing into it. A paused room has no
   *  session to queue into and must not be woken for a join — the line is
   *  skipped there, and the caller's own reply still reaches them. The
   *  service knows what the agent cannot infer from a roster poll: whether
   *  the joining address carries a `displayName` already in the room, i.e.
   *  the same human on another device (`booter.ts`'s same-person rule is the
   *  advisory half; this line is the data it was missing). */
  private async announceJoin(room: Room, member: Member): Promise<void> {
    if (room.sessionId === undefined) return
    const sameHuman = room.members.some(
      (candidate) => candidate.id !== member.id && sameHumanName(candidate.displayName, member.displayName),
    )
    const line = sameHuman
      ? `${member.displayName} just joined from another device (${member.address.provider}) — the same human already in this room. Nobody new has arrived, and the room has nothing to tell anyone: do not announce this.`
      : `${member.displayName} (${member.address.provider}) just joined this room — a new person, not greeted yet. Say one line that they have arrived.`
    this.countPrompt(room.code)
    const result = await this.client.prompt(room.sessionId, {
      prompt: line,
      queue: true,
      origin: "rdv:system",
    })
    if (!result.ok) {
      console.error(`[fanout] failed to report the join in room ${room.code}'s transcript: ${result.message}`)
    }
  }

  /** BRIEF-20 §3: `join <slug>` — identifies, never admits. Refused plainly
   *  (never silently, never as an auth-shaped error) for anyone `enterBySlug`
   *  doesn't already find on the named room's roster. */
  private async handleJoinBySlug(
    slug: string,
    sender: Omit<Member, "id" | "joinedAt">,
    input: InboundInput,
  ): Promise<InboundOutcome> {
    const result = await handleCommand(this.store, { kind: "join-by-slug", slug }, sender)
    if (!result.ok) {
      if (result.reason === "not-a-member") {
        await this.replyGuidance(
          input,
          "You're not a member of that room — naming it isn't enough to get in. Ask someone already there, or use the room's code.",
        )
        return { kind: "not-a-member" }
      }
      await this.replyGuidance(input, "That room name isn't known. Send `new` to start one.")
      return { kind: "unknown-code" }
    }
    this.fanout.start(result.room.code)
    await this.touchActivity(result.room.code)
    await this.sender.send(result.room.code, result.member, {
      text: joinRoomReplyText(result.room),
      artifactUrl: memberFacingArtifactUrl(result.room),
    })
    return { kind: "joined", room: result.room, member: result.member }
  }

  /** `identifier` is `parseCommand`'s parsed `leave <code-or-slug>` argument
   *  (BRIEF-13 step 4) — previously parsed and then DROPPED here, so "leave
   *  RDV-XXXX"/"leave some-slug" behaved exactly like bare "leave" for every
   *  inbound caller, phone or MCP: `leaveCurrent` (commands.ts) already
   *  resolves a given identifier to a SPECIFIC named room, by design (its own
   *  doc comment: "the person named it, so there is nothing to guess") — that
   *  mechanism was simply never reached. Fixed here, not worked around, so
   *  `rendezvous_leave` (and a real "leave <room>" message) leaves the room
   *  actually named, not whichever room `findByAddress` happens to resolve. */
  private async handleLeave(sender: Omit<Member, "id" | "joinedAt">, input: InboundInput, identifier?: string): Promise<InboundOutcome> {
    const result = await handleCommand(this.store, identifier === undefined ? { kind: "leave" } : { kind: "leave", code: identifier }, sender)
    if (!result.ok) {
      if (result.reason === "unknown-code") {
        await this.replyGuidance(input, "That room isn't known. Send `where` to see your rooms, or `new`/`join RDV-XXXX`.")
        return { kind: "unknown-code" }
      }
      await this.replyGuidance(input, "You're not in a room. Send `new` or `join RDV-XXXX`.")
      return { kind: "not-in-room" }
    }
    await this.sender.send(result.room.code, result.member, {
      text: `You left ${result.room.slug}. Send \`new\` or \`join RDV-XXXX\`.`,
      artifactUrl: undefined,
    })
    return { kind: "left", room: result.room, member: result.member }
  }

  /** R6: the one affordance that makes the active room legible from a surface
   *  (Telegram, WhatsApp) that otherwise gives no clue which room a member is
   *  speaking into — answers the room's slug and who else is there, and
   *  answers just as plainly when there is no active room, rather than an
   *  error or silence. BRIEF-20: names the slug, never the code — the code
   *  is the join capability, and `where` is not a deliberate reveal of it. */
  private async handleWhere(sender: Omit<Member, "id" | "joinedAt">, input: InboundInput): Promise<InboundOutcome> {
    const found = this.store.findByAddress(sender.address)
    if (found.kind === "one") {
      const roster = found.room.members.map((member) => member.displayName).join(", ")
      const text = roster.length > 0 ? `You are in room ${found.room.slug}. With: ${roster}.` : `You are in room ${found.room.slug}.`
      await this.sender.send(found.room.code, found.member, { text, artifactUrl: undefined })
      return { kind: "where", room: found.room, member: found.member }
    }
    if (found.kind === "ambiguous") {
      const codes = found.matches.map((match) => match.room.code)
      await this.replyGuidance(input, `You have a membership in more than one room (${codes.join(", ")}) — tell the operator.`)
      return { kind: "ambiguous", codes }
    }
    await this.replyGuidance(input, "You are in no room. Send `new` to start one or `join RDV-XXXX` to join one.")
    return { kind: "not-in-room" }
  }

  /** Only when the transport can actually deliver an image (R6-adjacent: the
   *  QR just encodes the same public web join link, no daemon access needed). */
  private async sendJoinQr(member: Member, room: Room, links: JoinLinks): Promise<void> {
    const transport = this.transport
    // A pull member is sent the QR as an outbox record (caption + published
    // URL), so it needs no media-capable transport — only a push member's
    // path is gated on the transport actually supporting images.
    const pull = deliveryModeOf(member) === "pull"
    if (!pull && !hasSendMedia(transport)) return
    const png = await qrPng(links.web)
    // Publish the bytes before sending. Telegram has no upload path of its
    // own and can only send media by public URL, so without this the QR
    // reaches a Telegram member as the caption alone — a "scan this" with
    // nothing to scan. Publishing is cheap and the URL is the same one the
    // deliverable flow already serves.
    const publicUrl = await this.publishPng(room, png)
    await this.sender.sendMedia(room.code, member, png, `Scan to join ${room.code}`, publicUrl)
  }

  /** Store a PNG against the room and return its public URL, or `undefined`
   *  if it could not be stored — a QR that fails to publish must still go
   *  out as a caption rather than throwing inside a join. */
  private async publishPng(room: Room, png: Uint8Array): Promise<string | undefined> {
    try {
      const record = await this.mediaStore.save(room.code, Buffer.from(png), {
        contentType: "image/png",
        pages: 1,
      })
      return publicMediaUrl(room.code, record.id)
    } catch {
      return undefined
    }
  }

  private async handleResume(
    code: string,
    sender: Omit<Member, "id" | "joinedAt">,
    input: InboundInput,
  ): Promise<InboundOutcome> {
    const result = await handleCommand(this.store, { kind: "resume", code }, sender)
    if (!result.ok) {
      await this.replyGuidance(input, "That room code isn't known. Send `new` to start one.")
      return { kind: "unknown-code" }
    }
    return this.finishResume(result)
  }

  /** BRIEF-20 §3: `resume <slug>` — same identify-not-admit posture as
   *  `join <slug>` (`handleJoinBySlug`); only a sender `enterBySlug` already
   *  finds on the named room's roster reaches the actual resume. */
  private async handleResumeBySlug(
    slug: string,
    sender: Omit<Member, "id" | "joinedAt">,
    input: InboundInput,
  ): Promise<InboundOutcome> {
    const result = await handleCommand(this.store, { kind: "resume-by-slug", slug }, sender)
    if (!result.ok) {
      if (result.reason === "not-a-member") {
        await this.replyGuidance(
          input,
          "You're not a member of that room — naming it isn't enough to get in. Ask someone already there, or use the room's code.",
        )
        return { kind: "not-a-member" }
      }
      await this.replyGuidance(input, "That room name isn't known. Send `new` to start one.")
      return { kind: "unknown-code" }
    }
    return this.finishResume(result)
  }

  /** Shared by `handleResume` and `handleResumeBySlug`: once a `CommandResult`
   *  has resolved a room the sender may actually resume, reviving/replying is
   *  identical regardless of whether they named it by code or slug. */
  private async finishResume(result: Extract<CommandResult, { ok: true }>): Promise<InboundOutcome> {
    const room = await this.reviveIfSessionDied(result.room)
    if (room.state === "active") {
      await this.sender.send(result.room.code, result.member, {
        text: activeRoomStatusText(room),
        artifactUrl: memberFacingArtifactUrl(room),
      })
      return { kind: "resumed", room, member: result.member }
    }

    const resumed = await this.doResume(room)
    // BRIEF-22: a resume that failed on auth already got its own room-visible
    // notice (`notifySpawnUnauthorized`, from inside `doResume`) and left
    // `sessionId` unset — sending "Resumed room" on top of that would tell
    // this member the opposite of what actually happened.
    if (resumed.sessionId === undefined) {
      return { kind: "resumed", room: resumed, member: result.member }
    }
    await this.sender.send(result.room.code, result.member, {
      text: welcomeText("Resumed room", resumed),
      artifactUrl: memberFacingArtifactUrl(resumed),
    })
    return { kind: "resumed", room: resumed, member: result.member }
  }

  private async handleMessage(input: InboundInput): Promise<InboundOutcome> {
    const found = this.store.findByAddress(input.address)
    // Assertion 3 (BRIEF-15, post-turn-assertions): the fact `findByAddress`
    // already computed — this address is a member of more than one room —
    // reaching an ORDINARY chat message (never a `join <code>`/`resume
    // <code>`, which are parsed and routed before `handleMessage` is ever
    // called, R3's "a message naming a room wins, for that message only")
    // means the message named no room code either. Logged into every
    // candidate room so the operator sees the full scope; the member
    // receives no delivery because `replyGuidance` twelve lines below
    // already tells them what happened and what to do — a second message
    // would be duplication and, when the same address is in N rooms, N-fold
    // spam to one person.
    if (found.kind === "ambiguous") {
      const codes = found.matches.map((match) => match.room.code).join(", ")
      for (const match of found.matches) {
        console.warn(
          `post-turn assertion violated: "ambiguous-sender" in room ${match.room.code} — ` +
            `an inbound message from ${input.address.provider}/${input.address.contactRef} named no room code, ` +
            `and that address is a member of more than one room (${codes})`,
        )
      }
    }
    // A "none" lookup is a genuine stranger; "ambiguous" is a broken
    // invariant (R1) that already logged loudly in `findByAddress` — routing
    // an ordinary chat message into ONE of several rooms would be exactly
    // the silent pick this whole brief exists to end, so both degrade to the
    // same guidance rather than guessing.
    if (found.kind !== "one") {
      await this.replyGuidance(input, "Send `new` to start a room, or `join RDV-XXXX` to join one.")
      return { kind: "unknown-sender" }
    }

    let { room } = found
    const { member } = found

    // Receiving a message is proof the member is there (brief 36,
    // presence): stamped before anything else can look at the roster, so a
    // member who just spoke is never read as away — the strongest possible
    // liveness evidence, fresher than any ack.
    await this.store.stampMemberSpoke(room.code, member.id, new Date().toISOString())

    const deliverableText = await this.resolveDeliverableText(room, member, input.text)
    if (deliverableText !== undefined) {
      await this.broadcast(room, deliverableText)
      return { kind: "message", room, member }
    }

    room = await this.reviveIfSessionDied(room)
    if (room.state === "paused") {
      await this.sender.send(room.code, member, { text: RESUMING_TEXT, artifactUrl: memberFacingArtifactUrl(room) })
      room = await this.doResume(room)
    }

    if (room.sessionId === undefined) {
      // BRIEF-20: names the room by slug — `resume` accepts it too (the
      // sender is a member of this exact room by construction, having just
      // been found by address), so the hint stays actionable without
      // printing the code in an otherwise ordinary chat message.
      await this.sender.send(room.code, member, {
        text: `This room has no live session yet — try \`resume ${room.slug}\`.`,
        artifactUrl: memberFacingArtifactUrl(room),
      })
      return { kind: "message", room, member }
    }

    // Assertion 4's fact (BRIEF-15, post-turn-assertions): recorded right
    // before the fan-in that starts the turn, so the fan-out's post-turn
    // check has someone to compare its deliveries against. One-shot (brief
    // 36); the prompt sequence (brief 40) makes it due only once the turn
    // that carries THIS message has ended — a later inbound overwrites the
    // slot, because the obligation belongs to the last of a burst.
    const promptSeq = this.countPrompt(room.code)
    this.outstandingAnswer.set(room.code, { memberId: member.id, promptSeq })
    const result = await fanIn(this.client, room.sessionId, { ...member, channel: member.address.provider }, input.text)
    await this.touchActivity(room.code)
    if (!result.ok) {
      await this.sender.send(room.code, member, {
        text: `Could not deliver your message: ${result.message}`,
        artifactUrl: memberFacingArtifactUrl(room),
      })
    }
    return { kind: "message", room, member }
  }

  /** `send pdf to <address>` / `confirm <token>` / `cancel <token>`
   *  (docs/DELIVERABLE.md) — any member, any tier. Returns `undefined` when
   *  `text` isn't one of these commands, so the caller falls through to the
   *  ordinary chat/fan-in path unchanged. Deliberately does not revive a
   *  paused session first: none of these three actions need the agent's
   *  session to be running (rendering only needs the stored `artifactUrl` to
   *  be reachable, and confirming/cancelling touches no session at all) —
   *  only the transcript audit note (`DeliverableService`'s own
   *  `postSystemNote`) is skipped when there is no live session to post it to. */
  private async resolveDeliverableText(room: Room, member: Member, text: string): Promise<string | undefined> {
    const command = parseDeliverableCommand(text)
    if (command === undefined) return undefined

    if (command.kind === "send") {
      const outcome = await this.deliverable.requestFromCommand(room, member, command.to)
      return outcome.ok ? outcome.previewText : `Could not start that delivery: ${outcome.error}`
    }

    if (command.kind === "confirm") {
      const outcome = await this.deliverable.confirm(room, member, command.token)
      if (outcome.kind === "sent") return outcome.resultText
      if (outcome.kind === "not-found") return `No pending delivery found for token ${command.token}.`
      return `Delivery ${command.token} expired 30 minutes after it was requested — ask again.`
    }

    const outcome = await this.deliverable.cancel(room, member, command.token)
    if (outcome.kind === "cancelled") return `Delivery ${command.token} cancelled — nothing sent.`
    if (outcome.kind === "not-found") return `No pending delivery found for token ${command.token}.`
    return `Delivery ${command.token} had already expired — nothing was sent.`
  }

  /** Every deliverable preview/confirmation/cancellation reaches every
   *  current member, not just whoever triggered it — the whole point of the
   *  preview gate is that anyone in the room can see and confirm it. */
  private async broadcast(room: Room, text: string): Promise<void> {
    const artifactUrl = memberFacingArtifactUrl(room)
    await Promise.allSettled(room.members.map((member) => this.sender.send(room.code, member, { text, artifactUrl })))
  }

  private async touchActivity(code: string): Promise<void> {
    await this.store.update(code, { lastActivityAt: new Date().toISOString() })
  }

  /** A session that dies out of band — a daemon kill, a crash, a daemon
   *  restart — never runs `doPause`, so the room is left `state: "active"`
   *  pointing at a dead `sessionId` with no self-healing path: auto-resume
   *  only fires from a `state: "paused"` room, and `resume <code>` on an
   *  "active" room used to just reply "already active" (Rehearsal Run 1,
   *  Finding 2). Called on every fan-in for an active room and on `resume
   *  <code>` alike, so both surfaces detect the same out-of-band death and
   *  fall through to the ordinary pause→resume path instead of stranding. */
  private async reviveIfSessionDied(room: Room): Promise<Room> {
    if (room.state !== "active" || room.sessionId === undefined) return room
    const alive = await isSessionAlive(this.daemon, room.sessionId)
    if (alive) return room
    await this.fanout.stop(room.code)
    // Keep the id: the daemon can still serve this dead session's transcript,
    // and `performResume` needs it to replay the room's history into the
    // fresh session (src/service/recap.ts).
    return this.store.update(room.code, {
      sessionId: undefined,
      lastSessionId: room.sessionId,
      state: "paused",
    })
  }

  private async doPause(room: Room, extra: Partial<Pick<Room, "artifactReady">> = {}): Promise<void> {
    await this.fanout.stop(room.code)
    if (room.sessionId !== undefined) {
      await this.client.kill(room.sessionId).catch((error: unknown) => {
        console.error(`failed to kill session for room ${room.code}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    // Same as `reviveIfSessionDied`: the session is killed, but its
    // transcript outlives it on the daemon and the resume replays it.
    await this.store.update(room.code, {
      sessionId: undefined,
      ...(room.sessionId !== undefined ? { lastSessionId: room.sessionId } : {}),
      state: "paused",
      ...extra,
    })
  }

  /** Serializes `performResume` per room code (docs/UPSTREAM.md #10 territory
   *  — a second, independent race). Every caller of `doResume` gets here
   *  after independently deciding "this room needs resuming" from its OWN
   *  copy of the room — two concurrent triggers (two messages, or a message
   *  racing `resume <code>`) can both decide that at once, and each one
   *  reaching `booter.resume` boots a REAL e2b session/box. Ground-truthed
   *  live, 2026-09-12: room RDV-NG7F got `sess_13a08221` on box `i65mye...`,
   *  then 80s later `sess_1696a06c` on box `icc84u...` — the store kept only
   *  the second, orphaning the first's session AND its billed box. Chaining
   *  every call for the same code onto one promise means a second caller's
   *  body only starts once the first's entire resume (boot included) has
   *  already been written to the store — and that body re-reads the store
   *  itself rather than trusting the `room` it was handed before it queued,
   *  so it can see that and skip booting a second time. */
  private async withRoomLock<T>(code: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.roomLocks.get(code) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    this.roomLocks.set(
      code,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    return run
  }

  private async doResume(room: Room): Promise<Room> {
    return this.withRoomLock(room.code, async () => {
      // Re-check the store, not the `room` this call was handed before it
      // queued for the lock: a prior holder may have already resumed this
      // exact room while this call waited its turn, in which case there is
      // nothing left to do — booting again would be the exact race this
      // lock exists to close.
      const current = this.store.get(room.code) ?? room
      if (current.state !== "paused") return current
      return this.boundedRevive(current)
    })
  }

  /** BRIEF-25: the WHOLE revive runs under one ceiling, and every way it can
   *  end produces a record in the room. On `main`, `performResume` awaited
   *  `booter.resume` unbounded and only caught `SpawnAgentUnauthorizedError`,
   *  so a resume leg that never settles (the RDV-HTUS measurement: a reaped
   *  box) left the room parked on "Resuming room, one moment…" forever and
   *  held the room's lock behind it. Bounding it HERE — not in any one leg —
   *  is what makes "every revive ends" true. */
  private async boundedRevive(room: Room): Promise<Room> {
    const attempt = (this.reviveAttempts.get(room.code) ?? 0) + 1
    this.reviveAttempts.set(room.code, attempt)

    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.reviveTimeoutMs)
    })
    try {
      const raced = await Promise.race([this.performResume(room, attempt), expiry])
      if (raced === "timeout") {
        // Invalidate this attempt: the leg is still in flight, and "bounded,
        // named and final" means its eventual result must not silently turn
        // the room back to active after the failure record already went out.
        this.reviveAttempts.set(room.code, attempt + 1)
        await this.notifyReviveFailed(room, REVIVE_FAILED_TEXT)
        return this.store.get(room.code) ?? room
      }
      return raced
    } catch (error) {
      // `"unknown"` is its own honest answer (BRIEF-25): the room is not told
      // it was a dead box, only that the box could not be reached. Every other
      // failure gets the bounded-and-final wording.
      const text = error instanceof BoxLivenessUnknownError ? BOX_LIVENESS_UNKNOWN_TEXT : REVIVE_FAILED_TEXT
      await this.notifyReviveFailed(room, text)
      return this.store.get(room.code) ?? room
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** A failed revive leaves the room paused, with no session and no artifact
   *  being advertised — the stored shape must never claim a live room that is
   *  not there. `sandboxId` is left as the booter left it: a box confirmed
   *  gone was already dropped by `E2bBooter.forgetConfirmedDeadBox`, while an
   *  `"unknown"` box must NOT be erased (it may still be alive, and the next
   *  send has to be able to reconnect to it). */
  private async notifyReviveFailed(room: Room, text: string): Promise<void> {
    await this.store.update(room.code, { state: "paused", sessionId: undefined, artifactReady: false })
    await Promise.allSettled(
      room.members.map((member) => this.sender.send(room.code, member, { text, artifactUrl: undefined })),
    )
  }

  /** BRIEF-25's "resumed" arm: the box was alive and the session came back on
   *  it, so the room is told in its own voice. The box-replaced arms keep
   *  their existing, more precise notices (`notifyBoxReplaced`). */
  private async notifyRoomResumed(room: Room): Promise<void> {
    const artifactUrl = memberFacingArtifactUrl(room)
    await Promise.allSettled(
      room.members.map((member) => this.sender.send(room.code, member, { text: "Room resumed.", artifactUrl })),
    )
  }

  private async performResume(room: Room, attempt: number): Promise<Room> {
    // Which session's transcript to replay. Usually `lastSessionId`: by the
    // time a resume runs, pausing has already cleared `sessionId` — that
    // ordering is what made the first version of this dead on arrival, since
    // it only looked at `sessionId` and always found `undefined`.
    // `sessionId` is still checked first for the case where a resume is
    // triggered on a room that was never paused.
    // `buildSessionRecap` is bounded and never throws: a resume that loses
    // the history is a working resume, a resume that hangs is not.
    const priorSessionId = room.sessionId ?? room.lastSessionId
    const recap = priorSessionId === undefined ? undefined : await buildSessionRecap(this.client, priorSessionId)
    let booted
    try {
      booted = await this.booter.resume(room, recap !== undefined ? { recap } : {})
    } catch (error) {
      if (!(error instanceof SpawnAgentUnauthorizedError)) throw error
      // BRIEF-22: the room stays exactly as it was (still paused, no
      // session) — a spawn that failed on auth must not be recorded as a
      // resume, and must not be retried here (it will not become valid).
      await this.notifySpawnUnauthorized(room)
      return room
    }

    // A revive that timed out while this one was still in flight releases the
    // room lock and lets a newer attempt start; if that happened, this stale
    // result must not clobber the store. Best-effort kill the session it
    // produced (unless it is the one already recorded) so a late boot does not
    // leave an untracked, billed box.
    if (this.reviveAttempts.get(room.code) !== attempt) {
      const current = this.store.get(room.code)
      if (current?.sessionId !== booted.sessionId) {
        await this.client.kill(booted.sessionId).catch(() => undefined)
      }
      return current ?? room
    }

    // A new sessionId restarts the daemon's own seq numbering near 1, while
    // `room.cursor` is still whatever seq the *previous* session last
    // flushed at — the fan-out reader would then open the new session's
    // stream at that stale `since` and nothing would ever cross it (Run 2,
    // Finding 3). Reset only when the session actually changed: a resume
    // that reconnects the same still-alive session must keep its cursor.
    const sessionChanged = booted.sessionId !== room.sessionId
    // A resume can cold-boot onto a fresh box when the old one's app-serve
    // came back dead (R8, architecture.md §9.3b) — the member-facing URL
    // (`memberFacingArtifactUrl`) never changes, so nobody needs a new link,
    // but they do deserve to know the artifact just came back on a different
    // box, in case they'd bookmarked or reasoned about the old one directly.
    const boxReplaced =
      room.sandboxId !== undefined && booted.sandboxId !== undefined && booted.sandboxId !== room.sandboxId
    const updated = await this.store.update(room.code, {
      sessionId: booted.sessionId,
      sandboxId: booted.sandboxId,
      artifactUrl: booted.artifactUrl,
      artifactReady: booted.artifactReady,
      state: "active",
      lastActivityAt: new Date().toISOString(),
      ...(sessionChanged ? { cursor: 0 } : {}),
    })
    this.fanout.start(updated.code)
    if (boxReplaced || booted.boxWasGone === true) {
      await this.notifyBoxReplaced(updated, booted.boxWasGone === true)
    } else {
      await this.notifyRoomResumed(updated)
    }
    return updated
  }

  /** BRIEF-22: the member who wrote and got nothing is the one who needs to
   *  know the room could not get an agent — but by the time a spawn fails
   *  here, more than one person may be waiting on the same room, so this
   *  broadcasts to everyone currently in it, the same reach `notifyBoxReplaced`
   *  uses for its own room-visible notice. Routed through `this.sender`
   *  (the one send path outside the delivery engine) so a pull member gets
   *  it as a `system` outbox record and a push member gets it on their own
   *  channel, exactly like every other room-authored notice. */
  private async notifySpawnUnauthorized(room: Room): Promise<void> {
    await Promise.allSettled(
      room.members.map((member) =>
        this.sender.send(room.code, member, { text: SPAWN_UNAUTHORIZED_TEXT, artifactUrl: undefined }),
      ),
    )
  }

  /** The single explicit notice architecture.md §9.3b asks for: broadcast to
   *  every current member, not just whoever triggered the resume — anyone
   *  already in the room may have the artifact open or bookmarked. A box
   *  confirmed GONE (docs/UPSTREAM.md #10, `E2bBooter.resume`'s own liveness
   *  gate) gets the more precise wording; every other box replacement (R8's
   *  same-or-reused-box re-serve) keeps the original generic notice. */
  private async notifyBoxReplaced(room: Room, boxWasGone: boolean): Promise<void> {
    const artifactUrl = memberFacingArtifactUrl(room)
    const text = boxWasGone
      ? "The previous box expired; artifact restored on a new box."
      : "Artifact restored on a new box, same link."
    await Promise.allSettled(room.members.map((member) => this.sender.send(room.code, member, { text, artifactUrl })))
  }

  /** Reply guidance to a sender whose command could not be honoured. The
   *  member is resolved against the store first: a member who IS in a room
   *  (even under an id this call never saw) gets the line through the
   *  one-send-path helper — pull members included, as an outbox record. Only
   *  a sender in NO room goes out over the transport on a placeholder, and a
   *  pull member with no room has no outbox to hold a record, so the miss is
   *  logged loudly rather than swallowed. An address nobody routes throws
   *  the loud `UnroutedDeliveryError` here, for the `handleInbound`
   *  boundary to answer (brief D) — the same throw the transport arm made
   *  before this helper existed. */
  private async replyGuidance(input: InboundInput, text: string): Promise<void> {
    const found = this.store.findByAddress(input.address)
    if (found.kind === "one") {
      await this.sender.send(found.room.code, found.member, { text, artifactUrl: undefined })
      return
    }
    let mode: "push" | "pull"
    try {
      mode = deliveryModeOf({
        id: `pending:${input.address.provider}:${input.address.contactRef}`,
        displayName: input.displayName,
        tier: input.tier,
        address: input.address,
        joinedAt: new Date().toISOString(),
      })
    } catch (error) {
      throw error instanceof UnroutedDeliveryError
        ? error
        : new UnroutedDeliveryError(`unrouted delivery: no delivery mode for provider "${input.address.provider}"`)
    }
    if (mode === "pull") {
      console.warn(
        `member-send: guidance for pull member ${input.displayName} (${input.address.provider}) reached no room — nothing was delivered: ${text}`,
      )
      return
    }
    // A push member in no room still goes over the transport on a
    // placeholder — through the helper's push arm, which is exactly this
    // send; there is no outbox to write to.
    const placeholder: Member = {
      id: `pending:${input.address.provider}:${input.address.contactRef}`,
      displayName: input.displayName,
      tier: input.tier,
      address: input.address,
      joinedAt: new Date().toISOString(),
    }
    await this.sender.send("", placeholder, { text, artifactUrl: undefined })
  }
}
