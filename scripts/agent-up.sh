#!/usr/bin/env bash
set -Eeuo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
HELPER="$HERE/lib/agent-runtime.py"
WT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
TASK="${AGENT_TASK_ID:-}"
SESSION="${AGENT_SESSION_ID:-}"
PREPARE=0
SERVICES=()
SERVICE_COUNT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) [ $# -ge 2 ] || exit 2; WT=$2; shift 2 ;;
    --prepare) PREPARE=1; shift ;;
    --service) [ $# -ge 2 ] || { echo 'agent-slots: --service requires web, db, queue or mobile' >&2; exit 2; }; SERVICES+=("$2"); SERVICE_COUNT=$((SERVICE_COUNT + 1)); shift 2 ;;
    --task) [ $# -ge 2 ] || exit 2; TASK=$2; shift 2 ;;
    --session) [ $# -ge 2 ] || exit 2; SESSION=$2; shift 2 ;;
    -h|--help) echo 'usage: agent-slots attach --worktree PATH [--prepare] [--service web|db|queue|mobile]'; exit 0 ;;
    *) echo "agent-slots: unknown attach option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$WT" ] || { echo 'agent-slots: --worktree is required outside a Git worktree' >&2; exit 2; }
WT=$(cd "$WT" 2>/dev/null && pwd -P) || { echo "agent-slots: worktree does not exist: $WT" >&2; exit 1; }
cd "$WT"
if [ "${AGENT_RUNTIME_LOCKED_PATH:-}" != "$WT" ]; then
  lock_args=(--worktree "$WT")
  [ -z "$TASK" ] || lock_args+=(--task "$TASK")
  [ -z "$SESSION" ] || lock_args+=(--session "$SESSION")
  [ "$PREPARE" = 0 ] || lock_args+=(--prepare)
  for service in ${SERVICES[@]+"${SERVICES[@]}"}; do lock_args+=(--service "$service"); done
  exec python3 -I "$HELPER" lock "$WT" 0 "$HERE/agent-up.sh" "${lock_args[@]}"
fi
. "$HERE/lib/agent-slot.sh"
agent_config_validate
AGENT_LEASE_SECONDS="${AGENT_LEASE_SECONDS:-1800}"
export AGENT_LEASE_SECONDS
MAIN=$(agent_main_root)
branch=$(git -C "$WT" symbolic-ref --quiet --short HEAD) || { echo 'agent-slots: detached worktree cannot be attached' >&2; exit 1; }
[ "$WT" != "$MAIN" ] || { echo 'agent-slots: refusing the primary worktree' >&2; exit 1; }

seen=' '
for service in ${SERVICES[@]+"${SERVICES[@]}"}; do
  case "$service" in web|db|queue|mobile) ;; *) echo "agent-slots: unknown service: $service" >&2; exit 2 ;; esac
  case "$seen" in *" $service "*) echo "agent-slots: repeated service: $service" >&2; exit 2 ;; esac
  seen="$seen$service "
done
if [ "$PREPARE" = 1 ]; then
  if agent_dependencies_present "$WT"; then
    agent_dependencies_stale "$WT" && { echo 'agent-slots: dependencies MAY BE STALE; update them explicitly' >&2; exit 1; }
  else
    cd "$MAIN"
    agent_prepare_worktree "$MAIN" "$WT"
    cd "$WT"
  fi
fi
[ "$SERVICE_COUNT" -gt 0 ] || { echo "agent-slots: worktree ready at $WT${PREPARE:+ (prepare requested)}"; exit 0; }

want_db=0; want_queue=0; want_web=0; want_mobile=0
for service in ${SERVICES[@]+"${SERVICES[@]}"}; do
  case "$service" in db) want_db=1 ;; queue) want_queue=1; want_db=1 ;; web) want_web=1 ;; mobile) want_mobile=1 ;; esac
