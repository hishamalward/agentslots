import { execFileSync } from 'node:child_process';
import {
  cpSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_REPO = path.resolve(__dirname, '..');

interface Fixture {
  base: string;
  repo: string;
}

function createFixture(prepareBody: string): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), 'agent-slots-up-'));
  const repo = path.join(base, 'main');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'trunk'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Agent Slots Test'], { cwd: repo });
  cpSync(path.join(SOURCE_REPO, 'scripts'), path.join(repo, 'scripts'), { recursive: true });
  writeFileSync(path.join(repo, '.gitignore'), '.agent\n');
  writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  writeFileSync(path.join(repo, '.agent-slots.conf'), [
    'AGENT_MAIN_BRANCH=trunk',
    'AGENT_PROJECT_SLUG=fixture',
    'AGENT_WORKTREE_PREFIX=fixture-',
    `AGENT_SIM_LOCK="${path.join(base, 'sim.lock')}"`,
    `agent_prepare_worktree() { ${prepareBody}; }`,
  ].join('\n'));
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: repo });
  return { base, repo };
}

function runUp(repo: string, branch: string, flags: string[] = []): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bash', ['scripts/agent-up.sh', '--worktree', branch, ...flags], { cwd: repo, encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (error: any) {
    return { status: error.status, stdout: error.stdout?.toString() ?? '', stderr: error.stderr?.toString() ?? '' };
  }
}

describe('explicit dependency preparation', () => {
  it('defers setup when configured, prepares once, and reports stale dependencies', () => {
    const fixture = createFixture('printf run >> "$2/prepare-count"; touch "$2/prepared"');
    const wt = path.join(fixture.base, 'fixture-deferred');
    writeFileSync(path.join(fixture.repo, '.agent-slots.conf'),
      readFileSync(path.join(fixture.repo, '.agent-slots.conf'), 'utf8') +
      '\nagent_dependencies_present() { [ -f "$1/prepared" ]; }\nagent_dependencies_stale() { [ -f "$1/stale" ]; }\n');
    try {
      execFileSync('git', ['worktree', 'add', '-qb', 'feat/deferred', wt], { cwd: fixture.repo });
      const deferred = runUp(fixture.repo, wt);
      expect(deferred.status).toBe(0);
      expect(deferred.stdout).not.toContain('(prepare requested)');
      expect(existsSync(path.join(wt, 'prepared'))).toBe(false);
      const prepared = runUp(fixture.repo, wt, ['--prepare']);
      expect(prepared.status).toBe(0);
      expect(prepared.stdout).toContain('(prepare requested)');
      expect(readFileSync(path.join(wt, 'prepare-count'), 'utf8')).toBe('run');
      expect(existsSync(path.join(wt, '.env'))).toBe(false);
      expect(runUp(fixture.repo, wt, ['--prepare']).status).toBe(0);
      expect(readFileSync(path.join(wt, 'prepare-count'), 'utf8')).toBe('run');
      writeFileSync(path.join(wt, 'stale'), 'yes');
      const stale = runUp(fixture.repo, wt, ['--prepare']);
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain('dependencies MAY BE STALE');
      expect(readFileSync(path.join(wt, 'prepare-count'), 'utf8')).toBe('run');
    } finally { rmSync(fixture.base, { recursive: true, force: true }); }
  });

  it('preserves an existing deferred worktree when preparation fails', () => {
    const fixture = createFixture('return 23');
    const wt = path.join(fixture.base, 'fixture-prepare-fails');
    try {
      execFileSync('git', ['worktree', 'add', '-qb', 'feat/prepare-fails', wt], { cwd: fixture.repo });
      expect(runUp(fixture.repo, wt).status).toBe(0);
      expect(runUp(fixture.repo, wt, ['--prepare']).status).toBe(23);
      expect(existsSync(path.join(wt, '.git'))).toBe(true);
    } finally { rmSync(fixture.base, { recursive: true, force: true }); }
  });

});
