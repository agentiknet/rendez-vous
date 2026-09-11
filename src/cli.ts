import { DaemonClient } from "./daemon/client.ts"
import { env } from "./env.ts"
import { RoomStore } from "./rooms/store.ts"
import { LocalBooter } from "./service/booter.ts"
import { startHttpServer } from "./service/http.ts"
import { RoomService } from "./service/room-service.ts"
import { ConsoleTransport } from "./service/transports.ts"

async function serve(): Promise<void> {
  const store = await RoomStore.open(env.dataDir)
  const client = new DaemonClient({ baseUrl: env.daemonUrl, token: env.daemonToken })
  const booter = new LocalBooter(client, { baseUrl: env.daemonUrl, token: env.daemonToken })
  const transport = new ConsoleTransport()
  const service = new RoomService({ store, client, booter, transport })

  service.start()
  const server = startHttpServer(service)
  console.log(`rendez-vous service listening on :${env.port}`)

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
