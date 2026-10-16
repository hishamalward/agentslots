import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  const primary = repo, tree = path.join(base, 'task');
  execFileSync(realGit, ['worktree', 'add', '-qb', 'feat/runtime', tree], { cwd: primary });
  mock(bin, 'lsof', 'exit 1');
  execFileSync('bash', ['scripts/agent-slots', 'attach', '--worktree', tree, '--service', 'mobile'], {
    cwd: primary, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, AGENT_REPO_ROOT: primary }, stdio: 'pipe',
  });
  return { base, repo: tree, primary, bin };
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

function simulatorMocks(f: ReturnType<typeof fixture>) {
  mock(f.bin, 'xcrun', 'printf \'{"devices":{"runtime":[{"name":"iPhone Fixture","udid":"fixture-device"}]}}\\n\'');
  mock(f.bin, 'jq', 'cat >/dev/null; printf "fixture-device\\n"');
  mock(f.bin, 'osascript', 'exit 0');
  return { ...mockedEnv(f), AGENT_SIM_LOCK: path.join(f.base, 'host.sim.lock'), AGENT_SIM_PID: String(process.pid) };
}
describe('host simulator claims, mocked devices only', () => {
  it('releases the matching claim while leaving the device running when requested', async () => {
    const f = fixture(), env = simulatorMocks(f);
    try {
      const acquired = await run(f.repo, ['scripts/sim-lock.sh', 'acquire', '1'], env);
      expect(acquired.code, acquired.stderr).toBe(0);
      const claim = readFileSync(env.AGENT_SIM_LOCK, 'utf8').match(/^CLAIM=(.+)$/m)![1];
      mock(f.bin, 'xcrun', 'printf "shutdown\\n" >> "$FIXTURE_BASE/device-effects"');
      mock(f.bin, 'osascript', 'printf "quit\\n" >> "$FIXTURE_BASE/device-effects"');
      const released = await run(f.repo, ['scripts/sim-lock.sh', 'release', '1', '--claim', claim, '--keep-device'], env);
      expect(released.code, released.stderr).toBe(0);
      expect(existsSync(env.AGENT_SIM_LOCK)).toBe(false);
      expect(existsSync(path.join(f.base, 'device-effects'))).toBe(false);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  it('shuts down only the owned device on default release without quitting Simulator', async () => {
    const f = fixture(), env = simulatorMocks(f);
    try {
      const acquired = await run(f.repo, ['scripts/sim-lock.sh', 'acquire', '1'], env);
      expect(acquired.code, acquired.stderr).toBe(0);
      mock(f.bin, 'xcrun', 'printf "%s\\n" "$*" >> "$FIXTURE_BASE/device-effects"');
      mock(f.bin, 'osascript', 'printf "quit\\n" >> "$FIXTURE_BASE/device-effects"');
      const released = await run(f.repo, ['scripts/sim-lock.sh', 'release', '1'], env);
      expect(released.code, released.stderr).toBe(0);
      expect(existsSync(env.AGENT_SIM_LOCK)).toBe(false);
      expect(readFileSync(path.join(f.base, 'device-effects'), 'utf8')).toBe('simctl shutdown fixture-device\n');
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  it('refuses replacement claims before device effects even with force', async () => {
    const f = fixture(), env = simulatorMocks(f);
    try {
      const acquired = await run(f.repo, ['scripts/sim-lock.sh', 'acquire', '1'], env);
      expect(acquired.code, acquired.stderr).toBe(0);
      const lock = readFileSync(env.AGENT_SIM_LOCK, 'utf8');
      const claim = lock.match(/^CLAIM=(.+)$/m)![1];
      const replacement = lock.replace(/^CLAIM=.+$/m, 'CLAIM=replacement-owner');
      writeFileSync(env.AGENT_SIM_LOCK, replacement);
      mock(f.bin, 'xcrun', 'printf "shutdown\\n" >> "$FIXTURE_BASE/device-effects"');
      mock(f.bin, 'osascript', 'printf "quit\\n" >> "$FIXTURE_BASE/device-effects"');
      const released = await run(f.repo, ['scripts/sim-lock.sh', 'release', '1', '--claim', claim, '--force'], env);
      expect(released.code).toBe(1);
      expect(released.stderr).toContain('claim was replaced');
      expect(readFileSync(env.AGENT_SIM_LOCK, 'utf8')).toBe(replacement);
      expect(existsSync(path.join(f.base, 'device-effects'))).toBe(false);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  it.each(['Booted', ''])('retains the claim when shutdown fails and device state is %j', async (state) => {
    const f = fixture(), env = simulatorMocks(f);
    try {
      const acquired = await run(f.repo, ['scripts/sim-lock.sh', 'acquire', '1'], env);
      expect(acquired.code, acquired.stderr).toBe(0);
      const original = readFileSync(env.AGENT_SIM_LOCK, 'utf8');
      mock(f.bin, 'xcrun', 'case "$*" in "simctl shutdown fixture-device") exit 12 ;; "simctl list devices -j") printf "{}\\n" ;; *) exit 14 ;; esac');
      mock(f.bin, 'jq', `cat >/dev/null; printf '%s\\n' '${state}'`);
      const released = await run(f.repo, ['scripts/sim-lock.sh', 'release', '1'], env);
      expect(released.code).toBe(1);
      expect(released.stderr).toContain('keeping its claim');
      expect(readFileSync(env.AGENT_SIM_LOCK, 'utf8')).toBe(original);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  it('releases the claim after a failed shutdown only when the device is confirmed Shutdown', async () => {
    const f = fixture(), env = simulatorMocks(f);
    try {
      const acquired = await run(f.repo, ['scripts/sim-lock.sh', 'acquire', '1'], env);
      expect(acquired.code, acquired.stderr).toBe(0);
      mock(f.bin, 'xcrun', 'case "$*" in "simctl shutdown fixture-device") exit 12 ;; "simctl list devices -j") printf "{}\\n" ;; *) exit 14 ;; esac');
      mock(f.bin, 'jq', 'cat >/dev/null; printf "Shutdown\\n"');
      const released = await run(f.repo, ['scripts/sim-lock.sh', 'release', '1'], env);
      expect(released.code, released.stderr).toBe(0);
      expect(existsSync(env.AGENT_SIM_LOCK)).toBe(false);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

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
      const losingRepo = winner.includes(`REPO=${a.primary}`) ? b.repo : a.repo;
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
