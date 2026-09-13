import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import {
  listAudience,
  parseAudienceSendArgs,
  resolveTargets,
  sendAudience,
  whisperNoticeOf,
  privateDeliveryText,
  type AudienceSendBackend,
} from "../../src/audience/contract.ts"
import { UnroutedDeliveryError, type Member, type Room } from "../../src/rooms/types.ts"

function member(id: string, displayName: string, tier: Member["tier"], provider: string, joinedAt = "2026-09-12T10:00:00.000Z"): Member {
  return {
    id,
    displayName,
    tier,
    address: { provider, source: "test", contactRef: `ref-${id}` },
    joinedAt,
  }
}

function room(code: string, members: Member[]): Room {
  return {
    code,
    sessionId: undefined,
    sandboxId: undefined,
    artifactUrl: undefined,
    artifactReady: undefined,
    members,
    createdAt: "2026-09-12T10:00:00.000Z",
    updatedAt: "2026-09-12T10:00:00.000Z",
    cursor: 0,
    lastActivityAt: "2026-09-12T10:00:00.000Z",
    state: "active",
  }
}

const NOW = Date.parse("2026-09-12T10:05:00.000Z")

test("the contract module imports nothing MCP-shaped (no mcp path, no inputSchema, no tools/list, no jsonrpc)", async () => {
  const source = await readFile(new URL("../../src/audience/contract.ts", import.meta.url), "utf8")
  for (const line of source.split("\n")) {
    if (!/^import\b/.test(line) && !/^} from\b/.test(line)) continue
    assert.doesNotMatch(line, /mcp/i, `an MCP-shaped import would make this the same code moved, not a contract: ${line}`)
  }
  assert.ok(!/Mcp[A-Z]/.test(source), "an MCP type in the contract is the same code moved, not a contract")
  assert.ok(!source.includes("jsonrpc"), "JSON-RPC codes are the MCP envelope, not the contract")
})

test("audience_list lists an away pull member — present in the roster, marked away, id intact (appendix §7.1)", () => {
  // joinedAt 5 minutes before NOW, never acked: past PULL_STALE_MS, so the
  // member is stale — but it MUST still be listed, still a member.
  const stale = member("m3", "Screen", "room-web", "room-web", "2026-09-12T09:00:00.000Z")
  const live = member("m4", "Fresh", "room-web", "room-web", "2026-09-12T10:04:00.000Z")
  const listed = listAudience(room("RDV-TTTT", [member("m1", "Alice", "messenger", "telegram"), stale, live]), NOW)

  assert.equal(listed.count, 3, "presence is not membership — the stale member is still listed")
  const screen = listed.members.find((entry) => entry.memberId === "m3")
  assert.ok(screen !== undefined)
  assert.equal(screen.presence, "away")
  assert.equal(screen.mode, "pull", "the away member still holds its id and its mode")

  const fresh = listed.members.find((entry) => entry.memberId === "m4")
  assert.ok(fresh !== undefined)
  assert.equal(fresh.presence, "present")

  // Push members are never away, however old: their transport hand-off is
  // the whole story.
  const alice = listed.members.find((entry) => entry.memberId === "m1")
  assert.ok(alice !== undefined)
  assert.equal(alice.presence, "present")
  assert.equal(alice.mode, "push")
})

test("audience_send with no `to` resolves every current member, explicitly, at call time", async () => {
  const r = room("RDV-TTTT", [member("m1", "Alice", "messenger", "telegram"), member("m2", "Bob", "messenger", "whatsapp")])
  const seen: { code: string; kind: string; text: string; memberIds: readonly string[] }[] = []
  const backend: AudienceSendBackend = {
    async accept(code, kind, text, memberIds) {
      seen.push({ code, kind, text, memberIds })
      return { accepted: [...memberIds], unknown: [] }
    },
  }

  const outcome = await sendAudience(r, backend, { text: "the picnic moves to noon", privacy: "public" })
  assert.ok(outcome.ok)
  assert.deepEqual(outcome.accepted, ["m1", "m2"])
  assert.deepEqual(seen[0]?.memberIds, ["m1", "m2"])
  assert.equal(seen[0]?.kind, "say", "a public send is a say — never a system record")
  // The expansion is resolveTargets', so it is the contract's, not the
  // adapter's and not the backend's.
  assert.deepEqual(resolveTargets(r, undefined), ["m1", "m2"])
  assert.deepEqual(resolveTargets(r, ["m2"]), ["m2"])
})

