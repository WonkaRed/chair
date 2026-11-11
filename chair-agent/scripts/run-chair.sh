#!/usr/bin/env bash
# Keeps the $CHAIR chair deciding once per epoch, unattended, on this machine.
#
# The agent already loops (one decision per epoch, `run` without `--once`) and already falls back to its
# rule chair when the local model is busy, down, slow or wrong. This wrapper adds only what a long run
# needs around it: a dated log outside the repo, a restart if the agent process exits, one instance at a
# time, and a clean stop on SIGTERM or SIGINT (the agent finishes the epoch it is in, then exits 0).
#
# Required: CHAIR_KEY_FILE, the path to the chair's function-call key file (its value is never read here).
# Optional, with the values of the live testnet deployment as defaults:
#   CHAIR_RPC_URL, CHAIR_TOKEN, CHAIR_ACCOUNT, CHAIR_LLM_ENDPOINT, CHAIR_LLM_MODEL
#   CHAIR_STATE_DIR   where the logs and the decision log live (default ~/.local/state/chair-agent)
# Testnet only: the agent refuses a mainnet RPC, and the key can call set_policy on the token and nothing else.
set -euo pipefail

: "${CHAIR_KEY_FILE:?set CHAIR_KEY_FILE to the path of the chair function-call key file}"
export CHAIR_KEY_FILE
export CHAIR_RPC_URL="${CHAIR_RPC_URL:-https://test.rpc.fastnear.com}"
export CHAIR_TOKEN="${CHAIR_TOKEN:-token.chair-coin-2.testnet}"
export CHAIR_ACCOUNT="${CHAIR_ACCOUNT:-challenger.chair-coin-2.testnet}"
export CHAIR_LLM_ENDPOINT="${CHAIR_LLM_ENDPOINT:-http://127.0.0.1:18020}"
export CHAIR_LLM_MODEL="${CHAIR_LLM_MODEL:-qwen3.8-27b}"

# Seconds to wait before restarting an agent that exited. The agent survives a failed epoch by itself;
# it exits only when it cannot start (RPC unreachable, key refused), so a minute costs nothing and spares the RPC.
RESTART_DELAY_S=60

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
agent="$root/dist/src/main.js"
state="${CHAIR_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/chair-agent}"

if [ ! -r "$CHAIR_KEY_FILE" ]; then
  echo "run-chair: key file not readable: $CHAIR_KEY_FILE" >&2
  exit 2
fi
if [ ! -f "$agent" ]; then
  echo "run-chair: $agent is missing; run: npm ci && npm run build (in $root)" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "run-chair: node is not on PATH (Node 22.22.2 or newer is required)" >&2
  exit 2
fi

mkdir -p "$state"
# The decision log is one file, not dated: the agent reads its supply history from it across restarts.
export CHAIR_LOG="$state/decisions.jsonl"
# The press record the press server (run-press.sh) writes: its pending questions go into the minutes of the next decision.
export CHAIR_PRESS="$state/press.jsonl"

# One chair per key: two runners would only collide on "policy already set". The agent inherits the lock,
# so a runner killed without a chance to clean up leaves it held by the agent, which is still deciding.
exec 9>"$state/runner.lock"
if ! flock -n 9; then
  echo "run-chair: another runner holds $state/runner.lock" >&2
  exit 1
fi

child=""
stop=0
on_stop() {
  stop=1
  if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null || true; fi
}
trap on_stop TERM INT

# Waits for $child. A trapped signal interrupts `wait` early, so keep waiting while the child is alive; sets rc.
await_child() {
  while :; do
    rc=0
    wait "$child" || rc=$?
    if ! kill -0 "$child" 2>/dev/null; then return; fi
  done
}

while [ "$stop" = 0 ]; do
  log="$state/chair-$(date +%F).log"
  echo "run-chair: logging to $log (stop with SIGTERM)"
  {
    echo "=== $(date -Is) runner start: token $CHAIR_TOKEN, chair $CHAIR_ACCOUNT, model $CHAIR_LLM_MODEL at $CHAIR_LLM_ENDPOINT"
  } >>"$log"
  node "$agent" run --chair llm >>"$log" 2>&1 &
  child=$!
  if [ "$stop" = 1 ]; then kill -TERM "$child" 2>/dev/null || true; fi
  await_child
  echo "=== $(date -Is) agent exited with status $rc" >>"$log"
  [ "$stop" = 0 ] || break
  sleep "$RESTART_DELAY_S" &
  child=$!
  if [ "$stop" = 1 ]; then kill -TERM "$child" 2>/dev/null || true; fi
  await_child
done
echo "run-chair: stopped"
