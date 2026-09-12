# A fresh agentpush workspace — costed, not executed

Cost estimate for a brand-new agentpush workspace dedicated to Rendez-vous,
instead of the `default` workspace the demo runs on today (`docs/DEMO.md`'s
"Deploy picture"). **Nothing below was run** — no workspace, provider
account, key, or route was created in prod. Anchors are read from the
agentpush source checkout, not exercised against the live deployment.

## 1. Create the workspace — needs a human with a login, ~1 min

`POST /api/workspace/workspaces` (`apps/web/src/app/api/workspace/workspaces/route.ts`)
is gated on `getAuthenticatedUser()` — a signed-in Supabase session, not a
workspace API key — and capped at `MAX_WORKSPACES_PER_USER = 10`
(`apps/web/src/lib/auth/provisioning.ts:324`). No `X-Internal-Key` path
around this: whoever already has a login to the agentpush web app has to
click "create workspace" (or call the route with their own session cookie).
Our service, holding only a workspace-scoped API key, can't do this step.

## 2. Connect a Telegram bot — ~5 min, needs a BotFather token

Get a token from @BotFather (~2 min). Then `POST /provider-accounts`
(`apps/api/src/app.ts:2552`, `{"provider":"telegram","credentials":{"token":...}}`,
draft account) → `POST /provider-accounts/:id/validate`
(`apps/api/src/app.ts:2790`, telegram branch `~2855-2868`, persists the
token and flips `status: "ready"`) → `POST /provider-accounts/:id/webhook/register`
(`apps/api/src/app.ts:2899`, telegram case `~3004-3022`, calls Telegram's
`setWebhook` at `<base>/inbound/telegram/<token>`). Same three steps as a
form at `apps/web/src/app/(app)/providers/page.tsx`, for clicking instead.

## 3. Optionally connect Gmail — ~3 min, or skip and drop to two tiers

`GET /oauth/gmail/start` (`apps/api/src/app.ts:3497`) redirects through
Google's consent screen; `GET /oauth/gmail/callback`
(`apps/api/src/app.ts:3574`) persists the tokens, redirecting back to
`?gmail=connected` (`.../ProviderAccountsClient.tsx:219`). Needs a Gmail
account someone will authorize for the workspace — not mintable from a
script. **Skip it and the demo is honestly two tiers** (messenger +
room-web), the same "email stays a slide" posture `docs/DEMO.md` documents
for `default`.

## 4. Mint a key — ~1 min, needs the deployment secret

`POST /admin/api-keys` (docs/AGENTPUSH.md §4, `apps/api/src/app.ts:1905-1941`)
is gated on `X-Internal-Key: <INTERNAL_SERVICE_KEY>` — the deployment's
shared admin secret, not a workspace login and not the key being minted.
Whoever ran step 1 doesn't automatically hold this — typically whoever
deploys/administers the Cloud Run service. `scopes: ["send-only"]` suffices.

## 5. Create the two inbound routes — ~1 min, unchanged shape

Identical `POST /tools/inbound_route_create` calls to the ones `docs/DEMO.md`
§5 already runs against `default` — `channel: "telegram"` for messaging,
`channel: "mail"` for Gmail (only if step 3 happened), same `notify_url`
shape. Only which workspace's key signs the request changes.

## 6. Update `.env.local` — ~1 min, names only

`RDV_AGENTPUSH_KEY` (new, step 4), `RDV_AGENTPUSH_WEBHOOK_SECRET` (new,
step 5's messaging `notify_secret`), `RDV_EMAIL_WEBHOOK_SECRET` (new, only
if step 3 happened), `RDV_TELEGRAM_BOT` (new bot's handle, for join links).
`RDV_AGENTPUSH_URL` is unchanged — same deployed `apps/api` instance, just a
different workspace scoped by the new key.

## Total and the trade-off

**~10-12 minutes, gated on four different humans being reachable at once:**
an agentpush login (step 1), a phone for BotFather (step 2), optionally
someone willing to authorize Gmail (step 3), and whoever holds
`INTERNAL_SERVICE_KEY` (step 4). Any one missing stalls the whole path.

**Versus staying on `default` and flipping the responder route:** editing
the existing workspace's "telegram → responder" catch-all to notify our
webhook instead is one API call, zero new accounts — but it repoints a
route something else already depends on (`docs/AGENTPUSH.md`'s "Do not pin
a route to a bot account"), so whatever `responder` was doing off that
route stops the moment we flip it, and we're back to sharing one bot
identity instead of owning one. A fresh workspace costs ~10 minutes and
four approvals; flipping the existing route costs one API call and someone
else's feature.
