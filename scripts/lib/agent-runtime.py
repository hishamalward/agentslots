#!/usr/bin/env python3
"""Small per-worktree resource claim shared by the Slots CLI commands."""
import fcntl
import ipaddress
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import time
from urllib.parse import unquote, urlsplit, urlunsplit


class Refused(Exception):
    pass


def local_db_endpoint(host, port, user):
    try:
        host = host.lower()
        port = int(port)
    except (AttributeError, TypeError, ValueError) as error:
        raise Refused("database endpoint is malformed") from error
    local = host == "localhost"
    if not local and "%" not in host:
        try:
            local = ipaddress.ip_address(host).is_loopback
        except ValueError:
            local = False
    if not local:
        raise Refused("only an explicit local PostgreSQL endpoint is allowed")
    if port < 1 or port > 65535 or not isinstance(user, str) or not user or "\x00" in user:
        raise Refused("database endpoint port or user is invalid")
    return {"host": host, "port": port, "user": user}


def local_db_url(raw, expected_source, target, user):
    try:
        parsed = urlsplit(raw)
        host = parsed.hostname or ""
        port = parsed.port or 5432
    except ValueError as error:
        raise Refused("source database URL is malformed") from error
    if parsed.scheme not in ("postgres", "postgresql"):
        raise Refused("only an explicit local PostgreSQL endpoint is allowed")
    if parsed.query or parsed.fragment:
        raise Refused("source database URL query options and fragments are not supported")
    if unquote(parsed.path.lstrip("/")) != expected_source:
        raise Refused("source environment database does not match configured main database")
    endpoint = local_db_endpoint(host, port, user)
    rewritten = urlunsplit((parsed.scheme, parsed.netloc, "/" + target, "", ""))
    return dict(endpoint, url=rewritten)


def git(path, *args):
    result = subprocess.run(["git", "-C", path, *args], text=True, capture_output=True, timeout=15)
    if result.returncode:
        raise Refused(result.stderr.strip() or "Git identity is unavailable")
    return result.stdout.strip()


