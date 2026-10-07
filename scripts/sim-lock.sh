#!/usr/bin/env bash
set -euo pipefail

# One simulator at a time, enforced by a lock whose liveness is re-verified against the OS
# (spec 4.5).

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$HERE/lib/agent-slot.sh"
. "$HERE/lib/agent-lock.sh"
ORIGINAL_ARGS=("$@")
agent_config_validate

LOCK="$AGENT_SIM_LOCK"
LOCK_DIR=$(dirname "$LOCK")
REPO=$(agent_main_root)
WORKSPACE=$(git rev-parse --show-toplevel)

usage() { echo "usage: sim-lock.sh <acquire|release|status> [slot] [--force]" >&2; exit 2; }

ACTION="${1:-}"
[ -n "$ACTION" ] || usage
shift || true

SLOT=""
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    *) [ -z "$SLOT" ] || usage; SLOT="$1"; shift ;;
  esac
done

# Portable form, and the `|| true` makes getting this wrong SILENT: under BSD sed the GNU
# variant returns empty with status 0, so every field would read as absent, holder_alive would
# always be false, and every acquire would break a live lock and boot a second simulator.
lock_get() { [ -f "$LOCK" ] && sed -n "/^$1=/{s///p;q;}" "$LOCK" || true; }

# The PID recorded in the lock must be a process that OUTLIVES this script.
#
# `$$` would be sim-lock.sh's own pid, and sim-lock.sh exits on the next line. Recording it makes
# every lock stale the instant it is written: the very next `acquire` finds a dead holder, breaks
# the lock and takes it, so the exclusivity guarantee never holds for a single second. A long
# lived caller (an agent session, a CI job) sets AGENT_SIM_PID to its own pid; otherwise the
# invoking shell, $PPID, is the best available proxy for "the agent that took this lock".
PID_TO_RECORD="${AGENT_SIM_PID:-$PPID}"

# The owner process and device must both still exist after acquisition completes. During the
# claim-before-boot window the UDID is empty, so the live owner process alone protects the claim.
holder_alive() { agent_sim_lock_alive "$LOCK"; }
claim_is_ours() { [ "$(lock_get CLAIM)" = "$CLAIM" ]; }
# Serialize stale checks, claims, device work, updates and release on the host-wide lock.
# Keep the mutex file forever: unlinking it would let a second inode acquire a second lock.
mkdir -p "$LOCK_DIR"
agent_lock_enter "$LOCK.mutex" "${ORIGINAL_ARGS[@]}"

held_for() {
  local acq now
  acq=$(lock_get ACQUIRED)
  [ -n "$acq" ] || { echo "unknown"; return 0; }
  now=$(date +%s)
  echo "$(( (now - acq) / 60 )) minutes"
}

