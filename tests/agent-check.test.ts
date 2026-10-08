import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const SCRIPT = path.resolve(__dirname, '../scripts/agent-check.sh');
const BASH = '/bin/bash';

function fixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'agent-check-'));
  const repo = path.join(base, 'repo');
  const bin = path.join(base, 'bin');
  const coordination = path.join(base, 'coordination');
  mkdirSync(repo);
  mkdirSync(bin);
  mkdirSync(coordination);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'AgentSlots Test');
  git('config', 'user.email', 'fixture@example.com');
  writeFileSync(path.join(repo, '.gitignore'), '.agent\n');
  writeFileSync(path.join(repo, '.agent-slots.conf'), [
    'AGENT_PROJECT_SLUG=fixture',
    'AGENT_PG_USER=fixture_role',
    `AGENT_SIM_LOCK='${coordination}/simulator.lock'`,
  ].join('\n'));
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  const stub = (name: string, code: string) => writeFileSync(path.join(bin, name),
    `#!/bin/bash\nprintf '%s\\n' '${name}' >> "$CHECK_LOG"\n${code}\n`, { mode: 0o755 });
  stub('ps', 'printf "%s\\n" "${PS_OUTPUT-Mon Oct 7 12:00:00 2026}"; exit "${PS_STATUS:-0}"');
  stub('lsof', 'printf "%s\\n" "${LSOF_OUTPUT-n/fixture}"; exit "${LSOF_STATUS:-0}"');
  stub('psql', 'printf "%s\\n" "$*" >> "$CHECK_LOG"; printf "%s\\n" "${PG_OUTPUT-ready}"; exit "${PG_STATUS:-0}"');
  for (const tool of ['createdb', 'dropdb', 'pg_dump']) stub(tool, 'exit 99');
  stub('xcrun', 'printf "%s\\n" "$*" >> "$CHECK_LOG"; printf "%s\\n" "$SIM_OUTPUT"; exit "${SIM_STATUS:-0}"');
  // Use Python's parser to fixture jq's JSON/availability contract without requiring Xcode/jq.
  stub('jq', `python3 -c 'import json,sys
try:
    data=json.load(sys.stdin)["devices"]
    valid=isinstance(data,dict)
    if "length" in sys.argv[1]:
        valid=valid and any(d.get("isAvailable") is True for group in data.values() for d in group)
    sys.exit(0 if valid else 1)
except (ValueError,KeyError,TypeError,AttributeError):
    sys.exit(1)' "$*"`);
  const log = path.join(base, 'commands.log');
  writeFileSync(log, '');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: base,
    AGENT_CONFIG: path.join(repo, '.agent-slots.conf'),
    AGENT_REPO_ROOT: repo,
    AGENTKEEL_HOME: path.join(base, 'agentkeel'),
    CHECK_LOG: log,
    PGHOST: '', PGHOSTADDR: '', PGSERVICE: '', SIM_OUTPUT: '{}',
  };
  const run = (args: string[] = [], overrides: Record<string, string> = {}) => spawnSync(BASH, [SCRIPT, ...args], {
    cwd: repo, env: { ...env, ...overrides }, encoding: 'utf8',
  });
  return {
    repo, coordination, stub, run, git,
    log: () => readFileSync(log, 'utf8'),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

describe('agent-check capability preflight', () => {
  it('proves runtime prerequisites without invoking mutators, reading secrets, or leaving probe files', () => {
    const f = fixture();
    try {
      const before = f.git('status', '--porcelain');
      const result = f.run([], { DATABASE_URL: 'postgresql://secret:password@remote.example/prod' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('local PostgreSQL role ready');
      expect(result.stdout + result.stderr + f.log()).not.toMatch(/secret|password|remote\.example/);
      expect(f.log()).toContain('-U fixture_role -d postgres');
      expect(f.log()).not.toMatch(/createdb\n|dropdb\n|pg_dump\n|xcrun/);
      expect(readdirSync(f.coordination)).toEqual([]);
      expect(f.git('status', '--porcelain')).toBe(before);
    } finally { f.cleanup(); }
  });

  it('code mode skips PostgreSQL, process and simulator probes', () => {
    const f = fixture();
    try {
      const result = f.run(['--code'], { PS_STATUS: '1', PG_STATUS: '1' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('code prerequisites ready');
      expect(f.log()).toBe('');
      expect(readdirSync(f.coordination)).toEqual([]);
    } finally { f.cleanup(); }
  });

  it.each([
    [{ PS_STATUS: '1' }, 'ps process identity is unavailable'],
    [{ PS_OUTPUT: '' }, 'ps returned no process identity'],
    [{ LSOF_STATUS: '1' }, 'lsof process identity is unavailable'],
    [{ LSOF_OUTPUT: '' }, 'lsof returned no usable process directory'],
    [{ PG_STATUS: '2' }, 'local PostgreSQL connection failed'],
    [{ PG_OUTPUT: '' }, 'no usable role result'],
    [{ PG_OUTPUT: 'no-createdb' }, 'needs CREATEDB'],
  ])('refuses failed or empty capability results: %j', (override, message) => {
    const f = fixture();
    try {
      const result = f.run([], override as Record<string, string>);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
      expect(readdirSync(f.coordination)).toEqual([]);
    } finally { f.cleanup(); }
  });

  it('distinguishes missing tools from a host policy refusal', () => {
    const f = fixture();
    try {
      writeFileSync(path.join(f.repo, '.agent-slots.conf'),
        `AGENT_SIM_LOCK='${f.coordination}/simulator.lock'\ncommand() { [ "$2" != lsof ] && builtin command "$@"; }\n`);
      const result = f.run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('missing dependency: lsof');
      expect(result.stderr).not.toContain('sandbox');
    } finally { f.cleanup(); }
  });

  it('refuses denied coordination writes before runtime probes', () => {
    const f = fixture();
    try {
      f.stub('mktemp', 'echo "Operation not permitted" >&2; exit 1');
      const result = f.run(['--code']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('coordination write denied');
      expect(result.stderr).toContain('host sandbox');
      expect(readdirSync(f.coordination)).toEqual([]);
    } finally { f.cleanup(); }
  });

  it('initializes only the missing configured coordination parent', () => {
    const f = fixture();
    try {
      rmSync(f.coordination, { recursive: true });
      const result = f.run(['--code']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('configured coordination directory initialized');
      expect(readdirSync(f.coordination)).toEqual([]);
      expect(f.log()).toBe('');
    } finally { f.cleanup(); }
  });

  it('refuses a sandbox denial while initializing coordination', () => {
    const f = fixture();
    try {
      rmSync(f.coordination, { recursive: true });
      f.stub('mkdir', 'exit 1');
      const result = f.run(['--code']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('coordination directory creation denied');
      expect(result.stderr).toContain('host sandbox');
    } finally { f.cleanup(); }
  });

  it('refuses missing Git prerequisites and remote connection overrides', () => {
    const f = fixture();
    try {
      f.git('config', 'user.email', '');
      expect(f.run(['--code']).stderr).toContain('empty Git configuration: user.email');
      f.git('config', 'user.email', 'fixture@example.com');
      expect(f.run([], { PGHOST: 'production.example' }).stderr).toContain('PGHOST must identify local PostgreSQL');
      expect(f.run([], { PGSERVICE: 'production' }).stderr).toContain('PGSERVICE is not supported');
      expect(f.log()).not.toContain('psql');
    } finally { f.cleanup(); }
  });

  it('checks available simulator devices without booting', () => {
    const f = fixture();
    try {
      const result = f.run(['--simulator'], { SIM_OUTPUT: '{"devices":{"runtime":[{"isAvailable":true}]}}' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('CoreSimulator device service ready');
      expect(f.log()).toContain('simctl list devices --json');
      expect(f.log()).not.toContain('boot');
    } finally { f.cleanup(); }
  });

  it.each([
    [{ SIM_STATUS: '1', SIM_OUTPUT: '{"devices":{}}' }, 'CoreSimulator service access failed'],
    [{ SIM_OUTPUT: '' }, 'no valid device list'],
    [{ SIM_OUTPUT: '{"devices":{}}' }, 'no available simulator device'],
    [{ SIM_OUTPUT: '{"devices":{"runtime":[{"isAvailable":false}]}}' }, 'no available simulator device'],
  ])('refuses unusable simulator results: %j', (override, message) => {
    const f = fixture();
    try {
      const result = f.run(['--simulator'], override as Record<string, string>);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
    } finally { f.cleanup(); }
  });

  it('returns usage status for unknown or incompatible options', () => {
    const f = fixture();
    try {
      expect(f.run(['--unexpected']).status).toBe(2);
      expect(f.run(['--code', '--simulator']).status).toBe(2);
      expect(f.log()).toBe('');
    } finally { f.cleanup(); }
  });
});