test("an id matching nobody delivers to nobody and is reported — the contract carries the unknown outcome", async () => {
  const r = room("RDV-TTTT", [member("m1", "Alice", "messenger", "telegram")])
  const backend: AudienceSendBackend = {
    async accept(_code, _kind, _text, memberIds) {
      const known = new Set(["m1"])
      const accepted = memberIds.filter((id) => known.has(id))
      return { accepted, unknown: memberIds.filter((id) => !known.has(id)) }
    },
  }

  const outcome = await sendAudience(r, backend, { text: "hello", to: ["m1", "ghost"], privacy: "public" })
  assert.ok(outcome.ok)
  assert.deepEqual(outcome.accepted, ["m1"])
  assert.deepEqual(outcome.unknown, ["ghost"], "the unknown id is reported, never silently dropped, never broadcast to")
})

test("an unroutable member is an OUTCOME, not an exception (brief 07)", async () => {
  const r = room("RDV-TTTT", [member("m1", "Alice", "messenger", "telegram")])
  const backend: AudienceSendBackend = {
    async accept() {
      throw new UnroutedDeliveryError(`unroutable delivery: no delivery mode for provider "smoke-signals"`)
    },
  }

  const outcome = await sendAudience(r, backend, { text: "hello", privacy: "public" })
  assert.ok(!outcome.ok)
  assert.equal(outcome.reason, "unroutable")
  assert.match(outcome.message, /smoke-signals/)
})

test("the private-send notices are the contract's: content-free to the room, marked private to the target", () => {
  assert.equal(whisperNoticeOf("Alice"), "(the agent whispered to Alice)")
  const secret = "the vault code is 44-21"
  assert.equal(privateDeliveryText(secret), `(private) ${secret}`)
  assert.ok(!whisperNoticeOf("Alice").includes(secret), "the notice cannot carry content it is never given")
})

test("parseAudienceSendArgs: private takes exactly one id; public takes none, one, or many; errors name the argument, never the value", () => {
  const secret = "sensitive payload xyz"

  const privateOk = parseAudienceSendArgs({ text: secret, to: "m1" }, "private")
  assert.ok("input" in privateOk)
  assert.deepEqual(privateOk.input.to, ["m1"])
  assert.equal(privateOk.input.privacy, "private")

  const privateMissingTo = parseAudienceSendArgs({ text: secret }, "private")
  assert.ok("error" in privateMissingTo)
  assert.ok(!JSON.stringify(privateMissingTo).includes(secret), "the error names the argument, not the value")

  const publicOmitted = parseAudienceSendArgs({ text: secret }, "public")
  assert.ok("input" in publicOmitted)
  assert.equal(publicOmitted.input.to, undefined, "omitted means every member — deliberately, not by fallback")

  const publicArray = parseAudienceSendArgs({ text: secret, to: ["m1", " m2 "] }, "public")
  assert.ok("input" in publicArray)
  assert.deepEqual(publicArray.input.to, ["m1", "m2"])

  const publicBadTo = parseAudienceSendArgs({ text: secret, to: "m1" }, "public")
  assert.ok("error" in publicBadTo)
  assert.ok(!JSON.stringify(publicBadTo).includes(secret))

  const emptyText = parseAudienceSendArgs({ text: "   " }, "public")
  assert.ok("error" in emptyText)
})
