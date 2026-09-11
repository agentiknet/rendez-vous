#!/usr/bin/env bash
# Public tunnel for the Rendez-vous service, so agentpush's inbound
# webhooks (docs/AGENTPUSH.md §3, §8.5) can reach it. See docs/DEMO.md.
#
#   scripts/tunnel.sh --quick          random *.trycloudflare.com hostname
#   scripts/tunnel.sh --named <name>   an existing named tunnel (~/.cloudflared/<name>.yml)
#
# Either way, prints `RDV_PUBLIC_URL=https://...` on stdout once the
# hostname is known — export it: `export $(scripts/tunnel.sh --quick | grep RDV_PUBLIC_URL)`
# doesn't work for --quick (it blocks in the foreground); watch stderr for
# the line, then export it by hand in another shell.
set -euo pipefail

PORT="${RDV_PORT:-8790}"

usage() {
  echo "Usage: $0 --quick | --named <name>" >&2
  exit 1
}

[ $# -ge 1 ] || usage

case "$1" in
  --quick)
    # cloudflared logs to stderr; tee it through so progress is visible,
    # and pull the assigned https URL out as soon as it appears.
    cloudflared tunnel --url "http://127.0.0.1:${PORT}" 2>&1 | while IFS= read -r line; do
      echo "$line" >&2
      if [[ "$line" =~ (https://[a-zA-Z0-9-]+\.trycloudflare\.com) ]]; then
        echo "RDV_PUBLIC_URL=${BASH_REMATCH[1]}"
      fi
    done
    ;;
  --named)
    name="${2:-}"
    [ -n "$name" ] || usage
    config="$HOME/.cloudflared/${name}.yml"
    if [ ! -f "$config" ]; then
      echo "no config at $config" >&2
      exit 1
    fi
    hostname=$(grep -m1 'hostname:' "$config" | awk '{print $2}')
    if [ -z "$hostname" ]; then
      echo "no hostname found in $config" >&2
      exit 1
    fi
    echo "RDV_PUBLIC_URL=https://${hostname}"
    exec cloudflared tunnel --config "$config" run "$name"
    ;;
  *)
    usage
    ;;
esac
