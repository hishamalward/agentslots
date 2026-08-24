#!/usr/bin/env bash
# -E (errtrace): project setup hooks may use functions, command substitutions, or subshells. A
# failure in any of them must inherit the rollback trap under bash 3.2.
set -Eeuo pipefail

# Provision a CODE TIER worktree (spec 4.1): worktree plus the configured project setup hook.
# No slot, no database, no ports.
#
# The whole economy of the design is that a worktree is cheap and everyone gets one, while ports
# and a database are scarce and are claimed only by work that actually boots a server. The test
# suite passes with DATABASE_URL unset, so provisioning a database for test-driven work is pure
# waste.
#
# Preflight refuses loudly and changes nothing if any check fails. A half-provisioned worktree is
# worse than none, because it looks ready and behaves wrong (spec 4.3, principle 5).

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$HERE/lib/agent-slot.sh"
agent_config_validate
agent_require_commands git

usage() {
  cat >&2 <<'EOF'
usage: agent-up.sh <branch> [--stack] [--handover <path>] [--spec <path>]

  <branch>      the branch to work on. Created from the configured main branch if absent.
  --stack       also claim a slot: a database, ports and the configured env file. Run it on
                an existing code-tier worktree to upgrade in place (spec 4.3).
  --handover    record an explicit handover path in .agent. Defaults to the path
                derived from the stream slug (spec 4.7). Use this for existing
                handovers that predate the naming convention.
  --spec        record a design-spec path in .agent. Optional.
EOF
  exit 2
}

fail() { echo "agent-up: $*" >&2; exit 1; }

BRANCH=""
HANDOVER=""
SPEC=""
STACK=0
UPGRADE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --handover) [ $# -ge 2 ] || usage; HANDOVER="$2"; shift 2 ;;
    --spec)     [ $# -ge 2 ] || usage; SPEC="$2";     shift 2 ;;
    --stack)    STACK=1; shift ;;
    -h|--help)  usage ;;
    -*)         echo "agent-up: unknown option: $1" >&2; usage ;;
    *)          [ -z "$BRANCH" ] || { echo "agent-up: unexpected argument: $1" >&2; usage; }
                BRANCH="$1"; shift ;;
  esac
done
[ -n "$BRANCH" ] || usage
git check-ref-format --branch "$BRANCH" >/dev/null 2>&1 || fail "invalid branch name: $BRANCH"

MAIN=$(agent_main_root)
WT=$(agent_worktree_path "$BRANCH")
MAIN_BRANCH=$(agent_main_branch)
ENV_PATH=$(agent_env_path "$WT")
[ -n "$HANDOVER" ] || HANDOVER=$(agent_handover_path "$BRANCH")
agent_relative_path_valid "$HANDOVER" || fail "handover path must stay inside the worktree: $HANDOVER"
[ -z "$SPEC" ] || agent_relative_path_valid "$SPEC" || fail "spec path must stay inside the worktree: $SPEC"

git -C "$MAIN" show-ref --verify --quiet "refs/heads/$MAIN_BRANCH" \
  || fail "main branch '$MAIN_BRANCH' does not exist. Set AGENT_MAIN_BRANCH in .agent-slots.conf."
git -C "$MAIN" check-ignore -q .agent \
  || fail ".agent is not ignored. Add it to the project's .gitignore before provisioning."

# --- preflight, spec 4.3 ---------------------------------------------------

# 1. the worktree path is free, OR this is a --stack upgrade of an existing code-tier worktree.
#    Choosing the cheap tier first is never a decision you have to undo (spec 4.3).
if [ -e "$WT" ]; then
  [ "$STACK" = "1" ] || fail "$WT already exists. Use it, or remove it first."
  [ "$(git -C "$WT" rev-parse --show-toplevel 2>/dev/null || true)" = "$WT" ] \
    || fail "$WT exists but is not the expected Git worktree. Refusing to upgrade it."
  [ "$(git -C "$WT" symbolic-ref -q --short HEAD 2>/dev/null || true)" = "$BRANCH" ] \
    || fail "$WT is not checked out on $BRANCH. Refusing to upgrade it."
  tier=$(agent_tier_of_worktree "$WT")
  [ "$tier" = "code" ] || fail "$WT already exists and is $tier tier, not code. Nothing to upgrade."
  UPGRADE=1
  echo "agent-up: upgrading the existing code-tier worktree at $WT"
fi

