import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SOURCE = path.resolve(__dirname, '..');
const PYTHON = execFileSync('which', ['python3'], { encoding: 'utf8' }).trim();
const shquote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";

describe('attach allocation ownership and rollback', () => {
  let base: string, main: string, wt: string, bin: string, dbState: string, dbLog: string, psqlLog: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'slots-attach-'));
    main = path.join(base, 'main'); wt = path.join(base, 'task'); bin = path.join(base, 'bin');
    dbState = path.join(base, 'db-state'); dbLog = path.join(base, 'db-log'); psqlLog = path.join(base, 'psql-log');
    mkdirSync(main); mkdirSync(bin);
    git(base, 'init', '-q', '-b', 'main', main);
    git(main, 'config', 'user.name', 'fixture'); git(main, 'config', 'user.email', 'fixture@example.invalid');
    writeFileSync(path.join(main, '.gitignore'), '.env\n');
    writeFileSync(path.join(main, '.agent-slots.conf'), [
      'AGENT_PROJECT_SLUG=fixture', 'AGENT_DATABASE_MAIN=fixture_dev', 'AGENT_DATABASE_PREFIX=fixture_a',
      'AGENT_PG_USER=fixture',
      'AGENT_LEASE_SECONDS=3600',
      'AGENT_SLOT_MAX=2', 'AGENT_APP_DIR=.', 'AGENT_ENV_FILE=.env', 'AGENT_CONFLICT_ENV_FILE=.env.local', 'AGENT_PUBLIC_URL_KEY=APP_URL',
      'AGENT_PUBLIC_URL_FORMAT=http://localhost:%s', 'AGENT_SIM_LOCK=' + path.join(base, 'sim.lock'),
    ].join('\n') + '\n');
    execFileSync('cp', ['-R', path.join(SOURCE, 'scripts'), main]);
    execFileSync('git', ['-C', main, 'add', '.']);
    execFileSync('git', ['-C', main, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
    execFileSync('git', ['-C', main, 'worktree', 'add', '-qb', 'feat/task', wt]);
    mock('psql', [
      '[ -z "$PGHOSTADDR" ] || exit 90',
      'printf "psql %s\\n" "$*" >> "$MOCK_PSQL_LOG"',
      'case "$*" in',
      '  *"select oid from pg_database"*) printf "%s\\n" "${MOCK_DB_OID:-42}" ;;',
      '  *"pg_database"*"fixture_dev"*) printf "1\\n" ;;',
      '  *"pg_database"*"fixture_a1"*) [ -f "$MOCK_DB_STATE" ] && printf "1\\n" || true ;;',
      '  *"pg_database"*"fixture_a2"*) [ -f "$MOCK_DB_STATE_2" ] && printf "1\\n" || true ;;',
      '  *"select 1"*) printf "1\\n" ;;',
      '  *) cat >/dev/null || true ;;',
      'esac',
    ].join('\n'));
    mock('createdb', [
      '[ -z "$PGHOSTADDR" ] || exit 90',
      'printf "createdb %s\\n" "$7" >> "$MOCK_DB_LOG"',
      '[ ! -f "$MOCK_DB_STATE" ] || exit 1',
      'touch "$MOCK_DB_STATE"',
      'if [ -n "$MOCK_CREATEDB_STATUS" ]; then exit "$MOCK_CREATEDB_STATUS"; fi',
    ].join('\n'));
    mock('dropdb', '[ -z "$PGHOSTADDR" ] || exit 90; printf "dropdb %s\\n" "$7" >> "$MOCK_DB_LOG"; rm -f "$MOCK_DB_STATE"');
    mock('pg_dump', 'printf -- "-- fixture dump\\n"');
    mock('lsof', 'exit 1');
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function mock(name: string, body: string) {
    const file = path.join(bin, name);
    writeFileSync(file, '#!/usr/bin/env bash\n' + body + '\n');
    chmodSync(file, 0o755);
  }
  function run(args: string[], extra: Record<string, string> = {}, cwd = main) {
    return spawnSync(path.join(main, 'scripts/agent-slots'), ['attach', '--worktree', wt, ...args], {
      cwd, encoding: 'utf8',
      env: { ...process.env, PATH: bin + ':' + process.env.PATH, MOCK_DB_STATE: dbState, MOCK_DB_LOG: dbLog, MOCK_PSQL_LOG: psqlLog, ...extra },
    });
  }
  function release(extra: Record<string, string> = {}) {
    return spawnSync(path.join(main, 'scripts/agent-slots'), ['release', '--worktree', wt], {
      cwd: main, encoding: 'utf8',
      env: { ...process.env, PATH: bin + ':' + process.env.PATH, MOCK_DB_STATE: dbState, MOCK_DB_LOG: dbLog, MOCK_PSQL_LOG: psqlLog, ...extra },
    });
  }
  function marker(): any {
    const raw = git(wt, 'rev-parse', '--git-path', 'agent-runtime.json');
    return JSON.parse(readFileSync(path.isAbsolute(raw) ? raw : path.join(wt, raw), 'utf8'));
  }

  it('allocates only requested resources when attaching web without a database', () => {
    writeFileSync(path.join(wt, '.env'), 'KEEP=yes\nDATABASE_URL=leave-me\n');
    const result = run(['--service', 'web']);
    expect(result.status, result.stderr).toBe(0);
    const env = readFileSync(path.join(wt, '.env'), 'utf8');
    expect(env).toContain('DATABASE_URL=leave-me');
    expect(env).toContain('APP_URL="http://localhost:3100"');
    expect(existsSync(dbLog)).toBe(false);
    expect(existsSync(psqlLog)).toBe(false);
    expect(marker().resources).toMatchObject({ slot: 1, web_port: 3100 });
    expect(marker().lease_seconds).toBe(3600);
    expect(marker().resources).not.toHaveProperty('db');
    expect(marker().resources).not.toHaveProperty('metro_port');
  });

  it('attaches mobile from outside Git without invoking database tools', () => {
    const result = run(['--service', 'mobile'], {}, base);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(psqlLog)).toBe(false);
    expect(existsSync(dbLog)).toBe(false);
    expect(marker().resources).toMatchObject({ slot: 1, metro_port: 8181 });
    expect(marker().resources).not.toHaveProperty('db');
  });

  it('runs the prepare hook in the primary worktree and then returns to the target worktree', () => {
    const hookLog = path.join(base, 'prepare.log');
    writeFileSync(path.join(main, '.agent-slots.conf'), readFileSync(path.join(main, '.agent-slots.conf'), 'utf8') +
      `\nagent_prepare_worktree() { printf '%s|%s|%s\\n' "$PWD" "$1" "$2" > ${shquote(hookLog)}; }\n`);
    const result = run(['--prepare'], {}, base);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(hookLog, 'utf8')).toBe(`${realpathSync(main)}|${realpathSync(main)}|${realpathSync(wt)}\n`);
  });

  it('refuses a remote source URL before environment or database mutation', () => {
    writeFileSync(path.join(main, '.env'), 'DATABASE_URL=postgresql://fixture@remote.example/fixture_dev\n');
    writeFileSync(path.join(wt, '.env'), 'KEEP=untouched\n');
    const result = run(['--service', 'db']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('explicit local PostgreSQL endpoint');
    expect(readFileSync(path.join(wt, '.env'), 'utf8')).toBe('KEEP=untouched\n');
    expect(existsSync(dbLog)).toBe(false);
    const raw = git(wt, 'rev-parse', '--git-path', 'agent-runtime.json');
    expect(existsSync(path.isAbsolute(raw) ? raw : path.join(wt, raw))).toBe(false);
  });

  it('refuses a worktree-local env override that would bypass the isolated database URL', () => {
    writeFileSync(path.join(main, '.env'), 'DATABASE_URL=postgresql://fixture@localhost:5432/fixture_dev\n');
    writeFileSync(path.join(wt, '.env.local'), 'DATABASE_URL=postgresql://fixture@localhost/fixture_dev\n');
    const result = run(['--service', 'db']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('.env.local sets DATABASE_URL');
    expect(existsSync(psqlLog)).toBe(false);
    expect(readFileSync(path.join(wt, '.env.local'), 'utf8')).toContain('DATABASE_URL=');
    const raw = git(wt, 'rev-parse', '--git-path', 'agent-runtime.json');
    expect(existsSync(path.isAbsolute(raw) ? raw : path.join(wt, raw))).toBe(false);
  });

  it('retains an ambiguous database creation claim and never drops that database', () => {
    writeFileSync(path.join(main, '.env'), 'DATABASE_URL=postgresql://fixture@localhost:5432/fixture_dev\n');
    writeFileSync(path.join(wt, '.env'), 'KEEP=untouched\n');
    const result = run(['--service', 'db'], { MOCK_CREATEDB_STATUS: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('outcome is unknown');
    expect(existsSync(dbState)).toBe(true);
    expect(readFileSync(dbLog, 'utf8')).toBe('createdb fixture_a1\n');
    expect(readFileSync(path.join(wt, '.env'), 'utf8')).toBe('KEEP=untouched\n');
    expect(marker().state).toBe('provisioning');
    expect(marker().resources).toMatchObject({ db: 'fixture_a1', db_create_started: true, db_created: false });
    const released = release();
    expect(released.status).not.toBe(0);
    expect(released.stderr).toContain('creation outcome is unknown');
    expect(existsSync(dbState)).toBe(true);
    expect(readFileSync(dbLog, 'utf8')).toBe('createdb fixture_a1\n');
    expect(marker().state).toBe('provisioning');
  });

  it('restores owned environment keys without overwriting a later user edit', () => {
    writeFileSync(path.join(wt, '.env'), 'KEEP=preserved\nAGENT_SLOT=old\nAPP_URL=old\n');
    const wrapper = path.join(bin, 'python3');
    writeFileSync(wrapper, [
      '#!/usr/bin/env bash',
      'if [ "$3" = complete ]; then',
      '  printf "KEEP=preserved\\nAGENT_SLOT=old\\nAPP_URL=http://user-edited\\n" > "$4/.env"',
      '  exit 1',
      'fi',
      'exec ' + shquote(PYTHON) + ' "$@"',
    ].join('\n') + '\n');
    chmodSync(wrapper, 0o755);
    const result = run(['--service', 'web']);
    expect(result.status).not.toBe(0);
    expect(readFileSync(path.join(wt, '.env'), 'utf8')).toBe(
      'KEEP=preserved\nAGENT_SLOT=old\nAPP_URL=http://user-edited\n',
    );
    const raw = git(wt, 'rev-parse', '--git-path', 'agent-runtime.json');
    expect(existsSync(path.isAbsolute(raw) ? raw : path.join(wt, raw))).toBe(false);
  });

  it('preserves a database that appears between free-slot checks and createdb', () => {
    writeFileSync(path.join(main, '.env'), 'DATABASE_URL=postgresql://fixture@localhost:5432/fixture_dev\n');
    mock('psql', [
      '[ -z "$PGHOSTADDR" ] || exit 90',
      'printf "psql %s\\n" "$*" >> "$MOCK_PSQL_LOG"',
      'case "$*" in',
      '  *"pg_database"*"fixture_dev"*) printf "1\\n" ;;',
      '  *"pg_database"*"fixture_a1"*)',
      '    if [ -f "$MOCK_DB_STATE" ]; then printf "1\\n"; else touch "$MOCK_DB_STATE"; fi ;;',
      '  *"pg_database"*"fixture_a2"*) true ;;',
      '  *"select 1"*) printf "1\\n" ;;',
      '  *) cat >/dev/null || true ;;',
      'esac',
    ].join('\n'));
    const result = run(['--service', 'db']);
    expect(result.status).not.toBe(0);
    expect(existsSync(dbState)).toBe(true);
    expect(readFileSync(dbLog, 'utf8')).toBe('createdb fixture_a1\n');
    expect(marker().resources).toMatchObject({ db_create_started: true, db_created: false });
    expect(existsSync(path.join(wt, '.env'))).toBe(false);
  });

  it('drops only the recorded database identity through its original local endpoint', () => {
    writeFileSync(path.join(main, '.env'), 'DATABASE_URL=postgresql://fixture@localhost:5432/fixture_dev\n');
    writeFileSync(path.join(wt, '.env'), 'KEEP=yes\n');
    const attached = run(['--service', 'db']);
    expect(attached.status, attached.stderr).toBe(0);
    expect(marker().resources).toMatchObject({
      db: 'fixture_a1', db_created: true, db_oid: 42,
      db_endpoint: { host: 'localhost', port: 5432, user: 'fixture' },
    });
    const released = release({ PGHOST: 'remote.example', PGHOSTADDR: '203.0.113.5', PGPORT: '6543', AGENT_PG_USER: 'other' });
    expect(released.status, released.stderr).toBe(0);
    expect(existsSync(dbState)).toBe(false);
    expect(readFileSync(dbLog, 'utf8')).toBe('createdb fixture_a1\ndropdb fixture_a1\n');
    expect(readFileSync(psqlLog, 'utf8')).toContain('-h localhost -p 5432 -U fixture -d postgres');
    expect(readFileSync(psqlLog, 'utf8')).not.toContain('remote.example');
    expect(readFileSync(path.join(wt, '.env'), 'utf8')).toBe('KEEP=yes\n');
  });

  it('refuses to drop a same-name database whose OID changed', () => {
    writeFileSync(path.join(main, '.env'), 'DATABASE_URL=postgresql://fixture@localhost:5432/fixture_dev\n');
    const attached = run(['--service', 'db']);
    expect(attached.status, attached.stderr).toBe(0);
    const released = release({ MOCK_DB_OID: '99' });
    expect(released.status).not.toBe(0);
    expect(released.stderr).toContain('different identity');
    expect(existsSync(dbState)).toBe(true);
    expect(readFileSync(dbLog, 'utf8')).toBe('createdb fixture_a1\n');
    expect(marker().resources).toMatchObject({ db_created: true, db_oid: 42 });
  });
});