done
DB_URL=''; DB_HOST=''; DB_PORT=''; DB_USER="$AGENT_PG_USER"
if [ "$want_db" = 1 ]; then
  for conflict_root in "$MAIN" "$WT"; do
    conflict_env=$(agent_conflict_env_path "$conflict_root" 2>/dev/null || true)
    if [ -n "$conflict_env" ] && [ -f "$conflict_env" ] && grep -q "^${AGENT_DATABASE_URL_KEY}=" "$conflict_env"; then
      echo "agent-slots: $conflict_env sets $AGENT_DATABASE_URL_KEY; remove that override before allocating a separate database" >&2
      exit 1
    fi
  done
  src_env=$(agent_env_path "$MAIN")
  [ -f "$src_env" ] || { echo "agent-slots: source env missing: $src_env" >&2; exit 1; }
  raw=$(sed -n "/^${AGENT_DATABASE_URL_KEY}=/{s///p;q;}" "$src_env" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
  [ -n "$raw" ] || { echo "agent-slots: source $AGENT_DATABASE_URL_KEY is empty" >&2; exit 1; }
  endpoint=$(python3 -I "$HELPER" local-db-url "$raw" "$(agent_db_name 0)" "$(agent_db_name 1)" "$AGENT_PG_USER") || exit 1
  DB_URL=$(python3 -I -c 'import json,sys; print(json.loads(sys.argv[1])["url"])' "$endpoint")
  DB_HOST=$(python3 -I -c 'import json,sys; print(json.loads(sys.argv[1])["host"])' "$endpoint")
  DB_PORT=$(python3 -I -c 'import json,sys; print(json.loads(sys.argv[1])["port"])' "$endpoint")
  # Make every libpq preflight use the same local instance as the validated application URL.
  PGHOST=$DB_HOST PGPORT=$DB_PORT
  export PGHOST PGPORT
  unset PGHOSTADDR PGSERVICE PGSERVICEFILE
  agent_require_commands psql createdb dropdb pg_dump
  agent_postgres_reachable || { echo 'agent-slots: local PostgreSQL is unreachable' >&2; exit 1; }
  agent_db_exists "$(agent_db_name 0)" || { echo 'agent-slots: source database is unavailable' >&2; exit 1; }
fi
[ "$AGENT_SLOT_MAX" -gt 0 ] || { echo 'agent-slots: no nonzero slots are configured' >&2; exit 1; }
claimed_slots=$(python3 -I "$HELPER" used-slots "$MAIN") || exit 1
SLOT=''
n=1
while [ "$n" -le "$AGENT_SLOT_MAX" ]; do
  if ! printf '%s\n' "$claimed_slots" | grep -qx "$n" \
    && { [ "$want_db" = 0 ] || ! agent_db_exists "$(agent_db_name "$n")"; } \
    && { [ "$want_web" = 0 ] || ! agent_port_busy "$(agent_web_port "$n")"; } \
    && { [ "$want_mobile" = 0 ] || ! agent_port_busy "$(agent_metro_port "$n")"; }; then
    SLOT=$n
    break
  fi
  n=$((n + 1))
done
[ -n "$SLOT" ] || { echo 'agent-slots: no free slot for the requested local resources' >&2; exit 1; }
DB=$(agent_db_name "$SLOT")
if [ "$want_db" = 1 ]; then
  endpoint=$(python3 -I "$HELPER" local-db-url "$raw" "$(agent_db_name 0)" "$DB" "$AGENT_PG_USER") || exit 1
  DB_URL=$(python3 -I -c 'import json,sys; print(json.loads(sys.argv[1])["url"])' "$endpoint")
fi
WEB_PORT=$(agent_web_port "$SLOT")
METRO_PORT=$(agent_metro_port "$SLOT")
SCHEMA=$(agent_boss_schema "$SLOT")
[ "$want_queue" = 0 ] || [ -n "$AGENT_QUEUE_SCHEMA_KEY" ] || { echo 'agent-slots: queue isolation is not configured' >&2; exit 1; }
[ "$want_web" = 0 ] || ! agent_port_busy "$WEB_PORT" || { echo "agent-slots: web port $WEB_PORT is already listening" >&2; exit 1; }
[ "$want_mobile" = 0 ] || ! agent_port_busy "$METRO_PORT" || { echo "agent-slots: mobile port $METRO_PORT is already listening" >&2; exit 1; }

services_json=$(printf '%s\n' "${SERVICES[@]}" | python3 -I -c 'import json,sys; print(json.dumps([x.strip() for x in sys.stdin if x.strip()]))')
python3 -I "$HELPER" claim "$WT" "$TASK" "$SESSION" "$services_json" >/dev/null
DB_CREATE_STARTED=0
DB_CREATED=0
DB_OID=''
ENV_APPLY_STARTED=0
rollback() {
  status=$?
  trap - ERR
  set +e
  if [ "$DB_CREATE_STARTED" = 1 ] && [ "$DB_CREATED" = 0 ]; then
    echo 'agent-slots: database creation outcome is unknown; preserving the runtime claim for inspection' >&2
    exit "$status"
  fi
  if [ "$DB_CREATED" = 1 ]; then
    current_oid=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -tAc "select oid from pg_database where datname = '$DB'" 2>/dev/null | tr -d '[:space:]')
    if [ -z "$DB_OID" ] || [ "$current_oid" != "$DB_OID" ]; then
      echo 'agent-slots: database identity changed or is unknown; preserving the runtime claim' >&2
      exit "$status"
    fi
    if ! dropdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB" >/dev/null 2>&1; then
      echo 'agent-slots: could not remove the database created by this attach; preserving its runtime claim' >&2
      exit "$status"
    fi
    DB_CREATED=0
  fi
  if [ "$ENV_APPLY_STARTED" = 1 ] && ! python3 -I "$HELPER" env-restore "$WT" >/dev/null 2>&1; then
    echo 'agent-slots: could not restore the environment changed by this attach; preserving its runtime claim' >&2
    exit "$status"
  fi
  python3 -I "$HELPER" clear "$WT" "$TASK" "$SESSION" >/dev/null 2>&1 || \
    echo 'agent-slots: could not clear the runtime claim; preserving it for inspection' >&2
  exit "$status"
}
trap rollback ERR
plan=$(python3 -I - "$SLOT" "$DB" "$WEB_PORT" "$METRO_PORT" "$SCHEMA" "$(agent_env_path "$WT")" "$want_db" "$want_web" "$want_mobile" "$want_queue" "$DB_HOST" "$DB_PORT" "$DB_USER" <<'PYPLAN'
import json,sys
slot,db,web,metro,schema,env,want_db,want_web,want_mobile,want_queue,db_host,db_port,db_user=sys.argv[1:]
resources={"slot":int(slot),"env_path":env}
if want_db == "1": resources.update(db=db, db_create_started=False, db_created=False,
    db_endpoint={"host":db_host,"port":int(db_port),"user":db_user})
if want_web == "1": resources["web_port"]=int(web)
if want_mobile == "1": resources["metro_port"]=int(metro)
if want_queue == "1": resources["schema"]=schema
print(json.dumps({"resources":resources}))
PYPLAN
)
python3 -I "$HELPER" update "$WT" "$TASK" "$SESSION" "$plan" >/dev/null

