# Rendez-vous pitch deck

13 slides — 9-slide pitch arc (problem, consequence, solution, how we built
it, the product working, the designed call, work leaves the room, close)
plus a 4-slide appendix for Q&A. Every number is sourced from
`docs/REHEARSAL.md` or `docs/ARCHITECTURE.md` (see `SCRIPT.md` for the
speaker read and shot list).

Built with [canvakit](../../../products/agentik/agentik-studio/tools/canvakit/README.md).
`_design/` (the `agentik` / `agentik-dark` design kits) is copied into this
directory because `kit:` refs resolve relative to the CWD.

## Files

- `rendez-vous.canvakit.html` — the template
- `data.json` — the 13 slides' content
- `rendez-vous.pdf` — rendered output, light kit (13 pages)
- `out/rendez-vous-light.pdf`, `out/rendez-vous-dark.pdf` — both kits rendered
- `SCRIPT.md` — ~4 minute speaker script + shot list for the recording

## Render command

Pages render as 16:9 landscape slides (1920×1080 px = 1440×810 pt), set by
the template frontmatter:

```yaml
page:
  size: "1920px 1080px"
  margin: "0"
```

From this directory:

```sh
node /Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/projects/openagentik/canvakit/packages/cli/dist/index.js \
  export rendez-vous.canvakit.html --format pdf --fonts embed \
  --design kit:agentik \
  --output out/rendez-vous-light.pdf

node /Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/projects/openagentik/canvakit/packages/cli/dist/index.js \
  export rendez-vous.canvakit.html --format pdf --fonts embed \
  --design kit:agentik-dark \
  --output out/rendez-vous-dark.pdf
```

`rendez-vous.pdf` at the top level is a copy of the light render, kept for
whatever pulls that path directly (e.g. the deliverable-flow send).

## Notes on content sourcing

- Slides 1–9 are the pitch arc: problem → consequence → solution → the
  product working (Run 3, real Telegram + web) → how it's built → the
  credential design → the deliverable flow → close. Slides 10–13 are
  appendix, each headed "Appendix", held for Q&A.
- Slide 5 ("The product working") is Run 3's real Telegram + web session,
  reframed as an observed product fact, not a test report: real phone,
  cold boot at 86.5s, a second member from the laptop, attribution on
  every message, the agent finding and editing the artifact unaided,
  delivery confirmed on the phone (`docs/REHEARSAL.md`, "Run 3 — real
  Telegram + web: COMPLETED live").
- Slide 8 ("Work leaves the room") keeps the substance of the deliverable
  flow (`docs/DELIVERABLE.md`): preview, explicit member confirm, PDF to
  messenger and mail, every send in the transcript. Caption reflects
  `docs/REHEARSAL.md`'s "Deliverable flow, first real exercise": the code
  is done and tested, but the first real send went by a one-off script,
  not the room's own `send pdf to`/`confirm` flow — update the caption
  once that's exercised live.
- Appendix slide 10 (the five findings) orders the liveness-by-existence
  bug first — it's `docs/UPSTREAM.md` finding 9, found live on a real
  phone during the Run 3 continuation — then the other four in the order
  they were found: `queue: true`, the resume cursor, account-pinned
  routes, and broker-blind planning (the Gmail rebuild proposal).
- Appendix slide 11 (honest limits) sources the resume-after-kill status
  from `docs/REHEARSAL.md`'s Run 3 continuation, "Step 3 — resume-after-
  kill: FAILED, root cause identified" — the fix has since landed
  (`4e73786`) but a fresh re-proof on a phone is still pending; the
  paused-sandbox expiry and the dead-artifact-link risk are
  `docs/ARCHITECTURE.md` §9.3b, confirmed live when box
  `i7jos61ixgkcfrekmi1vl` expired mid-rehearsal; the routing risk is
  `docs/AGENTPUSH.md` ("Do not pin a route to a bot account") plus
  `docs/WORKSPACE-OPTION.md` (the demo runs on the shared `default`
  workspace).
- Appendix slide 12 (the codex verdict) reflects `docs/CODEX-FLIP.md`'s
  verdict: the one-parameter claim does not hold as stated — a fresh box
  has no codex credentials, `installAdapters` installs the binary not the
  login, and the tested boot failed at the auth gate before the
  mechanical swap could be observed. Framed as the credential model
  (architecture.md §9.3, device-auth) being the real second-brain work,
  not the adapter swap.
- Appendix slide 13 (the middleman arc) is operator-specified directly, no
  doc anchor yet beyond `docs/ARCHITECTURE.md` §2.5 and `docs/MIDDLEMAN.md`.
  Marked "specced, not yet built" on-slide.
- No slide required an "ASK" placeholder — every number traced to
  `docs/REHEARSAL.md` or `docs/ARCHITECTURE.md`.
