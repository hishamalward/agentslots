#!/usr/bin/env python3
"""Read AgentKeel identity without maintaining another task or permission registry."""
import json
import os
import re
import signal
import stat
import subprocess
import sys
import time


class Unknown(Exception):
    pass


def real(path):
    return os.path.realpath(os.path.expanduser(path))


def run(*args):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise Unknown(str(error)) from error


def session():
    if os.environ.get('AGENTKEEL_SESSION_ID'):
        return os.environ['AGENTKEEL_SESSION_ID']
    present = {host: os.environ[key] for host, key in
               [('claude', 'CLAUDE_CODE_SESSION_ID'), ('codex', 'CODEX_THREAD_ID')]
               if os.environ.get(key)}
    if len(present) == 1:
        return next(iter(present.values()))
    if not present:
        return None
    pid = os.getpid()
    for _ in range(40):
        result = run('ps', '-o', 'ppid=,comm=', '-p', str(pid))
        fields = result.stdout.strip().split(None, 1)
        if result.returncode or len(fields) != 2:
            break
        parent, command = fields
        host = os.path.basename(command).lower()
        if host == 'claude' or host.startswith('codex'):
            return present.get('claude' if host == 'claude' else 'codex')
        if not parent.isdigit() or int(parent) <= 1:
            break
        pid = int(parent)
    raise Unknown('both host session IDs are set and the nearest host cannot be identified')


def records():
    home = real(os.environ.get('AGENTKEEL_HOME') or '~/.agentkeel')
    try:
        os.stat(home)
    except FileNotFoundError:
        return [], []
    except OSError as error:
        raise Unknown(f'cannot read AgentKeel home: {error}') from error
    if not os.path.isdir(home):
        raise Unknown('AgentKeel home is not a readable directory')
    out = []
    for family in ('tasks', 'opened'):
        folder = os.path.join(home, family)
        current = []
        if os.path.lexists(folder):
            try:
                names = sorted(os.listdir(folder))
            except OSError as error:
                raise Unknown(f'cannot read AgentKeel {family}: {error}') from error
            for name in names:
                if not name.endswith('.json'):
                    continue
                try:
                    with open(os.path.join(folder, name), encoding='utf8') as stream:
                        rec = json.load(stream)
                except (OSError, ValueError) as error:
                    raise Unknown(f'cannot read AgentKeel record {name}: {error}') from error
                key = 'session_id' if family == 'tasks' else 'task'
                value = rec.get(key) if isinstance(rec, dict) else None
                expected = re.sub(r'[^A-Za-z0-9_.-]', '_', value) if isinstance(value, str) else None
                if not value or expected != name[:-5] or not isinstance(rec.get('task'), str):
                    raise Unknown(f'malformed AgentKeel {family} record {name}')
                lists = ('worktrees', 'resources') if family == 'tasks' else ('sessions',)
                if any(not isinstance(rec.get(k, []), list) or
                       not all(isinstance(v, str) for v in rec.get(k, [])) for k in lists):
                    raise Unknown(f'malformed AgentKeel {family} record {name}')
                if family == 'opened' and any(not isinstance(rec.get(k), str) or
                                               not os.path.isabs(rec[k]) for k in ('clone', 'repo')):
                    raise Unknown(f'malformed AgentKeel clone record {name}')
                current.append(rec)
        out.append(current)
    return out


def clone_identity(rec):
    clone = rec['clone']
    if clone != real(clone) or clone == real(rec['repo']):
        raise Unknown('opened clone is not a separate canonical folder')
    expected, token = rec.get('clone_id'), rec.get('clone_token')
    if not isinstance(expected, list) or len(expected) != 2 or not all(isinstance(v, int) for v in expected) or not isinstance(token, str) or not token:
        raise Unknown('opened clone identity is missing or malformed')
    try:
        info = os.lstat(clone)
        with open(os.path.join(clone, '.git', 'agentkeel-clone-id'), encoding='utf8') as stream:
            actual = stream.read().strip()
    except OSError as error:
        raise Unknown(f'opened clone identity cannot be read: {error}') from error
    if not stat.S_ISDIR(info.st_mode) or [info.st_dev, info.st_ino] != expected or actual != token:
        raise Unknown('opened clone was replaced; recorded inode and token do not match')


def holders(name, tasks, opened):
    path = real(name) if os.path.isabs(name) else None
    for rec in tasks:
        if (path and path in [real(p) for p in rec.get('worktrees', [])]) or name in rec.get('resources', []):
            yield rec['task'], [rec['session_id']]
    for rec in opened:
        if path and path == real(rec['clone']):
            clone_identity(rec)
            yield rec['task'], rec.get('sessions', [])


def check(name):
    me = session()  # resolve even when AgentKeel is absent: ambiguous host is never human
    tasks, opened = records()
    owners = list(holders(name, tasks, opened))
    current = {rec['task'] for rec in tasks if me and rec['session_id'] == me}
    for task, sessions in owners:
        if not me and not sessions:
            continue  # Human prelaunch attachment to an opened clone, before any session binds.
        if not me or (me not in sessions and task not in current):
            raise Unknown(f'{name} is held by task {task}; use the owning session, or have a human '
                          'review and release the task with AgentKeel before cleanup')


