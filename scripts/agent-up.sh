#!/usr/bin/env bash
# -E (errtrace): without it, bash 3.2's ERR trap is NOT inherited into subshells, command
# substitutions or functions, so a failure inside the `( cd ... && npx prisma generate )`
# subshell or the `find | while read` node_modules loop below would abort the script via -e but
# silently skip the rollback trap. Verified empirically on the exact bash 3.2.57 this targets:
# without -E the trap never fires for either construct; with it, it fires correctly for both.
set -Eeuo pipefail

# Provision a CODE TIER worktree (spec 4.1): worktree, node_modules, generated Prisma client.
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

usage() {
  cat >&2 <<'EOF'
usage: agent-up.sh <branch> [--stack] [--handover <path>] [--spec <path>]

  <branch>      the branch to work on. Created from main if it does not exist.
  --stack       also claim a slot: a database, ports and apps/web/.env. Run it on
                an existing code-tier worktree to upgrade in place (spec 4.3).
  --handover    record an explicit handover path in .agent. Defaults to the path
                derived from the stream slug (spec 4.7). Use this for the 21
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

MAIN=$(agent_main_root)
WT=$(agent_worktree_path "$BRANCH")
[ -n "$HANDOVER" ] || HANDOVER=$(agent_handover_path "$BRANCH")

# --- preflight, spec 4.3 ---------------------------------------------------

# 1. the worktree path is free, OR this is a --stack upgrade of an existing code-tier worktree.
#    Choosing the cheap tier first is never a decision you have to undo (spec 4.3).
if [ -e "$WT" ]; then
  [ "$STACK" = "1" ] || fail "$WT already exists. Use it, or remove it first."
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

# 3. no .env.local carrying a DATABASE_URL in the tree we derive from. Prisma's CLI reads .env
#    and ignores .env.local, so such a file makes `prisma migrate dev` hit a different database
#    than the running app. That split brain is worse than any bug this design set out to fix,
#    which is why 4.4.3 deleted the file outright rather than merely not writing one.
if [ -f "$MAIN/apps/web/.env.local" ] && grep -q '^DATABASE_URL' "$MAIN/apps/web/.env.local"; then
  fail "$MAIN/apps/web/.env.local sets DATABASE_URL. Remove it (spec 4.4.3) before provisioning."
fi

# --- stack preflight, spec 4.3 items 3 to 6 --------------------------------

if [ "$STACK" = "1" ]; then
  # 3. a slot in 1..9 is free. agent_next_free_slot asks reality: no database, no listening
  #    ports. There is no registry file to go stale.
  SLOT=$(agent_next_free_slot) || fail "no free slot in 1..9. Run agent-status.sh to find orphans."
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
  agent_db_exists "$TEMPLATE" || fail "template database $TEMPLATE is unreachable. See docs/dev-environment.md."

  SRC_ENV="$MAIN/apps/web/.env"
  [ -f "$SRC_ENV" ] || fail "$SRC_ENV does not exist, so there is nothing to derive a slot .env from."
  grep -q '^DATABASE_URL=' "$SRC_ENV" || fail "$SRC_ENV has no DATABASE_URL to derive from."
  # An empty value would make SLOT_URL="${raw%/*}/$DB" silently collapse to "/$DB" further down.
  [ -n "$(sed -n '/^DATABASE_URL=/{s///p;q;}' "$SRC_ENV")" ] || fail "$SRC_ENV has an empty DATABASE_URL."
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
# failing under `set -Eeuo pipefail` (the .agent write, a `cp -Rc` mid-clone on a full disk, an
# `npx prisma generate` schema error from the branch's own commits) would otherwise leave a
# worktree that exists, is checked out, and looks ready but is not: the exact "worse than none"
# state the preflight exists to prevent, reached from a different direction. The trap rolls that
# back. CREATED_BRANCH is only 1 on the `-b` path, so a pre-existing branch is never destroyed.
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
      cp "$ENV_BACKUP" "$WT/apps/web/.env" 2>/dev/null || true
    else
      rm -f "$WT/apps/web/.env" 2>/dev/null || true
    fi
  fi
  [ -z "$ENV_BACKUP" ] || rm -f "$ENV_BACKUP" 2>/dev/null || true
  [ "$CREATED_WT" = "1" ] && git -C "$MAIN" worktree remove --force "$WT" 2>/dev/null || true
  [ "$CREATED_BRANCH" = "1" ] && git -C "$MAIN" branch -D "$BRANCH" 2>/dev/null || true
}

if [ "$UPGRADE" = "0" ]; then
  if git -C "$MAIN" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git -C "$MAIN" worktree add "$WT" "$BRANCH"
  else
    echo "agent-up: branch $BRANCH does not exist, creating it from main (spec 4.8)"
    CREATED_BRANCH=1
    git -C "$MAIN" worktree add -b "$BRANCH" "$WT" main
  fi
  CREATED_WT=1
fi
trap rollback ERR

