import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = process.cwd();
const helper = path.join(repo, 'scripts/lib/agent-ownership.py');
const lib = path.join(repo, 'scripts/lib/agent-slot.sh');
const temporary: string[] = [];
function fixture() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'agent-slots-owner-')));
  temporary.push(dir);
  return dir;
}
function env(home: string) {
  const out: NodeJS.ProcessEnv = { ...process.env, AGENTKEEL_HOME: home };
  delete out.AGENTKEEL_SESSION_ID; delete out.CODEX_THREAD_ID; delete out.CLAUDE_CODE_SESSION_ID;
  delete out.AGENT_REPO_ROOT; delete out.AGENT_CONFIG;
  return out;
}
function record(home: string, sid: string, workspace: string, task = 'owner') {
  mkdirSync(path.join(home, 'tasks'), { recursive: true });
  writeFileSync(path.join(home, 'tasks', sid + '.json'), JSON.stringify({ task, session_id: sid, worktrees: [workspace], resources: [] }));
}
function openedRecord(home: string, wt: string, shared: string, sessions: string[] = []) {
  mkdirSync(path.join(home, 'opened'), { recursive: true });
  mkdirSync(path.join(wt, '.git'), { recursive: true });
  writeFileSync(path.join(wt, '.git', 'agentkeel-clone-id'), 'fixture-clone-token\n');
  const st = statSync(wt);
  writeFileSync(path.join(home, 'opened', 'owner.json'), JSON.stringify({ task: 'owner', clone: wt, repo: shared, sessions, clone_id: [st.dev, st.ino], clone_token: 'fixture-clone-token' }));
}
function call(home: string, mode: string, value: string, extra = {}) {
  return spawnSync('python3', ['-I', helper, mode, value], { encoding: 'utf8', env: { ...env(home), ...extra } });
}
function gitRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, '-c', 'user.email=fixture@example.test', '-c', 'user.name=Fixture', 'commit', '--allow-empty', '-qm', 'initial']);
}
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('AgentKeel ownership adapter', () => {
  it('allows absent AgentKeel and allows the owning task, while refusing foreign and human claimed-task use', () => {
    const dir = fixture(); const home = path.join(dir, 'keel'); const wt = path.join(dir, 'work');
    expect(call(home, 'check', wt).status).toBe(0);
    record(home, 'self', wt);
    expect(call(home, 'check', wt, { AGENTKEEL_SESSION_ID: 'self' }).status).toBe(0);
    expect(call(home, 'check', wt, { AGENTKEEL_SESSION_ID: 'other' }).stderr).toContain('held by task owner');
    expect(call(home, 'check', wt).status).toBe(1);
  });
  it('refuses malformed records and filename identity mismatches rather than becoming standalone', () => {
    const home = fixture(); mkdirSync(path.join(home, 'tasks'));
    const file = path.join(home, 'tasks', 'one.json');
    writeFileSync(file, '{');
    expect(call(home, 'check', '/unclaimed').status).toBe(1);
    writeFileSync(file, JSON.stringify({ task: 'owner', session_id: 'two', worktrees: [] }));
    expect(call(home, 'check', '/unclaimed').stderr).toContain('malformed');
  });
  it('never treats ambiguous host identity as a human bypass', () => {
    const home = fixture(); const bin = path.join(home, 'bin'); mkdirSync(bin);
    writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const result = call(path.join(home, 'absent'), 'check', '/unclaimed', {
      CODEX_THREAD_ID: 'codex', CLAUDE_CODE_SESSION_ID: 'claude', PATH: bin + ':' + process.env.PATH,
    });
    expect(result.status).toBe(1); expect(result.stderr).toContain('nearest host');
  });
  it('uses current task identity for an opened clone without creating another record', () => {
    const home = fixture(); const wt = path.join(home, 'clone');
    record(home, 'self', '/different-bound-resource'); openedRecord(home, wt, '/shared');
    expect(call(home, 'check', wt, { AGENTKEEL_SESSION_ID: 'self' }).status).toBe(0);
    expect(call(home, 'check', wt, { AGENTKEEL_SESSION_ID: 'other' }).status).toBe(1);
    expect(call(home, 'check', wt).status).toBe(0); // human before host launch
    openedRecord(home, wt, '/shared', ['other']);
    expect(call(home, 'check', wt).status).toBe(1);
  });
});

