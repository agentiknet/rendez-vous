# Deliverable — render, preview, confirm, send

The demo's closing beat: in the room, a member asks the agent to build
something; they open the artifact URL and review it; they ask for a PDF; the
PDF is sent both to their own messenger and, separately, by email to a client
who is **not** a member of the room.

## Why a confirm gate

Sending to a non-member is an outbound action with a real-world consequence:
without a gate, any member could email an arbitrary third party under the
room's own agentpush identity. So nothing sends silently. A request — from
the agent's own reply, or a member typing a command — always produces a
**preview**, posted to every current member, naming the recipient, channel,
subject, page count, a link to the rendered PDF, and a confirmation token.
The send happens only on an explicit `confirm <token>` from any current
member (any tier); `cancel <token>` discards it. A pending preview expires
30 minutes after it was requested.

## The two ways to request one

**The agent's own reply text**, a convention mirroring
`docs/WHISPER.md` (never a tool call — the room agent has no channel
credentials, architecture.md §9.3):

```
[[deliver]]
to: messenger self
subject: Q3 roadmap deck
artifact: pdf
[[/deliver]]
```

`to` is either the literal `messenger self` (every current messenger-tier
member of the room) or an email address. `artifact` is currently always
`pdf` — the only artifact type this flow renders.

**A member command**, any tier (messenger, email, or room-web):

```
send pdf to me
send pdf to alice@client.com
confirm PDF-7F3K
cancel PDF-7F3K
```

`me`/`self`/`myself` resolves to the sender's own address and requires their
own tier to actually be `messenger` — a room-web member asking to deliver to
"me" has no messenger address to send to, and is told so rather than
silently doing nothing.

A **current member's display name** also works — `send pdf to Bob` resolves
to Bob's own address (his messenger contact, or his contact ref as a mail
target when his tier is `email`), matched case-insensitively against the
room's current roster. It never reaches a non-member: an unknown name is
refused with a visible line, two members sharing a name are refused
(ambiguity is never guessed — use an exact address), and a room-web member
has no deliverable address and is told so.

## The delivery allowlist

The operator hard limit (docs/STATE.md): `RDV_DELIVERY_ALLOWLIST` — a
comma-separated list of email addresses and messenger contact refs. When
set, `DeliverableService` refuses any resolved target whose address (the
email address, or the member's contact ref) is not on the list — at request
time, before any render, before a token even exists to confirm. The refusal
is posted into the room's transcript and nothing is rendered or stored.
When unset, every target is allowed and a loud warning is logged at
construction; `confirm` is still required either way.

## Persistence: a pending delivery survives a restart

Each pending delivery is persisted on the room record
(`Room.pendingDeliveries` in `src/rooms/types.ts`, guarded and written
through `RoomStore.update`) — one record per target, fields `token`,
`requestedBy`, `target`, `subject`, `mediaId`, `pageCount`, `createdAt`,
`expiresAt`. On startup `DeliverableService` hydrates them back from the
store and **sweeps the expired ones** with the usual
`[system · delivery] ... expired before anyone confirmed it.` transcript
line — a token that expired before the restart can never become
confirmable again. Confirm and cancel remove the record from the room.

One wrinkle, handled: the `MediaStore`'s index is in-memory, so after a
restart the stored PDF is no longer indexed even though the file is on
disk. If a confirmed delivery's PDF can no longer be read but the room's
raw artifact URL is still set, `confirm` re-renders the PDF from the live
artifact and sends that (noted in the transcript) rather than failing the
send.

## Why this never touches `src/fanout`

The agent-authored `[[deliver]]` block arrives as part of an ordinary
agent turn, flushed by `RoomFanout` on `turn-end` and handed to whichever
`Transport` `RoomService` gave it. Rather than editing that module,
`RoomService` wraps the `Transport` it hands to `RoomFanout` in
`DeliverableAwareTransport` (`src/service/deliverable.ts`) — the same
dependency-injection seam `RoomFanout` already exposes. The wrapper scans
each member's rendered text for `[[deliver]] ... [[/deliver]]` blocks,
resolves the room via `RoomStore.findByAddress(member.address)`, and
replaces the block with the preview text every member ends up seeing. A
small in-flight map dedupes the N calls one flush makes (one per member)
down to a single render/store/token, relying on `Array.prototype.map`
starting each member's `send()` synchronously before any of them yield —
see the class's own doc comment.

The member command path (`send pdf to ...`/`confirm`/`cancel`) is simpler:
`RoomService.resolveDeliverableText` intercepts it directly in
`handleMessage`/`sendFromRoomWeb`, before the ordinary chat/fan-in path, and
broadcasts the result to every member.

## Rendering: HTML in, PDF out, no new primitive

The room's artifact app is plain HTML (`apps/room-artifact/.agentproto/ui/index.html`),
not a canvakit template. `src/service/pdf-render.ts`:

1. Fetches the room's `artifactUrl` (the raw one — this is the service
   rendering server-side, not a member's browser, so there's no reason to
   round-trip through the room-scoped artifact proxy).
