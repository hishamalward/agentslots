#!/usr/bin/env bash
# Capability checks for the host profile that will run AgentSlots.
set -euo pipefail

usage() {
  echo 'usage: agent-check.sh [--code] [--simulator]' >&2
  echo 'Checks prerequisites without provisioning slots; initializes the configured coordination directory and creates/removes one private probe.' >&2
  exit 2
}
fail() { echo "agent-check: $*" >&2; exit 1; }
CODE=0
SIMULATOR=0
while [ $# -gt 0 ]; do
  case "$1" in
    --code) CODE=1 ;;
    --simulator) SIMULATOR=1 ;;
    *) usage ;;
  esac
  shift
done
[ "$CODE" = 0 ] || [ "$SIMULATOR" = 0 ] || usage

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
for dependency in git python3; do
  command -v "$dependency" >/dev/null 2>&1 || fail "missing dependency: $dependency"
done
python3 -I -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' \
  || fail 'Python 3.10 or newer is required'
. "$HERE/lib/agent-slot.sh"
. "$HERE/lib/agent-lock.sh"
agent_config_validate
MAIN=$(agent_main_root)
git -C "$MAIN" show-ref --verify --quiet "refs/heads/$AGENT_MAIN_BRANCH" \
  || fail "configured main branch '$AGENT_MAIN_BRANCH' does not exist"
git -C "$MAIN" check-ignore -q .agent \
  || fail '.agent must be ignored by Git before provisioning'
for key in user.name user.email; do
  value=$(git -C "$MAIN" config --get "$key") || fail "missing Git configuration: $key"
  [ -n "$value" ] || fail "empty Git configuration: $key"
done

# Exercise the actual coordination write grant without touching runtime locks.
COORDINATION=$(dirname "$AGENT_SIM_LOCK")
REPO_LOCK=$(agent_repo_lock_path)
python3 -I - "$COORDINATION" "$REPO_LOCK" "$AGENT_SIM_LOCK" <<'PYCHECK' \
  || fail 'coordination path is inaccessible; check permissions and the host writable-path grant'
import os, sys
for target in sys.argv[1:]:
    path = target
    while not os.path.exists(path):
        parent = os.path.dirname(path)
        if parent == path:
            sys.exit(1)
        path = parent
    mode = os.W_OK | (os.X_OK if os.path.isdir(path) else 0)
    if not os.access(path, mode):
        sys.exit(1)
PYCHECK
if [ ! -d "$COORDINATION" ]; then
  mkdir -p "$COORDINATION" 2>/dev/null \
    || fail 'coordination directory creation denied; grant the host sandbox access to the parent of AGENT_SIM_LOCK'
  echo 'agent-check: configured coordination directory initialized'
fi
PROBE=''
cleanup() { [ -z "$PROBE" ] || rm -f "$PROBE"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
PROBE=$(mktemp "$COORDINATION/.agent-check.XXXXXX" 2>/dev/null) \
  || fail 'coordination write denied; grant the host sandbox access to the parent of AGENT_SIM_LOCK'
rm "$PROBE" || fail 'cannot remove the private coordination probe'
PROBE=''
echo 'agent-check: Git and project configuration ready'
echo 'agent-check: coordination write access ready'
if [ "$CODE" = 1 ]; then
  echo 'agent-check: code prerequisites ready; project setup hooks are not executed'
  exit 0
fi

for dependency in ps lsof psql createdb dropdb pg_dump; do
  command -v "$dependency" >/dev/null 2>&1 || fail "missing dependency: $dependency"
done
started=$(ps -o lstart= -p "$$" 2>/dev/null) \
  || fail 'ps process identity is unavailable; check the host sandbox process-inspection policy'
[ -n "${started//[[:space:]]/}" ] \
  || fail 'ps returned no process identity; check the host sandbox process-inspection policy'
cwd=$(lsof -a -p "$$" -d cwd -Fn 2>/dev/null) \
  || fail 'lsof process identity is unavailable; check the host sandbox process-inspection policy'
printf '%s\n' "$cwd" | awk '/^n\// { found++ } END { exit(found == 1 ? 0 : 1) }' \
  || fail 'lsof returned no usable process directory; process inspection is not ready'
echo 'agent-check: ps and lsof process inspection ready'

# Match runtime psql's configured role and libpq local connection defaults. Never read an
# application URL, print client errors that may contain secrets, or connect to a remote host.
case "${PGHOST:-}" in ''|localhost|127.0.0.1|::1|/*) ;; *) fail 'PGHOST must identify local PostgreSQL' ;; esac
case "${PGHOSTADDR:-}" in ''|127.0.0.1|::1) ;; *) fail 'PGHOSTADDR must identify local PostgreSQL' ;; esac
[ -z "${PGSERVICE:-}" ] || fail 'PGSERVICE is not supported by this local PostgreSQL check; unset it and configure a local host'
role=$(PGCONNECT_TIMEOUT=3 psql -X -w -U "$AGENT_PG_USER" -d postgres -tAc \
  "SELECT CASE WHEN rolsuper OR rolcreatedb THEN 'ready' ELSE 'no-createdb' END FROM pg_roles WHERE rolname = current_user" 2>/dev/null) \
  || fail 'local PostgreSQL connection failed for the configured role; check the service, role/authentication and host sandbox local-network access'
case "$role" in
  ready) ;;
  no-createdb) fail 'the configured PostgreSQL role needs CREATEDB for stack slots' ;;
  *) fail 'local PostgreSQL returned no usable role result' ;;
esac
echo 'agent-check: local PostgreSQL role ready'

if [ "$SIMULATOR" = 1 ]; then
  for dependency in xcrun jq; do
    command -v "$dependency" >/dev/null 2>&1 || fail "missing dependency: $dependency"
  done
  devices=$(xcrun simctl list devices --json 2>/dev/null) \
    || fail 'CoreSimulator service access failed; check Xcode setup and the host sandbox service policy'
  printf '%s\n' "$devices" | jq -e '.devices | type == "object"' >/dev/null 2>&1 \
    || fail 'CoreSimulator returned no valid device list; check Xcode setup and host service access'
  printf '%s\n' "$devices" | jq -e '[.devices[][] | select(.isAvailable == true)] | length > 0' >/dev/null 2>&1 \
    || fail 'no available simulator device; install an Xcode simulator runtime and device'
  echo 'agent-check: CoreSimulator device service ready (no device booted)'
fi
echo 'agent-check: requested runtime prerequisites ready; no resources provisioned'
