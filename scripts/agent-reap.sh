#!/usr/bin/env bash
set -euo pipefail

# Act on the orphans agent-status.sh reports (spec 4.6).
#
# Dry run by default: it prints each orphan, why it is considered one, and what it would reclaim.
# --yes executes.
#
# The safety rule mirrors `git branch -d`. Unmerged branch or dirty worktree means REFUSE, loudly.
# A refusal is printed, never skipped silently, so a genuinely stuck slot is visible.

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$HERE/lib/agent-slot.sh"

EXECUTE=0
case "${1:-}" in
  --yes) EXECUTE=1 ;;
  ""|--dry-run) EXECUTE=0 ;;
  *) echo "usage: agent-reap.sh [--yes]" >&2; exit 2 ;;
esac

MAIN=$(agent_main_root)
REAPED=0
REFUSED=0
FAILED=0
FOUND=0

act() {
  if [ "$EXECUTE" = "1" ]; then return 0; fi
  return 1
}

refuse() {
  REFUSED=$((REFUSED + 1))
  printf '  REFUSED  %s\n' "$*"
}

# A destructive step that fails is not a refusal (the script never decided to act, it tried and
# the world said no): count and report it separately, so an operator can tell "reaped everything",
# "refused N stuck slots" and "attempted N, M of them failed mid-flight" apart at a glance.
fail() {
  FAILED=$((FAILED + 1))
  printf '  FAILED   %s\n' "$*"
}

echo "agent-reap: $([ "$EXECUTE" = "1" ] && echo 'EXECUTING' || echo 'DRY RUN, pass --yes to execute')"
echo ''