2. Wraps the fetched HTML's `<body>` content and inline `<style>` blocks
   into a minimal single-slide canvakit template (`wrapAsCanvakitPage`).
   Deliberately does **not** force `.slide` to a `100vh` viewport height —
   verified live that doing so overflows a single natural-flow page onto a
   spurious second blank page under canvakit's `--plain` layout; the
   multi-slide deck convention (`width:100vw; min-height:100vh` on
   `.slide+.slide{break-before:page}` siblings) doesn't apply to a
   single-slide document.
3. Runs the same canvakit CLI `deck/README.md` documents:
   `node <RDV_CANVAKIT_CLI> export <template> --format pdf --plain --output <out>`.
   No new npm dependency — canvakit is invoked as an external process by
   absolute path.
4. Counts pages by matching `/\/Type\s*\/Page\b/g` against the raw PDF bytes
   (`\b` excludes `/Type /Pages`, the tree node, without excluding `/Type
   /Page` itself) — page objects are written as plain-text dictionaries even
   when content streams are Flate-compressed, verified against a real
   render rather than assumed.

## Storage and the media route

The rendered PDF is stored under the room by `src/service/media-store.ts`:
`RDV_MEDIA_DIR/<room code>/<media id>.pdf`, with an in-memory index (page
count, content type, byte length) rebuilt as saves happen. `GET
/r/:code/media/:id` (`src/service/http.ts`) serves it back — the link every
preview and every sent message points at.

## Sending: agentpush, one endpoint, three shapes

All sends go through `POST {RDV_AGENTPUSH_URL}/tools/*`
(docs/AGENTPUSH.md), via the shared `AgentpushToolClient`:

- **Messenger (WhatsApp)**: `upload_media` with `type: "document"` and an
  explicit `mimeType: "application/pdf"` — the known gotcha: without it,
  `upload_media`'s own type→mime default guess is not `application/pdf` for
  a document — then `send_message` with `content.media[].providerMediaId`.
- **Messenger (Telegram/SMS) fallback, and mail always**: `send_message`
  with `content.media[].url` pointing at the room's own public media route.
  Verified against agentpush's real `send_message`/`upload_media` zod
  schemas: mail specifically **rejects** `providerMediaId` (no provider
  media storage for mail) but accepts a plain `url` or inline base64 `data`,
  and needs no open session window the way WhatsApp/Telegram free text
  does.
- **Mail**: `send_message` with `to.channel: "mail"`, `content.subject`,
  and the PDF as `content.media[]` — same endpoint, same auth, just a
  different channel and no upload step.

## The transcript record

Every request, confirm, cancel, expiry, and failure is posted back into the
room's own daemon session as a `[system · delivery]` prompt
(`DeliverableService.postSystemNote`, via `queue: true` fan-in) — so it
lands in the daemon's canonical transcript, not just this process's memory.
Each note names who asked or confirmed, what was sent (media id via the
page count and token), to whom, and the provider message id on success or
the error on failure. When a room has no live session (paused, never
booted), the note is skipped with a console warning — the broadcast to
members and the on-disk media record still exist either way.

## Env

- `RDV_CANVAKIT_CLI` — absolute path to the canvakit CLI's built entrypoint.
  Defaults to the same absolute path `deck/README.md` documents on this host.
- `RDV_MEDIA_DIR` — directory rendered deliverables are stored under.
  Defaults to `.rdv/media`.

## Proving it without a phone

`test/service/deliverable.test.ts` drives the whole state machine against a
fake daemon (for the transcript audit note) and a fake agentpush server (for
the actual send): request produces a preview and sends nothing; confirm
sends via `upload_media`→`send_message` for a messenger target and via a
single `send_message` for a mail target; cancel and expiry send nothing; a
non-member's message never resolves to a `Member` in the first place, so it
never reaches `confirm` at all. `test/service/pdf-render.test.ts` runs the
real canvakit CLI against a small HTML fixture and asserts the PDF
signature, byte length, and page count.

The first **real** send — an actual WhatsApp/email delivery — needs the
room's operator to confirm from their own phone. If `.env.local` configures
a real `RDV_AGENTPUSH_URL`/`RDV_AGENTPUSH_KEY` and the service is live, the
operator types, in the room:

```
send pdf to me
confirm PDF-XXXX
send pdf to <client's email>
confirm PDF-YYYY
```

(the two tokens are whatever the two preview messages actually show — they
are random per request, not fixed strings).
