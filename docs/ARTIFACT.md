# Artifact strategy — how the app gets into the box

Ranked from source, before spending any boot on the two-spawn approach that
was previously in `src/sandbox/boot.ts`.

## What `app_install` actually accepts

`packages/runtime/src/app-tools.ts`'s `app_install` tool has exactly one
input field: `dir` — "Absolute path to the app's directory." It calls
`performInstall(input.dir, ...)` → `loadAppHandle(dir)`
(`packages/app-kit/src/load-app.ts`), which reads `<dir>/.agentproto/APP.md`
straight off the local filesystem with `node:fs/promises.readFile`. There is
**no** package-name resolution, no git ref, no tarball, no URL fetch
anywhere in that path. `app_install` only ever reads a directory that
already exists on the box.

## The three candidates

### A — deterministic install at boot, single spawn (chosen)

`packages/sandbox-e2b/src/provider.ts`'s `E2bSandboxConfig` has a
`setupCommands?: string[]` field: "Extra shell commands host-executed
inside the box AFTER the boot `npm i -g` and BEFORE `agentproto serve`
hands control to the agent... Runs on EVERY boot/connect, even when the
health probe finds the daemon already autostarted — entries must be
idempotent." `ensureDaemonHealthy` (called from both `provider.ts`'s
`boot()` and `connect()`) runs this loop unconditionally, BEFORE the box's
own daemon starts and therefore BEFORE `session-spawn.ts`'s
`bootSandboxAgentSession` ever calls `host.start()` or
`startSandboxAppServe`. A `setupCommands` entry is a plain string executed
via the e2b SDK's `sandbox.commands.run()` — no agent, no LLM, no MCP round
trip. This means: one `POST /sessions/agent` with `sandbox.config
.setupCommands` (writing the app files) + `extraPorts` + `appServe`
pointed at that same directory, and by the time `app_install` runs inside
`startSandboxAppServe`, the directory is already there.

Checked the other two config-level candidates the amendment named:

- `mounts` — present in the AIP-36 schema (`sandboxFrontmatterSchema`,
  `z.array(z.any())`, "Maps to Mastra Workspace.mounts"), but
  `readE2bConfig` (`provider.ts`) never reads `spec.mounts` at all. Schema-only
  for this provider — dead on arrival for e2b.
- `installPackages` — real, but it's `npm i -g <spec>` against the public
  npm registry (or a local tarball path, which still has to already be ON
  the box — the same chicken-and-egg problem `setupCommands` doesn't have).
  Would need an actual published package; out of scope for a hackathon repo
  with no publish pipeline, and strictly more moving parts than a
  `setupCommands` heredoc for the same result.

`setupCommands` is the only one of the three that is (a) implemented by the
e2b provider today, (b) runs before any agent turn, and (c) needs nothing
external (no registry, no network fetch, no template rebuild).

**Verdict: winner.** Implemented in `src/sandbox/app-seed.ts`
(`buildAppSeedScript`) + `src/sandbox/boot.ts` (`buildSandboxSpec`). The
app's canonical source lives in this repo at `apps/room-artifact/` — the
seed script is generated FROM those files at call time (`readFileSync`),
so the repo files are the single source of truth, not a second copy
embedded in `boot.ts`.

### B — `extraPorts` only, an ad hoc static server

No `appServe`, no `app_install`, no APP.md — just expose the port and have
something (an agent turn or a deterministic command) bind a plain static
file server on it. Robust in the sense that it doesn't depend on
`agentproto app serve`'s own UI-path convention at all, but it throws away
everything `app_install` gives you: the app registry record, the
`ui.tools` allowlist, `app_data_*`, and being a first-class agentproto app
at all. And it still needs the exact same deterministic-seeding mechanism
(`setupCommands`) to launch the server without an agent turn — at which
point it's strictly worse than A for the same amount of plumbing.

**Verdict: ranked below A.** Not attempted; A covers everything B would
and stays inside the agentproto app model.

### C — two-spawn, agent-driven file creation (fallback, already shipped)

The approach `src/sandbox/boot.ts` used before this amendment: spawn
without `appServe`, give the agent a prompt that runs one exact shell
command to create the files, wait for the turn, then spawn again with
`reuse` + `appServe`. Works — proven live twice (docs/UPSTREAM.md) — but
puts an LLM turn on the critical path of "does the app exist" for no
reason: the agent is asked to run one fixed command verbatim, which
`setupCommands` does directly, deterministically, without spending a turn,
a turn-end wait, or any risk of the model doing something other than
exactly that command.

**Verdict: fallback only**, per the amendment. Kept in git history; not
reachable from the current `bootRoomSession`/`resumeRoomSession` (both now
seed via `setupCommands` when `seedFromDir` is given).

## Long-term recommendation

Use A (`setupCommands` + `appServe`, single spawn) for every room's
artifact going forward. Keep the room's actual UI app source under
version control in this repo (`apps/room-artifact/` today; a real room UI
would live the same way) and always pass `seedFromDir` pointing at it —
`bootRoomSession`/`resumeRoomSession` already do the rest, including
re-seeding idempotently on every reconnect. Only fall back to C if a
future app's setup genuinely can't be expressed as a static, idempotent
shell script (e.g. it needs a runtime decision only an agent can make) —
and even then, prefer teaching `setupCommands` to do more (it's a full
shell, not just file writes) before reaching for an agent turn.
