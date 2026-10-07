import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = path.resolve(__dirname, '..');
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
function fixture() {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'agent-slots-concurrency-')));
  const repo = path.join(base, 'main');
  mkdirSync(repo);
  execFileSync(realGit, ['init', '-q', '-b', 'trunk'], { cwd: repo });
  execFileSync(realGit, ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync(realGit, ['config', 'user.name', 'Fixture'], { cwd: repo });
  cpSync(path.join(source, 'scripts'), path.join(repo, 'scripts'), { recursive: true });
  writeFileSync(path.join(repo, '.gitignore'), '.agent\n.env\n');
  writeFileSync(path.join(repo, '.agent-slots.conf'), 'AGENT_MAIN_BRANCH=trunk\nAGENT_PROJECT_SLUG=fixture\nAGENT_WORKTREE_PREFIX=fixture-\nAGENT_SIM_LOCK="${AGENT_SIM_LOCK:-'+path.join(base, 'sim.lock')+'}"\n');
  mkdirSync(path.join(repo, 'docs'));
  writeFileSync(path.join(repo, 'docs/state.html'), '<p>Existing state</p>\n');
  execFileSync(realGit, ['add', '.'], { cwd: repo });
  execFileSync(realGit, ['commit', '-qm', 'fixture'], { cwd: repo });
  const bin = path.join(base, 'bin');
  mkdirSync(bin);
  return { base, repo, bin };
}
function mock(bin: string, name: string, body: string) {
  const file = path.join(bin, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
}
function run(repo: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const child = spawn('bash', args, { cwd: repo, env });
  return result(child);
}
function result(child: ChildProcess): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    child.stdout?.on('data', data => { stdout += data; });
    child.stderr?.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr, stdout }));
  });
}
function mockedEnv(f: ReturnType<typeof fixture>) {
  return { ...process.env, AGENT_SIM_LOCK: path.join(f.base, 'sim.lock'), PATH: `${f.bin}:${process.env.PATH}`, REAL_GIT: realGit, FIXTURE_REPO: f.repo, FIXTURE_BASE: f.base };
}

function cloneFixture() {
  const f = fixture();
  const clone = path.join(f.base, 'opened-clone');
  const keelHome = path.join(f.base, 'agentkeel');
  execFileSync(realGit, ['clone', '-q', '--local', f.repo, clone]);
  execFileSync(realGit, ['checkout', '-qb', 'feat/clone'], { cwd: clone });
  mkdirSync(path.join(keelHome, 'opened'), { recursive: true });
  const cloneStat = statSync(clone);
  const cloneToken = 'fixture-clone-token';
  writeFileSync(path.join(clone, '.git/agentkeel-clone-id'), `${cloneToken}\n`);
  writeFileSync(path.join(keelHome, 'opened/clone-task.json'), JSON.stringify({ task: 'clone-task', repo: f.repo, clone, sessions: ['owner'], clone_id: [cloneStat.dev, cloneStat.ino], clone_token: cloneToken }));
  writeFileSync(path.join(f.repo, '.env'), 'DATABASE_URL="postgresql://fixture@localhost/fixture_dev"\n');
  writeFileSync(path.join(clone, '.env'), 'KEEP_PRIOR=original\n');
  writeFileSync(path.join(clone, '.agent'), 'STATE=docs/state.html\n');
  mock(f.bin, 'psql', `case "$*" in
  *"datname = 'fixture_dev'"*) printf '1\\n' ;;
  *"datname = 'fixture_a"*) [ ! -f "$FIXTURE_BASE/database-created" ] || printf '1\\n' ;;
  *"select 1"*) printf '1\\n' ;;
  *) cat >/dev/null ;;
esac`);
  mock(f.bin, 'createdb', 'touch "$FIXTURE_BASE/database-created"');
  mock(f.bin, 'dropdb', 'rm -f "$FIXTURE_BASE/database-created"');
  mock(f.bin, 'pg_dump', 'printf "dump\\n"');
  mock(f.bin, 'lsof', 'exit 1');
  const env = { ...mockedEnv(f), AGENT_REPO_ROOT: f.repo, AGENTKEEL_HOME: keelHome, AGENTKEEL_SESSION_ID: 'owner' };
  return { ...f, clone, keelHome, env };
}

