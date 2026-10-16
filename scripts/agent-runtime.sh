#!/usr/bin/env bash
set -Eeuo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
HELPER="$HERE/lib/agent-runtime.py"
ACTION=${1:-}
[ -n "$ACTION" ] || { echo 'usage: agent-slots <start|heartbeat|pin|unpin|pause|release|sweep> ...' >&2; exit 2; }
shift
KIND=""
START_ARGS=()
if [ "$ACTION" = start ]; then
  KIND=${1:-}; [ -n "$KIND" ] || { echo 'usage: agent-slots start <web|mobile> --worktree PATH [-- args...]' >&2; exit 2; }
  shift
  case "$KIND" in web|mobile) ;; *) echo "agent-slots: unknown process service: $KIND" >&2; exit 2 ;; esac
fi
WT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
REPO="${AGENT_REPO_ROOT:-}"
TASK="${AGENT_TASK_ID:-}"
SESSION="${AGENT_SESSION_ID:-}"
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree|--repo|--task|--session)
      [ $# -ge 2 ] || { echo "agent-slots: $1 requires a value" >&2; exit 2; }
      case "$1" in
        --worktree) WT=$2 ;;
        --repo) REPO=$2 ;;
        --task) TASK=$2 ;;
        --session) SESSION=$2 ;;
      esac
      shift 2 ;;
    --yes) YES=1; shift ;;
    --)
      shift
      while [ $# -gt 0 ]; do START_ARGS+=("$1"); shift; done ;;
    *) echo "agent-slots: unknown option: $1" >&2; exit 2 ;;
  esac
done
if [ "$ACTION" = sweep ]; then
  [ -n "$REPO" ] || REPO=$(git rev-parse --show-toplevel 2>/dev/null) || { echo 'agent-slots: sweep requires --repo or a Git checkout' >&2; exit 1; }
  exec python3 -I "$HELPER" sweep "$REPO" "$YES"
fi
[ -n "$WT" ] || { echo 'agent-slots: --worktree is required outside a Git worktree' >&2; exit 2; }
WT=$(cd "$WT" 2>/dev/null && pwd -P) || { echo 'agent-slots: worktree does not exist' >&2; exit 1; }
if [ "${AGENT_RUNTIME_LOCKED_PATH:-}" != "$WT" ]; then
  lock_args=("$ACTION")
  [ -z "$KIND" ] || lock_args+=("$KIND")
  lock_args+=(--worktree "$WT")
  [ -z "$TASK" ] || lock_args+=(--task "$TASK")
  [ -z "$SESSION" ] || lock_args+=(--session "$SESSION")
  [ "$YES" = 0 ] || lock_args+=(--yes)
  [ "$ACTION" != start ] || lock_args+=(--)
  [ "$ACTION" != start ] || lock_args+=(${START_ARGS[@]+"${START_ARGS[@]}"})
  exec python3 -I "$HELPER" lock "$WT" 0 "$HERE/agent-runtime.sh" "${lock_args[@]}"
