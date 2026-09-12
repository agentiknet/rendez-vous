#!/usr/bin/env bash
# Supervisor ops: routine agentproto daemon chores as one-liners.
set -euo pipefail
DAEMON_URL="${RDV_DAEMON_URL:-http://127.0.0.1:18790}"
RUNTIME_JSON="${SV_RUNTIME_JSON:-/Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/.agentproto/runtime.json}"
HELPER="$(mktemp -t sv-helper-XXXXXX.mjs)"
trap 'rm -f "$HELPER"' EXIT
cat >"$HELPER" <<'JS'
const fs = require("fs");
const [mode, ...rest] = process.argv.slice(2);
const readJson = () => JSON.parse(fs.readFileSync(0, "utf8"));
const fmtRow = (s) => [s.id, s.label ?? "-", "busy=" + !!s.busy, "awaiting=" + !!s.awaitingInput,
  "queued=" + (s.queuedPrompts ?? 0), "tools=" + (s.toolCallsThisTurn ?? 0),
  "idle=" + (s.secondsSinceLastActivity ?? "?") + "s"].join("  ");
const resolveOne = (list, t) => {
  const byId = list.find((x) => x.id === t);
  if (byId) return byId;
  const m = list.filter((x) => x.label === t && x.status === "running");
  m.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  return m[0];
};
const mustResolve = (list, t) => {
  const s = resolveOne(list, t);
  if (!s) { console.error(`no session found for '${t}'`); process.exit(1); }
  return s;
};
if (mode === "resolve") console.log(mustResolve(readJson().sessions || [], rest[0]).id);
else if (mode === "status") {
  const list = readJson().sessions || [];
  const rows = rest.length
    ? rest.map((t) => mustResolve(list, t))
    : list.filter((s) => (s.label || "").startsWith("rdv-") && s.status === "running");
  for (const s of rows) console.log(fmtRow(s));
} else if (mode === "queue") {
  for (const item of readJson().promptQueue || []) {
    const text = typeof item.message === "string" ? item.message : JSON.stringify(item.message);
    console.log(item.id + "  " + text.slice(0, 70));
  }
} else if (mode === "out") {
  const [path, nStr] = rest;
  const n = parseInt(nStr, 10) || 20;
  let raw;
  try { raw = fs.readFileSync(path, "utf8"); } catch { console.error(`no transcript at ${path}`); process.exit(1); }
  const texts = raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && typeof r.text === "string" && r.text.length > 0).map((r) => r.text);
  for (const t of texts.slice(-n)) console.log(t);
}
JS
token() { node -p "require('$RUNTIME_JSON').token"; }
api() {
  local method="$1" path="$2" body="${3:-}" tmp code resp
  tmp="$(mktemp)"
  if [[ -n "$body" ]]; then
    code=$(curl -sS -o "$tmp" -w '%{http_code}' -X "$method" "$DAEMON_URL$path" -H "authorization: Bearer $(token)" -H 'content-type: application/json' -d "$body")
  else
    code=$(curl -sS -o "$tmp" -w '%{http_code}' -X "$method" "$DAEMON_URL$path" -H "authorization: Bearer $(token)")
  fi
  resp="$(cat "$tmp")"; rm -f "$tmp"
  if (( code >= 400 )); then echo "daemon error $code: $resp" >&2; exit 1; fi
  printf '%s' "$resp"
}
resolve_id() { api GET /sessions | node "$HELPER" resolve "$1"; }
usage() {
  cat <<'USAGE'
Usage: sv.sh <command> [args]
  status [label-or-id ...]              one line/session (default: running rdv-* sessions)
  queue <id-or-label>                   prompt FIFO: queueId  first 70 chars
  send <id-or-label> [--front] [--file path | text...]
  cancel <id-or-label> <queueId>
  promote <id-or-label> <queueId>
  out <id-or-label> [n]                 last n text-bearing transcript lines (default 20)
  verify                                git state, check-types, test, forbidden-cast grep
  boxes                                 agentproto + e2b running sandboxes
USAGE
}
cmd="${1:-}"; [[ -n "$cmd" ]] || { usage; exit 1; }; shift
case "$cmd" in
  status) api GET /sessions | node "$HELPER" status "$@" ;;
  queue)
    [[ $# -ge 1 ]] || { echo "usage: sv.sh queue <id-or-label>" >&2; exit 1; }
    api GET "/sessions/$(resolve_id "$1")" | node "$HELPER" queue ;;
  send)
    [[ $# -ge 1 ]] || { usage; exit 1; }
    target="$1"; shift
    force=0; [[ "${1:-}" == "--front" ]] && { force=1; shift; }
    if [[ "${1:-}" == "--file" ]]; then
      [[ -n "${2:-}" ]] || { echo "usage: sv.sh send <id-or-label> --file <path>" >&2; exit 1; }
      prompt="$(cat "$2")"
    else
      [[ $# -ge 1 ]] || { echo "usage: sv.sh send <id-or-label> [--front] [--file path | text...]" >&2; exit 1; }
      prompt="$*"
    fi
    body=$(node -e 'console.log(JSON.stringify({prompt: process.argv[1], queue: true, force: process.argv[2] === "1"}))' "$prompt" "$force")
    api POST "/sessions/$(resolve_id "$target")/prompt?wait=false" "$body"; echo ;;
  cancel)
    [[ $# -ge 2 ]] || { echo "usage: sv.sh cancel <id-or-label> <queueId>" >&2; exit 1; }
    api DELETE "/sessions/$(resolve_id "$1")/queue/$2"; echo ;;
  promote)
    [[ $# -ge 2 ]] || { echo "usage: sv.sh promote <id-or-label> <queueId>" >&2; exit 1; }
    api POST "/sessions/$(resolve_id "$1")/queue/$2/promote"; echo ;;
  out)
    [[ $# -ge 1 ]] || { echo "usage: sv.sh out <id-or-label> [n]" >&2; exit 1; }
    node "$HELPER" out "$HOME/.agentproto/sessions/$(resolve_id "$1")/events.jsonl" "${2:-20}" ;;
  verify)
    git log --oneline -3; git status --short
    types_out="$(pnpm check-types 2>&1)" || true
    echo "check-types errors: $(grep -c 'error TS' <<<"$types_out" || true)"
    test_out="$(pnpm test 2>&1)" || true
    grep -E '^# (tests|pass|fail|cancelled|skipped|todo)' <<<"$test_out" || tail -15 <<<"$test_out"
    echo "--- forbidden casts ---"
    grep -rnE '\bas [A-Z{(]' src test scripts --include='*.ts' 2>/dev/null | grep -vE ':[0-9]+:[[:space:]]*(//|/?\*)' || echo "none found" ;;
  boxes)
    echo "--- agentproto sandbox list ---"; agentproto sandbox list
    echo "--- e2b running sandboxes ---"; : "${E2B_API_KEY:?E2B_API_KEY not set}"
    curl -sS "https://api.e2b.dev/sandboxes?state=running" -H "X-API-Key: $E2B_API_KEY" \
      | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));const list=Array.isArray(j)?j:(j.sandboxes||[]);for(const s of list)console.log(s.sandboxID||s.id,(s.metadata&&s.metadata.label)||"");' ;;
  *) usage; exit 1 ;;
esac
