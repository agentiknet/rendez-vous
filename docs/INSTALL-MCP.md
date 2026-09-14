# Installing the Rendez-vous personal MCP surface

`POST /mcp` is a **door, not a window**. An installed client can list the rooms
your address is a member of and speak into them — and it **never returns
message text**, so it cannot read the conversation. Two things are worth
knowing before you hand it a credential. First, a principal token — **even a
read-only one — lists the join code of every room you are in. Anyone who
reads that list can join those rooms. The token cannot read your messages; it
can hand out the door.** Second, "read-only" means the token cannot *speak*; it
does not mean the token cannot *leak capability*, because the codes it lists
are themselves the capability to join.

If you install this expecting to read a room, it will look broken. It is
working as designed: this surface answers ids, counts and booleans, never
content (`src/service/mcp-personal.ts`, the HARD RULE at the top of the file).
The rule is load-bearing, not a limitation to route around: this token is
cross-room, so a token that could read text would read **every room that
address is in**.

## What it provides

One MCP server (`serverInfo.name: "rdv-personal"`) with:

- `rendezvous_list` — read. The rooms your principal is in, as
  `{code, slug, memberId, displayName, tier, presence, presenceBasis,
  memberCount, unread, active, lastActivityAt}` plus an `ambiguous` flag.
  `ambiguous: true` means the address holds a membership in more than one room
  at once; when it is true, no room is `active`.
- `rendezvous_send` — write, and only with a send-capable token. Sends *as
  you* into a room you already belong to, on the same inbound path a phone
  message takes. It returns `{roomCode, memberId, outcome, accepted}` — never
  the text back.
- A resource, `ui://rendezvous/roster` (`text/html;profile=mcp-app`) — the ICQ
  roster panel. Whether a host *renders* it is a separate question from
  whether it exists; see "The roster panel" below.

There is no tool that returns message text, and there is no route that issues
a token. Minting is a CLI act, never an HTTP one — a route that minted
principal tokens would be an account system.

## Mint a principal token

Tokens are HMACs over `RDV_ROOM_TOKEN_SECRET`, keyed on an **address**
(`provider` + `contactRef`), not a room code. Mint one from the repo, where
the secret is in the environment (`.env.local`):

```
node --env-file=.env.local src/cli.ts principal-token <provider> <contactRef>
```

`--can-send` is **required** to mint a writing token; omit it and you get the
read-only derivation, which is the default and what every example here uses.
A mistyped flag refuses rather than silently minting read-only
(`src/cli.ts`). When you pass `--can-send`, the CLI prints this, and the doc
repeats it because it is the only warning you get:

> WARNING: this token can SEND AS this person, in every room they are in.
> WARNING: it cannot be revoked — a principal token is a pure function of (address, secret),
> WARNING: so the only undo is rotating RDV_ROOM_TOKEN_SECRET, which invalidates EVERY token.

**Treat the printed token as a secret.** It is a pure function of
`(provider, contactRef, secret)`, so nothing records that it was minted and
nothing can withdraw it. The only revocation that exists is rotating
`RDV_ROOM_TOKEN_SECRET`, which invalidates **every** token of **every** kind
in the system — audience, render, member, principal — and is not a targeted
action. There is no per-token revocation.

## Claude Code

```
claude mcp add --transport http rendez-vous https://rdv.clipgen.co/mcp \
  --header "Authorization: Bearer <principal-token>"
```

Add `--scope user` to install it for every project instead of the current
one. Then run `claude mcp list` (or `/mcp` in an interactive session) and
confirm the server shows **connected** with `rendezvous_list` in its tools.

## Codex

Codex 0.153.4 accepts a streamable-HTTP URL directly, so no `mcp-remote`
shim is needed:

```
codex mcp add rendez-vous --url https://rdv.clipgen.co/mcp \
  --bearer-token-env-var RDV_PRINCIPAL_TOKEN
export RDV_PRINCIPAL_TOKEN=<principal-token>
```

