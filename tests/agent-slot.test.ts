// scripts/lib/agent-slot.sh is the single contract eight other scripts derive from, so it is
// the one piece of shell in this repo that must not drift. Vitest drives it directly: bats is
// not installed and eight scripts do not justify a new test-framework dependency.
//
// bash 3.2 is the macOS system bash, so the library must avoid associative arrays and mapfile.
// Running it under `bash` here is running it under the same interpreter the scripts use.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import {
  existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync, cpSync, realpathSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts/lib/agent-slot.sh');

/** Source the library in a fresh bash and evaluate one snippet against it. */
function sh(snippet: string): string {
  return execFileSync('bash', ['-c', `set -euo pipefail; . "${LIB}"; ${snippet}`], {
    encoding: 'utf8',
    cwd: REPO,
    // Resource assertions use a fixed project identity, independent of the checkout name.
    env: { ...process.env, AGENT_PROJECT_SLUG: 'agent_slots', AGENT_WORKTREE_PREFIX: 'fixture-' },
  }).trim();
}

/** Same, but for the return code of a predicate rather than its output. */
function ok(snippet: string): boolean {
  try {
    execFileSync('bash', ['-c', `. "${LIB}"; ${snippet}`], { cwd: REPO, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('agent-slot.sh exists and is loadable', () => {
  it('is present and syntactically valid bash', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(() => execFileSync('bash', ['-n', LIB], { stdio: 'ignore' })).not.toThrow();
  });

  it('does not set shell options, which would leak into every caller', () => {
    // A sourced library that runs `set -e` changes the behaviour of the script that sourced it.
    // Each executable sets its own options instead.
    const body = execFileSync('cat', [LIB], { encoding: 'utf8' });
    expect(body).not.toMatch(/^\s*set -/m);
  });
});

describe('slot validation', () => {
  it('accepts 0 through 9', () => {
    for (let n = 0; n <= 9; n++) expect(ok(`agent_slot_valid ${n}`), `slot ${n}`).toBe(true);
  });

  it('rejects 10, negatives, empty and non-numeric', () => {
    for (const bad of ['10', '-1', '', 'x', '1x', '0.5'])
      expect(ok(`agent_slot_valid '${bad}'`), `slot "${bad}"`).toBe(false);
  });
});

describe('resource derivation (spec 4.1 table)', () => {
  it('slot 0 is today, byte for byte', () => {
    expect(sh('agent_db_name 0')).toBe('agent_slots_dev');
    expect(sh('agent_boss_schema 0')).toBe('pgboss');
    expect(sh('agent_web_port 0')).toBe('3000');
    expect(sh('agent_metro_port 0')).toBe('8081');
  });

  it('slots 1 and 2 match the spec table exactly', () => {
    expect(sh('agent_db_name 1')).toBe('agent_slots_a1');
    expect(sh('agent_db_name 2')).toBe('agent_slots_a2');
    expect(sh('agent_boss_schema 1')).toBe('pgboss_a1');
    expect(sh('agent_boss_schema 2')).toBe('pgboss_a2');
    expect(sh('agent_web_port 1')).toBe('3100');
    expect(sh('agent_web_port 2')).toBe('3200');
    expect(sh('agent_metro_port 1')).toBe('8181');
    expect(sh('agent_metro_port 2')).toBe('8281');
  });

  it('every slot 1..9 derives a distinct database, schema and pair of ports', () => {
    const seen = new Set<string>();
    for (let n = 0; n <= 9; n++) {
      for (const fn of ['agent_db_name', 'agent_boss_schema', 'agent_web_port', 'agent_metro_port']) {
        const v = sh(`${fn} ${n}`);
        expect(seen.has(`${fn}:${v}`), `${fn} ${n} collides`).toBe(false);
        seen.add(`${fn}:${v}`);
      }
    }
  });
});

describe('reality probes (read-only, no provisioning)', () => {
  it('finds a database reported by psql', () => {
    expect(ok("psql() { printf '1\\n'; }; agent_db_exists agent_slots_dev")).toBe(true);
  });

  it('does not find a database that does not exist', () => {
    expect(ok('psql() { :; }; agent_db_exists agent_slots_definitely_not_here')).toBe(false);
  });

  it('reports a port with no listener as free', () => {
    // 3900 is slot 9's web port. Nothing in this design binds it during a unit run.
    expect(ok('lsof() { return 1; }; agent_port_busy 3900')).toBe(false);
  });

});

// xcrun is replaced with a shell function for the UDID branches. The liveness predicate cares
// about command output, not a real simulator, so all combinations are safe to test headlessly.
describe('agent_sim_lock_alive', () => {
  function simLockDir(): string {
    return mkdtempSync(path.join(tmpdir(), 'agent-slot-simlock-'));
  }

  function writeLock(dir: string, pid: string, udid = ''): string {
    const file = path.join(dir, 'sim.lock');
    writeFileSync(
      file,
      `SLOT=1\nPID=${pid}\nUDID=${udid}\nACQUIRED=${Math.floor(Date.now() / 1000)}\n`,
    );
    return file;
  }

  it('reads alive for a lock naming a live pid with an empty UDID', () => {
    const dir = simLockDir();
    try {
      // This test process's own pid is guaranteed alive for the duration of this test.
      const lock = writeLock(dir, String(process.pid));
      expect(ok(`agent_sim_lock_alive "${lock}"`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads dead for a lock naming a dead pid with an empty UDID', () => {
    const dir = simLockDir();
    try {
      // A shell that has already printed its own pid and exited: the pid is real but dead by
      // the time this line returns. Same fixture shape as the manual verification in
      // The child shell has exited before the lock is evaluated.
      const deadPid = execFileSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' }).trim();
      const lock = writeLock(dir, deadPid);
      expect(ok(`agent_sim_lock_alive "${lock}"`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads alive only when both the holder pid and named device are alive', () => {
    const dir = simLockDir();
    try {
      const lock = writeLock(dir, String(process.pid), 'BOOTED-DEVICE');
      expect(ok(`xcrun() { printf 'iPhone (BOOTED-DEVICE) (Booted)\\n'; }; agent_sim_lock_alive "${lock}"`))
        .toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads dead for a booted device whose holder pid has exited', () => {
    const dir = simLockDir();
    try {
      const deadPid = execFileSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' }).trim();
      const lock = writeLock(dir, deadPid, 'BOOTED-DEVICE');
      expect(ok(`xcrun() { printf 'iPhone (BOOTED-DEVICE) (Booted)\\n'; }; agent_sim_lock_alive "${lock}"`))
        .toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads dead for a live holder whose named device is no longer booted', () => {
    const dir = simLockDir();
    try {
      const lock = writeLock(dir, String(process.pid), 'STOPPED-DEVICE');
      expect(ok(`xcrun() { :; }; agent_sim_lock_alive "${lock}"`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads dead for a missing lock file', () => {
    const dir = simLockDir();
    const missing = path.join(dir, 'no-such-lock');
    try {
      expect(ok(`agent_sim_lock_alive "${missing}"`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('agent_node_modules_stale', () => {
  function makeDir(): string {
    return mkdtempSync(path.join(tmpdir(), 'agent-slot-nm-'));
  }

  it('reports stale when package-lock.json is newer than the node_modules marker', () => {
    const dir = makeDir();
    try {
      mkdirSync(path.join(dir, 'node_modules'));
      writeFileSync(path.join(dir, 'node_modules/.package-lock.json'), '{}');
      writeFileSync(path.join(dir, 'package-lock.json'), '{}');
      // touch -t, not touch -d: -d is a GNU extension, -t is BSD-portable.
      execFileSync('touch', ['-t', '202001010000', path.join(dir, 'node_modules/.package-lock.json')]);
      execFileSync('touch', ['-t', '202001020000', path.join(dir, 'package-lock.json')]);
      expect(ok(`agent_node_modules_stale "${dir}"`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports current when the node_modules marker is newer than package-lock.json', () => {
    const dir = makeDir();
    try {
      mkdirSync(path.join(dir, 'node_modules'));
      writeFileSync(path.join(dir, 'package-lock.json'), '{}');
      writeFileSync(path.join(dir, 'node_modules/.package-lock.json'), '{}');
      execFileSync('touch', ['-t', '202001010000', path.join(dir, 'package-lock.json')]);
      execFileSync('touch', ['-t', '202001020000', path.join(dir, 'node_modules/.package-lock.json')]);
      expect(ok(`agent_node_modules_stale "${dir}"`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports stale when package-lock.json exists but node_modules has no marker at all', () => {
    const dir = makeDir();
    try {
      writeFileSync(path.join(dir, 'package-lock.json'), '{}');
      expect(ok(`agent_node_modules_stale "${dir}"`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is the guard case: not stale when there is no package-lock.json at all', () => {
    const dir = makeDir();
    try {
      expect(ok(`agent_node_modules_stale "${dir}"`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
