#!/usr/bin/env bash
# Puts the press server on the internet through a Cloudflare quick tunnel, and tells the page where it is.
#
# A quick tunnel needs no account and no domain, but its https://<words>.trycloudflare.com address is new every time cloudflared starts.
# So after each start this script publishes the address to a GitHub gist file, chair-press.json, that the page reads:
#   https://gist.githubusercontent.com/<owner>/<PRESS_GIST_ID>/raw/chair-press.json   ->   {"url": "https://....trycloudflare.com", "updated_at_ms": 1234}
# It then checks the tunnel every 30 s through the public address, and exits (so systemd starts it again, with a new address,
# which is published again) after three misses in a row or when cloudflared dies.
#
# Required: PRESS_GIST_ID, the id of a gist the logged-in `gh` may edit (see chair-agent/README.md, "Press conference").
# Optional: CHAIR_PRESS_PORT (default 18790), CHAIR_STATE_DIR (default ~/.local/state/chair-agent; the tunnel log goes here).
# Nothing here reads a secret: cloudflared needs none, and `gh` uses its own stored login.
set -euo pipefail

: "${PRESS_GIST_ID:?set PRESS_GIST_ID to the id of the gist that publishes the tunnel address}"
port="${CHAIR_PRESS_PORT:-18790}"
state="${CHAIR_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/chair-agent}"
mkdir -p "$state"
log="$state/press-tunnel.log"

for tool in cloudflared gh curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "run-press-tunnel: $tool is not on PATH" >&2; exit 2; }
done
# The server must be up first: a tunnel to nothing publishes an address that answers 502.
curl -fsS --max-time 5 "http://127.0.0.1:$port/health" >/dev/null || { echo "run-press-tunnel: no press server on 127.0.0.1:$port" >&2; exit 1; }

: >"$log"
# http2 rather than the default quic: it needs only outbound TCP 443, which every network lets through.
cloudflared tunnel --no-autoupdate --protocol http2 --url "http://127.0.0.1:$port" >>"$log" 2>&1 &
tunnel=$!
trap 'kill "$tunnel" 2>/dev/null || true' EXIT
trap 'exit 0' TERM INT

url=""
for _ in $(seq 1 60); do
  url="$(grep -m1 -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" || true)"
  [ -n "$url" ] && break
  kill -0 "$tunnel" 2>/dev/null || { echo "run-press-tunnel: cloudflared exited early; see $log" >&2; exit 1; }
  sleep 1
done
[ -n "$url" ] || { echo "run-press-tunnel: no tunnel address after 60 s; see $log" >&2; exit 1; }

# The new name takes a few seconds to resolve everywhere; publish only once it answers.
up=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "$url/health" >/dev/null 2>&1; then up=1; break; fi
  sleep 2
done
[ "$up" = 1 ] || { echo "run-press-tunnel: $url never answered /health" >&2; exit 1; }

body="$(printf '{"url": "%s", "updated_at_ms": %s}' "$url" "$(date +%s%3N)")"
gh api --method PATCH "gists/$PRESS_GIST_ID" -f "files[chair-press.json][content]=$body" >/dev/null
echo "run-press-tunnel: $(date -Is) published $url"

misses=0
while kill -0 "$tunnel" 2>/dev/null; do
  sleep 30
  if curl -fsS --max-time 10 "$url/health" >/dev/null 2>&1; then misses=0; else misses=$((misses + 1)); fi
  if [ "$misses" -ge 3 ]; then echo "run-press-tunnel: $url stopped answering; restarting for a new address" >&2; exit 1; fi
done
echo "run-press-tunnel: cloudflared exited; see $log" >&2
exit 1
