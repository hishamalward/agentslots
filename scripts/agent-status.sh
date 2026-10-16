#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO="${AGENT_REPO_ROOT:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) [ $# -ge 2 ] || { echo 'usage: agent-slots status [--repo PATH]' >&2; exit 2; }; REPO=$2; shift 2 ;;
    -h|--help) echo 'usage: agent-slots status [--repo PATH]'; exit 0 ;;
    *) echo "agent-slots: unknown status option: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$REPO" ]; then REPO=$(git rev-parse --show-toplevel 2>/dev/null) || { echo 'agent-slots: status requires --repo or a Git checkout' >&2; exit 1; }; fi
REPO=$(cd "$REPO" 2>/dev/null && pwd -P) || { echo 'agent-slots: repository does not exist' >&2; exit 1; }
export AGENT_REPO_ROOT="$REPO"
. "$HERE/lib/agent-slot.sh"
agent_config_validate
HELPER="$HERE/lib/agent-runtime.py"
common=$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)
while IFS= read -r wt; do
  [ -d "$wt" ] || continue
  gitdir=$(git -C "$wt" rev-parse --path-format=absolute --git-dir 2>/dev/null || true)
  [ "$gitdir" != "$common" ] || continue
  marker=$(python3 -I "$HELPER" read "$wt" 2>/dev/null || true)
  printf '%s\n' "$wt"
  if [ -z "$marker" ]; then
    if [ -e "$(git -C "$wt" rev-parse --git-path agent-runtime.json)" ]; then
      echo '  runtime ownership unknown; inspect Git administration marker manually'
    else
      echo '  no AgentSlots runtime claim'
    fi
    continue
  fi
  python3 -I - "$marker" <<'PYSHOW'
import datetime,json,sys,time
m=json.loads(sys.argv[1]); r=m.get('resources',{})
print('  state:',m.get('state','unknown'))
print('  services:',', '.join(m.get('services',[])) or '(none)')
if r.get('slot') is not None: print('  slot:',r['slot'])
if r.get('db'): print('  database:',r['db'])
if r.get('web_port'): print('  web port:',r['web_port'])
if r.get('metro_port'): print('  mobile port:',r['metro_port'])
if m.get('pinned'): print('  pinned: yes')
try:
  age=int(time.time())-int(m['heartbeat']); limit=int(m['lease_seconds'])
  print('  lease:', 'expired' if age >= limit else f'{max(0,limit-age)}s remaining')
except (KeyError,TypeError,ValueError): print('  lease: unknown (sweep will preserve)')
for p in m.get('processes',[]): print(f"  process: {p.get('service')} pid {p.get('pid')} started {p.get('started')}")
PYSHOW
done < <(git -C "$REPO" worktree list --porcelain | sed -n 's/^worktree //p')
