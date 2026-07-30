#!/usr/bin/env bash
set -euo pipefail

# One simulator at a time, enforced by a lock whose liveness is re-verified against the OS
# (spec 4.5).

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$HERE/lib/agent-slot.sh"

LOCK="$AGENT_SIM_LOCK"
LOCK_DIR=$(dirname "$LOCK")

usage() { echo "usage: sim-lock.sh <acquire|release|status> [slot] [--force]" >&2; exit 2; }

ACTION="${1:-}"
[ -n "$ACTION" ] || usage
shift || true

SLOT=""
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    *) SLOT="$1"; shift ;;
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

# The OS is the authority (principle 3), and the strongest OS-level fact is the booted device:
# it survives the script that booted it and is the resource actually being contended. Check it
# first, and fall back to the recorded pid only when the lock names no device. This rule now
# lives in scripts/lib/agent-slot.sh, so agent-status.sh and agent-reap.sh cannot drift from it.
holder_alive() {
  agent_sim_lock_alive "$LOCK"
}

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
    agent_slot_valid "$SLOT" || { echo "sim-lock: slot must be a digit 0..9, got '$SLOT'" >&2; exit 2; }

    mkdir -p "$LOCK_DIR"

    # `ln file dir` creates `dir/file` and returns 0, so if something (e.g. a trailing-slash
    # AGENT_SIM_LOCK override, or a stray `mkdir -p` of the wrong path) leaves a DIRECTORY at
    # $LOCK, the claim below would silently "succeed" into $LOCK/$CLAIM_TMP-basename while every
    # reader's `[ -f "$LOCK" ]` keeps reporting free. Fail loudly before that can happen.
    if [ -d "$LOCK" ]; then
      echo "sim-lock: $LOCK is a directory, not a lock file. Remove it or point AGENT_SIM_LOCK elsewhere." >&2
      exit 1
    fi

    # Claim before selecting or booting a device. `ln` fails atomically if the destination
    # already exists, so writing the FULL claim (with an empty UDID) into a temp file first and
    # hard-linking it into place means a reader either sees no file or a complete one, never a
    # partial one, and exactly one of any number of concurrent `ln` calls can win. holder_alive
    # falls back to the recorded pid when UDID is empty, and PID_TO_RECORD outlives this script,
    # so a concurrent acquire that loses the `ln` correctly sees this claim as held, not as a
    # still-forming lock it is entitled to break.
    #
    # Losing the `ln` means the lock already exists: an alive holder is a legitimate refusal. A
    # dead holder is broken by atomically renaming it out of the path with `mv`, which can only
    # succeed for one caller since the source vanishes for everyone else the instant it wins; the
    # loop then retries the `ln`, now uncontested. This replaces the old check-then-write with
    # nothing serializing the two, and the old truncate-then-fill `{ ... } > "$LOCK"`, which is
    # exactly the race and the partial write parked as a finding on this branch.
    CLAIMED=0
    TRIES=0
    while [ "$CLAIMED" = "0" ]; do
      TRIES=$((TRIES + 1))
      if [ "$TRIES" -gt 20 ]; then
        echo "sim-lock: giving up after 20 attempts to claim the lock, something is stuck" >&2
        exit 1
      fi

      CLAIM_TMP=$(mktemp "$LOCK_DIR/.sim.lock.claim.XXXXXX")
      {
        printf 'SLOT=%s\n' "$SLOT"
        printf 'PID=%s\n' "$PID_TO_RECORD"
        printf 'UDID=\n'
        printf 'ACQUIRED=%s\n' "$(date +%s)"
      } > "$CLAIM_TMP"

      if ln "$CLAIM_TMP" "$LOCK" 2>/dev/null; then
        rm -f "$CLAIM_TMP" 2>/dev/null || true
        CLAIMED=1
        break
      fi
      rm -f "$CLAIM_TMP" 2>/dev/null || true

      if holder_alive; then
        printf 'sim-lock: REFUSED. Slot %s holds the simulator (pid %s, device %s) for %s.\n' \
          "$(lock_get SLOT)" "$(lock_get PID)" "$(lock_get UDID)" "$(held_for)" >&2
        echo "sim-lock: wait, or ask that slot to run sim-lock.sh release." >&2
        exit 1
      fi

      # Stale, and loudly so: break it by renaming it out of the path. Whichever concurrent
      # acquire wins this rename is the only one that gets to print the message, and the only one
      # whose retry of `ln` above lands uncontested; anyone who loses the rename just retries and
      # finds the winner's fresh claim already in its place.
      STALE_TMP=$(mktemp "$LOCK_DIR/.sim.lock.stale.XXXXXX")
      if mv "$LOCK" "$STALE_TMP" 2>/dev/null; then
        printf 'sim-lock: BREAKING a stale lock held by slot %s, pid %s (process is dead).\n' \
          "$(sed -n '/^SLOT=/{s///p;q;}' "$STALE_TMP")" \
          "$(sed -n '/^PID=/{s///p;q;}' "$STALE_TMP")" >&2
      fi
      rm -f "$STALE_TMP" 2>/dev/null || true
    done

    # From here we alone hold the claim (UDID empty, our pid alive). A failure choosing or
    # booting a device below is a new failure mode this claim-first order introduces, and it must
    # not strand the lock for the next agent: release on any exit until we succeed below, then
    # cancel the trap.
    release_on_failure() {
      echo "sim-lock: a later step failed after claiming the lock for slot $SLOT, releasing it" >&2
      rm -f "$LOCK" 2>/dev/null || true
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

    # Fill in the UDID with the same atomic replace, so a reader never sees a half-updated lock.
    # SLOT, PID and ACQUIRED carry forward unchanged from the claim.
    FILL_TMP=$(mktemp "$LOCK_DIR/.sim.lock.fill.XXXXXX")
    {
      printf 'SLOT=%s\n' "$SLOT"
      printf 'PID=%s\n' "$PID_TO_RECORD"
      printf 'UDID=%s\n' "$UDID"
      printf 'ACQUIRED=%s\n' "$(lock_get ACQUIRED)"
    } > "$FILL_TMP"
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
    rm -f "$LOCK"
    echo "sim-lock: released"
    ;;

  *) usage ;;
esac
