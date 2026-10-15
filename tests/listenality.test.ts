import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const source = path.resolve(__dirname, '..');
const temporary: string[] = [];
const config = readFileSync(path.join(source, 'integrations/listenality/agent-slots.conf'), 'utf8');
function fixture() {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'agentslots-listenality-')));
  temporary.push(base);
  const repo = path.join(base, 'project'), bin = path.join(base, 'bin');
  mkdirSync(repo); mkdirSync(bin);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repo });
  mkdirSync(path.join(repo, 'scripts/lib'), { recursive: true });
  mkdirSync(path.join(repo, 'apps/web'), { recursive: true });
  mkdirSync(path.join(repo, 'apps/mobile'), { recursive: true });
  writeFileSync(path.join(repo, 'apps/web/package.json'), '{"name":"fixture-web"}\n');
  writeFileSync(path.join(repo, 'apps/mobile/package.json'), '{"name":"fixture-mobile"}\n');
  writeFileSync(path.join(repo, '.agent-slots.conf'), config);
  writeFileSync(path.join(repo, '.gitignore'), '.agent\nnode_modules/\napps/web/.env\n');
  writeFileSync(path.join(repo, 'AGENTS.md'), '# Project instructions\n');
  writeFileSync(path.join(repo, 'scripts/agent-up.sh'), '#!/bin/bash\necho legacy entry\n', { mode: 0o755 });
  writeFileSync(path.join(repo, 'scripts/lib/agent-slot.sh'), '# legacy library\n');
  // The retained project simulator helpers source this library and use these existing APIs.
  const helper = '#!/bin/bash\nHERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)\n. "$HERE/lib/agent-slot.sh"\n';
  writeFileSync(path.join(repo, 'scripts/sim-up.sh'), helper + 'for api in agent_slot_of_worktree agent_web_port agent_metro_port agent_port_busy; do declare -F "$api" >/dev/null || exit 8; done\n');
  writeFileSync(path.join(repo, 'scripts/sim-down.sh'), helper + 'for api in agent_slot_of_worktree agent_metro_port; do declare -F "$api" >/dev/null || exit 8; done\n');
  const install = spawnSync('python3', [path.join(source, 'install.py'), '--repo', repo, '--adopt-existing', '--apply'], { encoding: 'utf8' });
  expect(install.status, install.stderr).toBe(0);
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'adopt runtime'], { cwd: repo });
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, AGENTKEEL_HOME: path.join(base, 'absent-keel'), AGENTKEEL_SESSION_ID: 'fixture', AGENT_REPO_ROOT: '', AGENT_SIM_LOCK: path.join(base, 'sim.lock'), MOCK_LOG: path.join(base, 'commands') };
  writeFileSync(path.join(bin, 'npx'), '#!/bin/bash\nprintf "%s|%s\\n" "$PWD" "$*" >> "$MOCK_LOG"\n', { mode: 0o755 });
  writeFileSync(path.join(bin, 'lsof'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
  for (const name of ['psql', 'createdb', 'dropdb', 'pg_dump', 'xcrun']) writeFileSync(path.join(bin, name), '#!/bin/bash\nprintf "unexpected runtime command\\n" >> "$MOCK_LOG"\nexit 99\n', { mode: 0o755 });
  return { base, repo, env };
}
function shell(f: ReturnType<typeof fixture>, code: string, cwd = f.repo) {
  return spawnSync('bash', ['-c', 'set -euo pipefail; . ./scripts/lib/agent-slot.sh; ' + code], { cwd, env: f.env, encoding: 'utf8' });
}
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('Listenality adoption adapter', () => {
  it('preserves existing resource formulas, env location and queue isolation', () => {
    const f = fixture();
    const result = shell(f, 'agent_config_validate; agent_db_name 0; agent_db_name 3; agent_web_port 3; agent_metro_port 3; agent_boss_schema 0; agent_boss_schema 3; printf "%s\\n" "$AGENT_PG_USER" "$AGENT_INHERITED_QUEUE_SCHEMA"; agent_env_path "$PWD"');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['music_analytics_dev', 'music_analytics_a3', '3300', '8381', 'pgboss', 'pgboss_a3', 'tracker', 'pgboss', `${f.repo}/apps/web/.env`]);
    expect(readFileSync(path.join(f.repo, '.agent-slots.conf'), 'utf8')).toBe(config);
    expect(existsSync(path.join(f.repo, 'CLAUDE.md'))).toBe(false);
  });

  it('retains project simulator helpers and their library APIs through managed wrappers', () => {
    const f = fixture();
    for (const helper of ['sim-up', 'sim-down']) {
      expect(readFileSync(path.join(f.repo, `scripts/${helper}.sh`), 'utf8')).not.toContain('managed wrapper');
      const r = spawnSync('bash', [`scripts/${helper}.sh`], { cwd: f.repo, env: f.env, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    }
    expect(existsSync(f.env.MOCK_LOG)).toBe(false);
  });

  it('provisions code tier with copied dependencies and Prisma generation, without runtime resources', () => {
    const f = fixture(), wt = path.join(f.base, 'ma-code');
    mkdirSync(path.join(f.repo, 'node_modules'));
    writeFileSync(path.join(f.repo, 'node_modules/fixture-package'), 'original dependency\n');
    execFileSync('git', ['worktree', 'add', '-qb', 'feat/code', wt], { cwd: f.repo });
    const r = spawnSync('bash', ['scripts/agent-slots', 'attach', '--worktree', wt, '--prepare'], { cwd: f.repo, env: f.env, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(statSync(path.join(wt, 'node_modules')).isDirectory()).toBe(true);
    expect(readFileSync(path.join(wt, 'node_modules/fixture-package'), 'utf8')).toBe('original dependency\n');
    writeFileSync(path.join(wt, 'node_modules/fixture-package'), 'clone dependency\n');
    expect(readFileSync(path.join(f.repo, 'node_modules/fixture-package'), 'utf8')).toBe('original dependency\n');
    expect(existsSync(path.join(wt, 'apps/web/.env'))).toBe(false);
    expect(existsSync(path.join(wt, 'docs/plans'))).toBe(false);
    expect(readFileSync(f.env.MOCK_LOG, 'utf8')).toBe(`${wt}/apps/web|prisma generate\n`);
    for (const command of ['web', 'mobile']) {
      const denied = spawnSync('bash', ['scripts/agent-slots', 'start', command, '--worktree', wt], { cwd: wt, env: f.env, encoding: 'utf8' });
      expect(denied.status).toBe(1);
      expect(denied.stderr).toContain('attach this worktree');
    }
    expect(readFileSync(f.env.MOCK_LOG, 'utf8')).toBe(`${wt}/apps/web|prisma generate\n`);
  });

  it('starts Next and Expo hooks on explicit ports with forwarded arguments, using mocks', () => {
    const f = fixture();
    const web = shell(f, 'agent_start_web "$PWD" 3300 --hostname 127.0.0.1');
    expect(web.status, web.stderr).toBe(0);
    const mobile = shell(f, 'agent_start_mobile "$PWD" 8381 --offline');
    expect(mobile.status, mobile.stderr).toBe(0);
    expect(readFileSync(f.env.MOCK_LOG, 'utf8')).toBe(`${f.repo}/apps/web|next dev -p 3300 --hostname 127.0.0.1\n${f.repo}/apps/mobile|expo start --port 8381 --offline\n`);
  });
});
