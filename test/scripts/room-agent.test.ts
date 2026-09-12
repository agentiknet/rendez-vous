/**
 * The room-agent bridge (scripts/room-agent.ts), proven with both streams
 * faked — no network, no daemon, no room. Four things must hold:
 *
 *   1. a room assistant turn lands as a desktop prompt carrying the
 *      load-bearing `queue: true`;
 *   2. the desktop reply is posted back to the room EXACTLY ONCE;
 *   3. a record attributed `[Atlas · room-web]` is never forwarded (the
 *      loop guard);
 *   4. after a simulated restart from the persisted cursor, nothing is
 *      replayed and nothing is skipped.
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import {
  isOwnContribution,
  ownAttribution,
  RoomAgent,
  type CursorStore,
  type DesktopPromptInput,
  type RoomAgentCursors,
  type RoomAgentTransports,
} from "../../scripts/room-agent.ts"
import type { TextDeltaRecord, TranscriptRecord, TurnEndRecord, UserPromptRecord } from "../../src/daemon/records.ts"

function userPrompt(seq: number, text: string): UserPromptRecord {
  return { kind: "user-prompt", seq, text }
}

function delta(seq: number, text: string): TextDeltaRecord {
  return { kind: "text-delta", seq, text }
}

function turnEnd(seq: number): TurnEndRecord {
  return { kind: "turn-end", seq, reason: "end_turn" }
}

class FakeTransports implements RoomAgentTransports {
  room: TranscriptRecord[] = []
  desktop: TranscriptRecord[] = []
  readonly prompts: DesktopPromptInput[] = []
  readonly sends: string[] = []

  async *roomRecords(since: number): AsyncIterable<TranscriptRecord> {
    for (const record of this.room) {
      if (record.seq > since) yield record
    }
  }

  async *desktopRecords(since: number): AsyncIterable<TranscriptRecord> {
    for (const record of this.desktop) {
      if (record.seq > since) yield record
    }
  }

  async promptDesktop(input: DesktopPromptInput): Promise<void> {
    this.prompts.push(input)
  }

  async sendToRoom(text: string): Promise<void> {
    this.sends.push(text)
  }
}

/** In-memory cursor store shared across "restarts" — the persisted state a
 *  fresh RoomAgent resumes from. */
class MapCursorStore implements CursorStore {
  private readonly seqs: Map<string, RoomAgentCursors> = new Map()

  async load(code: string): Promise<RoomAgentCursors> {
    return this.seqs.get(code) ?? { room: 0, desktop: 0 }
  }

  async save(code: string, cursors: RoomAgentCursors): Promise<void> {
    this.seqs.set(code, cursors)
  }
}

const CODE = "RDV-7F3K"
const NAME = "Atlas"

test("a room assistant turn arrives as a desktop prompt carrying queue: true", async () => {
  const transports = new FakeTransports()
  transports.room = [delta(1, "The offsite is "), delta(2, "in Lisbon."), turnEnd(3)]

  const agent = new RoomAgent({ code: CODE, name: NAME, transports, cursors: new MapCursorStore() })
  await agent.runPass(new AbortController().signal)

  assert.deepEqual(transports.prompts, [
    { prompt: "The offsite is in Lisbon.", queue: true, origin: "rdv:Atlas" },
  ])
})

test("the desktop reply lands back in the room exactly once", async () => {
  const transports = new FakeTransports()
  transports.desktop = [delta(1, "Booking the "), delta(2, "venue now."), turnEnd(3)]

  const agent = new RoomAgent({ code: CODE, name: NAME, transports, cursors: new MapCursorStore() })
  await agent.runPass(new AbortController().signal)

  assert.deepEqual(transports.sends, ["Booking the venue now."])
})

test("a record attributed [Atlas · room-web] is NOT forwarded — the loop guard", async () => {
  const transports = new FakeTransports()
  const cursors = new MapCursorStore()
  transports.room = [userPrompt(1, `${ownAttribution(NAME)} Booking the venue now.`)]

  const agent = new RoomAgent({ code: CODE, name: NAME, transports, cursors })
  await agent.runPass(new AbortController().signal)

  assert.deepEqual(transports.prompts, [], "our own echo must never re-enter the desktop session")
  // ...but the cursor still advanced past it: the guard skips the FORWARD,
  // never the record.
  assert.equal((await cursors.load(CODE)).room, 1)
})

test("a member's message (not ours) IS forwarded to the desktop session", async () => {
  const transports = new FakeTransports()
  transports.room = [userPrompt(1, "[Alice · messenger] when is the offsite?")]

  const agent = new RoomAgent({ code: CODE, name: NAME, transports, cursors: new MapCursorStore() })
  await agent.runPass(new AbortController().signal)

  assert.deepEqual(transports.prompts, [
    { prompt: "[Alice · messenger] when is the offsite?", queue: true, origin: "rdv:Atlas" },
  ])
})

test("the loop guard matches only the agent's own attribution", () => {
  const own: UserPromptRecord = userPrompt(1, `${ownAttribution(NAME)} hello`)
  const similarName: UserPromptRecord = userPrompt(2, "[Atlas Prime · room-web] hello")
  const notAPrompt: TextDeltaRecord = delta(3, `${ownAttribution(NAME)} hello`)

  assert.equal(isOwnContribution(own, NAME), true)
  assert.equal(isOwnContribution(similarName, NAME), false, "a similar display name is a different member")
  assert.equal(isOwnContribution(notAPrompt, NAME), false)
})

test("after a simulated restart from the persisted cursor, nothing replays and nothing is skipped", async () => {
  const transports = new FakeTransports()
  const cursors = new MapCursorStore()

  // First life: a human line and one assistant turn on the room stream
  // (seq 1..3), one desktop turn (seq 1..2).
  transports.room = [userPrompt(1, "[Alice · messenger] hi"), delta(2, "Hello Alice."), turnEnd(3)]
  transports.desktop = [delta(1, "Hi from the desktop."), turnEnd(2)]
  const first = new RoomAgent({ code: CODE, name: NAME, transports, cursors })
  await first.runPass(new AbortController().signal)

  const promptsAfterFirstLife = transports.prompts.length
  const sendsAfterFirstLife = transports.sends.length
  assert.equal(promptsAfterFirstLife, 2)
  assert.equal(sendsAfterFirstLife, 1)

  // "Restart": brand-new agent over the same cursor store, with both streams
  // still holding every record they ever had, plus one new room turn
  // (seq 4..5). Nothing from the first life may be replayed, and the new
  // turn must not be skipped.
  transports.room = [
    userPrompt(1, "[Alice · messenger] hi"),
    delta(2, "Hello Alice."),
    turnEnd(3),
    delta(4, "The venue is booked."),
    turnEnd(5),
  ]
  const second = new RoomAgent({ code: CODE, name: NAME, transports, cursors })
  await second.runPass(new AbortController().signal)

  assert.deepEqual(transports.prompts.slice(promptsAfterFirstLife), [
    { prompt: "The venue is booked.", queue: true, origin: "rdv:Atlas" },
  ])
  assert.equal(transports.sends.length, sendsAfterFirstLife, "the desktop stream is not re-read from zero")
})
