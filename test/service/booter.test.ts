import assert from "node:assert/strict"
import { test } from "node:test"
import { openingPrompt, resumePrompt } from "../../src/service/booter.ts"
import type { Room } from "../../src/rooms/types.ts"

function fakeRoom(code: string): Room {
  return {
    code,
    sessionId: undefined,
    sandboxId: undefined,
    artifactUrl: undefined,
    artifactReady: undefined,
    members: [],
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    cursor: 0,
    lastActivityAt: "2026-09-11T00:00:00.000Z",
    state: "active",
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

test("openingPrompt has no artifact path when called with no appDir (LocalBooter)", () => {
  const prompt = openingPrompt(fakeRoom("RDV-7F3K"))
  assert.ok(!prompt.includes(".agentproto/ui/index.html"), "LocalBooter has no artifact to point at")
})

test("openingPrompt explains the whisper syntax and its visibility rule", () => {
  const prompt = openingPrompt(fakeRoom("RDV-7F3K"))
  assert.ok(prompt.includes("[[whisper to"), "should mention the opening delimiter")
  assert.ok(prompt.includes("[[/whisper]]"), "should mention the closing delimiter")
  assert.ok(
    prompt.includes("but not what you said"),
    "should tell the agent that a whisper is visible as an event but not its content",
  )
})

test("openingPrompt with an appDir (e2b) names the exact served-page path to edit", () => {
  const prompt = openingPrompt(fakeRoom("RDV-7F3K"), { appDir: "/home/user/apps/rdv-hello" })
  assert.ok(
    prompt.includes("/home/user/apps/rdv-hello/.agentproto/ui/index.html"),
    "should name the exact file the agent must edit to change what members see",
  )
})

// --- resumePrompt ------------------------------------------------------
// A resume boots a FRESH agent session with no transcript replay. Every one
// of the properties below was missing live on 2026-09-12 and nothing
// errored: the room was `active`, replies flowed, and the agent performed a
// continuity it did not have.

test("resumePrompt tells the agent outright that it does NOT have the earlier conversation", () => {
  const prompt = resumePrompt(fakeRoom("RDV-7F3K"))

  assert.match(
    prompt,
    /do NOT have the earlier conversation/,
    "should state the transcript is gone, not leave the agent to infer it",
  )
  assert.match(prompt, /Never pretend otherwise/, "should forbid performing continuity")
})

test("resumePrompt never asks the agent to imply it remembers", () => {
  const prompt = resumePrompt(fakeRoom("RDV-7F3K"))

  assert.ok(
    !prompt.includes("Where were we?"),
    "the old greeting made a context-free agent perform remembering — it must not come back",
  )
  assert.ok(
    prompt.includes("I've lost the earlier thread"),
    "the greeting should say the thread is lost, in the required one-line form",
  )
})

test("resumePrompt keeps the whisper protocol a fresh boot gets", () => {
  const prompt = resumePrompt(fakeRoom("RDV-7F3K"))

  assert.ok(prompt.includes("[[whisper to <their display name>]]"), "a resumed room must still be able to whisper")
  assert.ok(prompt.includes("[[/whisper]]"), "should include the closing marker too")
})

test("resumePrompt with an appDir names the served-page path, so a resumed agent can still edit the artifact", () => {
  const prompt = resumePrompt(fakeRoom("RDV-7F3K"), { appDir: "/home/user/apps/rdv-hello" })

  assert.ok(
    prompt.includes("/home/user/apps/rdv-hello/.agentproto/ui/index.html"),
    "without this the resumed agent does not know which file backs the artifact",
  )
})

test("the [[ask]] syntax reaches the fresh-boot prompt and BOTH resume branches", () => {
  const room = fakeRoom("RDV-7F3K")
  const prompts: Array<[string, string]> = [
    ["fresh boot", openingPrompt(room)],
    ["resume with recap", resumePrompt(room, { appDir: "/home/user/apps/rdv-hello", recap: "Alain: red. Claire: blue." })],
    ["resume without recap", resumePrompt(room)],
  ]

  for (const [label, prompt] of prompts) {
    assert.ok(prompt.includes("[[ask <their display name>]]"), `${label} should teach the opening ask marker`)
    assert.ok(prompt.includes("[[/ask]]"), `${label} should teach the closing ask marker`)
    assert.ok(
      prompt.includes('"[Name · tier]" prefix — one member, not the whole room'),
      `${label} should say the ask addresses ONE member by their attribution name`,
    )
  }
})

test("resumePrompt carries the same capability lines as openingPrompt", () => {
  const room = fakeRoom("RDV-7F3K")
  const opts = { appDir: "/home/user/apps/rdv-hello" }
  const opening = openingPrompt(room, opts)
  const resumed = resumePrompt(room, opts)

  for (const line of [
    "Several humans drive this one session together",
    "[[whisper to <their display name>]]",
    "do not stall waiting for consensus",
    "[[ask <their display name>]]",
    "Keep replies short",
    "/home/user/apps/rdv-hello/.agentproto/ui/index.html",
  ]) {
    assert.ok(opening.includes(line), `opening prompt should contain: ${line}`)
    assert.ok(resumed.includes(line), `resume prompt should contain the same capability line: ${line}`)
  }
})