case "$ACTION" in

  status)
    if [ ! -f "$LOCK" ]; then
      echo "sim-lock: free"
      exit 0
    fi
    agent_require_commands xcrun
    printf 'sim-lock: held by slot %s, pid %s, device %s, for %s\n' \
      "$(lock_get SLOT)" "$(lock_get PID)" "$(lock_get UDID)" "$(held_for)"
    if holder_alive; then
      echo "sim-lock: holder is ALIVE"
    else
      echo "sim-lock: holder is DEAD. The next acquire will break this lock."
      exit 1
    fi
    ;;

  acquire)
    [ -n "$SLOT" ] || usage
    agent_slot_valid "$SLOT" || { echo "sim-lock: slot must be in 0..$AGENT_SLOT_MAX, got '$SLOT'" >&2; exit 2; }
    agent_require_commands xcrun jq

    mkdir -p "$LOCK_DIR"

    # `ln file dir` creates `dir/file` and returns 0, so if something (e.g. a trailing-slash
    # AGENT_SIM_LOCK override, or a stray `mkdir -p` of the wrong path) leaves a DIRECTORY at
    # $LOCK, the claim below would silently "succeed" into $LOCK/$CLAIM_TMP-basename while every
    # reader's `[ -f "$LOCK" ]` keeps reporting free. Fail loudly before that can happen.
    if [ -d "$LOCK" ]; then
      echo "sim-lock: $LOCK is a directory, not a lock file. Remove it or point AGENT_SIM_LOCK elsewhere." >&2
      exit 1
    fi

    agent_check_ownership "$WORKSPACE" "acquire simulator" || exit 1
    if [ -f "$LOCK" ]; then
      if holder_alive; then
        printf 'sim-lock: REFUSED. Slot %s holds the simulator (pid %s, device %s) for %s.\n' \
          "$(lock_get SLOT)" "$(lock_get PID)" "$(lock_get UDID)" "$(held_for)" >&2
        exit 1
      fi
      printf 'sim-lock: BREAKING a stale lock held by slot %s, pid %s.\n' \
        "$(lock_get SLOT)" "$(lock_get PID)" >&2
      rm -f "$LOCK"
    fi
    CLAIM="$$.$RANDOM.$(date +%s)"
    CLAIM_TMP=$(mktemp "$LOCK_DIR/.sim.lock.claim.XXXXXX")
    {
      printf 'SLOT=%s\n' "$SLOT"
      printf 'PID=%s\n' "$PID_TO_RECORD"
      printf 'UDID=\n'
      printf 'ACQUIRED=%s\n' "$(date +%s)"
      printf 'REPO=%s\n' "$REPO"
      printf 'WORKSPACE=%s\n' "$WORKSPACE"
      printf 'CLAIM=%s\n' "$CLAIM"
    } > "$CLAIM_TMP"
    mv "$CLAIM_TMP" "$LOCK"

    release_on_failure() {
      echo "sim-lock: acquisition failed for slot $SLOT, releasing its claim" >&2
      if claim_is_ours; then rm -f "$LOCK"; fi
    }
    trap release_on_failure EXIT

    # Prefer a device that is already booted, so acquiring does not gratuitously boot a second
    # one. Otherwise take AGENT_SIM_DEVICE by name, else the first available iPhone.
    UDID=$(xcrun simctl list devices booted -j 2>/dev/null | jq -r '[.devices[][]] | .[0].udid // empty')
    if [ -z "$UDID" ]; then
      if [ -n "${AGENT_SIM_DEVICE:-}" ]; then
        UDID=$(xcrun simctl list devices available -j | jq -r --arg n "$AGENT_SIM_DEVICE" \
               '[.devices[][] | select(.name == $n)] | .[0].udid // empty')
        [ -n "$UDID" ] || { echo "sim-lock: no available device named '$AGENT_SIM_DEVICE'" >&2; exit 1; }
      else
        UDID=$(xcrun simctl list devices available -j | jq -r \
               '[.devices[][] | select(.name | startswith("iPhone"))] | .[0].udid // empty')
        [ -n "$UDID" ] || { echo "sim-lock: no available iPhone simulator found" >&2; exit 1; }
      fi
      echo "sim-lock: booting $UDID"
      xcrun simctl boot "$UDID"
    fi

    claim_is_ours || { echo "sim-lock: claim changed during acquisition; refusing to update it" >&2; exit 1; }
    FILL_TMP=$(mktemp "$LOCK_DIR/.sim.lock.fill.XXXXXX")
    sed "s/^UDID=.*/UDID=$UDID/" "$LOCK" > "$FILL_TMP"
    mv "$FILL_TMP" "$LOCK"

    trap - EXIT
    printf 'sim-lock: slot %s holds the simulator, device %s.\n' "$SLOT" "$UDID"
    echo "sim-lock: release it when you are done: scripts/sim-lock.sh release $SLOT"
    ;;

  release)
    [ -n "$SLOT" ] || usage
    if [ ! -f "$LOCK" ]; then
      echo "sim-lock: no lock to release"
      exit 0
    fi
    agent_require_commands xcrun
    [ "$(lock_get REPO)" = "$REPO" ] || {
      echo "sim-lock: REFUSED. The simulator belongs to another repository." >&2; exit 1;
    }
    owner_workspace=$(lock_get WORKSPACE)
    [ -n "$owner_workspace" ] || { echo "sim-lock: legacy claim has no workspace identity; refusing release" >&2; exit 1; }
    agent_check_ownership "$owner_workspace" "release simulator" || exit 1
    RELEASE_CLAIM=$(lock_get CLAIM)
    holder=$(lock_get SLOT)
    if [ "$holder" != "$SLOT" ] && [ "$FORCE" = "0" ]; then
      printf 'sim-lock: REFUSED. The lock is held by slot %s, not %s. Use --force to override.\n' \
        "$holder" "$SLOT" >&2
      exit 1
    fi
    udid=$(lock_get UDID)
    if [ -n "$udid" ]; then
      echo "sim-lock: shutting down $udid"
      xcrun simctl shutdown "$udid" 2>/dev/null || true
    fi
    osascript -e 'tell application "Simulator" to quit' 2>/dev/null || true
    [ "$(lock_get CLAIM)" = "$RELEASE_CLAIM" ] || {
      echo "sim-lock: claim changed during release; refusing to remove it" >&2; exit 1;
    }
    rm -f "$LOCK"
    echo "sim-lock: released"
    ;;

  *) usage ;;
esac