if [ "$want_db" = 1 ]; then
  env_values=$(python3 -I - "$AGENT_SLOT_KEY" "$SLOT" "$AGENT_DATABASE_URL_KEY" "$DB_URL" "$AGENT_QUEUE_SCHEMA_KEY" "$SCHEMA" "$AGENT_PUBLIC_URL_KEY" "$AGENT_PUBLIC_URL_FORMAT" "$WEB_PORT" "$want_queue" "$want_web" <<'PYJSON'
import json,sys
slotk,slot,dbk,url,qk,schema,uk,fmt,port,queue,web=sys.argv[1:]
d={slotk:slot,dbk:url}
if queue == "1" and qk: d[qk]=schema
if web == "1" and uk: d[uk]=fmt % port
print(json.dumps(d))
PYJSON
)
  python3 -I "$HELPER" update "$WT" "$TASK" "$SESSION" '{"resources":{"db_create_started":true}}' >/dev/null
  DB_CREATE_STARTED=1
  createdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB"
  DB_OID=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -tAc "select oid from pg_database where datname = '$DB'" | tr -d '[:space:]')
  case "$DB_OID" in ''|*[!0-9]*) echo 'agent-slots: could not capture the created database identity; preserving the runtime claim' >&2; false ;; esac
  DB_CREATED=1
  python3 -I "$HELPER" update "$WT" "$TASK" "$SESSION" "{\"resources\":{\"db_created\":true,\"db_oid\":$DB_OID}}" >/dev/null
  pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$(agent_db_name 0)" | psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB" -q -v ON_ERROR_STOP=1 >/dev/null
  if [ -n "$AGENT_INHERITED_QUEUE_SCHEMA" ]; then
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB" -q -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS $AGENT_INHERITED_QUEUE_SCHEMA CASCADE"
  fi
else
  env_values=$(python3 -I - "$AGENT_SLOT_KEY" "$SLOT" "$AGENT_PUBLIC_URL_KEY" "$AGENT_PUBLIC_URL_FORMAT" "$WEB_PORT" "$want_web" <<'PYJSON'
import json,sys
slotk,slot,uk,fmt,port,web=sys.argv[1:]
d={slotk:slot}
if web == "1" and uk: d[uk]=fmt % port
print(json.dumps(d))
PYJSON
)
fi
ENV_APPLY_STARTED=1
python3 -I "$HELPER" env-apply "$WT" "$env_values" >/dev/null
agent_after_slot_env "$(agent_env_path "$WT")" "$SLOT" "$WEB_PORT"
python3 -I "$HELPER" complete "$WT" "$TASK" "$SESSION" >/dev/null
trap - ERR
printf 'agent-slots: attached %s to %s (slot %s; services: %s)\n' "$branch" "$WT" "$SLOT" "${SERVICES[*]}"
