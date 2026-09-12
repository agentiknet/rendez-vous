/**
 * Deterministic box seeding (M4 amendment — architecture.md §3, docs/ARTIFACT.md
 * "Artifact strategy": ranked A over the two-spawn approach). Reads this
 * repo's `apps/room-artifact/` source and turns it into a `sandbox.config
 * .setupCommands` entry — a plain shell script the e2b provider runs via
 * `sandbox.commands.run()` (`provider.ts`'s `ensureDaemonHealthy`) BEFORE
 * the box's own daemon starts and BEFORE `app_install`/`appServe` ever run,
 * on every boot AND every reconnect. No agent turn, no LLM in the loop —
 * the directory already exists by the time `app_install` looks for it.
 *
 * Must be idempotent: setupCommands re-run on every connect
 * ("entries must be idempotent" — `provider.ts`'s doc comment on
 * `setupCommands`). But "idempotent" (safe to repeat) is not the same as
 * "content-preserving": an unconditional `cat >` overwrite re-runs on every
 * RESUME too, silently wiping any edit the agent made to the page while the
 * room was live (Rehearsal Run 2, Finding 3 — the artifact reverted across
 * a pause). So the writes are guarded behind "does `APP.md` already exist in
 * the box" — true only on a genuine fresh boot, false on a reconnect to a
 * box that was already seeded, which is exactly the box whose edits must
 * survive.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

/** Delimiters unique enough that neither file's content will ever collide
 *  with them on their own line — both files are ours, kept small and
 *  reviewed, so this is a correctness invariant, not a runtime check. */
const APP_MD_DELIMITER = "RDV_SEED_APP_MD_EOF"
const UI_HTML_DELIMITER = "RDV_SEED_UI_HTML_EOF"

/**
 * Read `<localAppSourceDir>/.agentproto/{APP.md,ui/index.html}` and build a
 * shell script that recreates them at `<boxAppDir>/.agentproto/...` inside
 * the sandbox. `boxAppDir` must not contain a single quote (same constraint
 * `sandbox-app-serve.ts`'s `buildServeLaunchScript` documents for `dir`).
 */
export function buildAppSeedScript(localAppSourceDir: string, boxAppDir: string): string {
  if (boxAppDir.includes("'")) {
    throw new Error(`buildAppSeedScript: boxAppDir must not contain a single quote: "${boxAppDir}"`)
  }
  const appMd = readFileSync(join(localAppSourceDir, ".agentproto", "APP.md"), "utf8")
  const uiHtml = readFileSync(join(localAppSourceDir, ".agentproto", "ui", "index.html"), "utf8")
  if (appMd.includes(APP_MD_DELIMITER) || uiHtml.includes(UI_HTML_DELIMITER)) {
    throw new Error("buildAppSeedScript: app source content collides with its own heredoc delimiter")
  }
  const markerFile = `${boxAppDir}/.agentproto/APP.md`
  return [
    "set -e",
    `if [ ! -e '${markerFile}' ]; then`,
    `mkdir -p '${boxAppDir}/.agentproto/ui'`,
    `cat > '${markerFile}' <<'${APP_MD_DELIMITER}'`,
    appMd,
    APP_MD_DELIMITER,
    `cat > '${boxAppDir}/.agentproto/ui/index.html' <<'${UI_HTML_DELIMITER}'`,
    uiHtml,
    UI_HTML_DELIMITER,
    "fi",
  ].join("\n")
}
