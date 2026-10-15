import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SOURCE = path.resolve(__dirname, '..');

describe('managed runtime lifecycle', () => {
  let base: string, main: string, wt: string, bin: string, env: Record<string, string>;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'slots-lifecycle-'));
    main = path.join(base, 'main'); wt = path.join(base, 'task'); bin = path.join(base, 'bin'); mkdirSync(main); mkdirSync(bin);
    git(base, 'init', '-q', '-b', 'main', main);
    git(main, 'config', 'user.name', 'fixture'); git(main, 'config', 'user.email', 'fixture@example.invalid');
    const webPort = 20000 + Math.floor(Math.random() * 8000);
    writeFileSync(path.join(main, '.gitignore'), '.env\n');
    writeFileSync(path.join(main, '.agent-slots.conf'), [
      'AGENT_PROJECT_SLUG=lifecyclefixture', 'AGENT_DATABASE_MAIN=lifecyclefixture_dev',
      'AGENT_DATABASE_PREFIX=lifecyclefixture_a', 'AGENT_APP_DIR=.', 'AGENT_ENV_FILE=.env',
      'AGENT_SLOT_MAX=1', `AGENT_WEB_PORT_BASE=${webPort}`, `AGENT_METRO_PORT_BASE=${webPort + 10000}`,
      'AGENT_PORT_STEP=100', `AGENT_SIM_LOCK=${path.join(base, 'simulator.lock')}`,
      'AGENT_PREPARE_DEFAULT=deferred',
      'agent_start_web() { local worktree="$1" port="$2"; cd "$worktree"; exec python3 -c \'import time; time.sleep(120)\'; }',
    ].join('\n') + '\n');
    execFileSync('cp', ['-R', path.join(SOURCE, 'scripts'), main]);
    writeFileSync(path.join(main, 'tracked.txt'), 'fixture\n');
    execFileSync('git', ['-C', main, 'add', '.']);
    execFileSync('git', ['-C', main, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
    execFileSync('git', ['-C', main, 'worktree', 'add', '-qb', 'feat/runtime', wt]);
    mock('ps', 'printf "Thu Jan  1 00:00:00 1970 %s\\n" "$4"');
    mock('lsof', 'case "$*" in *"-d cwd"*) printf "p%s\\nn%s\\n" "$3" "$AGENT_TEST_WT" ;; *) exit 1 ;; esac');
    env = { ...process.env, AGENT_REPO_ROOT: main, AGENT_TEST_WT: wt,
      PATH: bin + ':' + process.env.PATH, HOME: path.join(base, 'home') } as Record<string, string>;
    mkdirSync(env.HOME, { recursive: true });
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function mock(name: string, body: string) {
    const file = path.join(bin, name);
    writeFileSync(file, '#!/usr/bin/env bash\n' + body + '\n');
    chmodSync(file, 0o755);
  }

  function run(args: string[]) {
    return spawnSync(path.join(main, 'scripts/agent-slots'), args, {
      cwd: base, encoding: 'utf8', env, timeout: 15000,
    });
  }

  function markerPath() {
    const raw = git(wt, 'rev-parse', '--git-path', 'agent-runtime.json');
    return path.isAbsolute(raw) ? raw : path.join(wt, raw);
  }

  function marker(): any { return JSON.parse(readFileSync(markerPath(), 'utf8')); }
  function saveMarker(value: unknown) { writeFileSync(markerPath(), `${JSON.stringify(value)}\n`, { mode: 0o600 }); }
  function setExpired() { const value = marker(); value.heartbeat = 1; saveMarker(value); }
  function isAlive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
  async function waitStopped(pid: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(isAlive(pid)).toBe(false);
  }

  function writeKeelClaim(worktree: string, task: string, session: string, slot: number) {
    const gitdir = git(worktree, 'rev-parse', '--path-format=absolute', '--git-dir');
    const commonDir = git(worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const branch = git(worktree, 'symbolic-ref', '--quiet', '--short', 'HEAD');
    const info = statSync(worktree);
    const keelIdentity = (task === 'task-one' ? '1' : '2').repeat(64);
    const runtimeIdentity = (task === 'task-one' ? 'a' : 'b').repeat(64);
    const manifest = {
      version: 1, task, session, identity: keelIdentity, path: realpathSync(worktree), gitdir: realpathSync(gitdir), common_dir: realpathSync(commonDir),
      primary: realpathSync(main), branch, dir_dev: info.dev, dir_ino: info.ino, state: 'active',
    };
    const workspaceMarker = git(worktree, 'rev-parse', '--git-path', 'agent-workspace.json');
    writeFileSync(path.isAbsolute(workspaceMarker) ? workspaceMarker : path.join(worktree, workspaceMarker), JSON.stringify(manifest));
    const runtimeMarker = {
      ...Object.fromEntries(Object.entries(manifest).filter(([key]) => !['identity', 'state'].includes(key))),
      version: 1, state: 'active', keel_identity: keelIdentity, identity: runtimeIdentity,
      services: ['web'], resources: { slot }, processes: [], heartbeat: 1, lease_seconds: 1800, pinned: false,
    };
    const marker = git(worktree, 'rev-parse', '--git-path', 'agent-runtime.json');
    writeFileSync(path.isAbsolute(marker) ? marker : path.join(worktree, marker), JSON.stringify(runtimeMarker), { mode: 0o600 });
  }

  it('records, pins, safely pauses, and releases only runtime resources', async () => {
    const attached = run(['attach', '--worktree', wt, '--service', 'web']);
    expect(attached.status, attached.stderr).toBe(0);
    expect(marker().services).toEqual(['web']);

    const started = run(['start', 'web', '--worktree', wt]);
    expect(started.status, started.stderr).toBe(0);
    const active = marker();
    expect(active.state).toBe('active');
    expect(active.processes).toHaveLength(1);
    const receipt = active.processes[0];
    expect(receipt).toMatchObject({ service: 'web', pid: receipt.pgid, log: expect.any(String) });
    expect(isAlive(receipt.pid)).toBe(true);

    // A reused PID with the wrong start identity must remain untouched.
    const replacement = structuredClone(active);
    replacement.processes = [{ ...receipt, pid: process.pid, pgid: process.pid, started: 'not-the-current-start' }];
    saveMarker(replacement);
    const refused = run(['pause', '--worktree', wt]);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/replaced or moved/);
    expect(isAlive(process.pid)).toBe(true);
    saveMarker(active);

    setExpired();
    marker().resources.secret = 'do-not-print-this'; saveMarker(marker());
    const heartbeated = run(['heartbeat', '--worktree', wt]);
    expect(heartbeated.status, heartbeated.stderr).toBe(0);
    expect(heartbeated.stdout).not.toContain('do-not-print-this');
    expect(marker().heartbeat).toBeGreaterThan(1);
    const pinned = run(['pin', '--worktree', wt]);
    expect(pinned.status, pinned.stderr).toBe(0);
    expect(pinned.stdout).not.toContain('do-not-print-this');
    setExpired();
    const pinnedSweep = run(['sweep', '--repo', main, '--yes']);
    expect(pinnedSweep.status, pinnedSweep.stderr).toBe(0);
    expect(marker().state).toBe('active');
    expect(isAlive(receipt.pid)).toBe(true);

    const unpinned = run(['unpin', '--worktree', wt]);
    expect(unpinned.status, unpinned.stderr).toBe(0);
    expect(unpinned.stdout).not.toContain('do-not-print-this');
    setExpired();
    const dryRun = run(['sweep', '--repo', main]);
    expect(dryRun.status, dryRun.stderr).toBe(0);
    expect(dryRun.stdout).toContain(`expired runtime lease: ${realpathSync(wt)}`);
    expect(marker().state).toBe('active');
    expect(isAlive(receipt.pid)).toBe(true);

    const swept = run(['sweep', '--repo', main, '--yes']);
    expect(swept.status, swept.stderr).toBe(0);
    expect(marker().state).toBe('paused');
    expect(marker().processes).toEqual([]);
    await waitStopped(receipt.pid);

    const restarted = run(['start', 'web', '--worktree', wt]);
    expect(restarted.status, restarted.stderr).toBe(0);
    const secondReceipt = marker().processes[0];
    expect(secondReceipt.log).not.toBe(receipt.log);
    const pausedAgain = run(['pause', '--worktree', wt]);
    expect(pausedAgain.status, pausedAgain.stderr).toBe(0);
    await waitStopped(secondReceipt.pid);

    writeFileSync(path.join(wt, 'user-work.txt'), 'keep this worktree\n');
    const released = run(['release', '--worktree', wt]);
    expect(released.status, released.stderr).toBe(0);
    expect(existsSync(markerPath())).toBe(false);
    expect(existsSync(path.join(wt, 'user-work.txt'))).toBe(true);
    expect(git(wt, 'branch', '--show-current')).toBe('feat/runtime');
    expect(existsSync(path.join(wt, '.env'))).toBe(false);
    expect(git(main, 'worktree', 'list', '--porcelain')).toContain(wt);
  }, 45000);

  it('counts other Keel tasks without treating their session as the current host identity', () => {
    const other = path.join(base, 'other-task');
    execFileSync('git', ['-C', main, 'worktree', 'add', '-qb', 'feat/other', other]);
    writeKeelClaim(wt, 'task-one', 'session-one', 1);
    writeKeelClaim(other, 'task-two', 'session-two', 2);
    const helper = path.join(main, 'scripts/lib/agent-runtime.py');
    const envWithSession = { ...env, AGENTKEEL_SESSION_ID: 'session-one' };
    const used = spawnSync('python3', ['-I', helper, 'used-slots', main], { encoding: 'utf8', env: envWithSession });
    expect(used.status, used.stderr).toBe(0);
    expect(used.stdout.trim().split('\n').sort()).toEqual(['1', '2']);
    const foreignValidation = spawnSync('python3', ['-I', helper, 'validate', other], { encoding: 'utf8', env: envWithSession });
    expect(foreignValidation.status).not.toBe(0);
    expect(foreignValidation.stderr).toContain('session does not match');
  });
});