# 2. the branch is not already checked out in another worktree
PORCELAIN=$(git -C "$MAIN" worktree list --porcelain)
if [ "$UPGRADE" = "0" ] && printf '%s\n' "$PORCELAIN" | grep -qx "branch refs/heads/$BRANCH"; then
  # Derived from the porcelain output above rather than a second grep | awk pipeline: under
  # pipefail, a non-matching grep in a plain assignment (not a condition) returns non-zero and
  # set -e aborts the script before `fail` ever runs, replacing the actionable message this line
  # exists to produce with a bare abort. awk always exits 0 here even when it prints nothing.
  where=$(printf '%s\n' "$PORCELAIN" | awk -v b="refs/heads/$BRANCH" \
    '/^worktree /{wt=$2} $0=="branch "b{print wt; exit}')
  [ -n "$where" ] || where="(location unknown)"
  fail "branch $BRANCH is already checked out at $where"
fi

# 3. an optional conflicting env file must not carry a second database URL. Projects configure
#    this when their framework and database tooling load different env-file layers.
CONFLICT_ENV=$(agent_conflict_env_path "$MAIN" 2>/dev/null || true)
if [ -n "$CONFLICT_ENV" ] && [ -f "$CONFLICT_ENV" ] && grep -q "^${AGENT_DATABASE_URL_KEY}=" "$CONFLICT_ENV"; then
  fail "$CONFLICT_ENV sets $AGENT_DATABASE_URL_KEY. Remove it before provisioning."
fi

# --- stack preflight, spec 4.3 items 3 to 6 --------------------------------

