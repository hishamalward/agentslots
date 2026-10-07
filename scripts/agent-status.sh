#!/usr/bin/env bash
set -euo pipefail

# What is running, right now, derived from the system (spec 4.9).
#
# It stores nothing, so it cannot go stale. It also cannot answer "what was this for and what
# comes next": that is intent, and it lives in each stream's handover (spec 4.7). The two are
# complementary, which is why this script reports the handover's staleness but never its content.

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$HERE/lib/agent-slot.sh"
agent_config_validate
agent_require_commands git lsof psql
agent_postgres_reachable || { echo "agent-status: PostgreSQL is unreachable for role $AGENT_PG_USER" >&2; exit 1; }

SIM_LOCK="$AGENT_SIM_LOCK"
MAIN=$(agent_main_root)
MAIN_BRANCH=$(agent_main_branch)
git -C "$MAIN" show-ref --verify --quiet "refs/heads/$MAIN_BRANCH" \
  || { echo "agent-status: configured main branch does not exist: $MAIN_BRANCH" >&2; exit 1; }
[ ! -f "$SIM_LOCK" ] || agent_require_commands xcrun

# Deliberately no running total: the worktree loop below runs inside a pipeline, so any counter
# incremented in it lives in a subshell and reads back as 0. Each orphan prints itself, which is
# what the reader needs anyway.
note() { printf '    ORPHAN: %s\n' "$*"; }

echo "worktrees"
echo "---------"

# `git worktree list --porcelain` emits a blank-line-separated record per worktree. Parsing the
# porcelain form rather than the human one is what makes a path with a space safe.
WORKSPACES=$(agent_workspaces) || exit 1
printf '%s\n' "$WORKSPACES" | while read -r wt; do
  [ -d "$wt" ] || { printf '  %s\n    ORPHAN: workspace directory is gone; inspect Git and AgentKeel records\n' "$wt"; continue; }

  branch=$(git -C "$wt" symbolic-ref -q --short HEAD 2>/dev/null || echo '(detached)')
  tier=$(agent_tier_of_worktree "$wt")
  slot=$(agent_slot_of_worktree "$wt" || true)

  printf '  %s\n' "$wt"
  ownership=$(agent_workspace_ownership "$wt") || exit 1
  printf '    ownership %s\n' "$ownership"
  if agent_workspace_is_clone "$wt"; then printf '    independent clone: runtime release only; human AgentKeel import/release preserves code\n'; fi
  printf '    branch %s, tier %s' "$branch" "$tier"
  if [ -n "$slot" ]; then
    printf ', slot %s\n' "$slot"
    web=$(agent_web_port "$slot"); metro=$(agent_metro_port "$slot"); db=$(agent_db_name "$slot")
    if agent_port_busy "$web";   then printf '    web   %s LISTENING\n' "$web";   else printf '    web   %s free\n' "$web"; fi
    if agent_port_busy "$metro"; then printf '    metro %s LISTENING\n' "$metro"; else printf '    metro %s free\n' "$metro"; fi
    if agent_db_exists "$db"; then
      printf '    db    %s exists\n' "$db"
    elif [ "$wt" != "$MAIN" ]; then
      printf '    db    %s MISSING\n' "$db"
      note "slot $slot has no database. Re-run agent-up.sh --stack or agent-down.sh $slot."
    fi
    # Both orphan checks skip the main tree. It is slot 0, it legitimately sits idle most of the
    # day, and agent-down.sh refuses slot 0 anyway, so flagging it would make the primary status
    # tool advise destroying the shared tree on every run, and du -sm a 1.4 GB node_modules to
    # do it. The merged-branch check further down already guards the same way.
    if ! agent_workspace_is_clone "$wt" && [ "$wt" != "$MAIN" ] && ! agent_port_busy "$web" && ! agent_port_busy "$metro"; then
      if mb=$(du -sm "$wt" 2>/dev/null | awk '{print $1}'); then
        note "slot $slot has no live server. agent-down.sh $slot reclaims about ${mb} MB."
      else
        note "slot $slot has no live server. agent-down.sh $slot reclaims disk space (could not measure, du failed)."
      fi
    fi
  else
    printf '\n'
  fi

  # node_modules cloned at provision time is a snapshot, so a rebase onto a main that changed
  # dependencies leaves it behind the lockfile. The symptom is an import or version error that
  # looks like a code bug, so it is worth naming before the tests run (spec 4.3).
  if agent_dependencies_stale "$wt"; then
    printf '    dependencies MAY BE STALE; run the project dependency-install command\n'
  fi

  # Optional project state pointer, with legacy handover compatibility.
  if [ -f "$wt/.agent" ]; then
    pointer=$(sed -n '/^STATE=/{s///p;q;}' "$wt/.agent")
    pointer_label="state"
    if [ -z "$pointer" ]; then
      pointer=$(sed -n '/^HANDOVER=/{s///p;q;}' "$wt/.agent")
      pointer_label="handover"
    fi
    if [ -n "$pointer" ]; then
      if [ -f "$wt/$pointer" ]; then
        behind=$(agent_handover_behind "$wt" "$pointer" || echo '')
        if [ -n "$behind" ] && [ "$behind" -gt 0 ]; then
          printf '    %s %s is %s commits behind\n' "$pointer_label" "$pointer" "$behind"
        else
          printf '    %s %s is current\n' "$pointer_label" "$pointer"
        fi
      else
        printf '    %s %s is not present\n' "$pointer_label" "$pointer"
      fi
    fi
  else
    printf '    no .agent marker (provisioned by hand?)\n'
  fi

  # Merged but still provisioned is the orphan case: the work is in main, so the worktree and
  # database are pure waste. Naming it every run is how the reminder arrives without anyone
  # having to remember it (spec 4.6).
  #
  # `branch --merged main` lists any branch that is an ancestor of main INCLUSIVE, so a
  # freshly-provisioned worktree (its branch cut from main, zero commits of its own) is "fully
  # merged" from the instant it exists, same as a branch whose work genuinely already landed, and
  # tip comparison cannot tell the two apart either (a fast-forward or merge-commit merge leaves
  # the branch's own tip exactly where it was created). The branch's own reflog can:
  # agent_branch_has_own_commits (lib/agent-slot.sh) is true only when the reflog shows at least
  # one commit beyond the branch's creation entry, which a merge into main never touches. And
  # `main` itself is excluded: it is only ever meant to be checked out in the main tree, but
  # nothing enforces that, so a linked worktree sitting on `main` must not be called an orphan.
  if ! agent_workspace_is_clone "$wt" && [ "$wt" != "$MAIN" ] && [ "$branch" != '(detached)' ] && [ "$branch" != "$MAIN_BRANCH" ]; then
    if git -C "$MAIN" branch --merged "$MAIN_BRANCH" --format='%(refname:short)' | grep -Fqx "$branch"; then
      if agent_branch_has_own_commits "$MAIN" "$branch"; then
        if agent_worktree_provisioned_after_tip "$wt" "$MAIN" "$branch"; then
          note "branch $branch is merged into $MAIN_BRANCH, and this worktree was provisioned onto it after its last commit (a merged branch re-provisioned onto a new worktree, not work in progress). agent-reap.sh will refuse it too; agent-down.sh it by hand if you are certain."
        else
          note "branch $branch is fully merged into $MAIN_BRANCH. agent-down.sh it."
        fi
      else
        printf '    branch %s: new or preserved branch; no automatic cleanup\n' "$branch"
      fi
    fi
  fi
  echo ''
