# Rendez-vous pitch deck

**6 pages**, plus 2 appendix pages held for Q&A and explicitly marked as not
part of the six. Written backwards from the closing line: page 6 is the claim,
pages 5 → 1 exist to make it unarguable by the time a judge reaches it.

Built with [canvakit](../../../products/agentik/agentik-studio/tools/canvakit/README.md).
`_design/` (the `agentik` / `agentik-dark` design kits) is copied into this
directory because `kit:` refs resolve relative to the CWD.

## Files

- `rendez-vous.canvakit.html` — the template
- `data.json` — the 6 pages + 2 appendix pages
- `rendez-vous.pdf` — rendered output, light kit
- `out/rendez-vous-light.pdf`, `out/rendez-vous-dark.pdf` — both kits
- `SCRIPT.md` — speaker read (~2:30) + the demo video beat sheet
- `SUBMISSION.md` — the written submission, structured against the four
  judging criteria
- `REVIEW-fable.md`, `REVIEW-glm.md` — independent critiques of the above

## The six pages

| # | Page | Carries |
| --- | --- | --- |
| 1 | The problem | Work is multiplayer, agents are single-player; the human becomes the integration layer |
| 2 | The room | The cast table: 4 members, 4 surfaces, one session — including a **machine** member |
| 3 | It works | The live run: cold boot 86.5 s, voice in, image in, private replies, media out, resume with continuity |
| 4 | The stack | agentpush → Rendez-vous → agentproto → e2b, and the seam that makes the runtime swappable |
| 5 | Work leaves the room | The confirmation gate and the audit line: who asked, who confirmed, what, to whom |
| 6 | Close | *The room is the primitive. The runtime is a detail.* |

Appendix: the five silent upstream failures (the failure-handling evidence the
rubric rewards) and the honest limits.

## Render command

Pages render as 16:9 landscape slides (1920×1080 px = 1440×810 pt), set by the
template frontmatter.

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

## Template note

The `ladder` layout's column headers come from `ladderHead` (five strings in
`data.json`) rather than being hardcoded, so the five-column table can carry
more than one kind of slide. Row fields keep their original names: `tier` is
the first, accent-styled cell, then `surface`, `sends`, `receives`, `latency`
in column order.

## Content sourcing

Every number traces to `docs/REHEARSAL.md`, `docs/STATE.md` or
`docs/ARCHITECTURE.md`. Two claims are newer than the rehearsal doc and are
sourced from the commits that landed them: the media round trip (voice and
image in, voice and files out) and resume-with-transcript-continuity, proven
in a local harness and then live from a phone. The machine-member row on page
2 is `scripts/room-agent.ts` (commit `e471b41`) — the bridge that joins a
local desktop agent session to a room through the same two endpoints the
laptop web view uses.