# --- orphan class 1: a worktree whose branch is fully merged into main ------
#
# `while read` fed by process substitution: `for x in $(...)` word-splits a path containing a
# space, and a pipe would put the loop in a subshell where the FOUND/REAPED/REFUSED counters
# printed at the end would read back as 0.
while IFS= read -r wt; do
  [ "$wt" != "$MAIN" ] || continue
  [ -d "$wt" ] || continue

  branch=$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')
  [ -n "$branch" ] && [ "$branch" != "HEAD" ] || continue
  # `main` is only ever meant to be checked out in the main tree, but nothing enforces that, so a
  # linked worktree sitting on `main` must be skipped rather than treated as a candidate.
  [ "$branch" != "main" ] || continue
  # -F: the branch name is not a regex. `-x` alone still lets two branches differing by one
  # character at a `.` (the only metacharacter git's ref format allows) false-match.
  git -C "$MAIN" branch --merged main --format='%(refname:short)' | grep -Fqx "$branch" || continue

  FOUND=$((FOUND + 1))
  slot=$(agent_slot_of_worktree "$wt" 2>/dev/null || true)

  # `branch --merged main` lists any branch that is an ancestor of main INCLUSIVE, so a worktree
  # `agent-up.sh` just cut from main (zero commits of its own, the documented first step of the
  # protocol) is "fully merged" from the instant it exists, same shape as work that genuinely
  # already landed, and tip comparison cannot tell the two apart either (a fast-forward or
  # merge-commit merge leaves the branch's own tip exactly where it was created). The branch's OWN
  # reflog can: `git worktree add -b` writes exactly one entry (its creation), every commit made
  # on the branch appends another, and merging it into main never touches its own ref, either
  # merge shape. See agent_branch_has_own_commits in lib/agent-slot.sh.
  if ! agent_branch_has_own_commits "$MAIN" "$branch"; then
    if [ -n "$slot" ]; then
      refuse "$wt (slot $slot) branch $branch is merged into main but its reflog shows no commits of its own. This is what agent-up.sh's output looks like the instant it is cut, before any work; it can also be an old branch whose reflog has since expired. Not reaping it automatically: if you are certain it is done, agent-down.sh $slot by hand."
    else
      refuse "$wt branch $branch is merged into main but its reflog shows no commits of its own. This is what agent-up.sh's output looks like the instant it is cut, before any work; it can also be an old branch whose reflog has since expired. Not reaping it automatically: if you are certain it is done, git worktree remove $wt by hand."
    fi
    continue
  fi

  # The reflog check above cannot see the OTHER shape it was meant to close: an already-merged
  # branch RE-PROVISIONED onto a brand new worktree (`git worktree add path branch`, no `-b`).
  # That command never moves the branch ref, so the reflog and its commit count are exactly what
  # they were when the branch genuinely carried work, and `git status --porcelain` reads clean
  # since everything the worktree adds is gitignored. Compare the worktree's own `.git` pointer
  # file's mtime against the branch tip's own commit date instead: the pointer is written once, at
  # provision time, and never rewritten by a commit, so in the normal flow (provision, then commit,
  # then merge) it always PREDATES the tip; re-provisioning writes a brand new pointer strictly
  # AFTER the tip, because there is nothing left to commit onto an already-merged branch.
  if agent_worktree_provisioned_after_tip "$wt" "$MAIN" "$branch"; then
    if [ -n "$slot" ]; then
      refuse "$wt (slot $slot) branch $branch carries real commits by its reflog, but this worktree was provisioned onto it AFTER its last commit (its .git pointer is not older than the branch tip). This is a merged branch re-provisioned onto a new worktree, not work in progress. If you are certain, agent-down.sh $slot by hand."
    else
      refuse "$wt branch $branch carries real commits by its reflog, but this worktree was provisioned onto it AFTER its last commit (its .git pointer is not older than the branch tip). This is a merged branch re-provisioned onto a new worktree, not work in progress. If you are certain, git worktree remove $wt by hand."
    fi
    continue
  fi

  # A live web or Metro port means an agent is actively using this slot right now, even though its
  # reflog just proved it carries real commits: refuse rather than call it an orphan.
  if [ -n "$slot" ] && { agent_port_busy "$(agent_web_port "$slot")" || agent_port_busy "$(agent_metro_port "$slot")"; }; then
    refuse "$wt is slot $slot and has a live web or Metro port. agent-stop.sh $slot it first, then re-run."
    continue
  fi

  printf '  ORPHAN   %s\n' "$wt"
  if mb=$(du -sm "$wt" 2>/dev/null | awk '{print $1}'); then
    printf '           branch %s is fully merged into main, about %s MB reclaimable\n' "$branch" "$mb"
  else
    printf '           branch %s is fully merged into main (could not measure size, du failed)\n' "$branch"
  fi

  if [ -n "$(git -C "$wt" status --porcelain)" ]; then
    refuse "$wt has uncommitted changes. Commit or discard them, then re-run."
    continue
  fi

  # Each destructive call is the condition of an `if`, never a bare statement, so a non-zero exit
  # does not trip `set -e`: a failure is caught, reported, counted, and the loop moves on to the
  # next orphan rather than aborting the whole run and losing the summary (and every orphan not
  # yet visited) with it. Nothing here rolls back what already succeeded.
  if act; then
    if [ -n "$slot" ]; then
      if "$HERE/agent-down.sh" "$slot"; then
        REAPED=$((REAPED + 1))
      else
        fail "$wt (slot $slot): agent-down.sh $slot failed partway. Re-run agent-down.sh $slot by hand once resolved, or re-run agent-reap.sh to retry."
      fi
    else
      if git -C "$MAIN" worktree remove "$wt"; then
        REAPED=$((REAPED + 1))
      else
        fail "$wt: git worktree remove failed. Verified on git 2.50.1: this can fail on the directory delete (e.g. an immutable file) while still dropping the worktree's git admin entry, so it stops appearing in git worktree list and neither this script nor agent-status.sh will ever see it again. Re-running agent-reap.sh will NOT help. Remove the directory yourself (rm -rf $wt), then run: git worktree prune"
      fi
    fi
  else
    if [ -n "$slot" ]; then
      printf '           would run: agent-down.sh %s\n' "$slot"
    else
      printf '           would run: git worktree remove %s\n' "$wt"
    fi
  fi
