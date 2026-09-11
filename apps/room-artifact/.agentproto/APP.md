---
schema: app/v1
id: rdv-room-artifact
name: Rendez-vous Room Artifact
version: 0.1.0
agents: []
workflows: []
ui:
  path: .agentproto/ui/index.html
  title: Rendez-vous Room Artifact
---

The smallest possible agentproto app: no agents, no workflows, just a UI —
the placeholder artifact a Rendez-vous room boots into a sandbox and serves
back to its members (architecture.md §3 "Sandbox plus artifact").

UI-only apps are explicitly supported by `defineApp` (`app-kit/src/define-app.ts`):
"an app needs at least one agent, or a `ui` block for a UI-only app". This
one has neither agents nor workflows, only `ui`.

The UI lives at `.agentproto/ui/index.html`, not `ui/index.html` —
`agentproto app serve` hardcodes that path and does not read the `ui.path`
frontmatter field to find it (only `app_install`/`loadAppHandle` does).
Putting it anywhere else installs fine and then never actually serves
(docs/UPSTREAM.md, "Second live attempt" section).