def root(path):
    _, opened = records()
    path = real(path)
    matched = [rec for rec in opened if path == real(rec['clone'])]
    for rec in matched:
        clone_identity(rec)
    matches = {real(rec['repo']) for rec in matched}
    explicit = os.environ.get('AGENT_REPO_ROOT')
    if explicit:
        matches.add(real(explicit))
    marker = os.path.join(path, '.agent')
    if os.path.isfile(marker):
        try:
            with open(marker, encoding='utf8') as stream:
                matches.update(real(line[5:].strip()) for line in stream if line.startswith('REPO='))
        except OSError as error:
            raise Unknown(f'cannot read runtime association: {error}') from error
    if len(matches) > 1:
        raise Unknown('canonical repository inputs disagree')
    if matches:
        answer = matches.pop()
        if not os.path.isdir(answer) or run('git', '-C', answer, 'rev-parse', '--show-toplevel').returncode:
            raise Unknown('canonical repository does not exist or is not a Git repository')
        return answer
    result = run('git', '-C', path, 'worktree', 'list', '--porcelain')
    if result.returncode:
        raise Unknown(result.stderr.strip() or 'cannot list Git worktrees')
    for line in result.stdout.splitlines():
        if line.startswith('worktree '):
            return real(line[9:])
    raise Unknown('Git returned no workspace')


def workspaces(repo):
    tasks, opened = records()
    del tasks
    result = run('git', '-C', repo, 'worktree', 'list', '--porcelain')
    if result.returncode:
        raise Unknown('cannot list Git worktrees')
    paths = [real(line[9:]) for line in result.stdout.splitlines() if line.startswith('worktree ')]
    paths += [real(rec['clone']) for rec in opened if real(rec['repo']) == real(repo)]
    return list(dict.fromkeys(paths))


def identity(pid):
    if sys.platform.startswith('linux'):
        try:
            with open(f'/proc/{pid}/stat', encoding='utf8') as stream:
                start = stream.read().rsplit(')', 1)[1].split()[19]
            cwd = os.readlink(f'/proc/{pid}/cwd')
            return real(cwd), start
        except (OSError, IndexError):
            return None
    started = run('ps', '-o', 'lstart=', '-p', str(pid))
    cwd = run('lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn')
    paths = [line[1:] for line in cwd.stdout.splitlines() if line.startswith('n')]
    if started.returncode or cwd.returncode or len(paths) != 1 or not started.stdout.strip():
        return None
    return real(paths[0]), started.stdout.strip()


def listeners(port):
    result = run('lsof', '-nP', f'-iTCP:{port}', '-sTCP:LISTEN', '-t')
    if result.returncode not in (0, 1) or (result.returncode == 1 and result.stderr.strip()):
        raise Unknown('cannot identify listening processes')
    try:
        return sorted({int(pid) for pid in result.stdout.split()})
    except ValueError as error:
        raise Unknown('invalid listener process IDs') from error


def owned_listeners(port, workspace, require_listener=False):
    workspace = real(workspace)
    pids = listeners(port)
    if require_listener and not pids:
        raise Unknown(f'port {port} has no listener to verify')
    original = {}
    for pid in pids:
        token = identity(pid)
        if token is None or not (token[0] == workspace or token[0].startswith(workspace + os.sep)):
            raise Unknown(f'port {port} listener {pid} is foreign or unidentified; nothing was killed')
        original[pid] = token
    return original


def stop(port, workspace):
    original = owned_listeners(port, workspace)
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid, token in original.items():
            now = identity(pid)
            if now is None:
                continue
            if now != token:
                raise Unknown(f'PID {pid} was replaced; replacement was not killed')
            os.kill(pid, sig)
        if original:
            time.sleep(2)
        if not listeners(port):
            return
    raise Unknown(f'port {port} still has a listener; runtime teardown stopped')


def main():
    mode, *args = sys.argv[1:]
    if mode == 'check':
        check(args[0])
    elif mode == 'root':
        print(root(args[0]))
    elif mode == 'workspaces':
        print('\n'.join(workspaces(args[0])))
    elif mode == 'ownership':
        me = session()
        tasks, opened = records()
        owners = list(holders(args[0], tasks, opened))
        print('unclaimed' if not owners else ', '.join(
            ('self' if me and (me in sessions or any(rec['task'] == task and rec['session_id'] == me for rec in tasks)) else 'foreign')
            + ':' + task for task, sessions in owners))
    elif mode == 'check-port':
        check(args[1])
        check(args[0])
        owned_listeners(args[0], args[1], require_listener=True)
    elif mode == 'stop-port':
        check(args[1])
        stop(args[0], args[1])
    else:
        raise Unknown('unknown operation')


if __name__ == '__main__':
    try:
        main()
    except (Unknown, OSError, ValueError) as error:
        print(f'agent-slots: ownership or identity unknown: {error}', file=sys.stderr)
        sys.exit(1)
