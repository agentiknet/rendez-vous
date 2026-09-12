# Rendez-vous pitch deck

11 slides, dark kit, one idea per slide. Every number is sourced from
`docs/REHEARSAL.md` or `docs/ARCHITECTURE.md` (see `SCRIPT.md` for the
speaker read and shot list).

Built with [canvakit](../../../products/agentik/agentik-studio/tools/canvakit/README.md).
`_design/` (the `agentik` / `agentik-dark` design kits) is copied into this
directory because `kit:` refs resolve relative to the CWD.

## Files

- `rendez-vous.canvakit.html` — the template
- `data.json` — the 11 slides' content
- `rendez-vous.pdf` — rendered output (11 pages)
- `SCRIPT.md` — ~4 minute speaker script + shot list for the recording

## Render command

From this directory:

```sh
node /Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/projects/openagentik/canvakit/packages/cli/dist/index.js \
  export rendez-vous.canvakit.html --format pdf --fonts embed \
  --design kit:agentik-dark \
  --output rendez-vous.pdf
```

## Notes on content sourcing

- Slide 8 ("Second brain is a parameter") is marked pending on-slide —
  `docs/CODEX-FLIP.md` does not exist yet. If it lands, replace the slide's
  caption with its verdict verbatim and drop the "pending" framing.
- Slide 10's "responder double reply" risk is sourced from
  `docs/AGENTPUSH.md` ("Do not pin a route to a bot account" — routes
  evaluate independently, not first-match-wins) and `docs/WORKSPACE-OPTION.md`
  (the demo runs on the shared `default` workspace, not a dedicated one).
- No slide required an "ASK" placeholder — every number traced to
  `docs/REHEARSAL.md` or `docs/ARCHITECTURE.md`.
- Slide 6's fifth finding (the liveness check reading `res.ok` instead of
  `status`) is sourced from `src/service/daemon-extra.ts`'s own doc comment
  on `isSessionAlive`, operator-reported as found live on a real phone
  during the Run 3 continuation; not yet written up in `docs/UPSTREAM.md`.
- Slide 10's dead-artifact-link line (box `i7jos61ixgkcfrekmi1vl` expiring
  mid-rehearsal) is operator-reported, confirming the risk
  `docs/ARCHITECTURE.md` §9.3b predicted. As of this render,
  `docs/REHEARSAL.md`'s Run 3 continuation is still marked "WAITING" on the
  resume-after-kill check, so the slide and script call the fix "fixed
  after rehearsal, re-proof pending" rather than claiming it's verified —
  update that framing once `docs/REHEARSAL.md` records a completed re-test.
