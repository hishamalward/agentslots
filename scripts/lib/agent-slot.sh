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

# Stable defaults. A tracked .agent-slots.conf in the project root, or the file named by
# AGENT_CONFIG, may override these values and the project hooks defined at the end of this file.
# Nothing here names the repository this code originally came from.
AGENT_MAIN_BRANCH="${AGENT_MAIN_BRANCH:-main}"
AGENT_PROJECT_SLUG="${AGENT_PROJECT_SLUG:-}"
AGENT_DATABASE_MAIN="${AGENT_DATABASE_MAIN:-}"
AGENT_DATABASE_PREFIX="${AGENT_DATABASE_PREFIX:-}"
AGENT_QUEUE_SCHEMA_MAIN="${AGENT_QUEUE_SCHEMA_MAIN:-pgboss}"
AGENT_QUEUE_SCHEMA_PREFIX="${AGENT_QUEUE_SCHEMA_PREFIX:-pgboss_a}"
AGENT_INHERITED_QUEUE_SCHEMA="${AGENT_INHERITED_QUEUE_SCHEMA:-}"
AGENT_WEB_PORT_BASE="${AGENT_WEB_PORT_BASE:-3000}"
AGENT_METRO_PORT_BASE="${AGENT_METRO_PORT_BASE:-8081}"
AGENT_PORT_STEP="${AGENT_PORT_STEP:-100}"
AGENT_SLOT_MAX="${AGENT_SLOT_MAX:-9}"
AGENT_WORKTREE_PREFIX="${AGENT_WORKTREE_PREFIX:-}"
AGENT_APP_DIR="${AGENT_APP_DIR:-.}"
AGENT_MOBILE_DIR="${AGENT_MOBILE_DIR:-}"
AGENT_ENV_FILE="${AGENT_ENV_FILE:-.env}"
AGENT_CONFLICT_ENV_FILE="${AGENT_CONFLICT_ENV_FILE:-}"
AGENT_SLOT_KEY="${AGENT_SLOT_KEY:-AGENT_SLOT}"
AGENT_DATABASE_URL_KEY="${AGENT_DATABASE_URL_KEY:-DATABASE_URL}"
AGENT_QUEUE_SCHEMA_KEY="${AGENT_QUEUE_SCHEMA_KEY:-PGBOSS_SCHEMA}"
AGENT_PUBLIC_URL_KEY="${AGENT_PUBLIC_URL_KEY:-}"
AGENT_PUBLIC_URL_FORMAT="${AGENT_PUBLIC_URL_FORMAT:-http://localhost:%s}"
AGENT_TEST_COMMAND="${AGENT_TEST_COMMAND:-npm test}"
AGENT_PG_USER="${AGENT_PG_USER:-${USER:-$(id -un)}}"
AGENT_SIM_LOCK="${AGENT_SIM_LOCK:-}"

# --- pure derivation, no I/O ------------------------------------------------

# agent_slot_valid <slot>: true for 0..AGENT_SLOT_MAX. Leading zeroes are rejected so arithmetic
# is never interpreted as octal by bash 3.2.
agent_slot_valid() {
  local slot="${1:-}"
  case "$slot" in
    ""|*[!0-9]*|0[0-9]*) return 1 ;;
  esac
  [ "$slot" -le "$AGENT_SLOT_MAX" ]
}

agent_project_slug() {
  if [ -n "$AGENT_PROJECT_SLUG" ]; then
    printf '%s\n' "$AGENT_PROJECT_SLUG"
    return 0
  fi
  basename "$(agent_main_root)" | tr '-' '_' | tr -cd '[:alnum:]_'
}

agent_main_branch() { printf '%s\n' "$AGENT_MAIN_BRANCH"; }

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
  local main prefix
  main="${AGENT_DATABASE_MAIN:-$(agent_project_slug)_dev}"
  prefix="${AGENT_DATABASE_PREFIX:-$(agent_project_slug)_a}"
  if [ "$1" = "0" ]; then printf '%s\n' "$main"
  else printf '%s%s\n' "$prefix" "$1"; fi
}

