/**
 * Typed environment. The only file allowed to read `process.env`.
 *
 * Every knob the service needs is declared here once, with its default and
 * its parser, and exposed as a frozen `Env` value. Callers import `env`;
 * nobody reads `process.env` anywhere else (build brief, constraint 5).
 */

export interface Env {
  /** Base URL of the agentproto daemon we drive. No trailing slash. */
  readonly daemonUrl: string
  /** Bearer token for the daemon, when it runs in `bearer` auth mode. */
  readonly daemonToken: string | undefined
  /** Directory holding the room registry and per-room cursors. */
  readonly dataDir: string
  /** Port the Rendez-vous HTTP service listens on. */
  readonly port: number
  /** Public origin of this service, used to mint join links. No trailing slash. */
  readonly publicUrl: string
  /** Adapter slug passed to the daemon when a room boots its session. */
  readonly agentAdapter: string
  /** Model id passed to the daemon when a room boots its session. */
  readonly agentModel: string
  /** WhatsApp number for join links, digits only, no leading `+`. Undefined when not configured. */
  readonly whatsappNumber: string | undefined
  /** Telegram bot username for join links, without the leading `@`. Undefined when not configured. */
  readonly telegramBot: string | undefined
  /** SMS number for join links (M11, Twilio via agentpush, docs/AGENTPUSH.md
   *  §9), digits only, no leading `+`. Same validation as `whatsappNumber`.
   *  Undefined when not configured. */
  readonly smsNumber: string | undefined
  /**
   * Base URL of the agentpush API our own outbound transport calls directly,
   * no trailing slash. The daemon never reads an agentpush URL from its own
   * environment — it reaches agentpush through an imported MCP server, whose
   * `apiBase` is a provider-manifest config value, not an env var (see
   * `defineAuthProvider` in skill-pack-agentpush/skills/auth/SKILL.md). There
   * is no daemon-side env name to mirror here.
   */
  readonly agentpushUrl: string | undefined
  /**
   * API key for the agentpush base URL above, sent as `Authorization: Bearer
   * <key>`. The closest daemon-side convention is `AGENTPUSH_API_KEY`,
   * mentioned in the same SKILL.md as the env var value to migrate OUT of
   * the daemon's global env and into its credential broker — not a name the
   * daemon itself reads. Kept as `RDV_AGENTPUSH_KEY` to stay inside this
   * service's own `RDV_*` namespace.
   */
  readonly agentpushKey: string | undefined
  /** HMAC secret for verifying `x-agentpush-signature` on inbound webhooks
   *  straight into this service (src/channels/agentpush/inbound.ts). Mirrors
   *  the per-endpoint `secret` field the daemon's own `InboundEndpoint`
   *  carries (inbound-endpoints.ts:30), scoped here to one shared secret
   *  since this service has exactly one agentpush webhook route, not one
   *  per provider/slug. */
  readonly agentpushWebhookSecret: string | undefined
  /** Which `SessionBooter` `serve` wires up: `"e2b"` picks `E2bBooter`
   *  (sandbox + artifact), anything else falls back to `LocalBooter`. */
  readonly booter: "local" | "e2b"
  /** In-box path `E2bBooter` seeds and serves the artifact app from. Matches
   *  `scripts/prove-sandbox.ts`'s `APP_DIR` — the layout that module's
   *  ground-truthing found actually serves (docs/UPSTREAM.md, "Second live
   *  attempt"). */
  readonly artifactAppDir: string
  /** In-box port `E2bBooter` serves the artifact app on. */
  readonly artifactPort: number
  /** A pre-warmed, already-paused e2b sandbox id to reuse for the next room
   *  that runs `new`, instead of paying for a fresh boot. Consumed at most
   *  once: `E2bBooter` checks the store for a room that already recorded
   *  this id as its `sandboxId` before offering it again, so a service
   *  restart can't hand the same box to a second room (build brief M4/R10). */
  readonly prewarmSandboxId: string | undefined
  /** How often `RoomService` checks for idle rooms to pause, in seconds. */
  readonly idleSweepSeconds: number
  /** How long a room may sit with no activity before the sweep pauses it. */
  readonly idlePauseMinutes: number
  /** How often the idle sweep probes an active room's own e2b box for
   *  liveness via the e2b API (docs/UPSTREAM.md #10) — independent of, and
   *  cheaper than, the idle-pause cadence above. A box found gone marks the
   *  room `artifactReady: false` and `state: "paused"` so the next message
   *  triggers a fresh boot. */
  readonly boxProbeMinutes: number
  /** HMAC secret for verifying `x-agentpush-signature` on the tier-2 email
   *  inbound webhook (src/channels/email/inbound.ts). Independent from
   *  `agentpushWebhookSecret`: agentpush's Gmail poll path dispatches
   *  through its own `inbound_route` row (docs/AGENTPUSH.md §8), which can
   *  carry a different `notify_secret` than the messaging route's. Outbound
   *  email reuses `agentpushUrl`/`agentpushKey` — it's the same
   *  `/tools/send_message` endpoint, just `channel: "mail"`. */
  readonly emailWebhookSecret: string | undefined
  /** Absolute path to the canvakit CLI's built entrypoint, invoked as
   *  `node <path> export ...` (deck/README.md's render command;
   *  docs/DELIVERABLE.md). Defaults to the same absolute path deck/README.md
   *  documents on this host. */
  readonly canvakitCli: string
  /** Directory rendered deliverables are stored under, one subdirectory per
   *  room code (src/service/media-store.ts). */
  readonly mediaDir: string
  /** Operator hard limit (docs/DELIVERABLE.md): comma-separated email
   *  addresses and messenger contact refs a deliverable may actually be sent
   *  to. When set, `DeliverableService` refuses any target not on this list
   *  at request/preview time — before rendering, before any agentpush call,
   *  before a token even exists to confirm. When unset, every target is
   *  accepted and `DeliverableService` logs a loud startup warning instead;
   *  `confirm` is still required either way. Compared case-insensitively.
   *  Undefined when unset or empty. */
  readonly deliveryAllowlist: readonly string[] | undefined
  /** Cap, in bytes, on a single inbound media item fetched at ingress
   *  (src/channels/media-ingress.ts), from `RDV_MEDIA_MAX_MB` (a positive
   *  integer of mebibytes). An item over the cap is never fetched/stored;
   *  the fan-in line says so instead (docs/MULTIMODAL.md, "Failure modes
   *  stay visible"). Default 20 MiB. */
  readonly mediaMaxBytes: number
  /** Telegram bot token, from `RDV_TELEGRAM_BOT_TOKEN`. Undefined when unset,
   *  which is the safe default.
   *
   *  This exists because agentpush hands on inbound Telegram media as a bare
   *  `file_id` with no fetchable URL, and resolving one requires a `getFile`
   *  call authenticated with the BOT TOKEN (docs/UPSTREAM.md §11). With this
   *  set, the service resolves and downloads the bytes itself, so a voice
   *  note or photo can actually be transcribed or described. With it unset,
   *  inbound media still lands and is still announced to the room — it just
   *  says it could not be read.
   *
   *  The token never leaves this service: it is used for the `getFile` call
   *  and the download, and the resulting token-bearing URL is never stored,
   *  never logged, and never sent to a member. That is exactly the leak
   *  docs/UPSTREAM.md §11 warns agentpush against introducing. */
  readonly telegramBotToken: string | undefined
  /** OpenAI API key, from `RDV_OPENAI_API_KEY`. One key covers all three
   *  media capabilities: Whisper for inbound speech-to-text, a vision model
   *  for inbound images, and TTS for the agent's own voice replies. Undefined
   *  when unset — every path degrades to a visible "unavailable" line rather
   *  than failing. */
  readonly openaiApiKey: string | undefined
  /**
   * HMAC secret for the per-room `render_artifact` bearer tokens the
   * canvakit MCP endpoint (`POST /mcp/canvakit`) requires before it will
   * render anything a room's members can see. From `RDV_ROOM_TOKEN_SECRET`;
   * when unset, a random secret is generated once per process — safe by
   * default (nothing outside this process can forge a token) at the cost of
   * old sessions' mounts going stale across a service restart, which the
   * next resume re-mounts anyway. Set it in production so a restart keeps
   * already-booted boxes' tokens valid.
   */
  readonly roomTokenSecret: string
  /** Operator-supplied display names, from `RDV_MEMBER_NAMES`:
   *  `"6371794295=Jeremy,33600000001=Alain"`. Wins over any provider lookup
   *  (src/channels/display-name.ts) — the escape hatch for a channel with no
   *  name API (WhatsApp, SMS, email), a wrong name, or a demo that wants
   *  specific labels. Undefined when unset. */
  readonly memberNames: string | undefined
}

