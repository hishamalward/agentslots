#!/usr/bin/env bash
set -euo pipefail

# End a slot's processes, keep its state (spec 4.6).
#
# Kills the dev server and Metro, shuts the simulator and releases the sim lock if this slot
# holds it. The worktree and the database survive, so work resumes instantly.

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$HERE/lib/agent-slot.sh"

SIM_LOCK="$AGENT_SIM_LOCK"

[ $# -ge 1 ] || { echo "usage: agent-stop.sh <slot>" >&2; exit 2; }
SLOT="$1"
agent_slot_valid "$SLOT" || { echo "agent-stop: slot must be a digit 0..9, got '$SLOT'" >&2; exit 2; }
[ "$SLOT" != "0" ] || { echo "agent-stop: refusing to stop slot 0, the main tree. Stop it by hand." >&2; exit 1; }

kill_port() {
  local port="$1" label="$2" pids
  pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -z "$pids" ]; then
    echo "agent-stop: $label port $port already free"
    return 0
  fi
  echo "agent-stop: killing $label on port $port (pids: $(echo "$pids" | tr '\n' ' '))"
  echo "$pids" | xargs kill 2>/dev/null || true
  sleep 2
  pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "agent-stop: $label did not exit, sending KILL"
    echo "$pids" | xargs kill -9 2>/dev/null || true
    sleep 2
    pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
    if [ -n "$pids" ]; then
      echo "agent-stop: WARNING, $label port $port is STILL HELD after KILL (pids: $(echo "$pids" | tr '\n' ' ')). agent-down.sh's dropdb may fail while this holds a database connection open." >&2
    fi
  fi
}

kill_port "$(agent_web_port "$SLOT")" "web"
kill_port "$(agent_metro_port "$SLOT")" "Metro"

# Teardown must not strand the simulator lock (spec 4.5).
if [ -f "$SIM_LOCK" ] && [ "$(sed -n '/^SLOT=/{s///p;q;}' "$SIM_LOCK")" = "$SLOT" ]; then
  echo "agent-stop: releasing the simulator lock held by slot $SLOT"
  "$HERE/sim-lock.sh" release "$SLOT" || echo "agent-stop: sim-lock release reported a problem, continuing"
fi

echo "agent-stop: slot $SLOT stopped. Worktree and database $(agent_db_name "$SLOT") survive."
echo "agent-stop: update your handover ledger before you walk away (spec 4.7)."
