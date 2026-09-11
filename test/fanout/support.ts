import type { FanoutRecord, OutboundMessage } from "../../src/fanout/types.ts"
import type { Member } from "../../src/rooms/types.ts"

/**
 * In-memory transcript stub with a controllable live tail: replays whatever has
 * already been `push`ed, then parks on a promise until either a new record
 * arrives or the caller's AbortSignal fires — the same shape as an SSE reader.
 */
export class FakeSource {
  private readonly records: FanoutRecord[] = []
  private waiters: Array<() => void> = []
  private nextError: Error | undefined

  push(record: FanoutRecord): void {
    this.records.push(record)
    this.wake()
  }

  /** The next call to the source function throws this error instead of streaming. */
  failNext(error: Error): void {
    this.nextError = error
  }

  read(): (sessionId: string, since: number, signal: AbortSignal) => AsyncIterable<FanoutRecord> {
    return (_sessionId, since, signal) => this.iterate(since, signal)
  }

  private wake(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter()
  }

  private async *iterate(since: number, signal: AbortSignal): AsyncGenerator<FanoutRecord> {
    if (this.nextError !== undefined) {
      const error = this.nextError
      this.nextError = undefined
      throw error
    }

    let index = 0
    while (!signal.aborted) {
      while (index < this.records.length) {
        const record = this.records[index]
        index += 1
        if (record !== undefined && record.seq > since) {
          yield record
        }
      }
      if (signal.aborted) return
      await this.parkUntilMoreOrAbort(signal)
    }
  }

  private parkUntilMoreOrAbort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const onAbort = (): void => resolve()
      signal.addEventListener("abort", onAbort, { once: true })
      this.waiters.push(() => {
        signal.removeEventListener("abort", onAbort)
        resolve()
      })
    })
  }
}

export interface RecordedSend {
  memberId: string
  text: string
  artifactUrl: string | undefined
}

export class FakeTransport {
  readonly sends: RecordedSend[] = []
  private readonly failing: Set<string> = new Set()

  /** The next send to this member throws once, then behaves normally. */
  failFor(memberId: string): void {
    this.failing.add(memberId)
  }

  async send(member: Member, message: OutboundMessage): Promise<void> {
    if (this.failing.has(member.id)) {
      this.failing.delete(member.id)
      throw new Error(`transport failed for ${member.id}`)
    }
    this.sends.push({ memberId: member.id, text: message.text, artifactUrl: message.artifactUrl })
  }
}

export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out")
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
