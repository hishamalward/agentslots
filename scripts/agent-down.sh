#!/usr/bin/env bash
set -euo pipefail

# End a slot's life entirely (spec 4.6): stop everything, then remove the worktree, drop the
# database and prune. Part of merging, not an afterthought. A merged branch whose slot is still
# provisioned is the orphan case: the work is in main, so the worktree and database are waste.

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$HERE/lib/agent-slot.sh"
agent_config_validate
agent_require_commands git lsof psql dropdb

FORCE=0
SLOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    -h|--help) echo "usage: agent-down.sh <slot> [--force]" >&2; exit 2 ;;
    *) [ -z "$SLOT" ] || { echo "agent-down: unexpected argument: $1" >&2; exit 2; }
       SLOT="$1"; shift ;;
  esac
done

[ -n "$SLOT" ] || { echo "usage: agent-down.sh <slot> [--force]" >&2; exit 2; }
agent_slot_valid "$SLOT" || { echo "agent-down: slot must be in 0..$AGENT_SLOT_MAX, got '$SLOT'" >&2; exit 2; }
[ "$SLOT" != "0" ] || { echo "agent-down: refusing to destroy slot 0, the main tree." >&2; exit 1; }
agent_postgres_reachable || { echo "agent-down: PostgreSQL is unreachable for role $AGENT_PG_USER; nothing was removed" >&2; exit 1; }

MAIN=$(agent_main_root)
DB=$(agent_db_name "$SLOT")

# Find the worktree that holds this slot, by asking each one rather than trusting a registry.
#
# `while read` fed by process substitution, not `for x in $(...)`: the latter word-splits, so a
# worktree path containing a space would be torn into fragments. Process substitution rather than
# a pipe, so the loop body runs in THIS shell and the assignment to WT survives it.
WT=$(agent_worktree_for_slot "$SLOT" 2>/dev/null || true)

"$HERE/agent-stop.sh" "$SLOT" || true

if [ -n "$WT" ]; then
  echo "agent-down: removing worktree $WT"
  # No --force by default: `git worktree remove` refuses a dirty worktree on its own, and that
  # refusal is the safety property. Automated cleanup that can eat uncommitted work is worse
  # than the orphans it prevents.
  if [ "$FORCE" = "1" ]; then
    git -C "$MAIN" worktree remove --force "$WT"
  else
    git -C "$MAIN" worktree remove "$WT" || {
      echo "agent-down: refused. The worktree has uncommitted changes." >&2
      echo "agent-down: commit them, or re-run with --force to discard them." >&2
      exit 1
    }
  fi
else
  echo "agent-down: no worktree holds slot $SLOT (already removed?)"
fi

if agent_db_exists "$DB"; then
  echo "agent-down: dropping database $DB"
  if ! dropdb -U "$AGENT_PG_USER" "$DB"; then
    echo "agent-down: FAILED to drop database $DB. Something still holds a connection to it" >&2
    echo "agent-down: (a surviving next-server is the usual cause). agent-status.sh will report" >&2
    echo "agent-down: it as a slot resource with no worktree until you close the connection and" >&2
    echo "agent-down: re-run agent-down.sh $SLOT." >&2
    git -C "$MAIN" worktree prune
    exit 1
  fi
else
  echo "agent-down: database $DB does not exist"
fi

git -C "$MAIN" worktree prune
echo "agent-down: slot $SLOT is gone. Nothing survives."
