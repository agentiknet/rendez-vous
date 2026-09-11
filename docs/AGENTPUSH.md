# agentpush — ground-truthed wire contract

Ground-truthed against the read-only checkout at
`/Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/projects/agentpush`
(never edited, never committed into). Every claim below carries a `file:line`
anchor into that checkout. This replaces the inferred contract from the M5
report, which assumed a single unified `{channel, from, text, messageId}`
webhook dialect and a `POST /send_message` endpoint — neither exists. The
real API is a generic tool-execution surface (`POST /tools/:name`) plus a
separate, richer notify-webhook contract for inbound.

## 1. Sending a message — `POST /tools/send_message`

Dispatched by the generic tool-execution route
`apps/api/src/app.ts:984-1051` (`app.post("/tools/:name", ...)`), which
resolves the workspace, validates the body against the tool's zod schema,
and calls `tool.handler`. The `send_message` tool itself is
`packages/tools/src/tools/send-message.ts:198-250`.

```
POST {RDV_AGENTPUSH_URL}/tools/send_message
Authorization: Bearer <apk_...>
Content-Type: application/json

{
  "to": { "channel": "whatsapp" | "telegram", "address": "+15551234567" },
  "content": { "text": "..." }
}
```

- **Auth** — `Authorization: Bearer <key>`, hashed and looked up in the
  `api_keys` table (`apps/api/src/app.ts:138-178`, `resolveWorkspaceId`).
  Missing/invalid → `401 {"error":"Unauthorized"}`. When no
  `INTERNAL_SERVICE_KEY` is configured on the deployment, ANY request is
  treated as a full-access dev bypass (`app.ts:148`) — that is a deployment
  posture, not something we control from the client side; assume production
  deployments set it.
- **`to`** — `{ channel, address }`, validated by
  `mailDomainChannelSchema` (`packages/tools/src/lib/channel-alias.ts:21-40`):
  the channel enum is `"whatsapp" | "sms" | "mail" | "telegram" | "discord"`
  (`"email"` is accepted and normalized to `"mail"`). `address` is the
  E.164 phone number (WhatsApp) or chat id (Telegram) —
  `send-message.ts:22-31`.
- **`content`** — `{ text }` is enough for a free-form send.
  `send-message.ts:33-41` notes WhatsApp free text only works inside the
  24h session window; outside it, `content.templateName` (a pre-approved
  Meta template) is required instead — not needed for Rendez-vous, whose
  members always messaged the room first.
- **Response** — `IndividualResultSchema`
  (`packages/core/src/contracts/api-shapes.ts:219-244`):
  - `{"status":"sent"|"queued","message_id":"...","cost"?:number}` — HTTP 200.
  - `{"status":"blocked","blocked_reason":"...","suggestion":"..."}` — HTTP
    200. A policy block (opt-out, session expired, …) is **not** an HTTP
    error; check `status`, not just `res.ok`.
  - `{"status":"failed","error":"..."}` on a provider-level send failure.
  - Non-2xx only for auth (401), unknown tool (404), schema validation (422,
    `{error, issues}`), or an uncaught handler throw (500,
    `{error: <safe message>}` — `app.ts:1045-1050`).

## 2. Sending media

**Channel support is asymmetric — verified per driver, not assumed:**

- **WhatsApp** — the only channel whose driver implements
  `uploadMediaFromBuffer`
  (`packages/messaging/src/providers/whatsapp/provider.ts:608-623`; grepped
  for that symbol across `packages/messaging/src/providers/*` and WhatsApp is
  the only hit). Two-call flow, exactly as `upload-media.ts:36-45` documents:

  ```
  POST {RDV_AGENTPUSH_URL}/tools/upload_media
  Authorization: Bearer <apk_...>
  { "channel": "whatsapp", "type": "image", "data": "<base64 png>",
    "filename": "qr.png", "mimeType": "image/png" }
  → { "media_id": "...", "url": "..." }   (upload-media.ts:47-64)

  POST {RDV_AGENTPUSH_URL}/tools/send_message
  { "to": { "channel": "whatsapp", "address": "+1..." },
    "content": { "text": "<caption>",
                 "media": [{ "type": "image", "providerMediaId": "<media_id>",
                             "caption": "<caption>" }] } }
  ```

  `push.uploadMedia`'s `data` branch (`packages/sdk/src/push.ts:645-662`)
  base64-decodes and calls `provider.uploadMediaFromBuffer` directly — no
  public URL needed. This is a real, verified path for a locally-generated
  PNG with nowhere public to host it.

