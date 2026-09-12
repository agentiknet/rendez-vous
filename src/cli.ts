import { AgentpushTransport, EmailTransport } from "./channels/index.ts"
import { DaemonClient } from "./daemon/client.ts"
import { env } from "./env.ts"
import type { Transport } from "./fanout/types.ts"
import { RoomStore } from "./rooms/store.ts"
import { E2bBooter, LocalBooter, type SessionBooter } from "./service/booter.ts"
import { startHttpServer } from "./service/http.ts"
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

function buildBooter(client: DaemonClient, store: RoomStore): { booter: SessionBooter; description: string } {
  const daemonOpts = { baseUrl: env.daemonUrl, token: env.daemonToken }
  if (env.booter === "e2b") {
    return { booter: new E2bBooter(client, daemonOpts, store), description: "e2b (sandbox + artifact)" }
  }
  return { booter: new LocalBooter(client, daemonOpts), description: "local (no sandbox, no artifact)" }
}

async function serve(): Promise<void> {
  const store = await RoomStore.open(env.dataDir)
  const client = new DaemonClient({ baseUrl: env.daemonUrl, token: env.daemonToken })
  const { booter, description: booterDescription } = buildBooter(client, store)
  const { transport, description } = buildTransport()
  const service = new RoomService({ store, client, booter, transport })

  service.start()
  const server = startHttpServer(service)
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

function main(): void {
  const command = process.argv[2]
  if (command === "serve") {
    serve().catch((error: unknown) => {
      console.error(error)
      process.exit(1)
    })
    return
  }
  console.error("Usage: node src/cli.ts serve")
  process.exit(1)
}

main()
