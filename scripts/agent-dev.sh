#!/usr/bin/env bash
set -euo pipefail

# Start the web dev server on THIS worktree's slot port (spec 4.4.4).
#
# The port is an explicit -p flag, never the PORT env var: whether next dev picks PORT up from a
# .env file depends on env-loading order, and a silent fallback to 3000 collides with the main
# stack, which is the exact failure this design exists to prevent.

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$HERE/lib/agent-slot.sh"
agent_config_validate
agent_require_commands git lsof

WT=$(git rev-parse --show-toplevel)
TIER=$(agent_tier_of_worktree "$WT")
BRANCH=$(git -C "$WT" rev-parse --abbrev-ref HEAD)

if [ "$TIER" = "code" ]; then
  cat >&2 <<EOF
agent-dev: this worktree is code tier (no slot, no database)
run: scripts/agent-up.sh $BRANCH --stack

Starting a server here would boot fine and then fail on every database-backed route,
which reads as a code bug rather than a missing tier.
EOF
  exit 1
fi

SLOT=$(agent_slot_of_worktree "$WT")
PORT=$(agent_web_port "$SLOT")

if agent_port_busy "$PORT"; then
  echo "agent-dev: port $PORT is already listening. Another server holds slot $SLOT." >&2
  echo "run: scripts/agent-status.sh" >&2
  exit 1
fi

echo "agent-dev: slot $SLOT, http://localhost:$PORT"
agent_start_web "$WT" "$PORT" "$@"