done

echo "slot resources with no worktree"
echo "-------------------------------"
# A database or a listening port whose slot no worktree claims. Derived by asking every slot,
# then subtracting the slots the worktrees above account for.
claimed=$(printf '%s\n' "$WORKSPACES" | while read -r wt; do
  [ -d "$wt" ] && agent_slot_of_worktree "$wt" || true
done | tr '\n' ' ')
found=0
n=1
while [ "$n" -le "$AGENT_SLOT_MAX" ]; do
  case " $claimed " in *" $n "*) n=$((n + 1)); continue ;; esac
  db=$(agent_db_name "$n"); web=$(agent_web_port "$n"); metro=$(agent_metro_port "$n")
  if agent_db_exists "$db"; then
    printf '  slot %s: database %s exists with no worktree. dropdb it, or agent-reap.sh.\n' "$n" "$db"
    found=$((found + 1))
  fi
  if agent_port_busy "$web"; then
    printf '  slot %s: port %s is listening with no worktree. Find it: lsof -nP -iTCP:%s -sTCP:LISTEN\n' "$n" "$web" "$web"
    found=$((found + 1))
  fi
  if agent_port_busy "$metro"; then
    printf '  slot %s: Metro port %s is listening with no worktree.\n' "$n" "$metro"
    found=$((found + 1))
  fi
  n=$((n + 1))
done
[ "$found" -gt 0 ] || echo "  none"
echo ''

echo "simulator lock"
echo "--------------"
# A lock file is a claim, not an authority (principle 3). Liveness is re-verified against the OS
# so a crashed agent cannot deadlock the simulator for everyone else.
if [ -f "$SIM_LOCK" ]; then
  lslot=$(sed -n '/^SLOT=/{s///p;q;}' "$SIM_LOCK")
  lpid=$(sed -n '/^PID=/{s///p;q;}' "$SIM_LOCK")
  ludid=$(sed -n '/^UDID=/{s///p;q;}' "$SIM_LOCK")
  if agent_sim_lock_alive "$SIM_LOCK"; then
    printf '  held by slot %s, pid %s, device %s, holder ALIVE\n' "$lslot" "$lpid" "$ludid"
  else
    printf '  held by slot %s, pid %s, device %s\n' "$lslot" "$lpid" "$ludid"
    printf '    ORPHAN: holder process or device is no longer alive. sim-lock.sh acquire will break it.\n'
  fi
else
  echo "  free"
fi
echo ''

echo "next free slot: $(agent_next_free_slot 2>/dev/null || echo "none, all $AGENT_SLOT_MAX are in use")"