async function waitForFile(file: string) {
  const deadline = Date.now() + 10000;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

describe('provisioning ownership and serialization', () => {
  it('preserves a competing winner created exactly at branch creation', async () => {
    const f = fixture();
    mock(f.bin, 'git', `if [ "$3" = branch ] && [ "$4" = feat/race ]; then
  "$REAL_GIT" "$@"
  "$REAL_GIT" -C "$FIXTURE_REPO" worktree add "$FIXTURE_BASE/fixture-race" feat/race
  printf winner > "$FIXTURE_BASE/fixture-race/winner"
  exit 19
fi
exec "$REAL_GIT" "$@"`);
    try {
      const r = await run(f.repo, ['scripts/agent-up.sh', 'feat/race'], mockedEnv(f));
      expect(r.code).toBe(19);
      expect(readFileSync(path.join(f.base, 'fixture-race/winner'), 'utf8')).toBe('winner');
      expect(execFileSync(realGit, ['worktree', 'list', '--porcelain'], { cwd: f.repo, encoding: 'utf8' })).toContain('branch refs/heads/feat/race');
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  it('removes its partially created worktree when git add fails', async () => {
    const f = fixture();
    mock(f.bin, 'git', `if [ "$3" = worktree ] && [ "$4" = add ]; then
  "$REAL_GIT" "$@"
  exit 21
fi
exec "$REAL_GIT" "$@"`);
    try {
      const r = await run(f.repo, ['scripts/agent-up.sh', 'feat/partial'], mockedEnv(f));
      expect(r.code).toBe(21);
      expect(existsSync(path.join(f.base, 'fixture-partial'))).toBe(false);
      expect(execFileSync(realGit, ['worktree', 'list', '--porcelain'], { cwd: f.repo, encoding: 'utf8' })).not.toContain('feat/partial');
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  it('allows exactly one concurrent creation, preserving its setup output', async () => {
    const f = fixture();
    writeFileSync(path.join(f.repo, '.agent-slots.conf'), readFileSync(path.join(f.repo, '.agent-slots.conf'), 'utf8') + 'agent_prepare_worktree() { sleep 0.2; printf ready > "$2/ready"; }\n');
    try {
      const results = await Promise.all([
        run(f.repo, ['scripts/agent-up.sh', 'feat/same']),
        run(f.repo, ['scripts/agent-up.sh', 'feat/same']),
      ]);
      expect(results.map(r => r.code).sort()).toEqual([0, 1]);
      expect(readFileSync(path.join(f.base, 'fixture-same/ready'), 'utf8')).toBe('ready');
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  it('assigns different slots to simultaneous stack provisioning in one repository', async () => {
    const f = fixture();
    const dbDir = path.join(f.base, 'databases');
    mkdirSync(dbDir);
    writeFileSync(path.join(f.repo, '.env'), 'DATABASE_URL="postgresql://fixture@localhost/fixture_dev"\n');
    writeFileSync(path.join(f.repo, '.agent-slots.conf'), readFileSync(path.join(f.repo, '.agent-slots.conf'), 'utf8') + 'AGENT_SLOT_MAX=2\n');
    mock(f.bin, 'psql', `case "$*" in
  *"datname = 'fixture_dev'"*) printf '1\\n' ;;
  *"datname = 'fixture_a1'"*) [ ! -f "$MOCK_DBS/fixture_a1" ] || printf '1\\n' ;;
  *"datname = 'fixture_a2'"*) [ ! -f "$MOCK_DBS/fixture_a2" ] || printf '1\\n' ;;
  *"select 1"*) printf '1\\n' ;;
  *) cat >/dev/null ;;
esac`);
    mock(f.bin, 'createdb', 'sleep 0.2; touch "$MOCK_DBS/\${@: -1}"');
    mock(f.bin, 'dropdb', 'rm -f "$MOCK_DBS/\${@: -1}"');
    mock(f.bin, 'pg_dump', 'printf "dump\\n"');
    mock(f.bin, 'lsof', 'exit 1');
    const env = { ...mockedEnv(f), MOCK_DBS: dbDir };
    try {
      const results = await Promise.all([
        run(f.repo, ['scripts/agent-up.sh', 'feat/first', '--stack'], env),
        run(f.repo, ['scripts/agent-up.sh', 'feat/second', '--stack'], env),
      ]);
      expect(results.map(r => r.code)).toEqual([0, 0]);
      const slots = ['first', 'second'].map(name => readFileSync(path.join(f.base, `fixture-${name}/.env`), 'utf8').match(/^AGENT_SLOT=(.*)$/m)?.[1]);
      expect(slots.sort()).toEqual(['1', '2']);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  it('serializes reaping against provisioning so a fresh slot database survives an old snapshot', async () => {
    const f = fixture(), env = mockedEnv(f);
    writeFileSync(path.join(f.repo, '.env'), 'DATABASE_URL="postgresql://fixture@localhost/fixture_dev"\n');
    writeFileSync(path.join(f.repo, '.agent-slots.conf'), readFileSync(path.join(f.repo, '.agent-slots.conf'), 'utf8') + 'AGENT_SLOT_MAX=1\n');
    mock(f.bin, 'psql', `case "$*" in
  *"datname = 'fixture_dev'"*) printf '1\\n' ;;
  *"datname = 'fixture_a1'"*)
    if [ "\${REAP_MODE:-}" = yes ] && [ ! -f "$FIXTURE_BASE/snapshot-taken" ]; then
      touch "$FIXTURE_BASE/snapshot-taken"
      while [ ! -f "$FIXTURE_BASE/release-reap" ]; do sleep 0.02; done
    fi
    [ ! -f "$FIXTURE_BASE/database-created" ] || printf '1\\n' ;;
  *"select 1"*) printf '1\\n' ;;
  *) cat >/dev/null ;;
esac`);
    mock(f.bin, 'createdb', 'touch "$FIXTURE_BASE/database-created"');
    mock(f.bin, 'dropdb', 'rm -f "$FIXTURE_BASE/database-created"');
    mock(f.bin, 'pg_dump', 'printf "dump\\n"');
    mock(f.bin, 'lsof', 'exit 1');
    mock(f.bin, 'git', `if [ "$3" = rev-parse ] && [ "$4" = --git-common-dir ] && [ "\${REAP_MODE:-}" != yes ]; then
  touch "$FIXTURE_BASE/up-at-lock"
fi
exec "$REAL_GIT" "$@"`);
    let reap: Promise<Awaited<ReturnType<typeof run>>> | undefined;
    let up: Promise<Awaited<ReturnType<typeof run>>> | undefined;
    try {
      reap = run(f.repo, ['scripts/agent-reap.sh', '--yes'], { ...env, REAP_MODE: 'yes' });
      await waitForFile(path.join(f.base, 'snapshot-taken'));
      up = run(f.repo, ['scripts/agent-up.sh', 'feat/reap-race', '--stack'], env);
      await waitForFile(path.join(f.base, 'up-at-lock'));
      let completed = false;
      void up.then(() => { completed = true; });
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(completed).toBe(false);
      writeFileSync(path.join(f.base, 'release-reap'), 'release\n');
      const results = await Promise.all([reap, up]);
      expect(results.map(r => r.code), results.map(r => r.stderr).join('\n')).toEqual([0, 0]);
      expect(existsSync(path.join(f.base, 'database-created'))).toBe(true);
      expect(readFileSync(path.join(f.base, 'fixture-reap-race/.env'), 'utf8')).toContain('AGENT_SLOT=1');
    } finally {
      writeFileSync(path.join(f.base, 'release-reap'), 'release\n');
      await Promise.allSettled([reap, up].filter((p): p is NonNullable<typeof p> => p !== undefined));
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  it('stores an existing state pointer without creating a document', async () => {
    const f = fixture();
    try {
      const r = await run(f.repo, ['scripts/agent-up.sh', 'feat/state', '--state', 'docs/state.html']);
      expect(r.code, r.stderr).toBe(0);
      expect(readFileSync(path.join(f.base, 'fixture-state/.agent'), 'utf8')).toContain('STATE=docs/state.html');
      expect(existsSync(path.join(f.base, 'fixture-state/docs/plans'))).toBe(false);
      const bad = await run(f.repo, ['scripts/agent-up.sh', 'feat/missing', '--state', 'docs/missing.html']);
      expect(bad.code).toBe(1);
      expect(existsSync(path.join(f.base, 'fixture-missing'))).toBe(false);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });
});

describe('owned external clone stack attachment', () => {
  it('attaches to the existing clone using shared config and preserves its Git history', async () => {
    const f = cloneFixture();
    const head = execFileSync(realGit, ['rev-parse', 'HEAD'], { cwd: f.clone, encoding: 'utf8' });
    writeFileSync(path.join(f.clone, '.agent-slots.conf'), 'AGENT_PROJECT_SLUG=wrong_clone\n');
    try {
      const r = await run(f.repo, ['scripts/agent-up.sh', 'feat/clone', '--stack', '--workspace', f.clone], f.env);
      expect(r.code, r.stderr).toBe(0);
      expect(readFileSync(path.join(f.clone, '.env'), 'utf8')).toContain('/fixture_a1');
      expect(readFileSync(path.join(f.clone, '.agent'), 'utf8')).toContain(`REPO=${f.repo}`);
      expect(execFileSync(realGit, ['rev-parse', 'HEAD'], { cwd: f.clone, encoding: 'utf8' })).toBe(head);
      const introspection = execFileSync('bash', ['-c', '. ./scripts/lib/agent-slot.sh; agent_tier_of_worktree "$PWD"; agent_slot_of_worktree "$PWD"'], { cwd: f.clone, env: { ...f.env, AGENT_REPO_ROOT: '' }, encoding: 'utf8' });
      expect(introspection.trim()).toBe('stack\n1');
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  it('releases an owned clone through nested down and stop without writing the shared Git directory', async () => {
    const f = cloneFixture();
    const sharedGit = path.join(f.repo, '.git');
    try {
      const up = await run(f.repo, ['scripts/agent-up.sh', 'feat/clone', '--stack', '--workspace', f.clone], f.env);
      expect(up.code, up.stderr).toBe(0);
      const foreignClaim = 'SLOT=1\nREPO=/foreign/project\nCLAIM=foreign-live-claim\n';
      writeFileSync(f.env.AGENT_SIM_LOCK, foreignClaim);
      chmodSync(sharedGit, 0o555);
      const down = await run(f.clone, ['scripts/agent-down.sh', '1'], f.env);
      expect(down.code, down.stderr).toBe(0);
      expect(existsSync(path.join(f.clone, '.git'))).toBe(true);
      expect(readFileSync(path.join(f.clone, '.env'), 'utf8')).not.toContain('AGENT_SLOT=');
      expect(existsSync(path.join(f.base, 'database-created'))).toBe(false);
      expect(existsSync(path.join(sharedGit, 'agent-provision.lock'))).toBe(false);
      expect(existsSync(path.join(f.base, 'repos'))).toBe(true);
      expect(readFileSync(f.env.AGENT_SIM_LOCK, 'utf8')).toBe(foreignClaim);
    } finally {
      chmodSync(sharedGit, 0o755);
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  it('refuses attaching the canonical checkout even when it is on a feature branch', async () => {
    const f = cloneFixture();
    execFileSync(realGit, ['checkout', '-qb', 'feat/primary'], { cwd: f.repo });
    const originalEnv = readFileSync(path.join(f.repo, '.env'), 'utf8');
    try {
      const r = await run(f.repo, ['scripts/agent-up.sh', 'feat/primary', '--stack', '--workspace', f.repo], f.env);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('cannot attach the canonical shared checkout');
      expect(readFileSync(path.join(f.repo, '.env'), 'utf8')).toBe(originalEnv);
      expect(existsSync(path.join(f.base, 'database-created'))).toBe(false);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  it('refuses a foreign clone before rewriting env or creating a database', async () => {
    const f = cloneFixture();
    try {
      const r = await run(f.repo, ['scripts/agent-up.sh', 'feat/clone', '--stack', '--workspace', f.clone], { ...f.env, AGENTKEEL_SESSION_ID: 'foreign' });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('held by task clone-task');
      expect(readFileSync(path.join(f.clone, '.env'), 'utf8')).toBe('KEEP_PRIOR=original\n');
      expect(existsSync(path.join(f.base, 'database-created'))).toBe(false);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  it('restores env and marker and leaves the clone when database import fails', async () => {
    const f = cloneFixture();
    mock(f.bin, 'pg_dump', 'exit 24');
    try {
      const r = await run(f.repo, ['scripts/agent-up.sh', 'feat/clone', '--stack', '--workspace', f.clone], f.env);
      expect(r.code, r.stderr).toBe(24);
      expect(readFileSync(path.join(f.clone, '.env'), 'utf8')).toBe('KEEP_PRIOR=original\n');
      expect(readFileSync(path.join(f.clone, '.agent'), 'utf8')).toBe('STATE=docs/state.html\n');
      expect(existsSync(path.join(f.clone, '.git'))).toBe(true);
      expect(existsSync(path.join(f.base, 'database-created'))).toBe(false);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });
});

function simulatorMocks(f: ReturnType<typeof fixture>) {
  mock(f.bin, 'xcrun', 'printf \'{"devices":{"runtime":[{"name":"iPhone Fixture","udid":"fixture-device"}]}}\\n\'');
  mock(f.bin, 'jq', 'cat >/dev/null; printf "fixture-device\\n"');
  mock(f.bin, 'osascript', 'exit 0');
  return { ...mockedEnv(f), AGENT_SIM_LOCK: path.join(f.base, 'host.sim.lock'), AGENT_SIM_PID: String(process.pid) };
}
describe('host simulator claims, mocked devices only', () => {
  it('allows one acquisition when different projects race to recover a stale lock', async () => {
    const a = fixture(), b = fixture();
    const env = simulatorMocks(a);
    writeFileSync(env.AGENT_SIM_LOCK, 'SLOT=1\nPID=99999999\nUDID=\nACQUIRED=0\nCLAIM=old\n');
    try {
      const results = await Promise.all([
        run(a.repo, ['scripts/sim-lock.sh', 'acquire', '1'], env),
        run(b.repo, ['scripts/sim-lock.sh', 'acquire', '1'], env),
      ]);
      expect(results.map(r => r.code).sort()).toEqual([0, 1]);
      const winner = readFileSync(env.AGENT_SIM_LOCK, 'utf8');
      expect(winner).toContain('UDID=fixture-device');
      expect(winner).not.toContain('CLAIM=old');
      const losingRepo = winner.includes(`REPO=${a.repo}`) ? b.repo : a.repo;
      const release = await run(losingRepo, ['scripts/sim-lock.sh', 'release', '1', '--force'], env);
      expect(release.code).toBe(1);
      expect(readFileSync(env.AGENT_SIM_LOCK, 'utf8')).toBe(winner);
    } finally { rmSync(a.base, { recursive: true, force: true }); rmSync(b.base, { recursive: true, force: true }); }
  });

  it('does not remove a replacement claim after mocked device selection fails', async () => {
    const f = fixture(), env = simulatorMocks(f);
    mock(f.bin, 'xcrun', 'printf "CLAIM=replacement\\nPID=%s\\n" "$AGENT_SIM_PID" > "$AGENT_SIM_LOCK"; exit 22');
    try {
      const r = await run(f.repo, ['scripts/sim-lock.sh', 'acquire', '1'], env);
      expect(r.code).not.toBe(0);
      expect(readFileSync(env.AGENT_SIM_LOCK, 'utf8')).toContain('CLAIM=replacement');
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });
});
