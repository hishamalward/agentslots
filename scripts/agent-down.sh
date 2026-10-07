#!/usr/bin/env bash
set -euo pipefail

# End a slot's life entirely (spec 4.6): stop everything, then remove the worktree, drop the
# database and prune. Part of merging, not an afterthought. A merged branch whose slot is still
# provisioned is the orphan case: the work is in main, so the worktree and database are waste.

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$HERE/lib/agent-slot.sh"
. "$HERE/lib/agent-lock.sh"
ORIGINAL_ARGS=("$@")
agent_config_validate
agent_require_commands git lsof psql dropdb

SLOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force) echo "agent-down: --force cannot discard code; use a human Git command after reviewing it." >&2; exit 1 ;;
    -h|--help) echo "usage: agent-down.sh <slot>" >&2; exit 2 ;;
    *) [ -z "$SLOT" ] || { echo "agent-down: unexpected argument: $1" >&2; exit 2; }
       SLOT="$1"; shift ;;
  esac
done

[ -n "$SLOT" ] || { echo "usage: agent-down.sh <slot>" >&2; exit 2; }
agent_slot_valid "$SLOT" || { echo "agent-down: slot must be in 0..$AGENT_SLOT_MAX, got '$SLOT'" >&2; exit 2; }
[ "$SLOT" != "0" ] || { echo "agent-down: refusing to destroy slot 0, the main tree." >&2; exit 1; }
agent_repo_lock "${ORIGINAL_ARGS[@]}"
agent_postgres_reachable || { echo "agent-down: PostgreSQL is unreachable for role $AGENT_PG_USER; nothing was removed" >&2; exit 1; }

MAIN=$(agent_main_root)
DB=$(agent_db_name "$SLOT")

# Find the worktree that holds this slot, by asking each one rather than trusting a registry.
#
# `while read` fed by process substitution, not `for x in $(...)`: the latter word-splits, so a
# worktree path containing a space would be torn into fragments. Process substitution rather than
# a pipe, so the loop body runs in THIS shell and the assignment to WT survives it.
WT=$(agent_worktree_for_slot "$SLOT") || {
  echo "agent-down: no identifiable workspace owns slot $SLOT; inspect resources by hand." >&2
  exit 1
}
agent_check_ownership "$WT" "destroy workspace"
agent_check_ownership "$DB" "drop database"
CLONE=0
agent_workspace_is_clone "$WT" && CLONE=1
if [ "$CLONE" = "0" ]; then
  [ -z "$(git -C "$WT" status --porcelain)" ] || { echo "agent-down: workspace has uncommitted changes; preserve them first." >&2; exit 1; }
  branch=$(git -C "$WT" symbolic-ref -q --short HEAD) || { echo "agent-down: detached workspace, preservation unknown." >&2; exit 1; }
  git -C "$MAIN" merge-base --is-ancestor "$branch" "$(agent_main_branch)" \
    || { echo "agent-down: branch is not preserved in the main branch; merge or preserve it first." >&2; exit 1; }
fi

"$HERE/agent-stop.sh" "$SLOT" || { echo "agent-down: stop failed; database and workspace retained." >&2; exit 1; }

if agent_db_exists "$DB"; then
  echo "agent-down: dropping database $DB"
  if ! dropdb -U "$AGENT_PG_USER" "$DB"; then
    echo "agent-down: FAILED to drop database $DB. Something still holds a connection to it" >&2
    echo "agent-down: workspace retained. Inspect the connection with agent-status.sh, then retry." >&2
    exit 1
  fi
else
  echo "agent-down: database $DB does not exist"
fi

if [ "$CLONE" = "1" ]; then
  ENV_PATH=$(agent_env_path "$WT")
  # Runtime state only. The independent clone and all its code belong to AgentKeel.
  ENV_TEMP=$(mktemp "$ENV_PATH.release.XXXXXX")
  sed "/^${AGENT_SLOT_KEY}=/d" "$ENV_PATH" > "$ENV_TEMP"
  mv "$ENV_TEMP" "$ENV_PATH"
  echo "agent-down: runtime released; clone retained. A human imports its reviewed SHA and uses task.py release to remove it."
else
  git -C "$MAIN" worktree remove "$WT" || { echo "agent-down: workspace removal failed; code retained where possible." >&2; exit 1; }
  git -C "$MAIN" worktree prune
  echo "agent-down: slot $SLOT released."
fi
