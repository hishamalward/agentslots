#!/usr/bin/env bash
set -euo pipefail

# Start Metro on THIS worktree's slot port (spec 4.4.4).
#
# Same tier guard as agent-dev.sh. The mobile bundle id is shared and cannot be slotted, so
# driving the simulator additionally needs scripts/sim-lock.sh acquire <N>.

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$HERE/lib/agent-slot.sh"
agent_config_validate
agent_require_commands git lsof

WT=$(git rev-parse --show-toplevel)
TIER=$(agent_tier_of_worktree "$WT")
BRANCH=$(git -C "$WT" rev-parse --abbrev-ref HEAD)

if [ "$TIER" = "code" ]; then
  cat >&2 <<EOF
agent-mobile: this worktree is code tier (no slot, no database)
run: scripts/agent-up.sh $BRANCH --stack
EOF
  exit 1
fi

SLOT=$(agent_slot_of_worktree "$WT")
PORT=$(agent_metro_port "$SLOT")
WEB_PORT=$(agent_web_port "$SLOT")

if agent_port_busy "$PORT"; then
  echo "agent-mobile: Metro port $PORT is already listening. Another Metro holds slot $SLOT." >&2
  echo "run: scripts/agent-status.sh" >&2
  exit 1
fi

echo "agent-mobile: slot $SLOT, Metro on $PORT"
echo "agent-mobile: this slot's API is on $WEB_PORT. Point the app at it if you are testing"
echo "              against this stack rather than the main one."
echo "agent-mobile: the simulator is exclusive. Take the lock first: scripts/sim-lock.sh acquire $SLOT"
agent_start_mobile "$WT" "$PORT" "$@"