# agent_boss_schema <slot>: slot 0 keeps pg-boss's default schema, so an unset PGBOSS_SCHEMA is
# byte-identical to today (spec principle 4).
agent_boss_schema() {
  if [ "$1" = "0" ]; then printf '%s\n' "$AGENT_QUEUE_SCHEMA_MAIN"
  else printf '%s%s\n' "$AGENT_QUEUE_SCHEMA_PREFIX" "$1"; fi
}

# agent_web_port <slot>: base + step*N.
agent_web_port() { printf '%s\n' "$(( AGENT_WEB_PORT_BASE + AGENT_PORT_STEP * $1 ))"; }

# agent_metro_port <slot>: base + step*N.
agent_metro_port() { printf '%s\n' "$(( AGENT_METRO_PORT_BASE + AGENT_PORT_STEP * $1 ))"; }

# --- paths ------------------------------------------------------------------

# agent_main_root: absolute path of the MAIN worktree, always the first entry of
# `git worktree list`. Deriving from it means a script run inside a linked worktree still
# resolves siblings correctly.
agent_main_root() {
  git worktree list --porcelain | sed -n '1s/^worktree //p'
}

# agent_worktree_path <branch>: a SIBLING of the main worktree, never nested (spec 4.8).
agent_worktree_path() {
  local prefix
  prefix="${AGENT_WORKTREE_PREFIX:-$(basename "$(agent_main_root)")-}"
  printf '%s/%s%s\n' "$(dirname "$(agent_main_root)")" "$prefix" "$(agent_branch_slug "$1")"
}

# agent_handover_path <branch>: repo-relative path of the stream's handover (spec 4.7).
agent_handover_path() {
  printf 'docs/plans/%s-handover.md\n' "$(agent_stream_slug "$1")"
}

agent_app_path() { printf '%s/%s\n' "$1" "$AGENT_APP_DIR"; }
agent_env_path() { printf '%s/%s/%s\n' "$1" "$AGENT_APP_DIR" "$AGENT_ENV_FILE"; }

agent_conflict_env_path() {
  [ -n "$AGENT_CONFLICT_ENV_FILE" ] || return 1
  printf '%s/%s/%s\n' "$1" "$AGENT_APP_DIR" "$AGENT_CONFLICT_ENV_FILE"
}

# --- reality probes: ask the system, never a registry file (spec principle 2) ---

# agent_db_exists <dbname>
agent_db_exists() {
  psql -U "$AGENT_PG_USER" -d postgres -tAc \
    "select 1 from pg_database where datname = '$1'" 2>/dev/null | grep -q '^1$'
}

agent_postgres_reachable() {
  psql -U "$AGENT_PG_USER" -d postgres -tAc 'select 1' 2>/dev/null | grep -q '^1$'
}

# agent_port_busy <port>: something is LISTENING right now.
agent_port_busy() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1
}

# agent_sim_lock_alive <lockfile>: a holder is alive only while its recorded owner process is
# alive and, once acquisition has filled a UDID, that exact device is still booted. During the
# short claim-before-boot window UDID is empty, so the live PID alone protects the atomic claim.
# A crashed owner can therefore never strand a booted simulator indefinitely.
agent_sim_lock_alive() {
  local pid udid
  pid=$([ -f "$1" ] && sed -n '/^PID=/{s///p;q;}' "$1" || true)
  case "$pid" in ""|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  udid=$([ -f "$1" ] && sed -n '/^UDID=/{s///p;q;}' "$1" || true)
  [ -z "$udid" ] || xcrun simctl list devices booted 2>/dev/null | grep -Fq "$udid"
}

# agent_slot_free <slot>: free when its database does not exist and neither port is listening.
agent_slot_free() {
  agent_db_exists "$(agent_db_name "$1")" && return 1
  agent_port_busy "$(agent_web_port "$1")" && return 1
  agent_port_busy "$(agent_metro_port "$1")" && return 1
  return 0
}

