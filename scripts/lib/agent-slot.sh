#!/usr/bin/env bash
# The shared derivation contract for the multi-agent slot model (spec 4.1).
#
# Every agent-*.sh script sources this and derives its values here, so eight scripts cannot
# disagree about what slot 3's database is called. Change a formula here, not in a consumer.
#
# Sourced, never executed. It deliberately does NOT set shell options: `set -euo pipefail` in a
# sourced file changes the behaviour of whatever sourced it. Each executable sets its own.
#
# bash 3.2 compatible (the macOS system bash): no associative arrays, no mapfile, no ${v,,}.

# The local Postgres role. docs/dev-environment.md is the authority for this value; the override
# exists so a machine that differs does not need the library edited.
AGENT_PG_USER="${AGENT_PG_USER:-tracker}"

# The simulator lock's path (spec 4.5). sim-lock.sh, agent-status.sh, agent-stop.sh and
# agent-reap.sh all derived this path independently until now, which is the exact duplication
# this library exists to eliminate. Overridable the same way AGENT_PG_USER is, so a test can point
# it at a scratch file instead of this machine-global, possibly-concurrently-held real path.
AGENT_SIM_LOCK="${AGENT_SIM_LOCK:-$HOME/.music_analytics/sim.lock}"

# --- pure derivation, no I/O ------------------------------------------------

# agent_slot_valid <slot>: true for a single digit 0..9 (spec 4.1 allows 0 plus 1..9).
agent_slot_valid() {
  case "${1:-}" in
    [0-9]) return 0 ;;
    *) return 1 ;;
  esac
}

# agent_branch_slug <branch>: strips the <type>/ prefix and flattens any remaining slash.
# This names the WORKTREE, so it KEEPS a -pN phase suffix: feat/weekly-recap-p2 gives
# weekly-recap-p2, which is what stops two phases of one stream colliding on ../ma-weekly-recap.
agent_branch_slug() {
  printf '%s\n' "${1#*/}" | tr '/' '-'
}

# agent_stream_slug <branch>: the branch slug with a -p<N> phase suffix removed. This names the
# HANDOVER, because a stream keeps one handover across its phases (spec 4.8).
agent_stream_slug() {
  agent_branch_slug "$1" | sed -E 's/-p[0-9]+$//'
}

# agent_db_name <slot>: slot 0 is the untouched main database.
agent_db_name() {
  if [ "$1" = "0" ]; then printf 'music_analytics_dev\n'
  else printf 'music_analytics_a%s\n' "$1"; fi
}

# agent_boss_schema <slot>: slot 0 keeps pg-boss's default schema, so an unset PGBOSS_SCHEMA is
# byte-identical to today (spec principle 4).
agent_boss_schema() {
  if [ "$1" = "0" ]; then printf 'pgboss\n'
  else printf 'pgboss_a%s\n' "$1"; fi
}

# agent_web_port <slot>: 3000 + 100N. Slot 0 gives 3000, today's port.
agent_web_port() { printf '%s\n' "$(( 3000 + 100 * $1 ))"; }

# agent_metro_port <slot>: 8081 + 100N. Slot 0 gives 8081, today's port.
agent_metro_port() { printf '%s\n' "$(( 8081 + 100 * $1 ))"; }

# --- paths ------------------------------------------------------------------

# agent_main_root: absolute path of the MAIN worktree, always the first entry of
# `git worktree list`. Deriving from it means a script run inside a linked worktree still
# resolves siblings correctly.
agent_main_root() {
  git worktree list --porcelain | sed -n '1s/^worktree //p'
}

# agent_worktree_path <branch>: a SIBLING of the main worktree, never nested (spec 4.8).
agent_worktree_path() {
  printf '%s/ma-%s\n' "$(dirname "$(agent_main_root)")" "$(agent_branch_slug "$1")"
}

# agent_handover_path <branch>: repo-relative path of the stream's handover (spec 4.7).
agent_handover_path() {
  printf 'docs/plans/%s-handover.md\n' "$(agent_stream_slug "$1")"
}

# --- reality probes: ask the system, never a registry file (spec principle 2) ---

# agent_db_exists <dbname>
agent_db_exists() {
  psql -U "$AGENT_PG_USER" -d postgres -tAc \
    "select 1 from pg_database where datname = '$1'" 2>/dev/null | grep -q '^1$'
}

# agent_port_busy <port>: something is LISTENING right now.
agent_port_busy() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1
}

