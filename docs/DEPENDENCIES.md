# Dependencies

Verified against the public npm registry on 2026-09-11.

## The agentproto packages we care about

| Package | Public | Version | Published | Role for Rendez-vous |
| --- | --- | --- | --- | --- |
| `@agentproto/cli` | yes | 0.20.0 | 2026-09-09 | The daemon binary. This is what runs at `http://127.0.0.1:18790`. Local build reports `version 0.20.0`, `build 264c4c7a`. |
| `@agentproto/runtime` | yes | 3.1.0 | 2026-09-09 | Daemon internals (sessions, http-server, transcript-writer). We only reach it over HTTP. |
| `@agentproto/sandbox-e2b` | yes | 0.4.2 | 2026-09-09 | The e2b provider the daemon loads for `agent_start { sandbox: "e2b" }`. Daemon-side. |
| `@agentproto/sandbox-box` | yes | 0.2.9 | 2026-09-09 | The box provider. No port exposure, so no artifact URL (R9). Daemon-side. |
| `@agentproto/sandbox` | yes | 0.4.0 | 2026-09-09 | Provider contract. Daemon-side. |
| `@agentproto/rendezvous` | yes | 0.2.3 | 2026-09-09 | The two-socket pairing broker. Tier 3b only, owner-only. Not a runtime dependency of this repo. |
| `@agentproto/skill-pack-agentpush` | yes | 0.2.1 | 2026-09-09 | agentpush inbound/outbound (WhatsApp, Telegram, mail). Daemon-side. |
| `@agentproto/apps` | yes | 0.9.3 | 2026-09-09 | `agentproto app serve`, what produces the artifact URL inside the sandbox. Daemon-side. |

Names that do **not** exist on npm: `@agentproto/core`, `@agentproto/client`,
`@agentproto/protocol`, `@agentproto/sdk`. Do not reference them.

The full public list is 20+ packages under `@agentproto/*` plus
`create-agentproto-app`. Only `agentproto-desktop`, `@agentproto/llm-endpoint`,
`agentproto-vscode` and `@agentproto/worktree-agent-example` are private in the
monorepo, and none of them matter here.

## What this repo actually depends on

**Zero `@agentproto/*` packages at runtime.** The whole design drives the
daemon over its public HTTP surface with native `fetch` and a hand-rolled SSE
reader (`docs/ARCHITECTURE.md` §3). There is no client SDK package to import,
and importing `@agentproto/runtime` for types would pull the entire daemon
dependency tree into a service that must stay small.

The daemon is an **external process** the service talks to:

```
npx -y @agentproto/cli@0.20.0 daemon      # or the locally running one
```

Dev dependencies, deliberately minimal:

| Package | Why |
| --- | --- |
| `typescript` | `pnpm check-types` |
| `@types/node` | typed `fetch`, `fs`, `crypto`, `node:test` |

Tests use `node --test` with Node's native type stripping (Node 22.18+). No
test framework, no bundler, no build step: `node src/cli.ts` runs the source.

## Version pin policy

The service targets the daemon HTTP contract at `@agentproto/cli@0.20.0`
(build `264c4c7a`). The three routes we depend on and their anchors in
`packages/runtime/src/http-server.ts` at that build:

| Route | Anchor |
| --- | --- |
| `POST /sessions/agent` | `http-server.ts:4013` |
| `POST /sessions/:id/prompt?wait=false` with `queue: true` | `http-server.ts:4408-4470` |
| `GET /sessions/:id/events/stream?since=<seq>` | `http-server.ts:5108-5190`, `deliverRecordsExactlyOnce` at `:3200` |

If the operator upgrades the daemon, re-verify those three before anything
else.