- **Telegram** — grepped `packages/messaging/src/providers/telegram/` for
  `uploadMediaFromBuffer`/`uploadMediaFromUrl`: neither exists. The
  telegram driver's `send()` only reads
  `media.providerMediaId || media.url || media.storageMediaId`
  (`packages/messaging/src/providers/telegram/provider.ts:128-131`) and
  passes whichever is present straight to grammY's `sendPhoto`/etc as the
  file source. Since `upload_media` has no telegram implementation,
  `providerMediaId` is unreachable for this channel — **the only working
  media path for Telegram is a public `content.media[].url`**, which we do
  not have for an in-memory-generated QR PNG.

  Implication for `sendMedia`, and why it is not a gap in our
  implementation: for Telegram, `sendMedia` degrades to a caption-only
  `send_message` call — the exact fallback this milestone's brief already
  sanctioned for an unverifiable media path, except here it is a *verified*
  channel limitation, not a hedge against an unknown contract.

## 3. The inbound notify webhook — what agentpush POSTs to us

This is the real analog of what M5 called "the agentpush dialect" — it does
not exist as M5 assumed (a webhook agentpush receives from providers and
re-shapes uniformly). What actually happens: agentpush receives
provider-native webhooks itself (Meta's WhatsApp Business format at
`POST /inbound/whatsapp`, Telegram Bot API updates at
`POST /inbound/telegram[/:token]` — `apps/api/src/app.ts:1241-1483`, not
consumed by us), then — for any inbound message that matches a `notify`
mode `inbound_route` the workspace configured — POSTs a **versioned,
provider-neutral envelope** to that route's `notify_url`. That envelope,
not the raw provider payload, is what lands on our webhook.

### Setup (operator, one-time, via the agentpush API — not our code)

```
POST /tools/inbound_route_create
{
  "name": "rendez-vous",
  "channel": null,                 // or "whatsapp"/"telegram" to scope it
  "match_type": "catch_all",
  "dispatch_tag": "rendez-vous",
  "dispatch_mode": "notify",
  "notify_url": "https://<our public origin>/inbound/agentpush",
  "notify_secret": "<same value as RDV_AGENTPUSH_WEBHOOK_SECRET>"
}
```
(`apps/web/src/app/docs/inbound/page.tsx:23-35`, `packages/tools/src/tools/`
— the `inbound_route_create` tool backing it;
`packages/core/src/domain/inbound-route/schema.ts:36-72` for the stored
shape.) `notify_url` must be public https — loopback/private/link-local
targets are refused (SSRF guard, same page, "notify_url" row).

### The envelope (`MessagingInboundEnvelope` v1)