# agent_next_free_slot: the lowest free configured slot. Slot 0 is the main tree and is never
# assigned.
agent_next_free_slot() {
  local n
  n=1
  while [ "$n" -le "$AGENT_SLOT_MAX" ]; do
    if agent_slot_free "$n"; then printf '%s\n' "$n"; return 0; fi
    n=$((n + 1))
  done
  echo "agent-slot: no free slot in 1..$AGENT_SLOT_MAX, every slot has a database or a listening port" >&2
  return 1
}

# --- worktree introspection -------------------------------------------------

# agent_tier_of_worktree <dir>: main, stack or code. Derived, never read from a written copy.
# A stack tier is exactly a worktree whose configured env file carries the slot key.
agent_tier_of_worktree() {
  local env_file
  if [ "$1" = "$(agent_main_root)" ]; then printf 'main\n'; return 0; fi
  env_file=$(agent_env_path "$1")
  if [ -f "$env_file" ] && grep -q "^${AGENT_SLOT_KEY}=" "$env_file"; then
    printf 'stack\n'
  else
    printf 'code\n'
  fi
}

# agent_slot_of_worktree <dir>: prints the slot and returns 0, or prints nothing and returns 1
# for a code-tier worktree, which HAS no slot. Do not substitute 0 for that: slot 0 is the main
# tree and the only schedule owner.
agent_slot_of_worktree() {
  local env_file
  if [ "$1" = "$(agent_main_root)" ]; then printf '0\n'; return 0; fi
  local v
  env_file=$(agent_env_path "$1")
  if [ -f "$env_file" ]; then
    # Read the first matching line with no pipe: `sed ... | head -1` can return 141 under
    # `set -o pipefail` when sed outruns head, the same family as plan 1's `npm run dev | head`.
    #
    # The form is `/^KEY=/{s///p;q;}`, NOT `s/^KEY=//{p;q;}`. The latter is a GNU extension and is
    # a hard syntax error on the BSD sed macOS ships ("bad flag in substitute command: '{'"), so
    # it fails on every run on the only platform this design targets. The empty regex in `s///`
    # reuses the address regex and is POSIX, so this form works on both.
    v=$(sed -n "/^${AGENT_SLOT_KEY}=/{s///p;q;}" "$env_file" | tr -d "\"' ")
    if agent_slot_valid "$v" && [ "$v" != "0" ]; then printf '%s\n' "$v"; return 0; fi
  fi
  return 1
}

agent_worktree_for_slot() {
  local main cand slot="$1"
  main=$(agent_main_root)
  while IFS= read -r cand; do
    [ -d "$cand" ] || continue
    [ "$cand" != "$main" ] || continue
    if [ "$(agent_slot_of_worktree "$cand" 2>/dev/null || true)" = "$slot" ]; then
      printf '%s\n' "$cand"
      return 0
    fi
  done < <(git worktree list --porcelain | awk '/^worktree /{print substr($0,10)}')
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

# Project hooks. A project's .agent-slots.conf may redefine any of these after setting the stable
# resource variables above. Hooks receive ordinary positional arguments, avoiding eval and the
# quoting hazards of executing configured command strings.
agent_prepare_worktree() { :; }

agent_start_web() {
  echo "agent-dev: no web hook configured. Define agent_start_web in .agent-slots.conf." >&2
  return 1
}

agent_start_mobile() {
  echo "agent-mobile: no mobile hook configured. Define agent_start_mobile in .agent-slots.conf." >&2
  return 1
}

agent_dependencies_stale() { return 1; }
agent_after_slot_env() { :; }

# Reusable helper for npm projects whose node_modules trees can safely be copied. pnpm and other
# layouts should provide their own agent_prepare_worktree hook instead.
agent_clone_node_modules() {
  local main="$1" wt="$2" src rel dst
  find "$main" -maxdepth 3 -type d -name node_modules -prune | while read -r src; do
    rel=${src#"$main"/}
    dst="$wt/$rel"
    [ -e "$dst" ] && continue
    mkdir -p "$(dirname "$dst")"
    cp -Rc "$src" "$dst"
  done
}

agent_require_commands() {
  local command_name missing=""
  for command_name in "$@"; do
    command -v "$command_name" >/dev/null 2>&1 || missing="$missing $command_name"
  done
  if [ -n "$missing" ]; then
    echo "agent-slots: missing required command(s):${missing}" >&2
    return 1
  fi
}

agent_identifier_valid() {
  case "${1:-}" in
    ""|[0-9]*|*[!A-Za-z0-9_]*) return 1 ;;
    *) return 0 ;;
  esac
}

