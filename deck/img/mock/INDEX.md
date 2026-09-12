# Mock asset index

All HTML sources live in `deck/mocks/` and share `deck/mocks/shared.css` for
phone/browser/terminal chrome. Every PNG here was rendered from that HTML by
headless Chrome (`--screenshot`, `--force-device-scale-factor=2` unless noted),
never by an image model — the only image-model outputs in this set are the two
avatars and the villa photo, called out below. Room code `RDV-7F3K`, bot handle
`@Agentpush_agentik_bot`, public host `rdv.clipgen.co` are consistent across
every asset.

## Cast portraits (OpenAI gpt-image-1)

- `avatar-julie.png` — Julie, square 1024×1024 Pixar-style portrait, brown bob,
  mustard sweater. Matches the cast established in `p2-two-phones.png` etc.
  For a cast/people slide, not consumed by the chat mocks (those show the bot,
  not a human, as the 1:1 contact).
- `avatar-tom.png` — Tom, square 1024×1024, dark hair, stubble, teal shirt.
- `villa-photo.png` — Basque-country surf villa, cropped to a 4:3 chat-bubble
  photo. Embedded in `tg-conflict.png`, `wa-julie-conflict.png`,
  `tg-tom-conflict.html`, `deliverable-gate.png`, and the artifact document.

## Deck assets (in storyboard order)

1. **`tg-join.png`** — Telegram, Tom's phone. He texts `new`; the bot replies
   with the room code, join link, and live artifact URL; a second bubble shows
   him forwarding the code to Julie. Deck page 4, "text a bot, you're in."

2. **`tg-tom-ask.png`** + **`tg-julie-ask.png`** — the opening-beat pair, same
   timestamp (10:02) on both. One agent asks Tom and Julie two different
   questions on two different phones at the same instant. Place side by side —
   this pair *is* the thesis.

3. **`tg-julie-attribution.png`** — Julie's phone. Tom's voice note arrives in
   HER thread, transcribed, carrying the `[Tom · messenger]` attribution badge
   above a waveform bubble. Proof the two threads are genuinely joined.

4. **`tg-conflict.png`** — the money shot. Julie's phone: Tom's villa photo
   (attributed, captioned), then the agent's conflict message held large:
   budget and calendar contradiction, addressed to both by name.

5. **`wa-julie-conflict.png`** — the identical conflict moment, rendered as
   WhatsApp (tan wallpaper, green header/accents, `#D9FDD3` outgoing bubbles)
   instead of Telegram. Same copy, different skin — shows the "works over
   Telegram, WhatsApp, SMS or email" claim rather than asserting it.

6. **`browser-room.png`** — `rdv.clipgen.co/r/RDV-7F3K` in browser chrome.
   Structurally mirrors the real `src/web/page.ts`: header with room code,
   live pill, agent status, member list with tier badges; left pane is the
   attributed transcript (including a closed `[[whisper to X]]` toggle,
   matching the real page's whisper-block parsing); right pane is the live
   artifact iframe. Footer input bar included for fidelity.

7. **`browser-artifact.png`** — the deliverable itself: the Ternwood-branded
   seminar document (`artifact-content.html`) in its own browser tab at
   `rdv.clipgen.co/r/RDV-7F3K/artifact/` (the stable per-room proxy path from
   `src/service/artifact-proxy.ts`, not the raw e2b URL). Programme, budget
   table, the "coût / personne — 460 €" line, villa hero photo.

8. **`deliverable-gate.png`** — Tom's Telegram. The send preview (recipient
   "Boss" — no real address shown, per the hard constraint — channel, subject,
   rendered document card) with the agent's line "Je n'envoie rien tant que
   l'un de vous ne confirme pas.", then Tom's `confirm PDF-X7PQ`, then the
   send acknowledgement. The human-control beat.

9. **`terminal-atlas.png`** — dark iTerm-style terminal. Reproduces exactly
   what `scripts/room-agent.ts` logs on startup (`room-agent: joining
   RDV-7F3K as Atlas (session sess_...)`) and nothing invented beyond that —
   the bridge is silent until a turn crosses it, so the prompt sits idle with
   a cursor. Carries the storyboard's permanent Atlas banner overlay.

10. **`frame-4up.png`** — the hero composite, 1920×1080, built by embedding the
    live mocks as scaled iframes (`frame-4up.html`), not photoshopped: Julie's
    phone (`tg-conflict.html`) left, Tom's mirrored view
    (`tg-tom-conflict.html`) right, center stack is `browser-room.html` over
    `terminal-atlas-band.html`, one shared clock overlaid top-center. Exact
    three-column geometry from `STORYBOARD.md`.

## Supporting sources (not standalone deliverables)

- `artifact-content.html` — the Ternwood seminar document, iframed into both
  `browser-artifact.html` and `browser-room.html`'s artifact pane.
- `tg-tom-conflict.html` — Tom's mirrored view of the money-shot conflict
  (his own outgoing photo, no attribution badge needed since it's his own
  thread), used only inside `frame-4up.html`.
- `terminal-atlas-band.html` — the same terminal content re-flowed at the
  1040×400 band size the storyboard's center-column geometry calls for.

## What I verified visually

Every PNG listed above was rendered and viewed. Fixed on inspection: the
artifact document's dead space (added a centered "page on canvas" layout so
the budget table and cost line are visible without scrolling), the room-web
badge/body layout (was running together on one line — real `page.ts` renders
the attribution badge as a block above the message, fixed to match), and the
gate's file-thumbnail metadata (was wrapping oddly — split into a flex column
so filename and page count each get their own line).

## What I could not fully verify

- Exact SF Pro / Telegram / WhatsApp font metrics — headless Chrome on this
  machine substitutes a system sans-serif close to SF Pro but not pixel
  identical. Reads as authentic at deck viewing size; would not survive a
  side-by-side pixel diff against a real screenshot.
- The Ternwood document uses Georgia/system-ui (the kit's own documented
  fallback stack) rather than fetching Fraunces/Inter from Google Fonts, to
  avoid a font-load race against the headless screenshot. Close in spirit,
  not the exact typeface.
