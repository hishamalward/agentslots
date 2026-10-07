#!/usr/bin/env bash
set -euo pipefail

# End a slot's processes, keep its state (spec 4.6).
#
# Kills the dev server and Metro, shuts the simulator and releases the sim lock if this slot
# holds it. The worktree and the database survive, so work resumes instantly.

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$HERE/lib/agent-slot.sh"
. "$HERE/lib/agent-lock.sh"
ORIGINAL_ARGS=("$@")
agent_config_validate
agent_require_commands git lsof

SIM_LOCK="$AGENT_SIM_LOCK"

[ $# -eq 1 ] || { echo "usage: agent-stop.sh <slot>" >&2; exit 2; }
SLOT="$1"
agent_slot_valid "$SLOT" || { echo "agent-stop: slot must be in 0..$AGENT_SLOT_MAX, got '$SLOT'" >&2; exit 2; }
[ "$SLOT" != "0" ] || { echo "agent-stop: refusing to stop slot 0, the main tree. Stop it by hand." >&2; exit 1; }

agent_repo_lock "${ORIGINAL_ARGS[@]}"

WT=$(agent_worktree_for_slot "$SLOT") || {
  echo "agent-stop: refusing slot $SLOT because no identifiable workspace claims it." >&2
  exit 1
}
agent_check_ownership "$WT" "stop workspace"
agent_check_ownership "$(agent_db_name "$SLOT")" "stop database"
agent_check_ownership "$(agent_web_port "$SLOT")" "stop web"
agent_check_ownership "$(agent_metro_port "$SLOT")" "stop Metro"

agent_stop_port "$(agent_web_port "$SLOT")" "$WT"
agent_stop_port "$(agent_metro_port "$SLOT")" "$WT"

# Teardown must not strand the simulator lock (spec 4.5).
if [ -f "$SIM_LOCK" ] && [ "$(sed -n '/^SLOT=/{s///p;q;}' "$SIM_LOCK")" = "$SLOT" ] \
   && [ "$(sed -n '/^REPO=/{s///p;q;}' "$SIM_LOCK")" = "$(agent_main_root)" ]; then
  agent_require_commands xcrun
  echo "agent-stop: releasing the simulator lock held by slot $SLOT"
  "$HERE/sim-lock.sh" release "$SLOT"
fi

echo "agent-stop: slot $SLOT stopped. Worktree and database $(agent_db_name "$SLOT") survive."