# agent_sim_lock_alive <lockfile>: the shared liveness rule for the simulator lock (spec 4.5).
# The booted UDID is checked FIRST and the recorded PID only as a fallback: the device outlives
# the shell that booted it and is the resource actually being contended, not the invoking shell.
# sim-lock.sh originated this rule; it used to be the only one of three consumers (sim-lock.sh,
# agent-status.sh, agent-reap.sh) that implemented it correctly, so the other two could call a
# live-UDID lock dead and destroy it. One definition here, called by all three.
#
# A lock naming no UDID and no live PID reads as dead. A missing lock file also reads dead: the
# caller should check existence first if it needs to distinguish "no lock" from "dead lock".
agent_sim_lock_alive() {
  local pid udid
  udid=$([ -f "$1" ] && sed -n '/^UDID=/{s///p;q;}' "$1" || true)
  if [ -n "$udid" ] && xcrun simctl list devices booted 2>/dev/null | grep -q "$udid"; then
    return 0
  fi
  pid=$([ -f "$1" ] && sed -n '/^PID=/{s///p;q;}' "$1" || true)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# agent_slot_free <slot>: free when its database does not exist and neither port is listening.
agent_slot_free() {
  agent_db_exists "$(agent_db_name "$1")" && return 1
  agent_port_busy "$(agent_web_port "$1")" && return 1
  agent_port_busy "$(agent_metro_port "$1")" && return 1
  return 0
}

# agent_next_free_slot: the lowest free slot in 1..9. Slot 0 is the main tree and is never
# assigned.
agent_next_free_slot() {
  local n
  for n in 1 2 3 4 5 6 7 8 9; do
    if agent_slot_free "$n"; then printf '%s\n' "$n"; return 0; fi
  done
  echo "agent-slot: no free slot in 1..9, every slot has a database or a listening port" >&2
  return 1
}

# --- worktree introspection -------------------------------------------------

# agent_tier_of_worktree <dir>: main, stack or code. Derived, never read from a written copy.
# A stack tier is exactly a worktree whose apps/web/.env carries AGENT_SLOT, which spec 4.4.3
# requires it to, because Prisma and tsx read .env and a slot known only to one shell would let
# another process run cron.
agent_tier_of_worktree() {
  if [ "$1" = "$(agent_main_root)" ]; then printf 'main\n'; return 0; fi
  if [ -f "$1/apps/web/.env" ] && grep -q '^AGENT_SLOT=' "$1/apps/web/.env"; then
    printf 'stack\n'
  else
    printf 'code\n'
  fi
}

# agent_slot_of_worktree <dir>: prints the slot and returns 0, or prints nothing and returns 1
# for a code-tier worktree, which HAS no slot. Do not substitute 0 for that: slot 0 is the main
# tree and the only schedule owner.
agent_slot_of_worktree() {
  if [ "$1" = "$(agent_main_root)" ]; then printf '0\n'; return 0; fi
  local v
  if [ -f "$1/apps/web/.env" ]; then
    # Read the first matching line with no pipe: `sed ... | head -1` can return 141 under
    # `set -o pipefail` when sed outruns head, the same family as plan 1's `npm run dev | head`.
    #
    # The form is `/^KEY=/{s///p;q;}`, NOT `s/^KEY=//{p;q;}`. The latter is a GNU extension and is
    # a hard syntax error on the BSD sed macOS ships ("bad flag in substitute command: '{'"), so
    # it fails on every run on the only platform this design targets. The empty regex in `s///`
    # reuses the address regex and is POSIX, so this form works on both.
    v=$(sed -n '/^AGENT_SLOT=/{s///p;q;}' "$1/apps/web/.env" | tr -d "\"' ")
    if [ -n "$v" ]; then printf '%s\n' "$v"; return 0; fi
  fi
  return 1
}

# agent_node_modules_stale <dir>: true when package-lock.json is newer than the .package-lock.json
# npm writes inside node_modules, which is what a rebase across a dependency change leaves behind
# (spec 4.3).
#
# This is an mtime heuristic and it OVER-REPORTS: a plain worktree checkout touches
# package-lock.json without changing a dependency. Over-reporting is the safe direction, because
# the remedy is `npm install`, which is idempotent and fast when nothing changed. Callers must
# word this as "may be stale", never "is stale".
agent_node_modules_stale() {
  [ -f "$1/package-lock.json" ] || return 1
  [ -f "$1/node_modules/.package-lock.json" ] || return 0
  [ "$1/package-lock.json" -nt "$1/node_modules/.package-lock.json" ]
}

# agent_branch_reflog_count <repo> <branch>: reflog entries for BRANCH's OWN ref, not HEAD's.
# `git worktree add -b BRANCH path main` writes exactly one entry for BRANCH (its creation), and
# every subsequent commit made while BRANCH is checked out appends another, because committing
# moves the ref the reflog is keyed to. Merging BRANCH into main, fast-forward or via a merge
# commit, never touches BRANCH's own ref (only main's ref moves), so the count survives either
# merge shape unchanged. Prints 0 when the branch has no reflog: missing, expired, or the ref does
# not exist. Local-only like all reflogs, and reachable entries expire on a default gc schedule
# (roughly 90 days), so this is not permanent history, only a recent one.
agent_branch_reflog_count() {
  local out
  out=$(git -C "$1" reflog show "$2" 2>/dev/null) || true
  [ -n "$out" ] || { printf '0\n'; return 0; }
  printf '%s\n' "$out" | wc -l | tr -d ' '
}

# agent_branch_has_own_commits <repo> <branch>: true only when the branch's reflog proves at
# least one commit happened on it beyond its creation. This is what distinguishes "cut from main
# and never worked on" from "worked on, then merged back into main", which `branch --merged main`
# cannot: both leave the branch an ancestor of main, and a fast-forward or merge-commit merge
# leaves the branch's own tip exactly where it was created either way, so tip comparison cannot
# tell them apart either.
#
# False is the AMBIGUOUS answer, not a confirmed negative: a reflog count of 0 or 1 means either
# "provably zero commits of its own" (a fresh worktree, the reflog will read exactly 1) or "a
# genuinely merged branch whose reflog has since expired". Callers must treat false as "cannot
# prove this carries real work", and refuse rather than destroy, in both cases.
agent_branch_has_own_commits() {
  local n
  n=$(agent_branch_reflog_count "$1" "$2")
  [ "$n" -ge 2 ]
}

# agent_worktree_provisioned_after_tip <worktree> <repo> <branch>: true when the worktree's own
# `.git` pointer file (a linked worktree's redirect, "gitdir: ...", never rewritten by a commit)
# has an mtime at or after the branch tip's own commit date.
#
# This closes the other half of the shape agent_branch_has_own_commits cannot see: an EXISTING,
# already-merged branch RE-PROVISIONED onto a brand new worktree via `git worktree add path
# branch` (no -b). That command does not move the branch ref, so the reflog and its commit count
# are exactly what they were when the branch first carried real work, and `git status --porcelain`
# reads clean because everything the worktree adds is gitignored. Both of the checks the rest of
# the reaper relies on pass, yet the worktree is not new work in progress.
#
# The discriminator: in the normal flow (provision, then commit, then merge) the `.git` pointer
# file is written once, at provision time, and every later commit on that branch moves refs inside
# the shared git dir, never that pointer file, so the pointer always PREDATES the branch's own tip.
# Re-provisioning writes a BRAND NEW pointer file, and it can only happen after the branch's last
# commit (there is nothing left to commit onto an already-merged branch in the old, now-removed
# worktree), so the new pointer's mtime lands AT OR AFTER the tip it is being compared against.
#
# Ambiguous or unreadable inputs return false (not provisioned-after-tip): agent_branch_has_own_commits
# is the primary discriminator and already ran; this is a second, narrower net over the one shape it
# misses, not a replacement for it.
agent_worktree_provisioned_after_tip() {
  local wt="$1" repo="$2" branch="$3" git_mtime tip_time
  git_mtime=$(stat -f %m "$wt/.git" 2>/dev/null) || return 1
  tip_time=$(git -C "$repo" log -1 --format=%ct "$branch" 2>/dev/null) || return 1
  [ -n "$git_mtime" ] && [ -n "$tip_time" ] || return 1
  [ "$git_mtime" -ge "$tip_time" ]
}

# agent_handover_behind <dir> <handover-relative-path>: how many commits the branch tip is ahead
# of the last commit touching the handover (spec 4.7). A derived fact ABOUT an intent document:
# the system cannot know what you meant, but it can know you have not said anything in twenty
# commits. Returns 1 and prints nothing when no commit has ever touched it.
agent_handover_behind() {
  local last
  last=$(git -C "$1" log -1 --format=%H -- "$2" 2>/dev/null)
  [ -n "$last" ] || return 1
  git -C "$1" rev-list --count "$last..HEAD" 2>/dev/null
}
