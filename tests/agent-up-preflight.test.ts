// scripts/agent-up.sh provisions the code tier worktree that Tasks 4 through 12 all build on,
// so its contract needs coverage even though the script itself has no test framework of its own.
// This suite covers refusal paths; successful provisioning and rollback are exercised against
// disposable repositories in agent-up-integration.test.ts.
//
// bash 3.2 is the macOS system bash agent-up.sh targets. Running it via `bash` here is running
// it under the same interpreter the real invocation uses.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const REPO = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts/agent-up.sh');

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd = REPO): Run {
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8', cwd });
    return { status: 0, stdout, stderr: '' };
  } catch (e: any) {
    return {
      status: typeof e.status === 'number' ? e.status : -1,
      stdout: e.stdout ? e.stdout.toString() : '',
      stderr: e.stderr ? e.stderr.toString() : '',
    };
  }
}

/** `git worktree list --porcelain`, byte for byte, from the repo root. The property that
 *  actually matters for a refusal path: it must read identically before and after. */
function worktreeList(): string {
  return execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8', cwd: REPO });
}

describe('agent-up.sh refusal paths', () => {
  it('with no argument, exits 2 and prints usage on stderr', () => {
    const before = worktreeList();
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^usage: agent-up\.sh/m);
    expect(worktreeList()).toBe(before);
  });

  it('with an unknown option, exits 2 and names the option', () => {
    const before = worktreeList();
    const r = run(['--not-a-real-flag', 'some-branch']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown option: --not-a-real-flag');
    expect(worktreeList()).toBe(before);
  });

  it('refuses a branch already checked out in another worktree', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'agent-up-checked-out-'));
    const repo = path.join(base, 'main');
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'AgentSlots Test');
      writeFileSync(path.join(repo, '.gitignore'), '.agent\n');
      writeFileSync(path.join(repo, '.agent-slots.conf'),
        `AGENT_WORKTREE_PREFIX=fixture-\nAGENT_SIM_LOCK=${base}/sim.lock\n`);
      git('add', '.');
      git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
      git('checkout', '-qb', 'feat/already-checked-out');
      const before = git('worktree', 'list', '--porcelain');
      const r = run(['feat/already-checked-out'], repo);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('already checked out at');
      expect(git('worktree', 'list', '--porcelain')).toBe(before);
      expect(existsSync(path.join(base, 'fixture-already-checked-out'))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('refuses a worktree path that already exists', () => {
    // This used to hardcode run(['feat/multi-agent-isolation']), relying on this branch's own
    // worktree already sitting at ../ma-multi-agent-isolation. That is ambient machine state, not
    // a fact this test controls: the merge protocol removes that worktree once this branch merges,
    // so the next `npm test` from
    // the main tree would find the path free, take agent-up.sh's happy path (a real
    // `git worktree add`, a cloned node_modules, `npx prisma generate`), and THEN fail the
    // `toBe(1)` assertion, after already provisioning something. This is the one test in the repo
    // that can do that.
    //
    // So: create the collision ourselves. Preflight 1 in agent-up.sh is exactly `[ -e "$WT" ]`,
    // checked before anything else (including whether $BRANCH even exists as a branch), so an
    // empty directory at the derived path is sufficient to force this exact refusal, and it is
    // sufficient regardless of what branches or worktrees exist on this machine. The fixture
    // branch name is one no human would use for real work, so it can never collide with a real
    // worktree on either side of a merge.
    const base = mkdtempSync(path.join(tmpdir(), 'agent-up-preflight-'));
    const repo = path.join(base, 'main');
    const wt = path.join(base, 'fixture-collision-fixture-zzz');
    mkdirSync(repo);
    try {
      execFileSync('git', ['init', '-q', '-b', 'trunk'], { cwd: repo });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 'Agent Slots Test'], { cwd: repo });
      cpSync(path.join(REPO, 'scripts'), path.join(repo, 'scripts'), { recursive: true });
      writeFileSync(path.join(repo, '.gitignore'), '.agent\n');
      writeFileSync(path.join(repo, '.agent-slots.conf'), [
        'AGENT_MAIN_BRANCH=trunk',
        'AGENT_PROJECT_SLUG=fixture',
        'AGENT_WORKTREE_PREFIX=fixture-',
      ].join('\n'));
      execFileSync('git', ['add', '.'], { cwd: repo });
      execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: repo });
      mkdirSync(wt);

      let status = 0;
      let stderr = '';
      try {
        execFileSync('bash', ['scripts/agent-up.sh', 'chore/collision-fixture-zzz'], {
          cwd: repo,
          encoding: 'utf8',
        });
      } catch (error: any) {
        status = error.status;
        stderr = error.stderr?.toString() ?? '';
      }
      expect(status).toBe(1);
      expect(stderr).toContain('already exists');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
