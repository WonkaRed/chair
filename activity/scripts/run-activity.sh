#!/usr/bin/env bash
# Runs the $CHAIR testnet activity bot: three accounts we control transfer, stake, unstake and claim every epoch.
# This is scripted test activity, not organic users, and every log line says so.
#
# Required: CHAIR_ACTIVITY_KEY_DIR, the directory with one `<account>.key` file per holder (the files are read by the
# bot, never by this script, and never printed or copied).
# Optional, with the values of the live testnet deployment as defaults:
#   CHAIR_RPC_URL (one endpoint or several, comma separated: reads move to the next on a failure, sends use the first), CHAIR_TOKEN, CHAIR_ACTIVITY_HOLDERS (three accounts, comma separated), CHAIR_ACTIVITY_SEED
#   CHAIR_ACTIVITY_EVERY  act in one epoch of every N (whole number, default 1; the live deployment sets 6 to save gas)
#   CHAIR_ACTIVITY_STATE_DIR  where the runner lock and the action log live (default ~/.local/state/chair-activity)
#   CHAIR_ACTIVITY_LOG   the JSON-lines action log (default activity.jsonl in the state dir)
# Extra arguments go to the bot: `--epochs <n>` stops it after n epochs (a trial). With none it runs until SIGTERM
# or SIGINT, or until a holder is under the NEAR floor (it then says so and exits 0).
# Testnet only: the bot refuses an RPC that is not testnet and any account that does not end in .testnet.
set -euo pipefail

: "${CHAIR_ACTIVITY_KEY_DIR:?set CHAIR_ACTIVITY_KEY_DIR to the directory with the holders key files}"
export CHAIR_ACTIVITY_KEY_DIR
export CHAIR_RPC_URL="${CHAIR_RPC_URL:-https://rpc.testnet.fastnear.com,https://near-testnet.drpc.org,https://rpc.testnet.near.org}"
export CHAIR_TOKEN="${CHAIR_TOKEN:-token.chair-coin-3.testnet}"
export CHAIR_ACTIVITY_HOLDERS="${CHAIR_ACTIVITY_HOLDERS:-alice.chair-coin-3.testnet,bob.chair-coin-3.testnet,carol.chair-coin-3.testnet}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
state="${CHAIR_ACTIVITY_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/chair-activity}"

if [ ! -d "$CHAIR_ACTIVITY_KEY_DIR" ]; then
  echo "run-activity: key directory not found: $CHAIR_ACTIVITY_KEY_DIR" >&2
  exit 2
fi
if [ ! -d "$root/node_modules" ] || [ ! -d "$root/../deploy/node_modules" ]; then
  echo "run-activity: dependencies are missing; run: make -C $root test (it installs both packages)" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "run-activity: node is not on PATH (Node 22.22.2 or newer is required)" >&2
  exit 2
fi

mkdir -p "$state"
export CHAIR_ACTIVITY_LOG="${CHAIR_ACTIVITY_LOG:-$state/activity.jsonl}"
# One bot per host: two would double every action and the gas.
exec 9>"$state/runner.lock"
if ! flock -n 9; then
  echo "run-activity: another runner holds $state/runner.lock" >&2
  exit 1
fi

cd "$root"
exec node src/main.ts "$@"
