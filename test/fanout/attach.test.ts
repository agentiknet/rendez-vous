/**
 * `[[attach …]]` — the agent sending a real file, src/fanout/attach.ts.
 *
 * The marker is agent-authored and the URL it produces is fetched by a third
 * party (the messaging provider), so the parsing tests below are as much
 * about what must NOT get through as about what must.
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import { attachmentUrl, kindAndMimeFor, parseAttachments, sanitizeName } from "../../src/fanout/attach.ts"

test("an attach marker is lifted out of the turn and never reaches a member as text", () => {
  const { text, attachments } = parseAttachments(
    ["Here's the summary you asked for.", "[[attach report.pdf]]", "Let me know if the numbers look off."].join("\n"),
  )

  assert.equal(text, "Here's the summary you asked for.\nLet me know if the numbers look off.")
  assert.equal(attachments.length, 1)
  assert.deepEqual(attachments[0], {
    name: "report.pdf",
    kind: "document",
    mimeType: "application/pdf",
    caption: undefined,
  })
})

test("the rest of the marker line is a caption", () => {
  const { attachments } = parseAttachments("[[attach chart.png the Q3 numbers you asked for]]")

  assert.equal(attachments.length, 1)
  assert.equal(attachments[0]?.caption, "the Q3 numbers you asked for")
  assert.equal(attachments[0]?.kind, "image")
})

test("several attachments in one turn all survive", () => {
  const { text, attachments } = parseAttachments(
    ["Both files:", "[[attach deck.pdf]]", "[[attach cover.png]]", "[[attach note.ogg a quick voice note]]"].join("\n"),
  )

  assert.equal(text, "Both files:")
  assert.deepEqual(
    attachments.map((a) => [a.name, a.kind]),
    [
      ["deck.pdf", "document"],
      ["cover.png", "image"],
      ["note.ogg", "audio"],
    ],
  )
})

test("a turn that is nothing but an attachment leaves empty text, not a stray marker", () => {
  const { text, attachments } = parseAttachments("[[attach invoice.pdf]]")

  assert.equal(text, "")
  assert.equal(attachments.length, 1)
})

test("the marker is only honoured on its own line", () => {
  // Otherwise any sentence mentioning the syntax would send a file.
  const inline = parseAttachments("you can write [[attach report.pdf]] to send a file")
  assert.equal(inline.attachments.length, 0)
  assert.equal(inline.text, "you can write [[attach report.pdf]] to send a file")
})

test("case and surrounding whitespace do not matter", () => {
  const { attachments } = parseAttachments("   [[ATTACH Report.PDF]]   ")
  assert.equal(attachments.length, 1)
  assert.equal(attachments[0]?.name, "Report.PDF")
  assert.equal(attachments[0]?.mimeType, "application/pdf", "extension matching is case-insensitive")
})

test("directory traversal is stripped, never resolved", () => {
  // The served artifact root is the only thing we are willing to expose.
  assert.equal(sanitizeName("../../etc/passwd"), "etc/passwd")
  assert.equal(sanitizeName("/etc/passwd"), "etc/passwd")
  assert.equal(sanitizeName("./a/../../b.png"), "a/b.png")
  assert.equal(sanitizeName("..\\..\\windows\\win.ini"), "windows/win.ini")
})

test("a marker naming nothing usable stays visible in the text instead of vanishing", () => {
  // Dropping it silently would be the exact failure this project keeps
  // finding: the agent believes it sent a file, nobody gets one, no error.
  const { text, attachments } = parseAttachments("[[attach ..]]")

  assert.equal(attachments.length, 0)
  assert.equal(text, "[[attach ..]]", "the room can see the agent tried to attach something unusable")
})

test("kind and mime are derived from the extension, with a safe default", () => {
  assert.deepEqual(kindAndMimeFor("a.pdf"), { kind: "document", mime: "application/pdf" })
  assert.deepEqual(kindAndMimeFor("a.png"), { kind: "image", mime: "image/png" })
  assert.deepEqual(kindAndMimeFor("a.ogg"), { kind: "audio", mime: "audio/ogg" })
  assert.deepEqual(kindAndMimeFor("a.mp4"), { kind: "video", mime: "video/mp4" })
  // Unknown and extensionless both become a document: every channel renders
  // one, and guessing "image" for a non-image is how a provider hard-errors.
  assert.deepEqual(kindAndMimeFor("a.zzz"), { kind: "document", mime: "application/octet-stream" })
  assert.deepEqual(kindAndMimeFor("README"), { kind: "document", mime: "application/octet-stream" })
})

test("the attachment URL is room-keyed and percent-encoded per segment", () => {
  const base = "https://rdv.example.com/r/RDV-7F3K/artifact/"

  assert.equal(attachmentUrl(base, "report.pdf"), `${base}report.pdf`)
  assert.equal(attachmentUrl(base, "Q3 report.pdf"), `${base}Q3%20report.pdf`)
  assert.equal(
    attachmentUrl(base, "sub/dir/file.png"),
    `${base}sub/dir/file.png`,
    "path separators must stay separators, not become %2F",
  )
})