describe('canonical repository and clone isolation', () => {
  it('finds opened independent clones together with linked worktrees and exits successfully when none are opened', () => {
    const dir = fixture(); const main = path.join(dir, 'shared'); const clone = path.join(dir, 'clone'); const home = path.join(dir, 'keel');
    gitRepo(main); gitRepo(clone);
    expect(call(home, 'workspaces', main).status).toBe(0);
    expect(call(home, 'workspaces', main).stdout.trim()).toBe(main);
    openedRecord(home, clone, main);
    expect(call(home, 'root', clone).stdout.trim()).toBe(main);
    expect(call(home, 'workspaces', main).stdout.trim().split('\n')).toEqual([main, clone]);
  });
  it('keeps an independent feature clone code-only and uses its assigned slot after explicit association', () => {
    const dir = fixture(); const main = path.join(dir, 'shared'); const clone = path.join(dir, 'clone'); const home = path.join(dir, 'absent');
    gitRepo(main); gitRepo(clone); execFileSync('git', ['-C', clone, 'switch', '-qc', 'feat/clone']);
    const run = (code: string, extra = {}) => spawnSync('bash', ['-c', '. "$LIB"; ' + code], {
      cwd: clone, encoding: 'utf8', env: { ...env(home), LIB: lib, ...extra },
    });
    expect(run('agent_tier_of_worktree "$PWD"').stdout.trim()).toBe('code');
    expect(run('agent_slot_of_worktree "$PWD"').status).toBe(1);
    writeFileSync(path.join(clone, '.agent'), 'REPO=' + main + '\n');
    writeFileSync(path.join(clone, '.env'), 'AGENT_SLOT=3\n');
    expect(run('agent_main_root').stdout.trim()).toBe(main);
    expect(run('agent_slot_of_worktree "$PWD"').stdout.trim()).toBe('3');
    expect(run('agent_web_port "$(agent_slot_of_worktree "$PWD")"').stdout.trim()).toBe('3300');
    expect(run('agent_workspace_is_clone "$PWD"').status).toBe(0);
  });
  it('refuses a replacement clone even for its recorded owner', () => {
    const dir = fixture(); const main = path.join(dir, 'main'); const clone = path.join(dir, 'clone'); const home = path.join(dir, 'keel');
    gitRepo(main); gitRepo(clone); record(home, 'self', clone); openedRecord(home, clone, main);
    writeFileSync(path.join(clone, '.git', 'agentkeel-clone-id'), 'replacement-token\n');
    const result = call(home, 'check', clone, { AGENTKEEL_SESSION_ID: 'self' });
    expect(result.status).toBe(1); expect(result.stderr).toContain('was replaced');
  });
  it('refuses contradictory canonical repository claims', () => {
    const dir = fixture(); const main = path.join(dir, 'main'); const clone = path.join(dir, 'clone');
    gitRepo(main); gitRepo(clone); writeFileSync(path.join(clone, '.agent'), 'REPO=' + main + '\n');
    const result = call(path.join(dir, 'absent'), 'root', clone, { AGENT_REPO_ROOT: clone });
    expect(result.status).toBe(1); expect(result.stderr).toContain('disagree');
  });
});

describe('process teardown identity', () => {
  function processCase(code: string) {
    const script = `import importlib.util, signal\nspec=importlib.util.spec_from_file_location('ownership', ${JSON.stringify(helper)})\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nm.time.sleep=lambda _:None\n${code}`;
    return spawnSync('python3', ['-I', '-c', script], { encoding: 'utf8' });
  }
  it('refuses a foreign or unidentified cwd before signalling any listener', () => {
    const result = processCase(`m.listeners=lambda _: [11,12]\nm.identity=lambda pid: ('/owned', 'start') if pid==11 else ('/foreign', 'start')\nm.os.kill=lambda *args: (_ for _ in ()).throw(AssertionError('must not signal'))\ntry:m.stop('3100','/owned')\nexcept m.Unknown as e:print(e)`);
    expect(result.status).toBe(0); expect(result.stdout).toContain('foreign or unidentified');
  });
  it('never signals a replacement PID found after TERM', () => {
    const result = processCase(`m.listeners=lambda _: [11]\nreads=iter([('/owned','first'),('/owned','first'),('/owned','replacement')])\nm.identity=lambda _:next(reads)\nsent=[]\nm.os.kill=lambda pid,sig:sent.append((pid,sig))\ntry:m.stop('3100','/owned')\nexcept m.Unknown as e:print(e)\nassert sent==[(11,signal.SIGTERM)],sent`);
    expect(result.status).toBe(0); expect(result.stdout).toContain('replacement was not killed');
  });
  it('does not signal a new listener that replaced the original on the port', () => {
    const result = processCase(`m.listeners=lambda _: [11] if not sent else [12]\nm.identity=lambda _: ('/owned','first') if not sent else None\nsent=[]\nm.os.kill=lambda pid,sig:sent.append((pid,sig))\ntry:m.stop('3100','/owned')\nexcept m.Unknown as e:print(e)\nassert sent==[(11,signal.SIGTERM)],sent`);
    expect(result.status).toBe(0); expect(result.stdout).toContain('still has a listener');
  });
});

