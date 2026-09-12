# Demo day checklist

In order. `docs/RUNBOOK.md` has the full detail behind every command here;
`docs/AGENTPUSH.md` §3/§8 has the webhook contract; `docs/ARTIFACT.md` has
the sandbox seeding strategy.

## Deploy picture

**Runs locally on this Mac:** the agentproto daemon (18790), the Rendez-vous
service itself (`node src/cli.ts serve`, port 8790), and a cloudflared
tunnel in front of it. **The Rendez-vous service is not deployed anywhere
else** — it only ever runs on whichever machine executes this checklist.

**Deployed to a server:** agentpush prod, on Cloud Run — `api` and `worker`
at HEAD as of 2026-09-12, base URL `https://api.agentpush.io`. `responder`
and `web` were **not** redeployed: a dirty-tree guard blocked that deploy.
`worker`'s own health check returns 404, and did so before this deploy too
— unsure whether that 404 is expected (a route that simply isn't mounted) or
a real regression; not independently re-verified against the live service
for this checklist.

**Provisioned as of Run 3 (2026-09-12):** the demo runs on the **existing
connected agentpush workspace, on Telegram** — a real bot, a real API key
in the gitignored `.env.local`, and inbound routes pointing at
`https://rdv.clipgen.co`. **Not provisioned:** WhatsApp and SMS — no
WhatsApp number, no Twilio number. **Email:** unconfirmed as of this
writing whether a mailbox is connected to the workspace; treat it as a
slide, not a live tier, until that's confirmed cheap to add (see the email
subsection below) — no rehearsal time was spent on it.

**Must be up before the first message can be sent:** the agentproto daemon
and the Rendez-vous service, always. The tunnel, whenever a real channel
(Telegram, via agentpush) is being used — a tier-3-only rehearsal against
`127.0.0.1:8790` directly needs no tunnel. An e2b account (env var
`E2B_API_KEY`), only if `RDV_BOOTER=e2b` — otherwise `LocalBooter` needs
none of it, at the cost of no sandbox and no artifact.

## Why Telegram + laptop is the full thesis

The pitch was never "every channel" — it's several *humans*, on the
surfaces they already live in, driving one session and one artifact
together (architecture.md §1.3). Telegram plus the laptop room-web view is
already **two real, distinct surfaces** — a phone app the operator already
has installed, and a browser tab — reachable with **zero extra
provisioning** beyond what agentpush already had connected. The room itself
doesn't know or care which channel a member is on; it's channel-agnostic by
construction (`Member.tier` is `messenger | email | room-web`, and
`messenger` covers WhatsApp and Telegram identically). That's the line worth
saying on stage: not "we didn't get WhatsApp working," but "the room doesn't
care which surface you're on — here it is on two of them at once, and adding
a third is a config change, not new code."

### Email tier

The provisioning executor's report on whether a mailbox is connected to the
agentpush workspace didn't arrive before this rehearsal closed. Per the
operator's own instruction: absent that confirmation, **email stays a
slide**, described from architecture.md §4.2 R11 and docs/AGENTPUSH.md §8,
not demoed live. If it later turns out a mailbox is connected and cheap to
wire in, the addition is: point `RDV_EMAIL_WEBHOOK_SECRET` at a real route
and rehearse one more member joining by replying to a room's digest email
— not attempted here.

## 1. Pre-warm one e2b box

```
node scripts/prove-sandbox.ts
```
Proves boot/artifact/resume end to end and leaves its final box **paused**.
Copy the sandbox id it prints into `RDV_PREWARM_SANDBOX_ID` (RUNBOOK.md §3)
— the first `new` of the day reuses it instead of paying for a fresh boot.

**Paused boxes expire on e2b's side within roughly 20–60 minutes**, even
though the local room/ledger state still shows them `paused` — both boxes
pre-warmed earlier today came back `"Paused sandbox not found"` on reconnect
despite that. So: run this step **no earlier than 10 minutes before going on
stage**, and never trust `agentproto sandbox list` (or the local ledger) as
a liveness check — it only reflects what we last recorded, not what e2b
still has. If the pre-warm box is gone, `new` just boots a fresh one instead
(about 40s) — annoying, not fatal; don't stall the demo trying to diagnose
it live.