`packages/core/src/domain/inbound-route/messaging.ts:40-50` (type),
`:65-82` (`buildMessagingInboundEnvelope`, the only place it's constructed):

```json
{
  "version": 1,
  "workspaceId": "acme",
  "channel": "whatsapp",
  "providerAccountId": "pa_7f3c…",
  "from": "+33612345678",
  "conversationId": "+33612345678",
  "messageId": "wamid.HBgL…",
  "text": "I'd like to change my booking",
  "media": [{ "type": "image", "url": "https://…", "mimeType": "image/jpeg", "size": 182734 }]
}
```

- `version` is always `1` today; per the docs page (`page.tsx:204-207`)
  receivers must tolerate **additive** fields, not a version bump — treat an
  unrecognized `version` as a contract change we haven't ground-truthed and
  reject it (400), rather than silently misparse.
- `channel` is a free string across the whole provider set (`whatsapp`,
  `telegram`, `discord`, `slack`, `sms`, `mail`, …) — the envelope itself
  places no restriction on it. Rendez-vous only supports `messenger`-tier
  `whatsapp`/`telegram` today, so anything else is a 400
  (`unsupported_channel`, our own gate, not agentpush's).
- `text` is **always present**, defaulting to `""` for a media-only message
  (`messaging.ts:79`, `input.msg.content.text ?? ""`) — it is never an
  absent key. A present-but-empty `text` is the "ignored, no text" case; an
  absent `text` key entirely is a malformed payload we don't recognize.
- **No display name anywhere.** `ReceivedMessage`
  (`packages/core/src/ports/messaging.ts:167-178`) has no name-shaped field,
  and `buildMessagingInboundEnvelope` only ever reads
  `from`/`conversation?.id`/`id`/`content.text`/`content.media` off it
  (`messaging.ts:76-80`) — there is no `name`/`profileName`/`senderName` to
  fall back through. `displayName` in our `InboundEnvelope` is always the
  contact ref (`from`) itself; guessing at alternate field names (as M5's
  inferred contract did) was chasing a field that does not exist.
- **No challenge/handshake.** Route creation is one authenticated API call
  (above); there is no receiver-side verification ping to answer. M5's
  `challenge` branch modeled a Meta/Slack-style verification flow this
  product doesn't have for notify delivery — removed.
- `messageId` = `ReceivedMessage.id`, always a non-empty string in the type.
  We still validate its presence/type defensively (an external payload is
  not a compile-time guarantee) and 400 if it's missing, since our
  `MessageDedup` is the only redelivery guard on our side of the wire.

### Signature — unchanged from M5, now with real citations

`X-Agentpush-Signature: sha256=<hex HMAC-SHA256(notify_secret, rawBody)>`,
computed over the **exact JSON bytes on the wire**
(`packages/sdk/src/push.ts:504-531`, the actual dispatcher;
`packages/core/src/ports/request.ts:29-35`, the field's doc comment;
`apps/web/src/app/docs/inbound/page.tsx:220-238`, the customer-facing
verification recipe, byte-for-byte the same construction M5 already
implemented). No timestamp or nonce rides in the scheme — there is no
replay window to enforce, confirmed by reading the signer itself, not just
inferred. `notify_secret` is optional per route; omitting it means
unsigned notifies, exactly like M5's "no secret configured" behavior.

### Delivery semantics

At-least-once: a durable `inbound_route_notifies` row is snapshotted before
the first attempt and a worker retry pass re-dispatches failures
(`packages/core/src/domain/inbound-route/schema.ts:87-119`; doc:
`page.tsx:240-257`). Each attempt has a 10s timeout
(`push.ts:524`); any non-2xx, timeout, or egress-guard rejection is
journaled `failed` and retried later. **Our `MessageDedup` on `messageId`
is required, not optional** — this is not a hypothetical redelivery, it's
the documented default.

## 4. Minting an API key for a workspace

```
POST {RDV_AGENTPUSH_URL}/admin/api-keys
X-Internal-Key: <deployment's INTERNAL_SERVICE_KEY>
{ "workspaceId": "<workspace id>", "label": "rendez-vous", "scopes": ["send-only"] }
→ 201 { "id", "key", "workspaceId", "label", "scopes" }   -- key shown ONCE
```
(`apps/api/src/app.ts:1905-1941`, `IssueApiKeyBody` at `app.ts:199-203`.)
Scopes are `"send-only" | "read-only" | "full"`
(`packages/core/src/domain/api-keys/schema.ts:4`) — `send-only` covers
`send_message`/`upload_media`. This route itself is gated on the shared
`X-Internal-Key` deployment secret, not a workspace API key — it's an admin
operation the operator runs once, out of band. The resulting `key` (looks
like `apk_...`) is what goes in **`RDV_AGENTPUSH_KEY`**. No key value is
reproduced anywhere in this repo.

## 5. The base URL for `RDV_AGENTPUSH_URL`

The `apps/api` service reads `PUBLIC_BASE_URL` for its own public origin
(`apps/api/src/env.ts:16-21`) and listens on `PORT` (default `8080`,
`env.ts:4`). For a deployed instance, `RDV_AGENTPUSH_URL` is whatever
`PUBLIC_BASE_URL` the operator set on that deployment; for a local instance
it's `http://localhost:<PORT>` (default `http://localhost:8080`). This repo
has no running agentpush instance and no `PUBLIC_BASE_URL` value to read —
the operator must supply the real one.

## 6. Ranking: direct REST (our own key) vs. the daemon's MCP proxy

Investigated per this milestone's brief: does the agentproto daemon expose
an HTTP route that lets an authenticated caller invoke an already-imported
MCP server's tool, so Rendez-vous could reuse the daemon's own agentpush
credentials instead of holding `RDV_AGENTPUSH_KEY` itself? Yes —
`POST /mcps/proxy/call` (agentproto/ts
`packages/runtime/src/http-server.ts:2371-2404`):
`{ alias: "agentpush", toolName: "send_message", args: {...} }` →
`opts.mcpProxy.callTool(alias, toolName, args)`.

| Dimension | A. Direct REST, our own key | B. Daemon MCP proxy |
| --- | --- | --- |
| **Verifiability today** | Every endpoint, auth header, body and response shape ground-truthed above against real agentpush source. | Depends on the daemon operator having already run agentproto's **local** MCP-import flow — `mcp-imports.ts:1-30` snapshots an MCP server **already configured in a local client** (e.g. Claude Desktop's own config), it does not provision a fresh agentpush connection. Whether an "agentpush" alias is actually imported, pointed at a real instance, and holds a working credential is unverifiable from here and not something our service can provision. |
| **Latency** | One hop: our service → agentpush. | Three: our service → daemon `/mcps/proxy/call` → a **freshly built MCP server per request** (`apps/api/src/app.ts:1163-1166`, "Stateless MCP: build a fresh server+transport per request... a shared transport 500s the initialize handshake") → agentpush's tool execution. Strictly more hops plus a repeated MCP initialize handshake on every send. |
| **Secrets held by our service** | One scoped `RDV_AGENTPUSH_KEY` (agentpush-only capability, mintable with `send-only` scope). | None of agentpush's — *but* `POST /mcps/proxy/call`'s handler (`http-server.ts:2371-2404`) calls neither `checkSessionsToken` nor `authorize()`, unlike neighboring mutating routes in the same file (e.g. `:2130`, `:2200`, `:2237` all call `checkSessionsToken` first). Anyone who can reach the daemon's HTTP port can drive **any** imported MCP tool, agentpush included, with **zero** token — the same class of gap as architecture.md's R6 (no multi-principal scoping on the daemon surface), sharper here since it doesn't even need a paired-laptop bearer. The "fewer secrets" advantage doesn't come with a security offset. |
| **Daemon-restart coupling** | None — this transport never talks to the daemon. | Total — every WhatsApp/Telegram send goes through the daemon, so a daemon restart (e2b pause/resume, a crash, an upgrade) takes our fan-out down with it. Directly contradicts architecture.md §2's "durability by code" invariant (the room should outlive a daemon restart). |

**Ranked #1: direct REST with our own key (A).** It is fully verified, has
the fewest hops, and — critically — keeps outbound messaging independent of
the daemon's own liveness, which is the whole point of Rendez-vous holding
its own room state. Option B is documented here for completeness and is not
implemented; if it's ever revisited, the missing `/mcps/proxy/call` auth
gate should be raised with the agentproto operator first (it reads like an
oversight relative to its neighbors, not a deliberate design choice), the
same caveat this repo already applies to R3.

## 7. What the operator must provide

- `RDV_AGENTPUSH_URL` — base URL of the deployed agentpush `apps/api`
  instance (§5). No trailing slash (stripped either way).
- `RDV_AGENTPUSH_KEY` — a workspace API key minted per §4, scope
  `send-only` or `full`.
- `RDV_AGENTPUSH_WEBHOOK_SECRET` — must match the `notify_secret` set on
  the `inbound_route` created per §3's setup step. Optional but strongly
  recommended; unset means unsigned inbound notifies are accepted.
- For `scripts/prove-agentpush.ts`: `RDV_TEST_RECIPIENT`, a real WhatsApp
  E.164 number that can receive the proof message.

None of these were discoverable on this machine: no agentpush process is
listening on any port (only the agentproto daemon on `18790`), no
`~/.agentpush`/`~/.config/agentpush` config, and no matching environment
variables — see the M5-ground-truth report for the check.
