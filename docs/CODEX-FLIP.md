# The codex flip — proving or disproving the one-parameter claim

## The claim (architecture.md §9.3(A))

> ...the second brain is one parameter:
> `agent_start({ adapter: "codex", model: "gpt-5.2-codex", sandbox: {
> provider: "e2b", config: { installAdapters: ["codex"] } }, appServe: {...} })`
> Same box, same filesystem, same artifact URL. Zero new code.

Tested the strictest reading: change **only** `adapter`/`model` first
(variant A); add `installAdapters` only on failure (variant B, a free
`reuse` reconnect on the same box); add an auth passthrough only if that
fails too (variant C). Never more than one fresh e2b boot total.
`scripts/prove-codex.ts` (copied from `scripts/prove-sandbox.ts`'s
single-spawn path) ran variant A as `bootRoomSession` with `adapter:
"codex"`, `model: "gpt-5.2-codex"` (from `agentproto models codex --json`),
everything else identical to the claude-code path: `sandbox` (e2b,
`setupCommands` seeding `apps/room-artifact`), `appServe` on port 3210,
`cwd: /home/user`, initial prompt "Reply with exactly the single word: pong".

## What happened

Spawn failed synchronously, before returning a `sandboxId`:
```
spawnAgent failed: 500 {"error":"sandbox_proxy_failed","message":"agent_start:
the sandbox's own agent_start failed for adapter \"codex\" — Tool
`agent_start` returned error: agent_start: no codex login found — run `codex l
```
(Truncated by `DaemonClient`'s 200-char error slice; meaning is unambiguous —
no codex credentials inside the box.)

`agentproto sandbox list --json` right after showed a ledger row (`sandboxId
ipqdgdvrswi6d1bv9v9ar`, label `rdv-prove-codex-a`, state `booted`), but
`GET https://api.e2b.dev/sandboxes/ipqdgdvrswi6d1bv9v9ar` → `404`. **The
daemon killed the box outright** after the inner `agent_start` failed —
different from `sandbox-e2b/provider.ts`'s `boot()` catch (guards only
`ensureDaemonHealthy`, already healthy here); an outer layer in
`session-spawn.ts` treats a failed adapter-level `agent_start` as a boot
failure and reclaims the box. No leak: e2b's `state=running` list was
unchanged (same two pre-existing, other-executors' boxes) before and after.

**Consequence:** escalating (`installAdapters` / `env.passthrough` via a free
reconnect) needs a live box to reuse. There wasn't one — gone before a
`sandboxId` came back. That would need a second fresh boot, forbidden by the
1-boot budget. **Variants B and C were not run.**

**Why B likely wouldn't have helped anyway:** `session-spawn.ts:3285`
(`withSandboxAdapterPackages`, read-only agentproto checkout) shows any
sandboxed spawn already auto-injects the spawned `adapter`'s own package,
independent of `installAdapters` — that field is for an *additional* harness
(§9.4 multi-brain), not this single-adapter swap. The error confirms codex
ran; it just had no credentials — `installAdapters` installs a binary, not a
login. Variant C (`env.passthrough: ["OPENAI_API_KEY"]`, key already present
in this shell) is the one variant with a real chance, left untested.

## Verdict

**Does not hold as stated**, for the reason architecture.md flags one
paragraph later ("nothing is sent automatically"): a fresh box has no codex
credentials, and `installAdapters` installs the binary, not the login. The
mechanical part — swapping `adapter`/`model` runs a different CLI in the
same box, seed, and port — is plausible from source but unobserved, since
the failure hit the auth gate first.

## Spawn body that failed (no secrets sent)

```json
{ "adapter": "codex", "model": "gpt-5.2-codex", "cwd": "/home/user",
  "label": "rdv-prove-codex-a",
  "prompt": "Reply with exactly the single word: pong",
  "sandbox": { "provider": "e2b",
    "config": { "setupCommands": ["<apps/room-artifact seed script>"] },
    "extraPorts": [3210] },
  "appServe": { "dir": "/home/user/apps/rdv-hello", "port": 3210 } }
```

**Boots used: 1 of 1.** No box left paused — the daemon destroyed it on
failure, so there's no pre-warm candidate here.