def paths(path):
    path = os.path.realpath(path)
    if not os.path.isdir(path) or git(path, "rev-parse", "--show-toplevel") != path:
        raise Refused(f"not an existing Git worktree root: {path}")
    gitdir = os.path.realpath(git(path, "rev-parse", "--path-format=absolute", "--git-dir"))
    common = os.path.realpath(git(path, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    primary = None
    listing = git(path, "worktree", "list", "--porcelain")
    for line in listing.splitlines():
        if line.startswith("worktree "):
            candidate = os.path.realpath(line[9:])
            if os.path.isdir(candidate) and os.path.realpath(git(candidate, "rev-parse", "--path-format=absolute", "--git-dir")) == common:
                primary = candidate
                break
    if primary is None or primary == path:
        raise Refused("AgentSlots requires an existing non-primary linked worktree")
    marker = git(path, "rev-parse", "--git-path", "agent-runtime.json")
    marker = os.path.abspath(marker if os.path.isabs(marker) else os.path.join(path, marker))
    workspace_path = git(path, "rev-parse", "--git-path", "agent-workspace.json")
    workspace_path = os.path.abspath(workspace_path if os.path.isabs(workspace_path) else os.path.join(path, workspace_path))
    info = os.stat(path)
    branch = git(path, "symbolic-ref", "--quiet", "--short", "HEAD")
    return {"path": path, "gitdir": gitdir, "common_dir": common, "primary": primary,
            "branch": branch, "marker": marker, "workspace_marker": workspace_path,
            "dir_dev": info.st_dev, "dir_ino": info.st_ino}


def identity(p, task=None, session=None, allow_pending=False, enforce_session=True):
    if os.path.islink(p["workspace_marker"]):
        raise Refused("AgentKeel workspace manifest is a symlink")
    if os.path.lexists(p["workspace_marker"]):
        try:
            with open(p["workspace_marker"], encoding="utf8") as stream:
                keel = json.load(stream)
        except (OSError, ValueError) as error:
            raise Refused(f"AgentKeel workspace manifest is unreadable: {error}") from error
        if not isinstance(keel, dict) or keel.get("version") != 1:
            raise Refused("AgentKeel workspace manifest is malformed")
        if any(not isinstance(keel.get(key), str) or not keel[key] for key in ("task", "session", "identity")) or not re.fullmatch(r"[0-9a-f]{64}", keel["identity"]):
            raise Refused("AgentKeel task, session or identity is malformed")
        host_session = os.environ.get("AGENTKEEL_SESSION_ID") or os.environ.get("CODEX_THREAD_ID") or os.environ.get("CLAUDE_CODE_SESSION_ID")
        if enforce_session and host_session and host_session != keel["session"]:
            raise Refused("AgentKeel session does not match the current host session")
        for field in ("path", "gitdir", "common_dir", "primary", "branch", "task", "session", "identity"):
            expected = p["path"] if field == "path" else p["gitdir"] if field == "gitdir" else p["common_dir"] if field == "common_dir" else p["primary"] if field == "primary" else p["branch"] if field == "branch" else None
            if expected is not None and keel.get(field) != expected:
                raise Refused(f"AgentKeel workspace {field} does not match Git")
        info = os.stat(p["path"])
        if [info.st_dev, info.st_ino] != [keel.get("dir_dev"), keel.get("dir_ino")]:
            raise Refused("AgentKeel worktree directory was replaced")
        if keel.get("state") not in (("active", "disposal_pending") if allow_pending else ("active",)):
            raise Refused(f"AgentKeel workspace is {keel.get('state')!r}")
        return {"task": keel["task"], "session": keel["session"], "keel_identity": keel["identity"]}
    return {"task": task or "local", "session": session or "local", "keel_identity": None}


def read(p):
    if os.path.islink(p["marker"]):
        raise Refused("runtime marker is a symlink")
    if not os.path.lexists(p["marker"]):
        return None
    try:
        with open(p["marker"], encoding="utf8") as stream:
            value = json.load(stream)
    except (OSError, ValueError) as error:
        raise Refused(f"runtime marker is malformed: {error}") from error
    if not isinstance(value, dict) or value.get("version") != 1:
        raise Refused("runtime marker is malformed or unsupported")
    for key in ("path", "gitdir", "common_dir", "primary", "branch"):
        if value.get(key) != p[key]:
            raise Refused(f"runtime marker {key} does not match this worktree")
    info = os.stat(p["path"])
    if [info.st_dev, info.st_ino] != [value.get("dir_dev"), value.get("dir_ino")]:
        raise Refused("runtime worktree directory was replaced")
    if not isinstance(value.get("identity"), str) or not re.fullmatch(r"[0-9a-f]{64}", value["identity"]):
        raise Refused("runtime identity token is malformed")
    if any(not isinstance(value.get(key), str) or not value[key] for key in ("task", "session")):
        raise Refused("runtime task/session identity is malformed")
    if not isinstance(value.get("resources"), dict) or not isinstance(value.get("processes"), list):
        raise Refused("runtime resource claims are malformed")
    if os.path.lexists(p["workspace_marker"]):
        owner = identity(p, allow_pending=True, enforce_session=False)
        if any(value.get(key) != owner[key] for key in ("task", "session", "keel_identity")):
            raise Refused("runtime owner does not match the AgentKeel workspace manifest")
    elif value.get("keel_identity") is not None:
        raise Refused("runtime claim references a missing AgentKeel workspace manifest")
    return value


def write(p, value):
    fd, temp = tempfile.mkstemp(prefix=".agent-runtime.", dir=p["gitdir"])
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf8") as stream:
            json.dump(value, stream, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, p["marker"])
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def replace_env(path, lines, mode):
    folder = os.path.dirname(path)
    os.makedirs(folder, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".agent-env.", dir=folder)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w", encoding="utf8") as stream:
            stream.writelines(lines)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def safe_env_path(p, requested):
    if not isinstance(requested, str) or not requested:
        raise Refused("configured environment path is missing")
    lexical = os.path.abspath(requested)
    root_alias = lexical
    while os.path.realpath(root_alias) != p["path"] and os.path.dirname(root_alias) != root_alias:
        root_alias = os.path.dirname(root_alias)
    if os.path.realpath(root_alias) != p["path"]:
        raise Refused("configured environment path escapes the worktree or crosses a symlink")
    relative = os.path.relpath(lexical, root_alias)
    if relative == os.pardir or relative.startswith(os.pardir + os.sep):
        raise Refused("configured environment path escapes the worktree")
    current = root_alias
    if relative != ".":
        for part in relative.split(os.sep):
            current = os.path.join(current, part)
            if os.path.islink(current):
                raise Refused("configured environment path crosses a symlink")
    canonical = os.path.realpath(lexical)
    if not canonical.startswith(p["path"] + os.sep):
        raise Refused("configured environment path escapes the worktree")
    return canonical


def env_apply(p, values):
    marker = read(p)
    if not marker or marker.get("state") != "provisioning":
        raise Refused("environment can only be changed during a runtime allocation")
    requested = values.pop("__path__", marker.get("resources", {}).get("env_path", ""))
    path = safe_env_path(p, requested)
    existed = os.path.isfile(path)
    mode = os.stat(path).st_mode & 0o777 if existed else 0o600
    with open(path, encoding="utf8") if existed else open(os.devnull, encoding="utf8") as stream:
        lines = stream.readlines()
    original = {key: [line for line in lines if line.startswith(key + "=")] for key in values}
    installed = {key: f"{key}={str(value) if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*|[0-9]+', str(value)) else json.dumps(str(value))}\n"
                 for key, value in values.items()}
    updated = [line for line in lines if not any(line.startswith(key + "=") for key in values)]
    if updated and not updated[-1].endswith("\n"):
        updated[-1] += "\n"
    updated.extend(installed.values())
    backup = os.path.join(p["gitdir"], f"agent-runtime-env-{marker['identity']}.json")
    marker["resources"]["env_backup"] = backup
    marker["resources"]["env_installed"] = installed
    write(p, marker)
    fd = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="utf8") as stream:
        json.dump({"path": path, "existed": existed, "mode": mode,
                   "original": original, "installed": installed}, stream, sort_keys=True)
        stream.write("\n")
    replace_env(path, updated, mode)


def env_restore(p):
    marker = read(p)
    if not marker:
        return
    backup = marker.get("resources", {}).get("env_backup")
    if not backup:
        return
    try:
        with open(backup, encoding="utf8") as stream:
            saved = json.load(stream)
    except (OSError, ValueError) as error:
        raise Refused(f"environment rollback data is unavailable: {error}") from error
    path = saved.get("path")
    path = safe_env_path(p, path)
    if os.path.exists(path):
        with open(path, encoding="utf8") as stream:
            lines = stream.readlines()
    else:
        lines = []
    for key, installed_line in saved["installed"].items():
        current = [line for line in lines if line.startswith(key + "=")]
        if current == [installed_line]:
            lines = [line for line in lines if not line.startswith(key + "=")]
            lines.extend(saved["original"].get(key, []))
    if lines or saved["existed"]:
        if safe_env_path(p, path) != path:
            raise Refused("environment rollback target changed")
        replace_env(path, lines, saved["mode"])
    elif os.path.isfile(path):
        os.unlink(path)
    os.unlink(backup)


def lock(path):
    p = paths(path)
    common_path = os.path.join(p["common_dir"], "agent-lifecycle.lock")
    def fd_matches(fd, target):
        try:
            opened, current = os.fstat(fd), os.stat(target)
            return (opened.st_dev, opened.st_ino) == (current.st_dev, current.st_ino)
        except OSError:
            return False

    def acquire(target, fd):
        if os.path.islink(target):
            raise Refused(f"lifecycle lock is a symlink: {target}")
        if fd_matches(fd, target):
            return
        opened = os.open(target, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            fcntl.flock(opened, fcntl.LOCK_EX)
            os.dup2(opened, fd)
        finally:
            if opened != fd:
                os.close(opened)

    acquire(common_path, 9)
    lockpath = os.path.join(p["gitdir"], "agent-lifecycle.lock")
    acquire(lockpath, 8)
    return p


def locked(path):
    p = paths(path)
    if os.environ.get("AGENT_RUNTIME_LOCKED_PATH") == p["path"]:
        try:
            tree_lock = os.stat(os.path.join(p["gitdir"], "agent-lifecycle.lock"))
            common_lock = os.stat(os.path.join(p["common_dir"], "agent-lifecycle.lock"))
            if ((os.fstat(8).st_ino, os.fstat(8).st_dev) == (tree_lock.st_ino, tree_lock.st_dev) and
                    (os.fstat(9).st_ino, os.fstat(9).st_dev) == (common_lock.st_ino, common_lock.st_dev)):
                # Inherited descriptors share flock ownership with their parent. Nonblocking
                # acquisition also makes an internal direct invocation safe if a caller merely
                # guessed the env variable and supplied matching but unlocked file descriptors.
                fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(8, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return True
        except OSError:
            pass
    return False


def proc_identity(pid):
    details = subprocess.run(["ps", "-o", "lstart=,pgid=", "-p", str(pid)], text=True, capture_output=True, timeout=5)
    cwd = subprocess.run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"], text=True, capture_output=True, timeout=5)
    paths = [line[1:] for line in cwd.stdout.splitlines() if line.startswith("n")]
    fields = details.stdout.strip().rsplit(None, 1) if details.stdout.strip() else []
    if details.returncode or cwd.returncode or len(paths) != 1 or len(fields) != 2:
        return None
    try:
        pgid = int(fields[1])
    except ValueError:
        return None
    return {"pid": int(pid), "started": fields[0], "cwd": os.path.realpath(paths[0]), "pgid": pgid}


def stop_process(process, worktree):
    pid = process.get("pid")
    if not isinstance(pid, int) or pid <= 1:
        raise Refused("managed process PID is malformed")
    expected = {key: process.get(key) for key in ("pid", "started", "cwd", "pgid")}
    if (not isinstance(expected["started"], str) or not expected["started"] or
            not isinstance(expected["cwd"], str) or expected["pgid"] != pid):
        raise Refused("managed process identity receipt is malformed")

    def alive():
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError as error:
            raise Refused(f"managed process {pid} liveness is unknown") from error

    def verify_identity(now, message):
        if now is None:
            raise Refused(message)
        if any(now.get(key) != expected[key] for key in ("pid", "started", "pgid")):
            raise Refused(f"managed process {pid} was replaced or moved; preserving it")
        cwd = now.get("cwd")
        if not isinstance(cwd, str) or (cwd != worktree and not cwd.startswith(worktree + os.sep)):
            raise Refused(f"managed process {pid} no longer has a worktree-owned cwd")

    if not alive():
        try:
            os.killpg(expected["pgid"], 0)
        except ProcessLookupError:
            return
        except PermissionError as error:
            raise Refused(f"managed process group {expected['pgid']} liveness is unknown") from error
        raise Refused(f"managed process leader {pid} exited but its process group remains; preserving it")
    now = proc_identity(pid)
    verify_identity(now, f"managed process {pid} is alive but unidentifiable; preserving it")
    os.killpg(expected["pgid"], 15)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if not alive():
            try:
                os.killpg(expected["pgid"], 0)
            except ProcessLookupError:
                return
            except PermissionError as error:
                raise Refused(f"managed process group {expected['pgid']} liveness is unknown") from error
            raise Refused(f"managed process leader {pid} exited but child processes remain; preserving the group")
        now = proc_identity(pid)
        if now is None:
            # A process can become temporarily uninspectable while handling SIGTERM.
            # Keep checking within the grace period; never signal an unknown receipt.
            time.sleep(0.1)
            continue
        verify_identity(now, f"managed process {pid} identity became unknown during shutdown")
        time.sleep(0.1)
    if not alive():
        try:
            os.killpg(expected["pgid"], 0)
        except ProcessLookupError:
            return
        except PermissionError as error:
            raise Refused(f"managed process group {expected['pgid']} liveness is unknown") from error
        raise Refused(f"managed process leader {pid} exited but child processes remain; preserving the group")
    now = proc_identity(pid)
    verify_identity(now, f"managed process {pid} identity changed during shutdown")
    os.killpg(expected["pgid"], 9)
    time.sleep(0.1)
    try:
        os.killpg(expected["pgid"], 0)
    except ProcessLookupError:
        return
    except PermissionError as error:
        raise Refused(f"managed process group {expected['pgid']} liveness is unknown after shutdown") from error
    if alive():
        now = proc_identity(pid)
        verify_identity(now, f"managed process {pid} identity became unknown after shutdown")
    raise Refused(f"managed process group {expected['pgid']} did not stop")


def launch_process(path, script, service, port, log, hook_args):
    p = paths(path)
    if not locked(path):
        raise Refused("managed process launch requires the shared lifecycle lock")
    log = os.path.abspath(log)
    if os.path.dirname(log) != p["gitdir"] or os.path.lexists(log):
        raise Refused("managed process log path is not a new file in this worktree's Git directory")
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(log, flags, 0o600)
    command = (
        'set -Eeuo pipefail; '
        'HERE=$(cd "$(dirname "$1")" && pwd -P); KIND=$2; WT=$3; PORT=$4; shift 4; '
        'cd "$WT"; . "$HERE/lib/agent-slot.sh"; agent_config_validate; '
        'case "$KIND" in '
        'web) agent_start_web "$WT" "$PORT" "$@" ;; '
        'mobile) agent_start_mobile "$WT" "$PORT" "$@" ;; '
        'esac'
    )
    try:
        child = subprocess.Popen(["/bin/bash", "-c", command, "agent-slots-hook",
                                  script, service, p["path"], str(port), *hook_args],
                                 cwd=p["path"], stdin=subprocess.DEVNULL, stdout=fd,
                                 stderr=subprocess.STDOUT, close_fds=True, start_new_session=True)
    finally:
        os.close(fd)
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        observed = proc_identity(child.pid)
        if observed and observed["pgid"] == child.pid and (observed["cwd"] == p["path"] or observed["cwd"].startswith(p["path"] + os.sep)):
            print(json.dumps(observed, sort_keys=True))
            return
        if child.poll() is not None:
            break
        time.sleep(0.1)
    # The group was created by this exact Popen call. If the hook exited too quickly to
    # establish a durable leader receipt, leave any surviving group untouched for inspection.
    raise Refused(f"{service} start did not leave an identifiable managed process; runtime claim retained (log: {log})")


def main(argv):
    mode, *args = argv
    if mode == "local-db-url":
        raw, expected_source, target, user = args
        print(json.dumps(local_db_url(raw, expected_source, target, user), sort_keys=True))
        return
    if mode == "local-db-endpoint":
        host, port, user = args
        print(json.dumps(local_db_endpoint(host, port, user), sort_keys=True))
        return
    if mode == "lock":
        path, _unused, script, *rest = args
        p = paths(path)
        if not locked(path):
            p = lock(path)
            if os.path.lexists(p["workspace_marker"]):
                identity(p, allow_pending=bool(rest and rest[0] == "release"))
            env = dict(os.environ, AGENT_RUNTIME_LOCKED_PATH=p["path"])
            os.execve("/bin/bash", ["bash", script, *rest], env)
        return
    if mode == "sweep":
        repo = os.path.realpath(args[0])
        yes = args[1] == "1"
        listing = git(repo, "worktree", "list", "--porcelain")
        common = os.path.realpath(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"))
        primary = next((os.path.realpath(line[9:]) for line in listing.splitlines()
                        if line.startswith("worktree ")), None)
        now = int(time.time())
        for line in listing.splitlines():
            if not line.startswith("worktree "):
                continue
            path = os.path.realpath(line[9:])
            if not os.path.isdir(path) or path == primary:
                continue
            try:
                p = lock(path)
                if os.path.lexists(p["workspace_marker"]):
                    identity(p, enforce_session=False)
                if p["common_dir"] != common:
                    continue
                value = read(p)
                if not value or value.get("pinned"):
                    continue
                stamp, lease = value.get("heartbeat"), value.get("lease_seconds")
                if not isinstance(stamp, int) or not isinstance(lease, int) or lease <= 0 or stamp > now:
                    raise Refused("lease timestamp or duration is unknown")
                if now - stamp < lease:
                    continue
                print(f"expired runtime lease: {path}")
                if yes:
                    runtime_script = os.path.join(os.path.dirname(os.path.dirname(__file__)), "agent-runtime.sh")
                    env = dict(os.environ, AGENT_RUNTIME_LOCKED_PATH=path)
                    # This sweep already validated the manifest, owner and expired lease while
                    # holding both lifecycle locks. Its internal pause must not impersonate the
                    # caller's host session; targeted pause commands keep their normal check.
                    for key in ("AGENTKEEL_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID"):
                        env.pop(key, None)
                    result = subprocess.run(["/bin/bash", runtime_script, "pause", "--worktree", path],
                                            env=env, pass_fds=(8, 9), timeout=30)
                    if result.returncode:
                        raise Refused(f"pause failed with exit status {result.returncode}")
            except (Refused, OSError, ValueError) as error:
                print(f"retained: {path}: {error}", file=sys.stderr)
        return
    if mode == "used-slots":
        repo = os.path.realpath(args[0])
        common = os.path.realpath(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"))
        for line in git(repo, "worktree", "list", "--porcelain").splitlines():
            if not line.startswith("worktree "):
                continue
            path = os.path.realpath(line[9:])
            if os.path.isdir(path):
                if os.path.realpath(git(path, "rev-parse", "--path-format=absolute", "--git-dir")) == common:
                    continue
                marker = git(path, "rev-parse", "--git-path", "agent-runtime.json")
                marker = os.path.abspath(marker if os.path.isabs(marker) else os.path.join(path, marker))
                if not os.path.lexists(marker):
                    continue
                p = paths(path)
                value = read(p)
                if value and value.get("state") not in ("released",):
                    slot = value.get("resources", {}).get("slot")
                    if isinstance(slot, int) and slot > 0:
                        print(slot)
        return
    if mode == "env-apply":
        path = args[0]
        p = paths(path)
        if not locked(path):
            raise Refused("environment update requires the shared lifecycle lock")
        env_apply(p, json.loads(args[1]))
        return
    if mode == "validate":
        p = paths(args[0])
        value = read(p)
        if not value:
            raise Refused("runtime marker is absent")
        identity(p, allow_pending=True)
        print("valid")
        return
    if mode == "env-restore":
        path = args[0]
        p = paths(path)
        if not locked(path):
            raise Refused("environment restore requires the shared lifecycle lock")
        env_restore(p)
        return
    if mode in ("claim", "read", "heartbeat", "pin", "unpin", "complete", "clear", "update"):
        path, *args = args
        p = paths(path)
        if mode != "read" and not locked(path):
            raise Refused("runtime state mutation requires the shared lifecycle lock")
        if mode == "read":
            value = read(p)
            print(json.dumps(value, sort_keys=True) if value else "")
            return
        task = args[0] if args else None
        session = args[1] if len(args) > 1 else None
        value = read(p)
        if value and not task and not session:
            task, session = value.get("task"), value.get("session")
        ident = identity(p, task, session, allow_pending=(mode in ("clear", "complete", "update")))
        if mode == "claim":
            if value:
                raise Refused("runtime is already claimed; release or inspect it first")
            services = json.loads(args[2]) if len(args) > 2 else []
            now = int(time.time())
            lease = int(os.environ.get("AGENT_LEASE_SECONDS", "1800"))
            if lease < 60:
                raise Refused("AGENT_LEASE_SECONDS must be at least 60")
            value = dict(p, **ident, version=1, identity=secrets.token_hex(32), state="provisioning",
                         services=services, resources={}, created=now, heartbeat=now, lease_seconds=lease,
                         pinned=False, processes=[])
            write(p, value)
        elif mode in ("heartbeat", "pin", "unpin", "complete", "clear", "update"):
            if not value:
                raise Refused("runtime marker is absent")
            if value.get("task") != ident["task"] or value.get("session") != ident["session"] or value.get("keel_identity") != ident["keel_identity"]:
                raise Refused("runtime marker identity does not match this worktree owner")
            if mode == "heartbeat":
                value["heartbeat"] = int(time.time())
            elif mode == "pin":
                value["pinned"] = True
            elif mode == "unpin":
                value["pinned"] = False
            elif mode == "complete":
                value["state"] = "active"
            elif mode == "clear":
                os.unlink(p["marker"])
                return
            elif mode == "update":
                patch = json.loads(args[2]) if len(args) > 2 else {}
                if not isinstance(patch, dict):
                    raise Refused("runtime update must be an object")
                resources = patch.pop("resources", None)
                if resources is not None:
                    if not isinstance(resources, dict):
                        raise Refused("runtime resource update must be an object")
                    value["resources"].update(resources)
                value.update(patch)
            write(p, value)
        print("updated" if mode in ("heartbeat", "pin", "unpin") else json.dumps(value, sort_keys=True))
        return
    if mode == "identity":
        p = paths(args[0])
        if not locked(p["path"]):
            raise Refused("process identity capture requires the shared lifecycle lock")
        process = proc_identity(int(args[1]))
        if process is None:
            raise Refused("process identity is unknown")
        print(json.dumps(process, sort_keys=True))
        return
    if mode == "launch":
        path, script, service, port, log, *hook_args = args
        launch_process(path, script, service, int(port), log, hook_args)
        return
    if mode == "stop-process":
        path = os.path.realpath(args[0])
        p = paths(path)
        if not locked(path):
            raise Refused("process shutdown requires the shared lifecycle lock")
        process = json.loads(args[1])
        marker = read(p)
        if not marker or process not in marker.get("processes", []):
            raise Refused("process receipt is not owned by this runtime marker")
        stop_process(process, path)
        return
    raise Refused("unknown runtime helper command")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (Refused, OSError, ValueError, IndexError, subprocess.TimeoutExpired) as error:
        print(f"agent-slots: {error}", file=sys.stderr)
        sys.exit(1)
