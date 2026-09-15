# send_file — the typed path beside the `[[attach …]]` marker

**BRIEF-47.** Written when `send_file` shipped, while the marker parser still
lives. The two mechanisms coexist by design in this commit; the parser's
deletion is a later, separate step.

## Why a tool

The `[[attach <file> <caption>]]` marker is text the service hopes to
recognise, on every path, the same way. That bet was lost four times this
week (BRIEF-31; the BRIEF-46 pair; the RDV-7TAF leak before those): a marker
is a string, not an intention — nothing validates it at the moment the agent
expresses it. `send_file` is the same intent as a **typed tool call**: the
schema validates the shape, the room server validates the path, and the
result tells the agent what happened — including an unknown member id,
honestly, with no broadcast rescue.

## The contract

```
name: send_file
input: {
  file: string     // required — path relative to the served artifact directory
  caption?: string // optional one-line caption
  to?: string[]    // member_id values from roster; omitted = every member
}
```

Results, ids and booleans only (the room MCP server's HARD RULE):

- `{accepted: true, file, recipients: [{member_id, ok: true}], unknown: [ids]}` —
  accepted-for-delivery, never a delivery claim. The field is named
  `accepted`, deliberately NOT `sent`: a name is what the agent reads when
  interpreting the result, and `sent` would affirm a delivery where only an
  acceptance is known (OUTBOX §1's fault, wearing a field name).
- `{accepted: false, file, recipients: [], unknown: [ids]}` — unknown ids,
  nothing sent to anybody.
- `{accepted: false, reason: "invalid-path"}` — the path sanitizes to nothing;
  nothing is minted, nobody is notified, nothing is probed.

## The one rule that governs it

> **Everything that goes out through a tool crosses exactly the machinery a
> marker's file crosses.**

`DeliveryEngine.attempt` (src/service/delivery.ts) is the single passage: the
tool handler only resolves targets and calls the `sendFile` dep, which in
production IS `RoomService.deliverAttachment` → `MemberSender.sendAttachment`
→ `DeliveryEngine.accept` → `drain` → `attempt`. The URL probe
(src/service/probe.ts, the ONE probe) lives in `attempt`. Consequences:

- a file that is not actually being served is **never** `delivered` — the
  record goes `failed`, the agent is corrected (`reportFinalFailure`), the
  member is told the file never went (`tellMemberAttachmentFailed`);
- the tool result still says `accepted`, because that is what happened at the
  moment of the call — absence of a delivery claim is the honesty, not a
  second probe in the handler. The handler adds no probe of its own.

## Migration

This commit adds the tool; nothing is removed. `booter.ts` now teaches both
the tool and the marker. The parser deletion and the prompt flip are
deliberately separate future commits (PLAN B §1.3 / PLAN A §1.6).
