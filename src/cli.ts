import { AgentpushTransport, EmailTransport } from "./channels/index.ts"
import { DaemonClient } from "./daemon/client.ts"
import { defaultRuntimeCandidatePaths, portFromDaemonUrl, resolveDaemonToken } from "./daemon/token.ts"
import { env } from "./env.ts"
import type { Transport } from "./fanout/types.ts"
import { RoomStore } from "./rooms/store.ts"
import { E2bBooter, LocalBooter, ResolvingBooter, type SessionBooter } from "./service/booter.ts"
import { startHttpServer } from "./service/http.ts"
import { principalToken } from "./service/mcp-personal.ts"
import { RoomService } from "./service/room-service.ts"
import { CompositeTransport, ConsoleTransport } from "./service/transports.ts"

function buildTransport(): { transport: Transport; description: string } {
  if (env.agentpushUrl === undefined) {
    return { transport: new ConsoleTransport(), description: "console only (RDV_AGENTPUSH_URL unset)" }
  }
  const agentpush = new AgentpushTransport({ baseUrl: env.agentpushUrl, apiKey: env.agentpushKey })
  const email = new EmailTransport({ baseUrl: env.agentpushUrl, apiKey: env.agentpushKey })
  return {
    transport: new CompositeTransport(agentpush, new ConsoleTransport(), email),
    description: "agentpush (whatsapp/telegram/sms) + email; pull members drain their outbox",
  }
}

function buildBooter(client: DaemonClient, store: RoomStore, token: string | undefined): { booter: SessionBooter; description: string } {
  const daemonOpts = { baseUrl: env.daemonUrl, token }
  return {
    booter: new ResolvingBooter(new LocalBooter(client, daemonOpts), new E2bBooter(client, daemonOpts, store), env.booter),
    description: `per-room (new = local, new sb = e2b; RDV_BOOTER=${env.booter} fallback)`,
  }
}

/** `RDV_DAEMON_TOKEN` is an override, not the source (BRIEF-22): the real
 *  source is the daemon's own `runtime.json`, read fresh at every boot of
 *  THIS service so a daemon restart's regenerated token is picked up
 *  without anyone editing a file. A resolution failure refuses to start
 *  rather than booting a service that would 401 on every room. */
function requireDaemonToken(): string {
  const port = portFromDaemonUrl(env.daemonUrl)
  const resolution = resolveDaemonToken({
    override: env.daemonToken,
    port,
    candidatePaths: defaultRuntimeCandidatePaths(port),
  })
  if (!resolution.ok) {
    console.error(resolution.message)
    process.exit(1)
  }
  return resolution.token
}

async function serve(): Promise<void> {
  const token = requireDaemonToken()
  const store = await RoomStore.open(env.dataDir)
  const client = new DaemonClient({ baseUrl: env.daemonUrl, token })
  const { booter, description: booterDescription } = buildBooter(client, store, token)
  const { transport, description } = buildTransport()
  const service = new RoomService({ store, client, booter, transport, daemon: { baseUrl: env.daemonUrl, token } })

  service.start()
  const server = startHttpServer(service, { daemon: { baseUrl: env.daemonUrl, token } })
  console.log(`rendez-vous service listening on :${env.port}`)
  console.log(`booter: ${booterDescription}`)
  console.log(`transport: ${description}`)
  console.log(`public url: ${env.publicUrl}`)
  console.log(`room pages: ${env.publicUrl}/r/<code>`)

  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    server.close()
    service
      .stop()
      .catch((error: unknown) => {
        console.error(error)
      })
      .finally(() => process.exit(0))
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

/** Mints a `POST /mcp` bearer for one address, to an operator, once. There is
 *  no HTTP route that does this (BRIEF-18) — a route that minted principal
 *  tokens would be an account system. `source` plays no part in the token
 *  (`principalToken`'s doc) so any value works; `cli` names where it came
 *  from for anyone reading a persisted room's `member.address` later.
 *
 *  READ-ONLY BY DEFAULT (BRIEF-19, AMENDMENT 2). `--can-send` is required to
 *  mint the `principal-rw` derivation, and the warning below is printed with
 *  it every single time, because the token that comes out CANNOT BE REVOKED:
 *  it is a pure function of (address, secret), so nothing records it and
 *  nothing can withdraw it. The only undo is rotating `RDV_ROOM_TOKEN_SECRET`,
 *  which invalidates every token of every kind at once. See `principalToken`
 *  in src/service/mcp-personal.ts for the full statement. */
function principalTokenCommand(provider: string | undefined, contactRef: string | undefined, flags: readonly string[]): void {
  if (provider === undefined || contactRef === undefined) {
    console.error("Usage: node src/cli.ts principal-token <provider> <contactRef> [--can-send]")
    process.exit(1)
  }
  const unknownFlag = flags.find((flag) => flag !== "--can-send")
  if (unknownFlag !== undefined) {
    // A mistyped `--can-send` must NOT silently mint a read-only token that
    // then fails confusingly at `rendezvous_send`.
    console.error(`Unknown option: ${unknownFlag}`)
    console.error("Usage: node src/cli.ts principal-token <provider> <contactRef> [--can-send]")
    process.exit(1)
  }
  const canSend = flags.includes("--can-send")
  // BRIEF-24: printed for EVERY principal token, read-only included. A token
  // that cannot send still enumerates every room this address is in, and the
  // join code of each is still a capability — it is now delivered to the HOST
  // side of the MCP session (the tool result's `_meta`), not to the model's
  // text payload, but the quiet path is the one that needs a word. No token
  // and no room code is ever printed here.
  console.error("Note: this token lists every room this address is in; the host — not the model — receives those rooms' join codes.")
  if (canSend) {
    console.error("WARNING: this token can SEND AS this person, in every room they are in.")
    console.error("WARNING: it cannot be revoked — a principal token is a pure function of (address, secret),")
    console.error("WARNING: so the only undo is rotating RDV_ROOM_TOKEN_SECRET, which invalidates EVERY token.")
  }
  console.log(principalToken({ provider, source: "cli", contactRef }, env.roomTokenSecret, canSend ? "send" : "read"))
}

function main(): void {
  const command = process.argv[2]
  if (command === "serve") {
    serve().catch((error: unknown) => {
      console.error(error)
      process.exit(1)
    })
    return
  }
  if (command === "principal-token") {
    principalTokenCommand(process.argv[3], process.argv[4], process.argv.slice(5))
    return
  }
  console.error("Usage: node src/cli.ts serve")
  console.error("       node src/cli.ts principal-token <provider> <contactRef> [--can-send]")
  process.exit(1)
}

main()