## 2. Confirm the daemon

```
curl -s http://127.0.0.1:18790/health
```
Must answer before anything else. If it doesn't, fix the daemon first —
nothing downstream will work.

## 3. Start the tunnel

**Use the named tunnel — not `--quick`.** A quick tunnel mints a fresh
random `*.trycloudflare.com` hostname on every run, which silently
invalidates any join link or QR already sent (architecture.md §9.3b); what
gets rehearsed has to be what gets demoed. A dedicated tunnel now exists for
this: `rendez-vous`, routing `rdv.clipgen.co` → `http://127.0.0.1:8790`
(`~/.cloudflared/rendez-vous.yml`; DNS routed once via `cloudflared tunnel
route dns --overwrite-dns <tunnel-uuid> rdv.clipgen.co` — pass the tunnel's
UUID to `route dns`, not its name, on this machine's cloudflared build,
which resolves a name argument against the wrong tunnel; docs/REHEARSAL.md
has the full story). Start it with:

```
scripts/tunnel.sh --named rendez-vous
```

It prints `RDV_PUBLIC_URL=https://rdv.clipgen.co` immediately (no need to
watch for a hostname to appear) — export it in another shell:
```
export RDV_PUBLIC_URL=https://rdv.clipgen.co
```
Prove it once the service is up: `curl -s https://rdv.clipgen.co/health`.
Stop the tunnel at the end of every session; don't leave it running.

The other named tunnels on this machine (`postiz`, `guilde`, `llm-endpoint`,
`local-3000`, `agentproto-local`) point at other services — leave them
alone.

## 4. `.env.local` values

No dotenv loader in this repo — export these in the shell that runs `serve`
(or `set -a; source .env.local; set +a` first). RUNBOOK.md §1 explains
every one:

- `RDV_DAEMON_URL`, `RDV_DAEMON_TOKEN` (if the daemon runs in bearer mode)
- `RDV_PUBLIC_URL` (from step 3)
- `RDV_AGENTPUSH_URL`, `RDV_AGENTPUSH_KEY` (docs/AGENTPUSH.md §4, §7)
- `RDV_AGENTPUSH_WEBHOOK_SECRET`, `RDV_EMAIL_WEBHOOK_SECRET` (docs/AGENTPUSH.md §7, §8.4)
- `RDV_WHATSAPP_NUMBER`, `RDV_TELEGRAM_BOT` (join links)
- `RDV_BOOTER=e2b`, `RDV_PREWARM_SANDBOX_ID` (from step 1)

## 5. Create the two agentpush inbound routes

Messaging (WhatsApp/Telegram), from docs/AGENTPUSH.md §3:
```
curl -s -X POST "$RDV_AGENTPUSH_URL/tools/inbound_route_create" \
  -H "Authorization: Bearer $RDV_AGENTPUSH_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "rendez-vous", "channel": null, "match_type": "catch_all",
    "dispatch_tag": "rendez-vous", "dispatch_mode": "notify",
    "notify_url": "'"$RDV_PUBLIC_URL"'/inbound/agentpush",
    "notify_secret": "'"$RDV_AGENTPUSH_WEBHOOK_SECRET"'"
  }'
```
Mail, from docs/AGENTPUSH.md §8.3:
```
curl -s -X POST "$RDV_AGENTPUSH_URL/tools/inbound_route_create" \
  -H "Authorization: Bearer $RDV_AGENTPUSH_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "rendez-vous-mail", "channel": "mail", "match_type": "catch_all",
    "dispatch_tag": "rendez-vous-mail", "dispatch_mode": "notify",
    "notify_url": "'"$RDV_PUBLIC_URL"'/inbound/agentpush-mail",
    "notify_secret": "'"$RDV_EMAIL_WEBHOOK_SECRET"'"
  }'
```
`POST /inbound/agentpush-mail` is wired into `src/service/http.ts`
(docs/AGENTPUSH.md §8.5): it calls `parseEmailInbound`, shares the same
`MessageDedup` as the messenger webhook, and — when the subject carries a
room code and the sender isn't yet a member of any room — joins that room
before fanning the message in as a tier-2 turn. Sanity check on the day with
`curl -s $RDV_PUBLIC_URL/inbound/agentpush-mail` (expect a 400 for an empty
body, not a 404); a 404 means the tunnel or route is misconfigured, not that
the route is missing.