type Source = Readonly<Record<string, string | undefined>>

function readString(source: Source, key: string, fallback: string): string {
  const raw = source[key]
  if (raw === undefined) return fallback
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

function readOptionalString(source: Source, key: string): string | undefined {
  const raw = source[key]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function readPort(source: Source, key: string, fallback: number): number {
  const raw = source[key]
  if (raw === undefined || raw.trim().length === 0) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${key} must be a port number between 1 and 65535, got "${raw}"`)
  }
  return n
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url
}

function readWhatsappNumber(source: Source, key: string): string | undefined {
  const raw = readOptionalString(source, key)
  if (raw === undefined) return undefined
  const digits = raw.startsWith("+") ? raw.slice(1) : raw
  if (!/^[0-9]+$/.test(digits)) {
    throw new Error(`${key} must contain only digits, with an optional leading +, got "${raw}"`)
  }
  return digits
}

function readTelegramBot(source: Source, key: string): string | undefined {
  const raw = readOptionalString(source, key)
  if (raw === undefined) return undefined
  return raw.startsWith("@") ? raw.slice(1) : raw
}

function readOptionalUrl(source: Source, key: string): string | undefined {
  const raw = readOptionalString(source, key)
  return raw === undefined ? undefined : stripTrailingSlash(raw)
}

function readBooter(source: Source, key: string): "local" | "e2b" {
  return readOptionalString(source, key) === "e2b" ? "e2b" : "local"
}

function readAllowlist(source: Source, key: string): readonly string[] | undefined {
  const raw = readOptionalString(source, key)
  if (raw === undefined) return undefined
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  return entries.length > 0 ? entries : undefined
}

function readPositiveInt(source: Source, key: string, fallback: number): number {
  const raw = source[key]
  if (raw === undefined || raw.trim().length === 0) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${key} must be a positive integer, got "${raw}"`)
  }
  return n
}

