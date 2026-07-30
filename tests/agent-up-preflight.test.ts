// scripts/agent-up.sh provisions the code tier worktree that Tasks 4 through 12 all build on,
// so its contract needs coverage even though the script itself has no test framework of its own.
// This suite covers only the refusal paths: none of them provision anything, so the whole file
// runs in well under a second and needs no cleanup afterwards. The happy path costs about 20s
// and clones 1.4GB of node_modules, and is exercised manually (task-3-report.md), not here.
//
// bash 3.2 is the macOS system bash agent-up.sh targets. Running it via `bash` here is running
// it under the same interpreter the real invocation uses.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import path from 'path';

const REPO = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(REPO, 'scripts/agent-up.sh');

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Run {
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8', cwd: REPO });
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

/** The branch checked out in the MAIN worktree right now, or null if it is detached.
 *  Never hardcode `main`: this repo's main tree switches branches mid-session (it is on
 *  recap-dashboard-round2-2026-07-29 as this file is written), so a hardcoded branch would
 *  either exercise the wrong preflight check or silently stop testing this one at all.
 *
 *  Porcelain entries are separated by a blank line and the main worktree is always the first
 *  entry, so confine the search to the first block: a naive first-`branch`-line-anywhere search
 *  would misattribute another worktree's branch to main if main itself is detached. */
function mainWorktreeBranch(): string | null {
  const firstBlock = worktreeList().split('\n\n')[0];
  const branchLine = firstBlock.split('\n').find((l) => l.startsWith('branch '));
  return branchLine ? branchLine.replace('branch refs/heads/', '') : null;
}

/** The absolute path of the MAIN worktree: the first porcelain entry, always. */
function mainWorktreeRoot(): string {
  const firstBlock = worktreeList().split('\n\n')[0];
  const worktreeLine = firstBlock.split('\n').find((l) => l.startsWith('worktree '));
  if (!worktreeLine) throw new Error('git worktree list --porcelain produced no worktree line');
  return worktreeLine.replace('worktree ', '');
}

/** Mirrors agent_worktree_path from scripts/lib/agent-slot.sh: strip the <type>/ prefix, flatten
 *  any remaining slash, and sit the worktree beside (never inside) the main root. */
function derivedWorktreePath(branch: string): string {
  const idx = branch.indexOf('/');
  const stripped = idx === -1 ? branch : branch.slice(idx + 1);
  const slug = stripped.replace(/\//g, '-');
  return path.join(path.dirname(mainWorktreeRoot()), `ma-${slug}`);
}

// Computed once at collection time, same as the manual verification in task-3-report.md.
const MAIN_BRANCH = mainWorktreeBranch();
// preflight 1 ("path already exists") runs before preflight 2 ("checked out elsewhere") in
// agent-up.sh, so if the main worktree's branch happens to derive a path that already has a
// sibling worktree (feat/multi-agent-isolation and recap-landing both do right now), the "already
// checked out at" assertion below would fail on the wrong preflight message rather than skip.
const MAIN_BRANCH_PATH_COLLIDES = MAIN_BRANCH !== null && existsSync(derivedWorktreePath(MAIN_BRANCH));

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

  it.skipIf(MAIN_BRANCH === null || MAIN_BRANCH_PATH_COLLIDES)(
    'refuses a branch already checked out in another worktree',
    () => {
      const branch = MAIN_BRANCH as string;
      const before = worktreeList();
      const r = run([branch]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('already checked out at');
      expect(worktreeList()).toBe(before);
    },
  );

  it('refuses a worktree path that already exists', () => {
    // This used to hardcode run(['feat/multi-agent-isolation']), relying on this branch's own
    // worktree already sitting at ../ma-multi-agent-isolation. That is ambient machine state, not
    // a fact this test controls: the merge protocol this branch itself writes (CLAUDE.md, "down
    // when you merge") removes that worktree once this branch merges, so the next `npm test` from
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
    const branch = 'chore/agent-up-preflight-collision-fixture-zzz';
    const wt = derivedWorktreePath(branch);
    // Guard: if a worktree already sits here, this fixture would not be testing what it claims to.
    expect(existsSync(wt)).toBe(false);
    const before = worktreeList();
    mkdirSync(wt, { recursive: true });
    try {
      const r = run([branch]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('already exists');
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
    expect(worktreeList()).toBe(before);
  });
});
