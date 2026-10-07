#!/usr/bin/env bash
# Advisory locking replaces the unsafe preflight/create and simulator check/remove paths.
# macOS has no flock CLI. Re-exec keeps a kernel lock in this process, without a daemon,
# stale PID files or stale-lock deletion. The stable lock file must never be unlinked.
# Sourced by Bash 3.2 scripts; python3 is also used for workspace ownership checks.
agent_lock_enter() {
  local lock="$1"
  shift
  # The inherited descriptor, rather than an environment flag, proves this re-exec owns it.
  if [ "${AGENT_LOCK_PATH:-}" = "$lock" ] && python3 -I - "$lock" <<'PYLOCK'
import fcntl, os, sys
try:
    a, b = os.fstat(9), os.stat(sys.argv[1])
    ok = (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino)
    if ok:
        fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    ok = False
sys.exit(0 if ok else 1)
PYLOCK
  then
    return 0
  fi
  exec python3 -I - "$lock" "$0" "$@" <<'PYLOCK'
import fcntl, os, sys
lock, script, *args = sys.argv[1:]
fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
if fd != 9:
    os.dup2(fd, 9)
    os.close(fd)
os.set_inheritable(9, True)
os.environ['AGENT_LOCK_PATH'] = lock
os.execvp('bash', ['bash', script, *args])
PYLOCK
}

# All provisioning, stop and cleanup observations for a repo share one lifecycle mutex.
# Keep coordination outside the shared Git directory so isolated clones need only read access
# to it. The filename is a hash of the canonical common Git path, not an ownership registry.
agent_repo_lock_path() {
  local main common
  main=$(agent_main_root) || return 1
  common=$(git -C "$main" rev-parse --git-common-dir) || return 1
  case "$common" in /*) ;; *) common="$main/$common" ;; esac
  python3 -I - "$common" "$AGENT_SIM_LOCK" <<'PYLOCK'
import hashlib, os, sys
common = os.path.realpath(sys.argv[1])
key = hashlib.sha256(os.fsencode(common)).hexdigest()
print(os.path.join(os.path.dirname(os.path.abspath(sys.argv[2])), 'repos', key + '.lock'))
PYLOCK
}

agent_repo_lock() {
  local lock
  lock=$(agent_repo_lock_path) || return 1
  mkdir -p "$(dirname "$lock")"
  # A nested reap -> down -> stop inherits FD9, so entering this same lock does not block itself.
  agent_lock_enter "$lock" "$@"
}