if [ "$STACK" = "1" ]; then
  agent_require_commands lsof psql createdb dropdb pg_dump
  agent_postgres_reachable || fail "PostgreSQL is unreachable for role $AGENT_PG_USER."
  # 3. a slot in the configured range is free. agent_next_free_slot asks reality: no database, no listening
  #    ports. There is no registry file to go stale.
  SLOT=$(agent_next_free_slot) || fail "no free slot in 1..$AGENT_SLOT_MAX. Run agent-status.sh to find orphans."
  DB=$(agent_db_name "$SLOT")
  SCHEMA=$(agent_boss_schema "$SLOT")
  WEB_PORT=$(agent_web_port "$SLOT")
  METRO_PORT=$(agent_metro_port "$SLOT")

  # 4. both ports free, and 5. the slot database does not exist. next_free_slot already
  #    established these; re-asserting them is cheap and makes the refusal name the exact
  #    resource rather than "no free slot".
  ! agent_port_busy "$WEB_PORT"   || fail "web port $WEB_PORT is already listening"
  ! agent_port_busy "$METRO_PORT" || fail "Metro port $METRO_PORT is already listening"
  ! agent_db_exists "$DB"         || fail "database $DB already exists. agent-down.sh $SLOT first."

  # 6. the template database is reachable
  TEMPLATE=$(agent_db_name 0)
  agent_db_exists "$TEMPLATE" || fail "template database $TEMPLATE is unreachable. Check PostgreSQL and .agent-slots.conf."

  SRC_ENV=$(agent_env_path "$MAIN")
  [ -f "$SRC_ENV" ] || fail "$SRC_ENV does not exist, so there is nothing to derive a slot .env from."
  grep -q "^${AGENT_DATABASE_URL_KEY}=" "$SRC_ENV" || fail "$SRC_ENV has no $AGENT_DATABASE_URL_KEY to derive from."
  # An empty value would make SLOT_URL="${raw%/*}/$DB" silently collapse to "/$DB" further down.
  [ -n "$(sed -n "/^${AGENT_DATABASE_URL_KEY}=/{s///p;q;}" "$SRC_ENV")" ] || fail "$SRC_ENV has an empty $AGENT_DATABASE_URL_KEY."
fi

# --- provision -------------------------------------------------------------

if [ "$UPGRADE" = "1" ]; then
  echo "agent-up: claiming a slot for $BRANCH at $WT"
elif [ "$STACK" = "1" ]; then
  echo "agent-up: provisioning stack tier for $BRANCH at $WT"
else
  echo "agent-up: provisioning code tier for $BRANCH at $WT"
fi

# The preflight above is atomic: nothing touches disk until every check passes. Past this point
# it is not, because `git worktree add` succeeding is itself a disk change, and any later step
# failing under `set -Eeuo pipefail` (the .agent write or a project setup-hook error) would
# otherwise leave a
# worktree that exists, is checked out, and looks ready but is not: the exact "worse than none"
# state the preflight exists to prevent, reached from a different direction. The trap rolls that
# back. CREATED_BRANCH becomes 1 only after this process creates the ref, so a pre-existing or
# concurrently-created branch is never destroyed.
CREATED_BRANCH=0
CREATED_WT=0
CREATED_DB=0
ENV_WRITTEN=0
ENV_HAD_PRIOR=0
ENV_BACKUP=""

# rollback() must be safe to call more than once (it is, on the two post-trap `fail` sites below,
# called explicitly and then the script still exits): every step here already guards on its flag
# and swallows its own error with `|| true`, so a second call is a no-op past whatever the first
# call already undid.
rollback() {
  echo "agent-up: provisioning failed, rolling back so no half-provisioned worktree is left" >&2
  [ "$CREATED_DB" = "1" ] && dropdb -U "$AGENT_PG_USER" "$DB" 2>/dev/null || true
  # The .env write happens before the trap can undo it via CREATED_WT on the upgrade path, where
  # the worktree is deliberately preserved (spec 4.3): a half-written .env would otherwise leave a
  # worktree that reads as stack tier (agent_tier_of_worktree keys off AGENT_SLOT alone) with no
  # database behind it, or worse, aliasing another agent's slot after a claim race. Restore
  # whatever was there before, or remove the file if nothing was.
  if [ "$ENV_WRITTEN" = "1" ]; then
    if [ "$ENV_HAD_PRIOR" = "1" ]; then
      cp "$ENV_BACKUP" "$ENV_PATH" 2>/dev/null || true
    else
      rm -f "$ENV_PATH" 2>/dev/null || true
    fi
  fi
  [ -z "$ENV_BACKUP" ] || rm -f "$ENV_BACKUP" 2>/dev/null || true
  [ "$CREATED_WT" = "1" ] && git -C "$MAIN" worktree remove --force "$WT" 2>/dev/null || true
  [ "$CREATED_BRANCH" = "1" ] && git -C "$MAIN" branch -D "$BRANCH" 2>/dev/null || true
}

# Arm rollback before git worktree add. That command creates the branch and worktree in several
# filesystem steps and can fail partway (for example on a full disk); cleanup must cover it too.
trap rollback ERR

if [ "$UPGRADE" = "0" ]; then
  CREATED_WT=1
  if git -C "$MAIN" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git -C "$MAIN" worktree add "$WT" "$BRANCH"
  else
    echo "agent-up: branch $BRANCH does not exist, creating it from $MAIN_BRANCH"
    # Create the ref as its own atomic operation, and mark ownership only after that succeeds.
    # With `worktree add -b`, a competing agent can create the same branch between preflight and
    # this command; pre-marking CREATED_BRANCH would then let rollback delete the other agent's
    # ref even though this process never created it.
    git -C "$MAIN" branch "$BRANCH" "$MAIN_BRANCH"
    CREATED_BRANCH=1
    git -C "$MAIN" worktree add "$WT" "$BRANCH"
  fi
fi

if [ "$UPGRADE" = "0" ]; then
  # The marker records INTENT: which stream this worktree serves and which handover governs it.
  # Stream names do not derive from branch names for the 21 legacy handovers, which is the whole
  # reason this pointer exists.
  {
    echo '# Agent worktree marker (spec 4.7). Gitignored, per-worktree, dies with the worktree.'
    echo '# Written by scripts/agent-up.sh.'
    echo '#'
    echo '# Intent only. TIER below is a human-readable echo, rewritten by `agent-up.sh --stack`.'
    echo "# The authority is $AGENT_APP_DIR/$AGENT_ENV_FILE: a worktree whose env carries $AGENT_SLOT_KEY is stack tier."
    echo '# agent-status.sh derives tier and slot rather than trusting this file (principle 2).'
    echo ''
    echo "STREAM=$(agent_stream_slug "$BRANCH")"
    echo "HANDOVER=$HANDOVER"
    echo "BRANCH=$BRANCH"
    echo 'TIER=code'
    [ -z "$SPEC" ] || echo "SPEC=$SPEC"
  } > "$WT/.agent"

  if [ ! -e "$WT/$HANDOVER" ]; then
    mkdir -p "$(dirname "$WT/$HANDOVER")"
    {
      echo "# $(agent_stream_slug "$BRANCH"): handover"
      echo ''
      echo "Goal: describe the outcome for this stream."
      echo "Status: in progress"
      [ -z "$SPEC" ] || echo "Spec: $SPEC"
      echo ''
      echo '## Current state in code'
      echo ''
      echo '- Nothing completed yet.'
      echo ''
      echo '## What will bite'
      echo ''
      echo '- Add project-specific hazards here.'
      echo ''
      echo '## Not built, in order'
      echo ''
      echo '- Define the first implementation step.'
      echo ''
      echo '## In flight'
      echo ''
      echo '- Nothing yet.'
      echo ''
      echo '## Blocked'
      echo ''
      echo '- Nothing.'
      echo ''
      echo '## Open questions'
      echo ''
      echo '- None.'
      echo ''
      echo '## Verification protocol'
      echo ''
      echo '- Run the project test command.'
    } > "$WT/$HANDOVER"
    echo "agent-up: created handover template at $HANDOVER"
  fi

  echo "agent-up: running the project worktree-setup hook"
  agent_prepare_worktree "$MAIN" "$WT"
fi

if [ "$STACK" = "1" ]; then
  # --- configured application env ------------------------------------------
  #
  # Slot identity and the rewritten database URL live in the configured application env file,
  # not only in the invoking shell, so every server, worker, and database CLI in the worktree sees
  # the same isolation boundary.
  echo "agent-up: writing $ENV_PATH for slot $SLOT"

  # Derive the URL by rewriting only the database name. Never synthesise credentials: the real
  # password is not the spec's illustrative literal.
  # `sed ... | head -1` is avoided: under pipefail sed can outrun head and the pipeline returns
  # 141 (SIGPIPE). `{p;q;}` stops at the first match with no pipe at all.
  raw=$(sed -n "/^${AGENT_DATABASE_URL_KEY}=/{s///p;q;}" "$SRC_ENV" \
        | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//")
  case "$raw" in
    # `fail` calls `exit`, and `exit` does NOT fire an armed ERR trap in bash (a third exemption,
    # distinct from missing -E and from a non-final &&/|| command): verified on this machine that
    # `exit 1` after `trap ... ERR` never runs the trap. Every `fail` call from here to the end of
    # the STACK block is past `trap rollback ERR`, so each must call rollback explicitly first.
    *\?*) rollback; fail "the main $AGENT_DATABASE_URL_KEY carries query parameters; rewrite it by hand for slot $SLOT" ;;
  esac
  SLOT_URL="${raw%/*}/$DB"

  # Back up any pre-existing env OUTSIDE the worktree before overwriting it, so rollback
  # can restore it byte for byte. `mktemp` in the system temp dir, not a sibling file in the
  # worktree: an adjacent backup may not be ignored, so a backup left
  # inside the worktree would show up as untracked, which makes `git worktree remove` refuse and
  # would make agent-reap.sh treat the tree as dirty and refuse to reap it.
  if [ -f "$ENV_PATH" ]; then
    ENV_HAD_PRIOR=1
    ENV_BACKUP=$(mktemp "${TMPDIR:-/tmp}/agent-up-env-backup.XXXXXX")
    cp "$ENV_PATH" "$ENV_BACKUP"
  fi
  ENV_WRITTEN=1

  # Copy every line the main tree has except the keys this slot owns, then append ours. awk exits
  # successfully even when every source line is filtered, unlike grep -v under set -e.
  awk -v slot_key="$AGENT_SLOT_KEY" -v db_key="$AGENT_DATABASE_URL_KEY" \
      -v queue_key="$AGENT_QUEUE_SCHEMA_KEY" -v public_key="$AGENT_PUBLIC_URL_KEY" '
    index($0, slot_key "=") == 1 { next }
    index($0, db_key "=") == 1 { next }
    queue_key != "" && index($0, queue_key "=") == 1 { next }
    public_key != "" && index($0, public_key "=") == 1 { next }
    { print }
  ' "$SRC_ENV" > "$ENV_PATH"
  {
    echo ''
    echo "# Slot $SLOT, written by scripts/agent-up.sh --stack (spec 4.4.3). Do not copy this"
    echo '# file between worktrees: it is what keeps this stack off the shared database.'
    printf '%s=%s\n' "$AGENT_SLOT_KEY" "$SLOT"
    printf '%s="%s"\n' "$AGENT_DATABASE_URL_KEY" "$SLOT_URL"
    [ -z "$AGENT_QUEUE_SCHEMA_KEY" ] || printf '%s=%s\n' "$AGENT_QUEUE_SCHEMA_KEY" "$SCHEMA"
    if [ -n "$AGENT_PUBLIC_URL_KEY" ]; then
      public_url=$(printf "$AGENT_PUBLIC_URL_FORMAT" "$WEB_PORT")
      printf '%s="%s"\n' "$AGENT_PUBLIC_URL_KEY" "$public_url"
    fi
  } >> "$ENV_PATH"
  agent_after_slot_env "$ENV_PATH" "$SLOT" "$WEB_PORT"

  # --- the database clone, spec 4.3 ----------------------------------------
  #
  # pg_dump works even when the source database has live development sessions, unlike
  # CREATE DATABASE ... TEMPLATE.
  echo "agent-up: cloning $TEMPLATE into $DB"
  createdb -U "$AGENT_PG_USER" "$DB"
  CREATED_DB=1
  pg_dump -U "$AGENT_PG_USER" "$TEMPLATE" \
    | psql -U "$AGENT_PG_USER" -d "$DB" -q -v ON_ERROR_STOP=1 >/dev/null

  # A project with a cloned scheduled-work schema names it explicitly. Empty means there is no
  # inherited queue schema to remove.
  if [ -n "$AGENT_INHERITED_QUEUE_SCHEMA" ]; then
    echo "agent-up: dropping inherited queue schema $AGENT_INHERITED_QUEUE_SCHEMA from $DB"
    psql -U "$AGENT_PG_USER" -d "$DB" -q -v ON_ERROR_STOP=1 \
      -c "DROP SCHEMA IF EXISTS $AGENT_INHERITED_QUEUE_SCHEMA CASCADE"
    left=$(psql -U "$AGENT_PG_USER" -d "$DB" -tAc \
           "select count(*) from pg_namespace where nspname = '$AGENT_INHERITED_QUEUE_SCHEMA'")
    [ "$left" = "0" ] || { rollback; fail "the inherited queue schema survived in $DB. Refusing to leave a slot that can fire cron."; }
  fi

  # Keep the .agent echo honest after an upgrade. Guarded, not fatal: by this point the slot is
  # fully and correctly provisioned (database cloned, inherited schema dropped, env written), and
  # .agent's TIER is not an authority, agent_tier_of_worktree derives tier solely from the slot key
  # in the configured env and never opens .agent (see the header this script writes into it, "Intent
  # only"). A failure here can only make the echo lag reality, not make the slot behave wrong, so
  # rolling back a correct clone and .env write to fix a label is the same spurious-rollback shape
  # line 326 below exists to avoid. Warn instead.
  if [ -f "$WT/.agent" ]; then
    if ! sed -i '' 's/^TIER=code$/TIER=stack/' "$WT/.agent" 2>/dev/null; then
      echo "agent-up: WARNING, could not refresh the .agent TIER echo. Cosmetic only: tier is derived" >&2
      echo "agent-up:          from $ENV_PATH, not from .agent. The slot is provisioned correctly." >&2
    fi
  fi

  # Success: the pre-upgrade .env is no longer needed. rollback() would otherwise never clean it
  # up, since it only runs on failure. `|| true` is mandatory here even though this runs on the
  # success path: `rm -f` still returns 1 on e.g. permission-denied, and as the LAST command of
  # this `||` list it is NOT exempt from the ERR trap (still armed here), so an unguarded failure
  # would fire a SPURIOUS rollback of a provision that already succeeded, dropping the database
  # and restoring the pre-upgrade .env while .agent keeps TIER=stack from two statements earlier.
  [ -z "$ENV_BACKUP" ] || rm -f "$ENV_BACKUP" 2>/dev/null || true
fi

trap - ERR

if [ "$STACK" = "1" ]; then
  cat <<EOF

agent-up: stack tier ready.
  worktree    $WT
  branch      $BRANCH
  handover    $HANDOVER
  slot        $SLOT
  database    $DB
  queue       $SCHEMA$([ -n "$AGENT_INHERITED_QUEUE_SCHEMA" ] && printf ' (inherited %s removed)' "$AGENT_INHERITED_QUEUE_SCHEMA")
  web port    $WEB_PORT
  Metro port  $METRO_PORT

Read the handover before your first write (spec 4.9 item 9).
Start the server: scripts/agent-dev.sh (uses the project hook in .agent-slots.conf)
Stop when you pause, down when you merge: scripts/agent-stop.sh $SLOT / scripts/agent-down.sh $SLOT
EOF
else
  cat <<EOF

agent-up: code tier ready.
  worktree  $WT
  branch    $BRANCH
  handover  $HANDOVER
  tier      code (no slot, no database, no ports)

Read the handover before your first write (spec 4.9 item 9).
Tests run here now: $AGENT_TEST_COMMAND
To boot a server, upgrade in place: scripts/agent-up.sh $BRANCH --stack
EOF
fi
