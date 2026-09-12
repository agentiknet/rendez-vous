/**
 * Real names for members, instead of raw contact refs.
 *
 * agentpush's inbound envelope carries NO display-name field — `ReceivedMessage`
 * has no name-shaped member and the envelope builder never reads one — so
 * `InboundEnvelope.displayName` is the contact ref itself
 * (src/channels/agentpush/inbound.ts). In a room that shows every message as
 * `[Name · tier] …`, that means members appear to each other as
 * `700000002` and `33600000001`, and the agent addresses them that way too.
 * It reads like a database, not a conversation.
 *
 * Two sources, in this order:
 *
 * 1. **`RDV_MEMBER_NAMES`** — an explicit operator map,
 *    `"6371794295=Jeremy,33600000001=Alain"`. Wins over everything: it is the
 *    escape hatch for a channel with no name API, a wrong name, or a demo
 *    where you want specific labels.
 * 2. **The provider's own directory** — for Telegram, `getChat(chat_id)`
 *    returns `first_name`/`username` when the service holds the bot token
 *    (`RDV_TELEGRAM_BOT_TOKEN`, already needed for inbound media). This is
 *    what makes names work with no configuration at all.
 *
 * Falling back to the contact ref is always acceptable: a room with ugly names
 * works, a room that fails to boot because a name lookup died does not. Every
 * failure path here returns the ref.
 */

import { env } from "../env.ts"

const TELEGRAM_API = "https://api.telegram.org"
const LOOKUP_TIMEOUT_MS = 5_000

/** Parsed once. `"ref=Name,ref2=Other Name"`; blank entries ignored. */
function parseOverrides(raw: string | undefined): ReadonlyMap<string, string> {
  const map = new Map<string, string>()
  if (raw === undefined) return map
  for (const entry of raw.split(",")) {
    const eq = entry.indexOf("=")
    if (eq <= 0) continue
    const ref = entry.slice(0, eq).trim()
    const name = entry.slice(eq + 1).trim()
    if (ref.length > 0 && name.length > 0) map.set(ref, name)
  }
  return map
}

const OVERRIDES = parseOverrides(env.memberNames)

/** In-process, and deliberately never invalidated: a display name is stable
 *  enough that one lookup per contact per process beats a request per message
 *  on the inbound hot path. */
const resolved = new Map<string, string>()

export interface DisplayNameFetchResponse {
  readonly ok: boolean
  json(): Promise<unknown>
}

export type DisplayNameFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<DisplayNameFetchResponse>

const defaultFetch: DisplayNameFetch = (url, init) => fetch(url, init)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** `{ok: true, result: {first_name, username, …}}` — prefer the human first
 *  name, fall back to the @handle, and treat anything else as no answer. */
function readTelegramName(body: unknown): string | undefined {
  if (!isRecord(body) || body["ok"] !== true) return undefined
  const result = body["result"]
  if (!isRecord(result)) return undefined
  const first = result["first_name"]
  if (typeof first === "string" && first.trim().length > 0) return first.trim()
  const username = result["username"]
  if (typeof username === "string" && username.trim().length > 0) return username.trim()
  return undefined
}

export interface ResolveDisplayNameOptions {
  readonly fetch?: DisplayNameFetch
  readonly telegramBotToken?: string | undefined
  /** Bypass the process cache — tests only. */
  readonly noCache?: boolean
}

/**
 * The name to show for `contactRef` on `provider`. Never throws; returns
 * `contactRef` when nothing better is available.
 */
export async function resolveDisplayName(
  provider: string,
  contactRef: string,
  options: ResolveDisplayNameOptions = {},
): Promise<string> {
  const override = OVERRIDES.get(contactRef)
  if (override !== undefined) return override

  const cacheKey = `${provider}:${contactRef}`
  if (options.noCache !== true) {
    const hit = resolved.get(cacheKey)
    if (hit !== undefined) return hit
  }

  const token = options.telegramBotToken ?? env.telegramBotToken
  if (provider !== "telegram" || token === undefined) return contactRef

  const doFetch = options.fetch ?? defaultFetch
  try {
    const res = await doFetch(
      `${TELEGRAM_API}/bot${token}/getChat?chat_id=${encodeURIComponent(contactRef)}`,
      { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) },
    )
    if (!res.ok) return contactRef
    const name = readTelegramName(await res.json())
    if (name === undefined) return contactRef
    if (options.noCache !== true) resolved.set(cacheKey, name)
    return name
  } catch {
    // An unreachable Telegram API must never stop a message reaching the room.
    return contactRef
  }
}

/** Exposed for tests: the override map the operator configured. */
export function displayNameOverrides(): ReadonlyMap<string, string> {
  return OVERRIDES
}
