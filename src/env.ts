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
  })
}

/** The process-wide environment, resolved once at import. */
export const env: Env = loadEnv(process.env)