fi
cd "$WT"
umask 077
. "$HERE/lib/agent-slot.sh"
agent_config_validate
python_call() { python3 -I "$HELPER" "$@"; }
read_marker() { python_call read "$WT"; }
update_marker() { python_call update "$WT" "$TASK" "$SESSION" "$1" >/dev/null; }
release_mobile_lock() {
  local lock_workspace lock_repo slot
  [ -f "$AGENT_SIM_LOCK" ] || return 0
  lock_workspace=$(sed -n '/^WORKSPACE=/{s///p;q;}' "$AGENT_SIM_LOCK")
  [ "$lock_workspace" = "$WT" ] || return 0
  lock_repo=$(sed -n '/^REPO=/{s///p;q;}' "$AGENT_SIM_LOCK")
  [ "$lock_repo" = "$(agent_main_root)" ] || { echo 'agent-slots: simulator lock identity mismatch; preserving runtime claim' >&2; return 1; }
  slot=$(sed -n '/^SLOT=/{s///p;q;}' "$AGENT_SIM_LOCK")
  [ -n "$slot" ] || { echo 'agent-slots: simulator lock is malformed; preserving runtime claim' >&2; return 1; }
  "$HERE/sim-lock.sh" release "$slot"
}
case "$ACTION" in
  heartbeat|pin|unpin)
    python_call "$ACTION" "$WT" "$TASK" "$SESSION" >/dev/null
    printf 'agent-slots: %s updated for %s\n' "$ACTION" "$WT" ;;
  start)
    marker=$(read_marker)
    [ -n "$marker" ] || { echo 'agent-slots: attach this worktree to the requested service first' >&2; exit 1; }
    selected=$(python3 -I - "$marker" "$KIND" <<'PYSEL'
import json,sys
print(int(sys.argv[2] in json.loads(sys.argv[1]).get("services", [])))
PYSEL
)
    [ "$selected" = 1 ] || { echo "agent-slots: $KIND was not selected when this worktree attached" >&2; exit 1; }
    slot=$(python3 -I - "$marker" <<'PYSLOT'
import json,sys
print(json.loads(sys.argv[1]).get("resources", {}).get("slot", ""))
PYSLOT
)
    [ -n "$slot" ] || { echo 'agent-slots: runtime marker has no slot' >&2; exit 1; }
    if [ "$KIND" = web ]; then port=$(agent_web_port "$slot"); else port=$(agent_metro_port "$slot"); fi
    ! agent_port_busy "$port" || { echo "agent-slots: port $port is already listening; refusing to adopt it" >&2; exit 1; }
    already=$(python3 -I - "$marker" "$KIND" <<'PYPROC'
import json,sys
m=json.loads(sys.argv[1]); print(int(any(p.get("service")==sys.argv[2] for p in m.get("processes",[]))))
PYPROC
)
    [ "$already" = 0 ] || { echo "agent-slots: managed $KIND process already recorded" >&2; exit 1; }
    token=$(python3 -I - "$marker" <<'PYTOKEN'
import json,sys
print(json.loads(sys.argv[1])["identity"])
PYTOKEN
)
    gitdir=$(git -C "$WT" rev-parse --path-format=absolute --git-dir)
    nonce=$(python3 -I -c 'import secrets; print(secrets.token_hex(8))')
    log="$gitdir/agent-runtime-$token-$KIND-$nonce.log"
    intent=$(python3 -I - "$marker" "$KIND" "$log" <<'PYINTENT'
import json,sys
m=json.loads(sys.argv[1]); m["processes"].append({"service":sys.argv[2],"log":sys.argv[3],"starting":True}); m["state"]="starting"
print(json.dumps({"processes":m["processes"],"state":m["state"]}))
PYINTENT
)
    update_marker "$intent"
    process=$(python3 -I "$HELPER" launch "$WT" "$HERE/agent-runtime.sh" "$KIND" "$port" "$log" ${START_ARGS[@]+"${START_ARGS[@]}"}) || {
      echo "agent-slots: $KIND start failed; runtime start intent and log retained for inspection: $log" >&2
      exit 1
    }
    pid=$(python3 -I - "$process" <<'PYPID'
import json,sys
print(json.loads(sys.argv[1])["pid"])
PYPID
)
    receipt=$(python3 -I - "$marker" "$process" "$KIND" "$log" <<'PYRECEIPT'
import json,sys
m=json.loads(sys.argv[1]); p=json.loads(sys.argv[2]); p["service"]=sys.argv[3]; p["log"]=sys.argv[4]
m["processes"].append(p)
print(json.dumps({"processes":m["processes"],"heartbeat":__import__("time").time_ns()//1000000000,"state":"active"}))
PYRECEIPT
)
    update_marker "$receipt"
    printf 'agent-slots: started managed %s process %s on port %s (log %s)\n' "$KIND" "$pid" "$port" "$log" ;;
  pause|release)
    marker=$(read_marker)
    [ -n "$marker" ] || { echo "agent-slots: no runtime resources are attached to $WT"; exit 0; }
    while IFS= read -r process; do
      [ -n "$process" ] || continue
      python3 -I "$HELPER" stop-process "$WT" "$process"
    done < <(python3 -I - "$marker" <<'PYPIDS'
import json,sys
for process in json.loads(sys.argv[1]).get("processes",[]): print(json.dumps(process,sort_keys=True))
PYPIDS
)
    if python3 -I - "$marker" <<'PYMOBILE'
import json,sys
sys.exit(0 if "mobile" in json.loads(sys.argv[1]).get("services",[]) else 1)
PYMOBILE
    then release_mobile_lock; fi
    [ "$ACTION" != pause ] || {
      update_marker '{"processes":[],"state":"paused"}'
      echo "agent-slots: paused $WT; database, env, slot claim and worktree retained"
      exit 0
    }
    db=$(python3 -I - "$marker" <<'PYDB'
import json,sys
print(json.loads(sys.argv[1]).get("resources",{}).get("db",""))
PYDB
)
    db_state=$(python3 -I - "$marker" <<'PYDBSTATE'
import json,sys
resources=json.loads(sys.argv[1]).get("resources",{})
print("created" if resources.get("db_created") is True else
      "unknown" if resources.get("db_create_started") is True else "none")
PYDBSTATE
)
    if [ -n "$db" ] && [ "$db_state" = unknown ]; then
      echo "agent-slots: database creation outcome is unknown for $db; inspect it before releasing" >&2
      exit 1
    fi
    if [ -n "$db" ] && [ "$db_state" = created ]; then
      endpoint=$(python3 -I - "$marker" <<'PYENDPOINT'
import json,sys
r=json.loads(sys.argv[1]).get("resources",{})
e=r.get("db_endpoint",{})
print("\t".join(str(e.get(k,"")) for k in ("host","port","user")))
PYENDPOINT
)
      IFS=$'\t' read -r db_host db_port db_user <<< "$endpoint"
      validated=$(python3 -I "$HELPER" local-db-endpoint "$db_host" "$db_port" "$db_user") || {
        echo 'agent-slots: recorded database endpoint is invalid; runtime claim retained' >&2
        exit 1
      }
      db_host=$(python3 -I -c 'import json,sys; print(json.loads(sys.argv[1])["host"])' "$validated")
      db_port=$(python3 -I -c 'import json,sys; print(json.loads(sys.argv[1])["port"])' "$validated")
      db_user=$(python3 -I -c 'import json,sys; print(json.loads(sys.argv[1])["user"])' "$validated")
      # An inherited PGHOSTADDR can override -h and route libpq to another server.
      unset PGHOSTADDR PGSERVICE PGSERVICEFILE
      slot=$(python3 -I - "$marker" <<'PYSLOT'
import json,sys
print(json.loads(sys.argv[1]).get("resources",{}).get("slot",""))
PYSLOT
)
      case "$slot" in ''|*[!0-9]*|0) echo 'agent-slots: recorded database slot is invalid; runtime claim retained' >&2; exit 1 ;; esac
      [ "$db" = "$(agent_db_name "$slot")" ] || { echo 'agent-slots: recorded database name no longer matches its slot; runtime claim retained' >&2; exit 1; }
      db_oid=$(python3 -I - "$marker" <<'PYOID'
import json,sys
print(json.loads(sys.argv[1]).get("resources",{}).get("db_oid",""))
PYOID
)
      case "$db_oid" in ''|*[!0-9]*) echo 'agent-slots: recorded database identity is missing; runtime claim retained' >&2; exit 1 ;; esac
      agent_require_commands psql dropdb
      current_oid=$(psql -h "$db_host" -p "$db_port" -U "$db_user" -d postgres -tAc "select oid from pg_database where datname = '$db'" | tr -d '[:space:]')
      if [ -n "$current_oid" ]; then
        [ "$current_oid" = "$db_oid" ] || { echo "agent-slots: database $db has a different identity; refusing to drop it" >&2; exit 1; }
        dropdb -h "$db_host" -p "$db_port" -U "$db_user" "$db" || { echo "agent-slots: could not safely drop $db; runtime claim retained" >&2; exit 1; }
      fi
    fi
    python_call env-restore "$WT"
    python_call clear "$WT" "$TASK" "$SESSION" >/dev/null
    echo "agent-slots: released runtime resources for $WT; Git worktree retained" ;;
  *) echo "agent-slots: unknown command: $ACTION" >&2; exit 2 ;;
esac
