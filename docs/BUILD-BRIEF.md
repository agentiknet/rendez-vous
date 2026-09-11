# Rendez-vous — build brief for the supervising agent

Read `docs/ARCHITECTURE.md` first. It is ground-truthed against
`agentproto/ts@264c4c7a` and every claim carries a `file:line` anchor. Do not
re-derive it. Do not contradict it without evidence at a new anchor.

## Mission

Build the Rendez-vous room service: a host application that turns an
**unmodified** agentproto daemon into a multi-human, multi-surface shared
agent room.

## Hard constraints

1. **Never fork, vendor, or patch agentproto.** Consume `@agentproto/*` from
   npm. The local checkout at
   `/Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/projects/agentproto/ts`
   is **read-only reference** for verifying behaviour. Do not edit it. Do not
   commit into it.
2. If you find an upstream bug (R3 in the architecture doc is a real one),
   write it up in `docs/UPSTREAM.md` with a repro. Do not fix it in this repo
   and do not open a PR without checking with the operator first.
3. TypeScript, Node 20+, pnpm. Keep dependencies minimal. Prefer the platform:
   native `fetch`, native SSE parsing over a `ReadableStream`.
4. No `any`, no `unknown` escape hatches, no `as` casts to silence the
   compiler. Type the seams properly.
5. Typed env module, never raw `process.env` reads scattered through the code.
6. Commit as soon as `pnpm check-types` passes. Small commits, imperative
   subject lines. **No AI attribution in commit messages** — no Co-Authored-By,
   no "generated with".
7. Everything must be provable without a phone. Every milestone ships with a
   local simulator or test that exercises it end to end.

## Delegation model

You are the supervisor. You do not write the bulk of the code.

- Spawn executors with `agent_start`: adapter `claude-code`, model
  `claude-sonnet-5`, `role: "executor"`, `attach` default so they nest under
  you.
- One executor per milestone. Give each a self-contained brief: the files it
  owns, the interface it must satisfy, the test that proves it, and the
  explicit statement that it must not touch the agentproto checkout.
- Two executors must never own the same file. Partition by directory.
- Verify every executor's work yourself before accepting it: read the diff,
  run the types, run the test. An executor reporting success is a claim, not
  evidence.
- If an executor stalls with blank output, prompt it. Do not kill it.

## Milestones, frozen order

Build 1 through 4 first. They need no phone and no external account, and they
are the whole thesis.

**M1 — Room registry.** A persisted store: room code (`RDV-XXXX`, unambiguous
alphabet, no I/O/0/1), `sessionId`, `sandboxId`, `artifactUrl`, members. A
member is `{id, displayName, tier, address:{provider,source,contactRef}}` where
tier is `messenger | email | room-web`. Commands `new`, `join <code>`,
`resume <code>`. Atomic writes, survives process restart. Unit tested.

**M2 — Attributed fan-in.** Inbound message plus room plus member becomes a
turn on the session. Prefix the text `[<displayName> · <tier>] `. Post to
`POST /sessions/:id/prompt?wait=false` with `queue: true` and
`origin: "rdv:<memberId>"`.
**The `queue: true` is load-bearing** — without it a message arriving mid-turn
throws `session "<id>" is mid-turn` (`sessions.ts:4814`) and is lost. Prove
this with a test that fires two messages while the agent is busy and asserts
both land as turns, in order.

**M3 — Tier-aware fan-out.** One long-lived SSE reader per active room on
`GET /sessions/:id/events/stream?since=<cursor>`. Accumulate `text-delta`,
flush on `turn-end`. Tier 1 gets a trimmed message, tier 2 an email digest,
tier 3 nothing pushed (its browser holds its own stream). Persist the cursor
per room so a service restart neither drops nor duplicates. Prove with a fake
transcript stream.

**M4 — Sandbox and artifact.** `agent_start` with an e2b `sandbox` plus
`appServe` to get a public artifact URL. Store it on the room. On resume,
probe the URL and re-run app-serve if dead (R8 — nothing re-launches it after
a resume). Artifact is e2b-only; box has no port exposure (R9).

M5 through M11 are in `docs/ARCHITECTURE.md` §6. Do not start them until M1
through M4 are green and committed.

## First task, exactly

1. Verify which `@agentproto/*` packages are published and at what version.
   `npm view @agentproto/runtime version` and friends. Write what you find to
   `docs/DEPENDENCIES.md`. If the packages we need are not public, say so
   immediately and stop — that changes the plan and the operator must decide.
2. Scaffold the TypeScript project: `package.json`, `tsconfig.json`, a typed
   env module, `pnpm check-types` wired and passing on an empty build.
3. Confirm you can reach a local agentproto daemon: `GET /health`, then spawn a
   throwaway session and read its event stream. Write the working snippet to
   `docs/DAEMON-NOTES.md`. This de-risks everything downstream.
4. Then delegate M1.

Report after step 3 with: the dependency situation, whether the daemon path
works, and your M1 executor brief. Do not wait for approval to proceed to M1
if steps 1 through 3 are clean.
