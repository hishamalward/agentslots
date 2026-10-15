import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLI = path.resolve(__dirname, '../scripts/agent-slots');

describe('Git ownership stays with Keel or the caller', () => {
  let root: string, primary: string, tree: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const run = (...args: string[]) => spawnSync(CLI, args, {
    cwd: primary, encoding: 'utf8', env: { ...process.env, AGENT_REPO_ROOT: primary },
  });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'slots-contract-')));
    primary = path.join(root, 'main');
    tree = path.join(root, 'task');
    git(root, 'init', '-q', '-b', 'main', primary);
    git(primary, 'config', 'user.name', 'fixture');
    git(primary, 'config', 'user.email', 'fixture@example.invalid');
    writeFileSync(path.join(primary, '.gitignore'), '.env\n.agent\n.prepared\n');
    writeFileSync(path.join(primary, '.agent-slots.conf'),
      `AGENT_PROJECT_SLUG=contract\nAGENT_SIM_LOCK='${root}/sim.lock'\n` +
      'agent_prepare_worktree() { printf prepared > "$2/.prepared"; }\n');
    git(primary, 'add', '.gitignore', '.agent-slots.conf');
    git(primary, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    git(primary, 'worktree', 'add', '-qb', 'feat/task', tree);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('dependency preparation and release preserve the existing worktree, branch and user files', () => {
    const env = path.join(tree, '.env');
    writeFileSync(env, 'CUSTOM=keep\n');
    chmodSync(env, 0o600);
    const before = git(primary, 'worktree', 'list', '--porcelain');
    const attached = run('attach', '--worktree', tree, '--prepare');
    expect(attached.status, attached.stderr).toBe(0);
    expect(readFileSync(path.join(tree, '.prepared'), 'utf8')).toBe('prepared');
    writeFileSync(path.join(tree, 'unfinished.txt'), 'uncommitted user work');
    const released = run('release', '--worktree', tree);
    expect(released.status, released.stderr).toBe(0);
    expect(git(primary, 'worktree', 'list', '--porcelain')).toBe(before);
    expect(git(tree, 'symbolic-ref', '--short', 'HEAD')).toBe('feat/task');
    expect(readFileSync(path.join(tree, 'unfinished.txt'), 'utf8')).toBe('uncommitted user work');
    expect(readFileSync(env, 'utf8')).toBe('CUSTOM=keep\n');
    expect(existsSync(path.join(tree, '.prepared'))).toBe(true);
  });

  it('does not create a missing path or allocate against canonical main', () => {
    const before = git(primary, 'worktree', 'list', '--porcelain');
    const missing = path.join(root, 'missing');
    expect(run('attach', '--worktree', missing, '--prepare').status).not.toBe(0);
    expect(run('attach', '--worktree', primary, '--prepare').status).not.toBe(0);
    expect(existsSync(missing)).toBe(false);
    expect(git(primary, 'worktree', 'list', '--porcelain')).toBe(before);
  });
});