`--bearer-token-env-var` names the environment variable Codex reads at
runtime, which keeps the token out of `~/.codex/config.toml`:

```toml
[mcp_servers.rendez-vous]
url = "https://rdv.clipgen.co/mcp"
bearer_token_env_var = "RDV_PRINCIPAL_TOKEN"
```

Prefer this over pasting the token into the config file. With the older
stdio-only Codex builds you would need the `mcp-remote` shim in your own
config; this build does not.

## The roster panel

`resources/list` returns `ui://rendezvous/roster`, and `resources/read` returns
HTML (`text/html;profile=mcp-app`) with a CSP that allows the panel to fetch
`/r/<code>/state` from the public origin. A host that implements MCP Apps
renders it as the roster; a host that does not ignores the resource.

Tested 2026-09-14 (see below): **neither CLI host renders the panel.** Claude
Code enumerated the resource and could fetch its raw HTML as text, but never
presented it as an app; Codex did not request the resource at all. This is a
finding about the hosts, not about the panel — the resource is served
correctly.

## Verified against

Both clients were run against the **live** service at
`https://rdv.clipgen.co/mcp` on 2026-09-14, with a read-only principal token
for an address that is a member of two rooms. (`main` was at `2c7022e` when
the brief was written and advanced to `12086b9` shortly after; neither commit
touches `/mcp`.) While the public host was briefly down, the same findings
were reproduced against a local instance of `2c7022e` on `127.0.0.1:8790`,
which is where the request-level trace below was captured.

- **Claude Code 2.1.259** (`claude -p` with `--mcp-config` +
  `--strict-mcp-config`). On connect it sent `server/discover` (unrecognised,
  ignored), `initialize`, `notifications/initialized`, then **`GET /mcp`**,
  which the service answers `405 Method Not Allowed` with `allow: POST` by
  design (`src/service/http.ts`; the 405 exists precisely so a client does not
  read the endpoint as missing). The client did **not** fall into OAuth
  discovery — it proceeded straight to `tools/list` and `resources/list`,
  listed both tools and the roster resource, and `rendezvous_list` returned the
  test address's two rooms. The panel was **not rendered**: the client surfaced
  the resource's name and mime type but issued no `resources/read` on its own,
  and when explicitly asked it only printed the HTML as text — a terminal host
  has no app surface to render into. With a wrong token, `tools/list` still
  succeeded (the service authenticates only `tools/call` and `resources/read`),
  and the resulting 401 was reported by Claude Code as `MCP server "…" requires
  re-authorization (token expired)` — i.e. the client reads a 401 as an OAuth
  refresh problem, not as a bad credential. Plan for that wording in any
  support story.
- **Codex CLI 0.153.4**. The URL + `--bearer-token-env-var` stanza was
  accepted and `codex mcp list` shows it enabled with Bearer auth. Connecting
  it, the client sent `initialize`, `notifications/initialized` and
  `tools/list` — and **never** `resources/list`, so the panel is not even a
  candidate for rendering there. The model turn could not be exercised in the
  test sandbox (the OpenAI API rejected the test credentials), so no tool
  result was driven through Codex end to end.

## The decision this doc does not make

Whether `/mcp` should ever return message text. Today it cannot, by rule, and
that rule is load-bearing: a cross-room token that could read text would read
every room the address is in — a materially different object from a room code.
A "my Claude Code reads the room" feature is a product conversation and a new
token scope, not a tweak to `rendezvous_list`.

One follow-up this implies, deliberately not done here: dropping `code` from
`rendezvous_list` and taking `slug` in `rendezvous_send` would make a read-only
token actually read-only with no loss of function — `rendezvous_send`'s handler
already refuses any room the principal is not a member of by name, and the list
already carries `slug`. That touches `src/service/mcp-personal.ts` and needs its
own tests.