describe('down respects runtime failure and clone code ownership', () => {
  function runtime(dir: string, foreign = false) {
    const bin = path.join(dir, 'bin'); mkdirSync(bin);
    writeFileSync(path.join(bin, 'lsof'), foreign
      ? '#!/bin/sh\ncase "$*" in *-d\ cwd*) echo n/foreign;; *) echo 999999;; esac\n'
      : '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\necho "Fri Oct 7 12:00:00 2026"\n', { mode: 0o755 });
    writeFileSync(path.join(bin, 'psql'), '#!/bin/sh\necho 1\n', { mode: 0o755 });
    writeFileSync(path.join(bin, 'dropdb'), '#!/bin/sh\ntouch "$DROP_LOG"\n', { mode: 0o755 });
    return bin;
  }
  it('reports a fresh code workspace neutrally and prefers its optional state pointer', () => {
    const dir = fixture(); const main = path.join(dir, 'main'); const wt = path.join(dir, 'work');
    gitRepo(main); execFileSync('git', ['-C', main, 'worktree', 'add', '-qb', 'feat/fresh', wt]);
    writeFileSync(path.join(wt, '.agent'), 'STATE=docs/active.html\nHANDOVER=docs/legacy.md\n');
    const config = path.join(dir, 'config'); writeFileSync(config, 'AGENT_SLOT_MAX=1\n');
    const bin = runtime(dir);
    const result = spawnSync('bash', [path.join(repo, 'scripts/agent-status.sh')], {
      cwd: wt, encoding: 'utf8', env: { ...env(path.join(dir, 'absent')), AGENT_CONFIG: config, PATH: bin + ':' + process.env.PATH },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('branch feat/fresh: new or preserved branch; no automatic cleanup');
    expect(result.stdout).not.toContain('ORPHAN: branch feat/fresh');
    expect(result.stdout).toContain('state docs/active.html is not present');
    expect(result.stdout).not.toContain('docs/legacy.md');
  }, 15000);
  it('retains workspace and database when a listener cannot be identified as owned', () => {
    const dir = fixture(); const main = path.join(dir, 'main'); const wt = path.join(dir, 'work'); const home = path.join(dir, 'absent');
    gitRepo(main);
    writeFileSync(path.join(main, '.gitignore'), '.env\n.agent\n');
    execFileSync('git', ['-C', main, 'add', '.gitignore']);
    execFileSync('git', ['-C', main, '-c', 'user.email=fixture@example.test', '-c', 'user.name=Fixture', 'commit', '-qm', 'ignores']);
    execFileSync('git', ['-C', main, 'worktree', 'add', '-qb', 'feat/work', wt]);
    writeFileSync(path.join(wt, '.env'), 'AGENT_SLOT=1\n');
    const bin = runtime(dir, true); const log = path.join(dir, 'dropped');
    const result = spawnSync('bash', [path.join(repo, 'scripts/agent-down.sh'), '1'], {
      cwd: wt, encoding: 'utf8', env: { ...env(home), PATH: bin + ':' + process.env.PATH, DROP_LOG: log },
    });
    expect(result.status).toBe(1); expect(result.stderr).toContain('stop failed');
    expect(existsSync(wt)).toBe(true); expect(existsSync(log)).toBe(false);
  }, 15000);
  it('releases a dirty independent clone runtime while retaining all clone code for human import/release', () => {
    const dir = fixture(); const main = path.join(dir, 'main'); const clone = path.join(dir, 'clone'); const home = path.join(dir, 'keel');
    gitRepo(main); gitRepo(clone); openedRecord(home, clone, main);
    writeFileSync(path.join(clone, '.env'), 'AGENT_SLOT=2\nDATABASE_URL=placeholder\n');
    writeFileSync(path.join(clone, 'unpreserved.txt'), 'important clone work');
    const bin = runtime(dir); const log = path.join(dir, 'dropped');
    const result = spawnSync('bash', [path.join(repo, 'scripts/agent-down.sh'), '2'], {
      cwd: clone, encoding: 'utf8', env: { ...env(home), PATH: bin + ':' + process.env.PATH, DROP_LOG: log },
    });
    expect(result.status).toBe(0); expect(result.stdout).toContain('clone retained');
    expect(existsSync(path.join(clone, 'unpreserved.txt'))).toBe(true);
    expect(existsSync(path.join(clone, '.git'))).toBe(true); expect(existsSync(log)).toBe(true);
    expect(call(home, 'root', clone).stdout.trim()).toBe(main);
  }, 15000);
});