done < <(git worktree list --porcelain | awk '/^worktree /{print substr($0,10)}')

# --- orphan class 2: a slot database with no worktree -----------------------
claimed=$(while IFS= read -r wt; do
  [ -d "$wt" ] && agent_slot_of_worktree "$wt" 2>/dev/null || true
done < <(git worktree list --porcelain | awk '/^worktree /{print substr($0,10)}') | tr '\n' ' ')

for n in 1 2 3 4 5 6 7 8 9; do
  case " $claimed " in *" $n "*) continue ;; esac
  db=$(agent_db_name "$n")
  agent_db_exists "$db" || continue

  FOUND=$((FOUND + 1))
  size=$(psql -U "$AGENT_PG_USER" -d postgres -tAc \
         "select pg_size_pretty(pg_database_size('$db'))" 2>/dev/null || echo 'unknown')
  printf '  ORPHAN   database %s\n' "$db"
  printf '           slot %s has no worktree, %s reclaimable\n' "$n" "$size"
  if act; then
    if dropdb -U "$AGENT_PG_USER" "$db"; then
      REAPED=$((REAPED + 1))
    else
      fail "database $db: dropdb failed (something still holds a connection to it, a surviving next-server is the usual cause). Re-run agent-reap.sh once the connection is closed."
    fi
  else
    printf '           would run: dropdb %s\n' "$db"
  fi
done

# --- orphan class 3: a listening slot port with no worktree -----------------
for n in 1 2 3 4 5 6 7 8 9; do
  case " $claimed " in *" $n "*) continue ;; esac
  for port in "$(agent_web_port "$n")" "$(agent_metro_port "$n")"; do
    agent_port_busy "$port" || continue
    FOUND=$((FOUND + 1))
    printf '  ORPHAN   port %s is listening and slot %s has no worktree\n' "$port" "$n"
    # Never killed automatically: this process is not provably ours, and killing an
    # unidentified listener is the kind of automated destruction this script exists to avoid.
    refuse "will not kill an unidentified process. Inspect: lsof -nP -iTCP:$port -sTCP:LISTEN"
  done
done

# --- orphan class 4: a simulator lock whose holder is dead ------------------
SIM_LOCK="$AGENT_SIM_LOCK"
if [ -f "$SIM_LOCK" ]; then
  lpid=$(sed -n '/^PID=/{s///p;q;}' "$SIM_LOCK" 2>/dev/null || true)
  if ! agent_sim_lock_alive "$SIM_LOCK"; then
    FOUND=$((FOUND + 1))
    printf '  ORPHAN   simulator lock held by dead pid %s\n' "$lpid"
    if act; then
      if rm -f "$SIM_LOCK" 2>/dev/null; then
        REAPED=$((REAPED + 1))
      else
        fail "simulator lock $SIM_LOCK: rm failed. Remove it by hand."
      fi
    else
      printf '           would run: rm %s\n' "$SIM_LOCK"
    fi
  fi
fi

# Printed unconditionally, even after a destructive step failed partway through: the operator
# needs "reaped everything" and "reaped some, failed one, refused two" to look different, both by
# reading this and by exit status, never by the script having silently stopped short instead.
echo ''
if [ "$FOUND" = "0" ]; then
  echo "agent-reap: no orphans found."
else
  printf 'agent-reap: %s orphans found, %s reaped, %s refused, %s failed.\n' "$FOUND" "$REAPED" "$REFUSED" "$FAILED"
fi
[ "$REFUSED" = "0" ] || echo "agent-reap: refusals above are stuck slots, not noise. Resolve them by hand."
[ "$FAILED" = "0" ] || echo "agent-reap: failures above did not roll back; whatever succeeded before each one stays done. Resolve them, then re-run."
[ "$FAILED" = "0" ] || exit 1