import { randomUUID } from "node:crypto"

/**
 * Build an `Env` from an arbitrary source map. Exported so tests can pass a
 * literal instead of mutating `process.env`.
 */
export function loadEnv(source: Source): Env {
  const port = readPort(source, "RDV_PORT", 8790)
  return Object.freeze({
    daemonUrl: stripTrailingSlash(readString(source, "RDV_DAEMON_URL", "http://127.0.0.1:18790")),
    daemonToken: readOptionalString(source, "RDV_DAEMON_TOKEN"),
    dataDir: readString(source, "RDV_DATA_DIR", ".rdv"),
    port,
    publicUrl: stripTrailingSlash(readString(source, "RDV_PUBLIC_URL", `http://127.0.0.1:${port}`)),
    agentAdapter: readString(source, "RDV_AGENT_ADAPTER", "claude-code"),
    agentModel: readString(source, "RDV_AGENT_MODEL", "claude-sonnet-5"),
    whatsappNumber: readWhatsappNumber(source, "RDV_WHATSAPP_NUMBER"),
    telegramBot: readTelegramBot(source, "RDV_TELEGRAM_BOT"),
    smsNumber: readWhatsappNumber(source, "RDV_SMS_NUMBER"),
    agentpushUrl: readOptionalUrl(source, "RDV_AGENTPUSH_URL"),
    agentpushKey: readOptionalString(source, "RDV_AGENTPUSH_KEY"),
    agentpushWebhookSecret: readOptionalString(source, "RDV_AGENTPUSH_WEBHOOK_SECRET"),
    booter: readBooter(source, "RDV_BOOTER"),
    artifactAppDir: readString(source, "RDV_ARTIFACT_APP_DIR", "/home/user/apps/rdv-hello"),
    artifactPort: readPort(source, "RDV_ARTIFACT_PORT", 3210),
    prewarmSandboxId: readOptionalString(source, "RDV_PREWARM_SANDBOX_ID"),
    idleSweepSeconds: readPositiveInt(source, "RDV_IDLE_SWEEP_SECONDS", 60),
    idlePauseMinutes: readPositiveInt(source, "RDV_IDLE_PAUSE_MINUTES", 20),
    boxProbeMinutes: readPositiveInt(source, "RDV_BOX_PROBE_MINUTES", 5),
    emailWebhookSecret: readOptionalString(source, "RDV_EMAIL_WEBHOOK_SECRET"),
    canvakitCli: readString(
      source,
      "RDV_CANVAKIT_CLI",
      "/Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/projects/openagentik/canvakit/packages/cli/dist/index.js",
    ),
    mediaDir: readString(source, "RDV_MEDIA_DIR", ".rdv/media"),
    deliveryAllowlist: readAllowlist(source, "RDV_DELIVERY_ALLOWLIST"),
    mediaMaxBytes: readPositiveInt(source, "RDV_MEDIA_MAX_MB", 20) * 1024 * 1024,
    telegramBotToken: readOptionalString(source, "RDV_TELEGRAM_BOT_TOKEN"),
    openaiApiKey: readOptionalString(source, "RDV_OPENAI_API_KEY"),
    memberNames: readOptionalString(source, "RDV_MEMBER_NAMES"),
    roomTokenSecret: readOptionalString(source, "RDV_ROOM_TOKEN_SECRET") ?? randomUUID(),
  })
}

/** The process-wide environment, resolved once at import. */
export const env: Env = loadEnv(process.env)
