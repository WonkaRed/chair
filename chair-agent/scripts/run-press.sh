#!/usr/bin/env bash
# Runs the press-conference server for the $CHAIR page on this machine: 127.0.0.1 only; the tunnel (run-press-tunnel.sh) is what faces the internet.
# Run it as a systemd user unit so it restarts and stays up: see "Press conference" in chair-agent/README.md.
#
# Optional, with the values of the live deployment as defaults:
#   CHAIR_LLM_ENDPOINT, CHAIR_LLM_MODEL   the model on this machine that answers
#   CHAIR_PRESS_PORT                      default 18790
#   CHAIR_RPC_URL, CHAIR_TOKEN, CHAIR_ACCOUNT   the chain, the token and the chair account (as run-chair.sh); only "Make the Chair overreach" and "Join the Committee" read them
#   CHAIR_OVERREACH_KEY_FILE              the chair account's key file; set it (the unit does) to switch "Make the Chair overreach" on, unset it to switch it off
#   CHAIR_VISITOR_ACCOUNT, CHAIR_VISITOR_KEY_FILE   the visitor pool account and its key file; both set (the unit does) switch "Join the Committee" on, unset it to switch it off. No defaults: the unit names the pool account
#   CHAIR_STATE_DIR                       where press.jsonl lives (default ~/.local/state/chair-agent), shared with run-chair.sh
set -euo pipefail

export CHAIR_LLM_ENDPOINT="${CHAIR_LLM_ENDPOINT:-http://127.0.0.1:18020}"
export CHAIR_LLM_MODEL="${CHAIR_LLM_MODEL:-qwen3.8-27b}"
export CHAIR_PRESS_PORT="${CHAIR_PRESS_PORT:-18790}"
export CHAIR_RPC_URL="${CHAIR_RPC_URL:-https://test.rpc.fastnear.com}"
export CHAIR_TOKEN="${CHAIR_TOKEN:-token.chair-coin-2.testnet}"
export CHAIR_ACCOUNT="${CHAIR_ACCOUNT:-challenger.chair-coin-2.testnet}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
state="${CHAIR_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/chair-agent}"

if [ ! -f "$root/dist/src/main.js" ]; then
  echo "run-press: $root/dist/src/main.js is missing; run: npm ci && npm run build (in $root)" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "run-press: node is not on PATH (Node 22.22.2 or newer is required)" >&2
  exit 2
fi

mkdir -p "$state"
export CHAIR_PRESS="$state/press.jsonl"
exec node "$root/dist/src/main.js" press