agent_relative_path_valid() {
  case "${1:-}" in
    ""|/*|'..'|'../'*|*'/../'*|*/'..') return 1 ;;
    *) return 0 ;;
  esac
}

agent_config_validate() {
  local value n port db schema seen_ports=" " seen_dbs=" " seen_schemas=" "
  case "$AGENT_SLOT_MAX" in ""|*[!0-9]*|0|0[0-9]*) echo "agent-slots: AGENT_SLOT_MAX must be a positive integer without leading zeroes" >&2; return 1 ;; esac
  { [ "${#AGENT_SLOT_MAX}" -le 2 ] && [ "$AGENT_SLOT_MAX" -le 99 ]; } \
    || { echo "agent-slots: AGENT_SLOT_MAX must be <= 99" >&2; return 1; }
  for value in "$AGENT_WEB_PORT_BASE" "$AGENT_METRO_PORT_BASE" "$AGENT_PORT_STEP"; do
    case "$value" in ""|*[!0-9]*|0|0[0-9]*) echo "agent-slots: port bases and step must be positive integers without leading zeroes" >&2; return 1 ;; esac
    { [ "${#value}" -le 5 ] && [ "$value" -le 65535 ]; } \
      || { echo "agent-slots: port bases and step must be <= 65535" >&2; return 1; }
  done
  [ "$AGENT_PORT_STEP" -gt 0 ] || { echo "agent-slots: AGENT_PORT_STEP must be positive" >&2; return 1; }
  [ "$(agent_web_port "$AGENT_SLOT_MAX")" -le 65535 ] \
    && [ "$(agent_metro_port "$AGENT_SLOT_MAX")" -le 65535 ] \
    || { echo "agent-slots: configured slot ports exceed 65535" >&2; return 1; }
  [ -n "$AGENT_MAIN_BRANCH" ] || { echo "agent-slots: AGENT_MAIN_BRANCH must not be empty" >&2; return 1; }
  git check-ref-format --branch "$AGENT_MAIN_BRANCH" >/dev/null 2>&1 \
    || { echo "agent-slots: invalid AGENT_MAIN_BRANCH: $AGENT_MAIN_BRANCH" >&2; return 1; }
  agent_identifier_valid "$(agent_project_slug)" \
    || { echo "agent-slots: AGENT_PROJECT_SLUG must use letters, numbers and underscores" >&2; return 1; }
  [ -n "$AGENT_PG_USER" ] || { echo "agent-slots: AGENT_PG_USER must not be empty" >&2; return 1; }
  case "$AGENT_SIM_LOCK" in /*) ;; *) echo "agent-slots: AGENT_SIM_LOCK must be an absolute path" >&2; return 1 ;; esac
  case "$AGENT_APP_DIR" in /*|*'/../'*|'../'*|*/'..') echo "agent-slots: AGENT_APP_DIR must stay inside the repository" >&2; return 1 ;; esac
  case "$AGENT_MOBILE_DIR" in /*|*'/../'*|'../'*|*/'..') echo "agent-slots: AGENT_MOBILE_DIR must stay inside the repository" >&2; return 1 ;; esac
  case "$AGENT_ENV_FILE" in ""|*/*) echo "agent-slots: AGENT_ENV_FILE must be a filename" >&2; return 1 ;; esac
  case "$AGENT_CONFLICT_ENV_FILE" in */*) echo "agent-slots: AGENT_CONFLICT_ENV_FILE must be a filename" >&2; return 1 ;; esac
  for value in "$AGENT_SLOT_KEY" "$AGENT_DATABASE_URL_KEY"; do
    agent_identifier_valid "$value" || { echo "agent-slots: invalid environment key: $value" >&2; return 1; }
  done
  for value in "$AGENT_QUEUE_SCHEMA_KEY" "$AGENT_PUBLIC_URL_KEY"; do
    [ -z "$value" ] || agent_identifier_valid "$value" || { echo "agent-slots: invalid environment key: $value" >&2; return 1; }
  done
  [ -z "$AGENT_INHERITED_QUEUE_SCHEMA" ] || agent_identifier_valid "$AGENT_INHERITED_QUEUE_SCHEMA" || {
    echo "agent-slots: AGENT_INHERITED_QUEUE_SCHEMA must be an unquoted SQL identifier" >&2
    return 1
  }
  for value in "$AGENT_QUEUE_SCHEMA_MAIN" "$AGENT_QUEUE_SCHEMA_PREFIX"; do
    [ -z "$AGENT_QUEUE_SCHEMA_KEY" ] || agent_identifier_valid "$value" || {
      echo "agent-slots: queue schema names/prefixes must be unquoted SQL identifiers" >&2
      return 1
    }
  done
  for value in "$(agent_db_name 0)" "${AGENT_DATABASE_PREFIX:-$(agent_project_slug)_a}"; do
    agent_identifier_valid "$value" || { echo "agent-slots: database names/prefixes must use letters, numbers and underscores" >&2; return 1; }
  done
  case "${AGENT_WORKTREE_PREFIX:-$(basename "$(agent_main_root)")-}" in */*) echo "agent-slots: AGENT_WORKTREE_PREFIX must not contain /" >&2; return 1 ;; esac

  n=0
  while [ "$n" -le "$AGENT_SLOT_MAX" ]; do
    for port in "$(agent_web_port "$n")" "$(agent_metro_port "$n")"; do
      case "$seen_ports" in *" $port "*) echo "agent-slots: configured port formulas collide at $port" >&2; return 1 ;; esac
      seen_ports="$seen_ports$port "
    done
    db=$(agent_db_name "$n")
    [ "${#db}" -le 63 ] || { echo "agent-slots: database name exceeds PostgreSQL's 63-byte limit: $db" >&2; return 1; }
    case "$seen_dbs" in *" $db "*) echo "agent-slots: configured database formulas collide at $db" >&2; return 1 ;; esac
    seen_dbs="$seen_dbs$db "
    if [ -n "$AGENT_QUEUE_SCHEMA_KEY" ]; then
      schema=$(agent_boss_schema "$n")
      [ "${#schema}" -le 50 ] || { echo "agent-slots: pg-boss schema exceeds 50 bytes: $schema" >&2; return 1; }
      case "$seen_schemas" in *" $schema "*) echo "agent-slots: configured queue schema formulas collide at $schema" >&2; return 1 ;; esac
      seen_schemas="$seen_schemas$schema "
    fi
    n=$((n + 1))
  done
}

# Load the project adapter last so it can replace the hook functions above. A missing implicit
# config is fine: generic defaults still support code-tier worktrees. An explicitly requested
# AGENT_CONFIG must exist, since silently ignoring a typo would start a stack with wrong values.
_agent_config_path="${AGENT_CONFIG:-}"
if [ -z "$_agent_config_path" ]; then
  # Resource formulas must not drift when a feature branch edits its copy of the config. The
  # primary worktree is the one authority every linked worktree reads.
  _agent_current_root=$(agent_main_root 2>/dev/null || true)
  [ -z "$_agent_current_root" ] || _agent_config_path="$_agent_current_root/.agent-slots.conf"
  [ -f "$_agent_config_path" ] || _agent_config_path=""
elif [ ! -f "$_agent_config_path" ]; then
  echo "agent-slots: AGENT_CONFIG does not exist: $_agent_config_path" >&2
  return 1 2>/dev/null || exit 1
fi
[ -z "$_agent_config_path" ] || . "$_agent_config_path"

if [ -z "$AGENT_SIM_LOCK" ]; then
  AGENT_SIM_LOCK="$HOME/.agent-slots/$(agent_project_slug).sim.lock"
fi

unset _agent_config_path _agent_current_root

# agent_branch_reflog_count <repo> <branch>: reflog entries for BRANCH's OWN ref, not HEAD's.
# Creating BRANCH from MAINLINE writes exactly one entry for BRANCH (its creation), and
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
