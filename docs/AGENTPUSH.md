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
  "channel": "telegram",
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
`channel: null` (catch-all across every channel) must not be used here:
`matchesInboundRoute` (agentpush's `inbound-route/evaluate.ts:56`) treats a
`null` channel as matching everything, including the Gmail poll path's
`"mail"` channel (§8.2) — a `channel: null` messaging route and the §8.3
`channel: "mail"` route would both match the same inbound email, each firing
its own notify to a webhook that rejects the other's envelope shape with a
400 (see `test/service/route-overlap.test.ts`). Scope this route to one real
messenger channel instead — `"telegram"` here, matching this deployment's
live surface — so the two routes stay disjoint.

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

### Do not pin a route to a bot account

Routes evaluate independently, not first-match-wins
(`packages/core/src/domain/inbound-route/evaluate.ts:12`) — matching is by
`channel` string and `match_type` only; `matchesInboundRoute` never looks at
`provider_account_id`. So a second Telegram bot added to the same workspace
is still caught by any workspace-wide "telegram → responder" catch-all
route already configured — the two bots are indistinguishable to the
matcher. Pinning our own route to a specific provider account instead
doesn't scope it to that bot; it makes it never fire at all, since
`listEnabledMessagingRoutes` filters `provider_account_id IS NULL`
(§3's own citation, `repository.ts:335`). The real isolation boundary here
is `workspace_id`, not the account — one workspace per bot you need
distinct routing for.

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

## 8. Email (tier 2) — M10

**Correction to this milestone's premise: email is not unimplemented in
agentpush.** The brief's fallback ("if email is not implemented, build a
generic `RDV_EMAIL_SEND_URL`/`RDV_EMAIL_SEND_KEY` adapter, mark it 'adapter
pending'") does not apply — agentpush has a full mailbox surface: Gmail
OAuth connect flow, a poll-driven inbound path, mailbox-triage tools, and
`channel: "mail"` on the same `send_message` tool used for WhatsApp/Telegram
(`apps/api/src/app.ts:660-919` for the OAuth flow,
`packages/tools/src/tools/mailbox*.ts` for the triage tools,
`packages/tools/src/lib/channel-alias.ts:21-30` for `"mail"` in
`MAIL_DOMAIN_CHANNELS`). Built against the real contract, not a placeholder
— consistent with how M5 was corrected.

### 8.1 Outbound — same endpoint, `channel: "mail"`

Identical call to §1: `POST {RDV_AGENTPUSH_URL}/tools/send_message`, same
`Authorization: Bearer <key>`, same response envelope
(`{status:"sent"|"queued",message_id,cost?}` / `{status:"blocked",...}` /
`{status:"failed",...}`). Mail-only `content` fields
(`packages/tools/src/tools/send-message.ts:33-97`):

```json
{
  "to": { "channel": "mail", "address": "alice@example.com" },
  "content": {
    "subject": "Room RDV-7F3K update",
    "text": "...",
    "reply_to_message_id": "<id of the message being replied to>"
  }
}
```

- `subject` — required for a sane inbox line; without it the mail goes out
  with `"(no subject)"` (`packages/messaging/src/providers/gmail/provider.ts:382-383`).
- `html`/`format: "markdown"` — richer body, not used by Rendez-vous (plain
  text digest is enough for tier 2).
- `cc`/`bcc` — mail-only, rejected with an error on every other channel
  (`send-message.ts:65-74`) — not used here either.
- **Threading**: `reply_to_message_id` set to a prior message's provider id
  makes Gmail's `resolveThreading` fetch that message's `Message-ID`/
  `References`/`Subject` via the Gmail API and set real RFC 2822
  `In-Reply-To`/`References` headers on the outbound MIME message
  (`packages/messaging/src/providers/gmail/provider.ts:296-341`). This is
  genuine thread continuation, not a synthetic id Rendez-vous invents.
  Non-Gmail mail providers accept the field but send unthreaded
  (`send-message.ts:187`, "les autres providers mail envoient hors-thread").

`EmailTransport` (`src/channels/email/outbound.ts`) keeps one
`threadRef: memberId -> last message_id` map in memory and passes it as
`reply_to_message_id` on every send after the first for that member — each
reply threads off the immediately-prior message in the conversation.

### 8.2 Inbound — a different envelope, same signature scheme

**This is not `MessagingInboundEnvelope`.** Gmail inbound does not arrive
through the messaging webhook path (`POST /inbound/whatsapp`-style routes)
at all — there's no live webhook for Gmail. Instead `apps/worker` polls
Gmail's API on an interval (`apps/worker/src/poll-inbound.ts`, `pollAccount`
at :165-238) and, for a message matching an enabled `mail`-channel
`inbound_route`, builds its own notify payload:

```json
{
  "event": "inbound_mail",
  "route": { "name": "rendez-vous", "dispatch_tag": "rendez-vous" },
  "message": {
    "message_id": "18d2f...",
    "from": "alice@example.com",
    "subject": "Re: the room",
    "text": "sounds good",
    "timestamp": "2026-09-12T00:00:00.000Z"
  },
  "workspace_id": "acme"
}
```
(`apps/worker/src/poll-inbound.ts:124-144`, `buildNotifyPayload`.) Route
evaluation for mail runs under a fixed channel name,
`MAIL_CHANNEL = "mail"` (`packages/core/src/domain/inbound-route/evaluate.ts:22`,
`:191` in poll-inbound.ts) — a route with `channel: null` (catch-all) or
`channel: "mail"` is eligible.

**Same signature, different shape, no shared discriminant field.** Both
paths dispatch through the identical `push.dispatch()`
(`packages/sdk/src/push.ts:504-531`) via the shared
`buildInboundNotifyRequest` (`evaluate.ts:94-111`), so
`X-Agentpush-Signature: sha256=<hex HMAC-SHA256(notify_secret, rawBody)>`
is byte-for-byte the same scheme as §3. agentpush itself tells a mail
payload apart from a messaging one structurally — `notifyKindForPayload`
checks for `version`+`channel` (messaging) vs. anything else (mail)
(`evaluate.ts:113-123`) — `parseEmailInbound` does the same: it rejects
anything whose `event` isn't `"inbound_mail"` rather than assume the caller
only ever routes mail payloads to it.

**No display name, same as the messaging tier.** `message.from` is always a
*bare* email address against real agentpush — Gmail's provider strips any
display name before this payload is built:
`extractEmail(decodeRfc2047(findHeader(headers, "From")))`
(`packages/messaging/src/providers/gmail/provider.ts:512-514`).
`parseEmailInbound` still accepts an RFC 5322 `"Name <addr>"` form
defensively for a future/alternate mail connector — dead code against real
agentpush today, kept because it costs nothing and matches this milestone's
interface spec (`displayName` from the From header when present).

**No quote/signature stripping on agentpush's side.** Gmail's
`findPlainText` returns the raw MIME plain-text part verbatim
(`provider.ts:518`) — no heuristic applied upstream. `parseEmailInbound`
does the stripping itself: drop lines starting with `>`, and drop a line
matching `/^On .* wrote:$/` or `/^-- $/` and everything after it. A message
that's entirely quote/signature is `{ok:true, ignored:"no_text"}` after
stripping, same "ignored, not an error" treatment as an empty-text
messaging inbound (§3).

`roomCodeHint` has no agentpush counterpart — it's parsed from the subject
locally (`RDV-XXXX`, validated through `normalizeCode`,
src/rooms/code.ts) and returned for the caller to act on; the parser never
routes on it itself.

### 8.3 Setup (operator, one-time)

A **second** `inbound_route` (or one shared catch-all with `channel: null`)
via `POST /tools/inbound_route_create`, this time evaluated against Gmail
poll traffic rather than a live messaging webhook:

```json
{
  "name": "rendez-vous-mail",
  "channel": "mail",
  "match_type": "catch_all",
  "dispatch_tag": "rendez-vous-mail",
  "dispatch_mode": "notify",
  "notify_url": "https://<our public origin>/inbound/agentpush-mail",
  "notify_secret": "<same value as RDV_EMAIL_WEBHOOK_SECRET>"
}
```

A connected Gmail account must already exist on the workspace (the OAuth
consent flow at `apps/api/src/app.ts:660-919`) — out of scope for this
service, an operator action against agentpush's own dashboard/API.

### 8.4 Env

- Outbound reuses `RDV_AGENTPUSH_URL`/`RDV_AGENTPUSH_KEY` (§7) — it's the
  same `/tools/send_message` endpoint, just `channel: "mail"`. No new
  fields needed.
- `RDV_EMAIL_WEBHOOK_SECRET` (new) — independent from
  `RDV_AGENTPUSH_WEBHOOK_SECRET`, since the mail `inbound_route` is a
  separate row with its own `notify_secret` (an operator could reuse the
  same value across both routes, or set a different one — this service
  doesn't assume either).

### 8.5 What the service executor needs to wire

- A second webhook route (e.g. `POST /inbound/agentpush-mail`) that reads
  the raw body + headers, calls `parseEmailInbound({rawBody, headers,
  secret: env.emailWebhookSecret})`, and on a returned `envelope` treats it
  like any other tier's inbound turn — `envelope.provider` is `"email"`,
  `envelope.roomCodeHint` is available if the room needs to be resolved
  from the subject rather than an existing `(provider, source, contactRef)`
  binding.
- Dedup: reuse the existing `MessageDedup` class
  (`src/channels/agentpush/inbound.ts`) keyed on `envelope.messageId` — it's
  already channel-agnostic, no email-specific variant needed.
- Construct one `EmailTransport` alongside the existing
  `AgentpushTransport` for tier-2 members (`member.address.provider ===
  "email"`), same `{baseUrl: env.agentpushUrl, apiKey: env.agentpushKey}`
  options shape.
- For the subject line to read `"Room RDV-7F3K update"` instead of the
  generic fallback, whoever creates an email member should set
  `address.source` to the room's code.

## 9. SMS (a fourth surface, via Twilio) — M11

**"For fun."** Same messaging-tier machinery as WhatsApp/Telegram — no new
envelope, no new signature scheme. Ground-truthed against
`packages/messaging/src/providers/twilio/twilio.provider.ts` and
`apps/api/src/app.ts`.

### 9.1 The channel string is `"sms"`

`TwilioConfig.channel: "sms" | "rcs"` (`twilio.provider.ts:19`) — this
milestone only wires `"sms"` (RCS is the same driver, different Twilio
product, out of scope). `"sms"` is also already a valid `send_message`
channel per `MAIL_DOMAIN_CHANNELS`
(`packages/tools/src/lib/channel-alias.ts:21-27`, which despite the name
covers every non-`contact_id` send target, not just mail).

### 9.2 Outbound — identical `send_message` call, E.164 address

```json
{ "to": { "channel": "sms", "address": "+15551234567" }, "content": { "text": "..." } }
```
`TwilioProvider.send()` passes `recipient` straight through as the `To`
param on Twilio's `Messages.json` (`twilio.provider.ts:86-115`) — Twilio
requires E.164, so `address` must already be in that form; same convention
as WhatsApp.

### 9.3 Inbound — the SAME `MessagingInboundEnvelope`, `channel: "sms"`

Unlike email (§8), Twilio SMS has a **live webhook**, not a poll loop:
`POST /inbound/sms` (`apps/api/src/app.ts:1557-1615`) verifies
`X-Twilio-Signature` (Twilio's own HMAC-SHA1-over-URL-plus-sorted-params
scheme, `twilio.provider.ts:152-198,205-216` — irrelevant to us, agentpush
verifies it before ever building a notify), parses Twilio's form-encoded
webhook (`TwilioProvider.parse()`, `twilio.provider.ts:134-150`:
`id` = `MessageSid` (or `SmsSid`), `from` = the `From` param — a bare E.164
number, no display name — `content.text` = the `Body` param), then calls
`push.inbound(msg, "sms", workspaceId)` →
`fireMessagingInbound(deps, "sms", msg, workspaceId)`
(`app.ts:1606-1612`) — **the exact same `dispatchMessagingInbound` /
`buildMessagingInboundEnvelope` path §3 documents for WhatsApp/Telegram**,
just with `channel: "sms"`. Same envelope shape, same
`X-Agentpush-Signature` HMAC on the notify POST, same at-least-once
delivery semantics. No new parsing code needed beyond accepting the
channel value — `parseAgentpushWebhook` (`src/channels/agentpush/inbound.ts`)
now treats `"sms"` as a third valid messenger channel alongside
`"whatsapp"`/`"telegram"`.

### 9.4 No MMS — media is unimplemented for this driver, not merely unproven

`TwilioProvider.capabilities.media` is hardcoded `false`
(`twilio.provider.ts:41-54`), and the class defines neither
`uploadMediaFromBuffer` nor `uploadMediaFromUrl` — grepped the whole file,
zero hits. This isn't "MMS might work, unverified" the way Telegram's media
gap was framed in §2 — it's the driver's own capability flag disproving it.
`AgentpushTransport.sendMedia` for `"sms"` is therefore unconditionally
caption-only, same code path as Telegram (§2), for a stronger reason: the
source doesn't just lack a working upload method, it actively declares
`media: false`.

### 9.5 Join link — `sms:` URI, no agentpush involvement

Unlike WhatsApp/Telegram's `wa.me`/`t.me` deep links (which round-trip
through agentpush or the provider's own app), the SMS join link is a bare
`sms:` URI the phone's own Messages app opens directly — agentpush is
irrelevant to *joining*, only to messages sent *after* joining. Format:
`sms:+<number>?&body=<url-encoded "join RDV-XXXX">` — the `?&body=` form
(question mark immediately followed by `&`) is the one shape that prefills
the body on both iOS and Android; `?body=` alone is Android-only and iOS
silently drops the body. Driven by `RDV_SMS_NUMBER` (env.ts), validated
identically to `RDV_WHATSAPP_NUMBER` (E.164 digits, optional leading `+`
stripped).

### 9.6 What the service executor needs to wire

- `CompositeTransport` (or wherever transports are routed by
  `member.address.provider`) needs `"sms"` added alongside
  `"whatsapp"`/`"telegram"` to route through the same `AgentpushTransport`
  instance — no new transport class, `AgentpushTransport` already handles
  all three.
- The `joinLinks(...)` call site needs `smsNumber: env.smsNumber` added to
  its options so the `sms` field gets populated.
