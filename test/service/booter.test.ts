import assert from "node:assert/strict"
import { test } from "node:test"
import { openingPrompt } from "../../src/service/booter.ts"
import type { Room } from "../../src/rooms/types.ts"

function fakeRoom(code: string): Room {
  return {
    code,
    sessionId: undefined,
    sandboxId: undefined,
    artifactUrl: undefined,
    members: [],
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    cursor: 0,
  }
}

test("openingPrompt names the room code, explains the [Name · tier] prefix, and asks for a one-line greeting", () => {
  const prompt = openingPrompt(fakeRoom("RDV-7F3K"))

  assert.ok(prompt.includes("RDV-7F3K"), "should mention the room code")
  assert.match(prompt, /\[[^\]]+ · [^\]]+\]/, "should explain the [Name · tier] message prefix")
  assert.ok(
    prompt.includes('Room RDV-7F3K is open. Say what you want built.'),
    "should instruct the agent to greet with the room code in the required one-line form",
  )
})
