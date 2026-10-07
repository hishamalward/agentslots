import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts/lib/agent-slot.sh');

function source(snippet: string, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('bash', ['-c', `set -e; . "${LIB}"; agent_config_validate; ${snippet}`], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trim();
}

describe('project configuration', () => {
  it.each([
    ['sample-project', 'sample_project'],
    ['renamedproject', 'renamedproject'],
  ])('derives generic defaults from the repository name %s', (name, slug) => {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'slots-name-')));
    const repo = path.join(base, name);
    try {
      mkdirSync(repo);
      execFileSync('git', ['init', '-q', repo]);
      const config = path.join(base, 'empty.conf');
      writeFileSync(config, '');
      const env = { AGENT_REPO_ROOT: repo, AGENT_CONFIG: config,
        AGENT_PROJECT_SLUG: '', AGENT_WORKTREE_PREFIX: '',
        AGENT_DATABASE_MAIN: '', AGENT_DATABASE_PREFIX: '' };
      expect(source('agent_db_name 0', env)).toBe(`${slug}_dev`);
      expect(source('agent_db_name 3', env)).toBe(`${slug}_a3`);
      expect(source('agent_worktree_path feat/demo', env)).toBe(path.join(base, `${name}-demo`));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('loads an explicit config and allows safe hook overrides', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agent-slots-config-'));
    const config = path.join(dir, 'config.sh');
    try {
      writeFileSync(config, [
        'AGENT_PROJECT_SLUG=custom',
        'AGENT_DATABASE_MAIN=custom_local',
        'AGENT_DATABASE_PREFIX=custom_slot_',
        'AGENT_WEB_PORT_BASE=4100',
        'AGENT_PORT_STEP=10',
        'agent_start_web() { printf "hook:%s:%s\\n" "$1" "$2"; }',
      ].join('\n'));
      expect(source('printf "%s %s %s\\n" "$(agent_db_name 0)" "$(agent_db_name 2)" "$(agent_web_port 2)"', {
        AGENT_CONFIG: config,
      })).toBe('custom_local custom_slot_2 4120');
      expect(source('agent_start_web /tmp/worktree 4120', { AGENT_CONFIG: config }))
        .toBe('hook:/tmp/worktree:4120');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid slot and path configuration before use', () => {
    expect(() => source(':', { AGENT_SLOT_MAX: '0' })).toThrow();
    expect(() => source(':', { AGENT_SLOT_MAX: '99999999999999999999' })).toThrow();
    expect(() => source(':', { AGENT_APP_DIR: '../outside' })).toThrow();
    expect(() => source(':', { AGENT_CONFLICT_ENV_FILE: '../../outside' })).toThrow();
    expect(() => source(':', { AGENT_WEB_PORT_BASE: '99999999999999999999' })).toThrow();
    expect(() => source(':', {
      AGENT_WEB_PORT_BASE: '3000',
      AGENT_METRO_PORT_BASE: '3100',
      AGENT_PORT_STEP: '100',
    })).toThrow();
  });
});