if [ "$UPGRADE" = "0" ]; then
  # The marker records INTENT: which stream this worktree serves and which handover governs it.
  # Stream names do not derive from branch names for the 21 legacy handovers, which is the whole
  # reason this pointer exists.
  {
    echo '# Agent worktree marker (spec 4.7). Gitignored, per-worktree, dies with the worktree.'
    echo '# Written by scripts/agent-up.sh.'
    echo '#'
    echo '# Intent only. TIER below is a human-readable echo, rewritten by `agent-up.sh --stack`.'
    echo '# The authority is apps/web/.env: a worktree whose .env carries AGENT_SLOT is stack tier.'
    echo '# agent-status.sh derives tier and slot rather than trusting this file (principle 2).'
    echo ''
    echo "STREAM=$(agent_stream_slug "$BRANCH")"
    echo "HANDOVER=$HANDOVER"
    echo "BRANCH=$BRANCH"
    echo 'TIER=code'
    [ -z "$SPEC" ] || echo "SPEC=$SPEC"
  } > "$WT/.agent"

  # node_modules is always CLONED, never symlinked (founder ruling, 2026-07-29). A symlink would
  # let any `npm install` write through to every other worktree, and npm reconciles node_modules
  # against the installing worktree's lockfile, so it can REMOVE packages another worktree needs.
  # Seventeen seconds paid once is cheaper than one silent cross-worktree dependency change.
  echo "agent-up: cloning node_modules (about 17s, APFS clone-on-write, near-zero new blocks)"
  find "$MAIN" -maxdepth 3 -type d -name node_modules -prune | while read -r src; do
    rel=${src#"$MAIN"/}
    dst="$WT/$rel"
    [ -e "$dst" ] && continue
    mkdir -p "$(dirname "$dst")"
    cp -Rc "$src" "$dst"
  done

  # Prisma generates into apps/web/lib/generated/prisma, inside the worktree, so generated clients
  # cannot collide between worktrees. It needs no DATABASE_URL, which is what lets the code tier
  # exist without a database.
  #
  # Two statements, not `cd ... && npx prisma generate`: bash exempts every command in an
  # `&&`/`||` list except the last one from the ERR trap, `-E` included. A branch checked out here
  # that predates apps/web (before 399c77e) makes `cd` fail, and as `&&`'s non-final command that
  # would abort the script under `-e` while the trap never fires, leaving the worktree and its
  # cloned node_modules behind uncleaned. Two statements make `cd` the whole (and therefore
  # non-exempt) command, so its failure is caught like any other.
  echo "agent-up: generating the Prisma client"
  (
    cd "$WT/apps/web"
    npx prisma generate >/dev/null
  )
fi

if [ "$STACK" = "1" ]; then
  # --- apps/web/.env, spec 4.4.3 -------------------------------------------
  #
  # The slot env goes in .env and NOT .env.local, because Prisma's CLI reads .env and ignores
  # .env.local. With the override in .env.local, Next and tsx would read the agent's database
  # while `prisma migrate dev` read the main one, so an agent running a migration would silently
  # migrate the primary dev database from inside its supposedly isolated worktree.
  #
  # AGENT_SLOT must live here rather than only in the shell for the same reason: Prisma and tsx
  # read .env, and a slot whose AGENT_SLOT existed only in one shell would run cron the moment
  # any other process started its server.
  echo "agent-up: writing apps/web/.env for slot $SLOT"

  # Derive the URL by rewriting only the database name. Never synthesise credentials: the real
  # password is not the spec's illustrative literal.
  # `sed ... | head -1` is avoided: under pipefail sed can outrun head and the pipeline returns
  # 141 (SIGPIPE). `{p;q;}` stops at the first match with no pipe at all.
  raw=$(sed -n '/^DATABASE_URL=/{s///p;q;}' "$SRC_ENV" \
        | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//")
  case "$raw" in
    # `fail` calls `exit`, and `exit` does NOT fire an armed ERR trap in bash (a third exemption,
    # distinct from missing -E and from a non-final &&/|| command): verified on this machine that
    # `exit 1` after `trap ... ERR` never runs the trap. Every `fail` call from here to the end of
    # the STACK block is past `trap rollback ERR`, so each must call rollback explicitly first.
    *\?*) rollback; fail "the main DATABASE_URL carries query parameters; rewrite it by hand for slot $SLOT" ;;
  esac
  SLOT_URL="${raw%/*}/$DB"

  # Back up any pre-existing apps/web/.env OUTSIDE the worktree before overwriting it, so rollback
  # can restore it byte for byte. `mktemp` in the system temp dir, not a sibling file in the
  # worktree: `git check-ignore -v apps/web/.env.agent-up-bak` says NOT IGNORED, so a backup left
  # inside the worktree would show up as untracked, which makes `git worktree remove` refuse and
  # would make agent-reap.sh treat the tree as dirty and refuse to reap it.
  if [ -f "$WT/apps/web/.env" ]; then
    ENV_HAD_PRIOR=1
    ENV_BACKUP=$(mktemp "${TMPDIR:-/tmp}/agent-up-env-backup.XXXXXX")
    cp "$WT/apps/web/.env" "$ENV_BACKUP"
  fi
  ENV_WRITTEN=1

  # Copy every line the main tree has except the four this slot owns, then append ours.
  grep -v -E '^(AGENT_SLOT|PGBOSS_SCHEMA|DATABASE_URL|NEXT_PUBLIC_APP_URL)=' "$SRC_ENV" \
    > "$WT/apps/web/.env"
  {
    echo ''
    echo "# Slot $SLOT, written by scripts/agent-up.sh --stack (spec 4.4.3). Do not copy this"
    echo '# file between worktrees: it is what keeps this stack off the shared database.'
    printf 'AGENT_SLOT=%s\n' "$SLOT"
    printf 'DATABASE_URL="%s"\n' "$SLOT_URL"
    printf 'PGBOSS_SCHEMA=%s\n' "$SCHEMA"
    # The main tree's value hardcodes port 3000, so an unrewritten copy would point this slot's
    # absolute URLs at the MAIN tree's server.
    printf 'NEXT_PUBLIC_APP_URL="http://localhost:%s"\n' "$WEB_PORT"
  } >> "$WT/apps/web/.env"

  # SPOTIFY_REDIRECT_URI and GOOGLE_REDIRECT_URI also hardcode :3000 and are copied UNCHANGED,
  # deliberately. They are registered with Spotify and Google, so rewriting them to :3100 would
  # simply make the provider reject the callback. The consequence is a real and stated limit:
  # OAuth sign-in on a slot bounces back to the main tree's port. Say so rather than let it be
  # discovered mid-flow.
  if grep -qE '^(SPOTIFY_REDIRECT_URI|GOOGLE_REDIRECT_URI)=.*:3000' "$WT/apps/web/.env"; then
    echo "agent-up: NOTE, the OAuth redirect URIs still point at port 3000. They are registered"
    echo "agent-up:       with the providers and cannot be slotted, so platform sign-in from this"
    echo "agent-up:       slot will land on the main tree. Test sign-in on slot 0."
  fi

  # --- the database clone, spec 4.3 ----------------------------------------
  #
  # CREATE DATABASE ... TEMPLATE fails here: the template has live sessions. pg_dump piped into
  # psql takes 1.1s and preserves all 1199 global_enrichment rows.
  echo "agent-up: cloning $TEMPLATE into $DB (about 1.1s)"
  createdb -U "$AGENT_PG_USER" "$DB"
  CREATED_DB=1
  pg_dump -U "$AGENT_PG_USER" "$TEMPLATE" \
    | psql -U "$AGENT_PG_USER" -d "$DB" -q -v ON_ERROR_STOP=1 >/dev/null

  # NOT OPTIONAL. The dump carries the default pgboss schema with its 10 cron rows, including
  # press-all-editions at '0 * * * *'. Dropping it means pg-boss creates pgboss_a<N> fresh with
  # an EMPTY schedule table, so a non-owner agent runs no cron at all. Agents trigger jobs
  # explicitly through apps/web/scripts/dev-press-now.ts instead.
  echo "agent-up: dropping the inherited pgboss schema from $DB"
  psql -U "$AGENT_PG_USER" -d "$DB" -q -v ON_ERROR_STOP=1 -c 'DROP SCHEMA IF EXISTS pgboss CASCADE'
  left=$(psql -U "$AGENT_PG_USER" -d "$DB" -tAc \
         "select count(*) from pg_namespace where nspname = 'pgboss'")
  [ "$left" = "0" ] || { rollback; fail "the inherited pgboss schema survived in $DB. Refusing to leave a slot that can fire cron."; }

  # Keep the .agent echo honest after an upgrade. Guarded, not fatal: by this point the slot is
  # fully and correctly provisioned (database cloned, inherited schema dropped, .env written), and
  # .agent's TIER is not an authority, agent_tier_of_worktree derives tier solely from AGENT_SLOT
  # in apps/web/.env and never opens .agent (see the header this script writes into it, "Intent
  # only"). A failure here can only make the echo lag reality, not make the slot behave wrong, so
  # rolling back a correct clone and .env write to fix a label is the same spurious-rollback shape
  # line 326 below exists to avoid. Warn instead.
  if [ -f "$WT/.agent" ]; then
    if ! sed -i '' 's/^TIER=code$/TIER=stack/' "$WT/.agent" 2>/dev/null; then
      echo "agent-up: WARNING, could not refresh the .agent TIER echo. Cosmetic only: tier is derived" >&2
      echo "agent-up:          from apps/web/.env, not from .agent. The slot is provisioned correctly." >&2
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
  queue       $SCHEMA (empty schedule: this slot never fires cron)
  web port    $WEB_PORT
  Metro port  $METRO_PORT

Read the handover before your first write (spec 4.9 item 9).
Start the server: scripts/agent-dev.sh
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
Tests run here now: cd apps/web && npx vitest run
To boot a server, upgrade in place: scripts/agent-up.sh $BRANCH --stack
EOF
fi
