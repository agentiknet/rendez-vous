/** Shared test helper, not a test file itself (no `*.test.ts` name). */

import type { Server } from "node:http"

/** `server.address()` typed as `string | AddressInfo | null` — a bare `as
 *  AddressInfo` would silence that instead of checking it. This asserts the
 *  server is actually bound to a TCP port and throws with a clear message
 *  otherwise (a unix-socket or unbound server), rather than casting past it. */
export function listeningPort(server: Server): number {
  const address = server.address()
  if (typeof address !== "object" || address === null) {
    throw new Error("server is not listening on a TCP port")
  }
  return address.port
}
