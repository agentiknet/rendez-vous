# Multimodal — normalize at ingress, fan out by fidelity

Status: spec only. No code in this document is built.

## The principle

Multimodal is not a new axis for Rendez-vous. It is the fidelity ladder (`docs/ARCHITECTURE.md` §2.1)
already in the architecture, extended: not just *how much* of the transcript a tier sees, but *which
encoding*.

A voice note or photo is converted to text plus a durable media reference **at the room service, before
anything is enqueued.** The session's prompt queue stays text-only, forever. Four reasons:

1. **`queue: true` losslessness is a property of the existing text path** (§5.1, §4.2 R3). A second binary
   path into the session is a second chance to drop a message silently — `docs/UPSTREAM.md`'s "The
   pattern": a plausible config, checked by nothing, routed around with no error anywhere. One ingestion
   path stays the only path.
2. **STT/vision credentials stay at the service**, never enter the box — consistent with §9.3 ("Tool
   grants belong to the room"): a capability granted to the room is granted to every member, so
   transcription keys are workspace-scoped service config, not a sandbox-reachable secret.
3. **Attribution stays uniform**: `[Alice · whatsapp · voice] "..."` — same shape whether Alice typed or
   spoke, so R2's attribution never grows a media-shaped special case.
4. **SSE transcript must replay for late joiners** (§5.2, `since=0`). Text replays over
   `GET /sessions/:id/events/stream`; audio cannot. Normalizing to text at ingress is what makes replay
   work at all.

The agent can still fetch the original bytes by reference when it genuinely needs pixels. Never discard
the source: the media reference is retained alongside the text forever, so a transcription error stays
recoverable, not lost — the transcript text is canonical, the media is its provenance. Outbound is
symmetric: the transcript stays canonical text, and each tier renders it at its own fidelity — a voice
reply is a TTS rendering of that record, not a separate message.

## Ingress pipeline

```
webhook (agentpush notify, docs/AGENTPUSH.md §3)
  → media in envelope? (`media: [{ type, url, mimeType, size }]`)
  → fetch bytes by reference (the URL the envelope already carries)
  → STT (voice) or vision caption (image), at the service
  → text = "[" + displayName + " · " + tier + " · " + kind + "] " + transcript_or_caption + "  media:" + mediaId
  → store MediaRecord on the room, next to `cursor` (src/rooms/types.ts:19-40)
  → existing fan-in: POST /sessions/{sessionId}/prompt?wait=false { prompt: text, queue: true, origin: "rdv:" + member.id }
```

`text` stays a plain string, `queue: true` unchanged — the new work sits strictly before that call, never
inside the session's prompt path.

**Stored media record**, appended next to the room's `cursor` (`src/rooms/types.ts:19-40`, `src/rooms/store.ts`):

```ts
interface MediaRecord {
  mediaId: string
  kind: "voice" | "image"
  source: string                   // agentpush media URL, or provider ref
  mime: string
  transcript: string | undefined   // voice
  caption: string | undefined      // image
  confidence: number | undefined
  receivedAt: string
}
```

Never overwritten or pruned on retry: a redelivered webhook (at-least-once, `docs/AGENTPUSH.md` §3) is
caught by the existing `MessageDedup` on `messageId` (`src/channels/agentpush/inbound.ts`) before it
produces a second record for the same message.

## Transcript convention

```
[Alice · whatsapp · voice] "let's ship the blue version"  media:m_8f21
[Bob · telegram · image] "screenshot of the error"  media:m_a034
```

`media:<id>` is plain text in the prompt, not a structured field — the session and `text-delta`
accumulation already treat content as opaque strings, so nothing new is needed from the daemon. The web
view (tier 3) is the one consumer that resolves `media:<id>` to a player or thumbnail via the room's
stored `MediaRecord[]`.

## Agent access to source bytes

`GET /r/:code/media/:id` — a service route, scoped like §9.3b's artifact proxy (`GET /r/:code/artifact/*`):
looks up the record, reverse-proxies the bytes. Never a raw agentpush/provider URL — stable, gateable, no
ephemeral upstream URL leaking into a thread or tool call.

Whether the model can *see* those bytes (true vision, not a caption) depends on the runtime adapter, not
on Rendez-vous: **claude-code adapter** and **codex adapter** are both unverified from this repo — not
confirmed whether the ACP transport (§9.3A) carries image content blocks end to end for either. Until
verified: the agent reasons over the ingress caption, and reaches for the media route only with an
explicit image-capable tool. State "unverified," never assume.

## Egress per tier

| Tier | Text | TTS audio |
| --- | --- | --- |
| WhatsApp | yes | yes — `upload_media` then `send_message` with `content.media[{type:"audio",providerMediaId}]`, same flow §2 uses for images |
| Telegram | yes | URL-only, no buffer upload for this driver — needs the clip hosted publicly; our own `/r/:code/media/:id` route is that URL once stored, else text-only (§2's PNG fallback) |
| SMS | yes | never — `TwilioProvider.capabilities.media` is hardcoded `false` (§9.4) |
| email | yes | not built — text digest only, per R11 |
| room-web | yes (live) | yes — inline audio player resolving `media:<id>` |

## The fidelity ladder, extended

| Tier | In | Out | In fidelity | Out fidelity |
| --- | --- | --- | --- | --- |
| 1 messenger | text, or voice/photo normalized at ingress | reply text + artifact URL | text always; media never reaches the session as binary | text; TTS where upload is supported (WhatsApp; Telegram if hosted); never SMS |
| 2 email | reply-thread text | digest + link | text only, no inbound media tier yet | text only |
| 3 room-web | turns, permission answers | full transcript + live artifact | text, plus media resolvable via `media:<id>` | text, plus inline audio per turn |

## Credentials

STT/vision/TTS credentials live at the service, via env, names only — never forwarded into the sandbox.
Same placement as `RDV_AGENTPUSH_KEY`/`RDV_AGENTPUSH_WEBHOOK_SECRET` (`docs/AGENTPUSH.md` §7): add
`RDV_STT_*`/`RDV_VISION_*`/`RDV_TTS_*` names alongside them, never a new secret path.

## Failure modes stay visible

STT/vision failure at ingress must never silently drop the turn — `docs/UPSTREAM.md`'s "The pattern,"
exactly. Instead the enqueued text becomes `[Alice · whatsapp · voice] (voice note, transcription failed,
media:m_8f21)` — still `queue: true`, still attributed, still replayable, `MediaRecord` kept regardless.
Same shape for a vision failure. Never skip the enqueue, never discard the `MediaRecord`.

## Implementation plan

Explicitly after: the deck, the resume test, leave/switch, and whisper — per the frozen build priority.
Rough sizes, in order:

1. **`MediaRecord` on `Room`** (S) — extend `src/rooms/types.ts`, persist alongside `cursor` in `src/rooms/store.ts`.
2. **Ingress normalization** (M) — new module beside `src/channels/agentpush/inbound.ts`: fetch `media[].url`, call STT/vision, build attributed text, call existing fan-in.
3. **`GET /r/:code/media/:id` proxy** (S) — same shape as §9.3b's artifact proxy, room-scoped, reverse-proxy only.
4. **Egress TTS rendering** (M) — extend `src/fanout/render.ts`'s per-tier renderers to attach a TTS `MediaRecord` where upload is supported.
5. **Web view media resolver** (S) — resolve `media:<id>` to a player or thumbnail in the transcript view.
6. **Failure-mode + retention check** (XS) — verify the failure path never drops the enqueue, and the `MediaRecord` always survives it.
