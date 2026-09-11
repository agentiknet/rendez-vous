# Demo day checklist

In order. `docs/RUNBOOK.md` has the full detail behind every command here;
`docs/AGENTPUSH.md` §3/§8 has the webhook contract; `docs/ARTIFACT.md` has
the sandbox seeding strategy.

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

Two named tunnels already exist on this machine (`~/.cloudflared/*.yml`),
but none of them point at Rendez-vous's port — they're `postiz`, `guilde`,
`llm-endpoint`, `local-3000`, and `agentproto-local` (the daemon itself, not
this service). Making a new named tunnel needs a DNS route this checklist
deliberately doesn't run. **Default to the quick tunnel**:

```
scripts/tunnel.sh --quick
```

Watch stderr for the `RDV_PUBLIC_URL=https://....trycloudflare.com` line
and export it in another shell:
```
export RDV_PUBLIC_URL=https://<the printed hostname>
```
Trade-off: zero setup, but the hostname is random per run — if the tunnel
dies mid-demo, restarting it means updating both agentpush routes (step 5)
with the new URL. If a stable hostname turns out to matter more than
zero-setup on the day, `scripts/tunnel.sh --named <name>` runs one of the
existing named tunnels instead — but none is currently pointed at this
service's port, so that requires reconfiguring one first (out of scope
here; not a `tunnel route dns` change, just editing that tunnel's own
ingress, which this script doesn't do for you).

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

1. Alice sends `new` on WhatsApp.
2. She scans the QR code shown on the laptop room page to hand Bob the link.
3. Bob joins from Telegram with `join RDV-XXXX`.
4. Alice and Bob argue about what the agent should build, at the same time.
5. The laptop shows the live transcript and the artifact `<iframe>` update
   as they go.

## 9. Recovery moves

- **Room paused** (idle sweep, RUNBOOK.md §3) → any message from a known
  member resumes it automatically; nothing to do by hand.
- **Daemon restarted** → have anyone send `resume <code>` on any tier; the
  room reconnects the sandbox and re-probes the artifact (R8).
- **Tunnel died** → rerun `scripts/tunnel.sh --quick`, re-export
  `RDV_PUBLIC_URL`, and re-run step 5 for both routes (the hostname
  changed, so agentpush is still pointed at the dead one until updated).

## 10. Venue network

Two SIMs and a hotspot (architecture.md §7) — venue Wi-Fi is not a plan.
Confirm the hotspot is up and the laptop is on it before step 3.