## 6. Start the service

```
node src/cli.ts serve
```

## 7. Smoke test

```
curl -s http://127.0.0.1:8790/health
```
Then a signed simulated webhook (RUNBOOK.md §2, same recipe, real values):
```
BODY='{"channel":"whatsapp","from":"+15550001111","text":"new","messageId":"smoke-1","displayName":"Smoke Test"}'
SIG="sha256=$(node -e 'const c=require("crypto");process.stdout.write(c.createHmac("sha256",process.argv[1]).update(process.argv[2]).digest("hex"))' "$RDV_AGENTPUSH_WEBHOOK_SECRET" "$BODY")"
curl -s -X POST http://127.0.0.1:8790/inbound/agentpush \
  -H "content-type: application/json" -H "x-agentpush-signature: $SIG" -d "$BODY"
```
A `room.code` in the reply means fan-in, session spawn, and (if
`RDV_BOOTER=e2b`) the sandbox/artifact path all work end to end.

## 8. The on-stage script

1. Alice (the operator) sends `new` on Telegram.
2. Bob (the laptop) opens `https://rdv.clipgen.co/r/RDV-XXXX` — the room web
   view — either from the code Alice reports back or by scanning the QR on
   that page to hand a second phone the link (architecture.md §5.3).
3. Alice and Bob argue about what the agent should build, at the same time
   — Alice on Telegram, Bob typing in the room's send box.
4. The laptop shows the live transcript and the artifact `<iframe>` update
   as they go.

## 9. Recovery moves

- **Room paused** (idle sweep, RUNBOOK.md §3) → any message from a known
  member resumes it automatically; nothing to do by hand.
- **Daemon restarted** → have anyone send `resume <code>` on any tier; the
  room reconnects the sandbox and re-probes the artifact (R8).
- **Tunnel died** → rerun `scripts/tunnel.sh --named rendez-vous`. The
  hostname (`rdv.clipgen.co`) is stable across restarts, so `RDV_PUBLIC_URL`
  and the agentpush routes from step 5 stay valid — no re-export, no rerun.

### Fallback if Telegram fails on the day

Simulated channels via `POST /inbound/simulated` are an acceptable
**fallback only** — not a first choice, and not something to reach for just
because the network is flaky for a few seconds. Switch only if Telegram is
genuinely down (bot unresponsive, agentpush outage) and the demo can't wait.

```
curl -s $RDV_PUBLIC_URL/inbound/simulated \
  -H 'content-type: application/json' \
  -d '{"provider":"telegram","source":"agentpush","contactRef":"+operator-phone",
       "displayName":"Alice","tier":"messenger","text":"new"}'
```
Use `displayName: "Alice"` for the operator's own turn and keep `Bob` for
whoever is on the laptop room view, same as the real run — don't invent new
names mid-demo, it breaks the roster continuity on screen.

**What to say on stage:** name it plainly — *"Telegram's not cooperating
right now, so I'm going to prove the same round trip by injecting the
message directly at the layer our webhook would otherwise call — the room
itself doesn't know the difference."* That's honest and still lands the
point (§ "Why Telegram + laptop is the full thesis" above): the room is
channel-agnostic, so the fallback IS the proof, not an apology.

## 10. Venue network

Two SIMs and a hotspot (architecture.md §7) — venue Wi-Fi is not a plan.
Confirm the hotspot is up and the laptop is on it before step 3.
