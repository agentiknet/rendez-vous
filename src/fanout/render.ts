import type { Tier } from "../rooms/types.ts"
import type { OutboundMessage } from "./types.ts"

const MESSENGER_MAX_CHARS = 1500
const ELLIPSIS = "…"

function collapseNewlines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n")
}

function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars - ELLIPSIS.length) + ELLIPSIS
}

function renderMessenger(turnText: string, artifactUrl: string | undefined, artifactChanged: boolean): OutboundMessage {
  const collapsed = collapseNewlines(turnText.trim())
  const capped = capText(collapsed, MESSENGER_MAX_CHARS)
  const text = artifactChanged && artifactUrl !== undefined ? `${capped}\n${artifactUrl}` : capped
  return { text, artifactUrl }
}

function renderEmail(turnText: string, artifactUrl: string | undefined): OutboundMessage {
  const lines = ["Room update", "", turnText.trim()]
  if (artifactUrl !== undefined) {
    lines.push("", artifactUrl)
  }
  return { text: lines.join("\n"), artifactUrl }
}

export function renderForTier(
  tier: Tier,
  turnText: string,
  artifactUrl: string | undefined,
  artifactChanged: boolean,
): OutboundMessage | undefined {
  switch (tier) {
    case "messenger":
      return renderMessenger(turnText, artifactUrl, artifactChanged)
    case "email":
      return renderEmail(turnText, artifactUrl)
    case "room-web":
      return undefined
  }
}
