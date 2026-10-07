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

function createStackFixture(): Fixture & { bin: string; dbState: string } {
  const fixture = createFixture(':');
  const bin = path.join(fixture.base, 'bin');
  const dbState = path.join(fixture.base, 'slot-database-created');
  mkdirSync(bin);
  writeFileSync(path.join(fixture.repo, '.env'), [
    'DATABASE_URL="postgresql://test:password@localhost:5432/fixture_dev"',
    'APP_URL="http://localhost:3000"',
    'KEEP_ME=yes',
  ].join('\n') + '\n');
  writeFileSync(path.join(fixture.repo, '.agent-slots.conf'), [
    'AGENT_MAIN_BRANCH=trunk',
    'AGENT_PROJECT_SLUG=fixture',
    'AGENT_DATABASE_MAIN=fixture_dev',
    'AGENT_DATABASE_PREFIX=fixture_a',
    'AGENT_WORKTREE_PREFIX=fixture-',
    `AGENT_SIM_LOCK="${path.join(fixture.base, 'sim.lock')}"`,
    'AGENT_SLOT_MAX=2',
    'AGENT_APP_DIR=.',
    'AGENT_ENV_FILE=.env',
    'AGENT_PUBLIC_URL_KEY=APP_URL',
    'AGENT_QUEUE_SCHEMA_KEY=PGBOSS_SCHEMA',
    'AGENT_QUEUE_SCHEMA_MAIN=pgboss',
    'AGENT_QUEUE_SCHEMA_PREFIX=pgboss_a',
    'AGENT_INHERITED_QUEUE_SCHEMA=pgboss',
    'agent_prepare_worktree() { :; }',
  ].join('\n'));
  writeFileSync(path.join(fixture.repo, '.gitignore'), '.agent\n.env\n');
  execFileSync('git', ['add', '.agent-slots.conf', '.gitignore'], { cwd: fixture.repo });
  execFileSync('git', ['commit', '-q', '-m', 'configure stack'], { cwd: fixture.repo });

  const commands: Record<string, string> = {
    psql: `#!/usr/bin/env bash
case "$*" in
  *"datname = 'fixture_dev'"*) printf '1\\n' ;;
  *"datname = 'fixture_a1'"*) [ -f "$MOCK_DB_STATE" ] && printf '1\\n' ;;
  *"select count(*) from pg_namespace"*) printf '0\\n' ;;
  *"select 1"*) printf '1\\n' ;;
  *) cat >/dev/null || true ;;
esac
`,
    createdb: '#!/usr/bin/env bash\ntouch "$MOCK_DB_STATE"\n',
    dropdb: '#!/usr/bin/env bash\nrm -f "$MOCK_DB_STATE"\n',
    pg_dump: '#!/usr/bin/env bash\nprintf -- "-- fixture dump\\n"\n',
    lsof: '#!/usr/bin/env bash\nexit 1\n',
  };
  for (const [name, body] of Object.entries(commands)) {
    const command = path.join(bin, name);
    writeFileSync(command, body);
    chmodSync(command, 0o755);
  }
  return { ...fixture, bin, dbState };
}

function runUp(repo: string, branch: string): { status: number; stderr: string } {
  try {
    execFileSync('bash', ['scripts/agent-up.sh', branch], { cwd: repo, encoding: 'utf8' });
    return { status: 0, stderr: '' };
  } catch (error: any) {
    return { status: error.status, stderr: error.stderr?.toString() ?? '' };
  }
}

describe('agent-up code-tier integration', () => {
  it('creates a self-contained worktree with project hooks and no authored documents', () => {
    const fixture = createFixture(':');
    const wt = path.join(fixture.base, 'fixture-happy-path');
    try {
      expect(runUp(fixture.repo, 'feat/happy-path').status).toBe(0);
      expect(existsSync(path.join(wt, '.agent'))).toBe(true);
      expect(existsSync(path.join(wt, 'docs'))).toBe(false);
      expect(readFileSync(path.join(wt, '.agent'), 'utf8')).not.toContain('HANDOVER=');
      writeFileSync(path.join(wt, '.agent-slots.conf'), 'AGENT_PROJECT_SLUG=wrong_branch_value\n');
      expect(execFileSync('bash', ['-c', '. ./scripts/lib/agent-slot.sh; agent_db_name 0'], {
        cwd: wt,
        encoding: 'utf8',
      }).trim()).toBe('fixture_dev');
    } finally {
      if (existsSync(wt)) execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: fixture.repo });
      execFileSync('git', ['branch', '-D', 'feat/happy-path'], { cwd: fixture.repo, stdio: 'ignore' });
      rmSync(fixture.base, { recursive: true, force: true });
    }
  });

  it('rolls back the branch and worktree when setup fails after worktree creation', () => {
    const fixture = createFixture('return 23');
    const wt = path.join(fixture.base, 'fixture-rollback');
    const before = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: fixture.repo,
      encoding: 'utf8',
    });
    try {
      const result = runUp(fixture.repo, 'feat/rollback');
      expect(result.status).toBe(23);
      expect(result.stderr).toContain('rolling back');
      expect(existsSync(wt)).toBe(false);
      expect(execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: fixture.repo,
        encoding: 'utf8',
      })).toBe(before);
      expect(() => execFileSync('git', ['show-ref', '--verify', 'refs/heads/feat/rollback'], {
        cwd: fixture.repo,
        stdio: 'ignore',
      })).toThrow();
    } finally {
      rmSync(fixture.base, { recursive: true, force: true });
    }
  });

  it('provisions and tears down a complete configured stack without leaking resources', () => {
    const fixture = createStackFixture();
    const wt = path.join(fixture.base, 'fixture-stack');
    const env = {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      MOCK_DB_STATE: fixture.dbState,
    };
    try {
      execFileSync('bash', ['scripts/agent-up.sh', 'feat/stack', '--stack'], {
        cwd: fixture.repo,
        env,
        stdio: 'pipe',
      });
      expect(existsSync(fixture.dbState)).toBe(true);
      const slotEnv = readFileSync(path.join(wt, '.env'), 'utf8');
      expect(slotEnv).toContain('KEEP_ME=yes');
      expect(slotEnv).toContain('AGENT_SLOT=1');
      expect(slotEnv).toContain('DATABASE_URL="postgresql://test:password@localhost:5432/fixture_a1"');
      expect(slotEnv).toContain('PGBOSS_SCHEMA=pgboss_a1');
      expect(slotEnv).toContain('APP_URL="http://localhost:3100"');
      expect(readFileSync(path.join(wt, '.agent'), 'utf8')).toContain('TIER=stack');

      execFileSync('bash', ['scripts/agent-down.sh', '1'], {
        cwd: fixture.repo,
        env,
        stdio: 'pipe',
      });
      expect(existsSync(wt)).toBe(false);
      expect(existsSync(fixture.dbState)).toBe(false);
    } finally {
      if (existsSync(wt)) execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: fixture.repo });
      try {
        execFileSync('git', ['branch', '-D', 'feat/stack'], { cwd: fixture.repo, stdio: 'ignore' });
      } catch {
        // The branch can be absent when provisioning failed before branch creation.
      }
      rmSync(fixture.base, { recursive: true, force: true });
    }
  });
});
