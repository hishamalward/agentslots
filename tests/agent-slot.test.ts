// scripts/lib/agent-slot.sh is the single contract eight other scripts derive from, so it is
// the one piece of shell in this repo that must not drift. Vitest drives it directly: bats is
// not installed and eight scripts do not justify a new test-framework dependency.
//
// bash 3.2 is the macOS system bash, so the library must avoid associative arrays and mapfile.
// Running it under `bash` here is running it under the same interpreter the scripts use.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import {
  existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync,
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

describe('branch and stream slugs', () => {
  it('strips the type prefix', () => {
    expect(sh("agent_branch_slug feat/weekly-recap")).toBe('weekly-recap');
    expect(sh("agent_branch_slug docs/multi-agent-isolation-spec")).toBe('multi-agent-isolation-spec');
  });

  it('leaves a bare branch name alone', () => {
    expect(sh("agent_branch_slug phase-4-design-foundation")).toBe('phase-4-design-foundation');
  });

  it('flattens a second slash rather than producing a nested path', () => {
    expect(sh("agent_branch_slug feat/recap/phase-2")).toBe('recap-phase-2');
  });

  it('KEEPS the phase suffix in the branch slug, so two phases get two worktrees', () => {
    expect(sh("agent_branch_slug feat/weekly-recap-p2")).toBe('weekly-recap-p2');
  });

  it('STRIPS the phase suffix in the stream slug, so two phases share one handover', () => {
    expect(sh("agent_stream_slug feat/weekly-recap-p2")).toBe('weekly-recap');
    expect(sh("agent_stream_slug feat/weekly-recap")).toBe('weekly-recap');
  });

  it('does not mistake a trailing word ending in p-digits for a phase suffix', () => {
    expect(sh("agent_stream_slug feat/mp3-import")).toBe('mp3-import');
  });
});

describe('path derivation', () => {
  it('resolves the main worktree, not the current one', () => {
    // This suite may itself be running from a linked worktree. The main root is the first
    // entry of `git worktree list`, which is stable from anywhere.
    const root = sh('agent_main_root');
    expect(path.isAbsolute(root)).toBe(true);
    expect(existsSync(path.join(root, '.git'))).toBe(true);
  });

  it('puts worktrees beside the main root, never nested inside it', () => {
    const root = sh('agent_main_root');
    const wt = sh('agent_worktree_path feat/weekly-recap');
    expect(wt).toBe(path.join(path.dirname(root), 'agent-slots-weekly-recap'));
    expect(wt.startsWith(root + path.sep)).toBe(false);
  });

  it('derives the handover path from the stream slug', () => {
    expect(sh('agent_handover_path feat/weekly-recap-p2')).toBe('docs/plans/weekly-recap-handover.md');
  });

  it('reproduces this worktree, which was provisioned by hand to the same rules', () => {
    const root = sh('agent_main_root');
    expect(sh('agent_worktree_path feat/multi-agent-isolation'))
      .toBe(path.join(path.dirname(root), 'agent-slots-multi-agent-isolation'));
    expect(sh('agent_handover_path feat/multi-agent-isolation'))
      .toBe('docs/plans/multi-agent-isolation-handover.md');
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

  it('returns a slot in 1..9 from next_free_slot', () => {
    expect(sh('psql() { :; }; lsof() { return 1; }; agent_next_free_slot')).toBe('1');
  });

  it('classifies the main worktree as the main tier and slot 0', () => {
    expect(sh('agent_tier_of_worktree "$(agent_main_root)"')).toBe('main');
    expect(sh('agent_slot_of_worktree "$(agent_main_root)"')).toBe('0');
  });

  it('classifies a worktree with no configured env file as code tier with NO slot', () => {
    // A code-tier worktree has no slot at all. That is not slot 0: slot 0 is the main tree,
    // and conflating them is how a code worktree would end up owning the cron schedules.
    const tmp = sh('printf %s "$TMPDIR"') || '/tmp';
    expect(sh(`agent_tier_of_worktree "${tmp}"`)).toBe('code');
    expect(ok(`agent_slot_of_worktree "${tmp}"`)).toBe(false);
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

// This block exists because of a real defect. An earlier draft read keyed .env lines with
// `sed -n 's/^KEY=//{p;q;}'`, which is a GNU extension and a hard syntax error on the BSD sed
// macOS ships. Every slot read-back returned empty, so `$(( 3000 + 100 * SLOT ))` collapsed to
// 3000 and scripts would have targeted the MAIN tree's port. The suite passed anyway, because
// no test ever handed agent_slot_of_worktree an .env that actually contained AGENT_SLOT.
//
// So: build a real stack-tier worktree on disk and read it back. A parser is only tested by
// input it must parse.
describe('reading a stack-tier worktree back off disk', () => {
  function fakeStackWorktree(slot: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'agent-slot-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, '.env'),
      [
        '# a comment line, which must not be mistaken for a key',
        'NEXT_PUBLIC_APP_URL="http://localhost:3100"',
        `AGENT_SLOT=${slot}`,
        'PGBOSS_SCHEMA=pgboss_a' + slot,
        'DATABASE_URL="postgresql://user:pw@localhost:5432/agent_slots_a' + slot + '"',
      ].join('\n') + '\n',
    );
    return dir;
  }

  it('reports stack tier and the exact slot, not an empty string', () => {
    const dir = fakeStackWorktree('7');
    try {
      expect(sh(`agent_tier_of_worktree "${dir}"`)).toBe('stack');
      // The load-bearing assertion. An empty read here is what made every derived port collapse
      // to the main tree's 3000.
      expect(sh(`agent_slot_of_worktree "${dir}"`)).toBe('7');
      expect(sh(`agent_web_port "$(agent_slot_of_worktree "${dir}")"`)).toBe('3700');
      expect(sh(`agent_metro_port "$(agent_slot_of_worktree "${dir}")"`)).toBe('8781');
      expect(sh(`agent_db_name "$(agent_slot_of_worktree "${dir}")"`)).toBe('agent_slots_a7');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the slot even when other keys sit above it', () => {
    // Guards against an implementation that only ever looks at line 1.
    const dir = fakeStackWorktree('2');
    try {
      expect(sh(`agent_slot_of_worktree "${dir}"`)).toBe('2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('every keyed read in EVERY agent script uses BSD-portable sed', () => {
    // `sed -n 's/^KEY=//{p;q;}'` parses under GNU sed and dies under BSD sed with
    // "bad flag in substitute command". macOS is the only platform this design targets, so the
    // GNU-only form is always wrong here. The portable equivalent is `/^KEY=/{s///p;q;}`.
    //
    // Scanning the whole scripts/ tree, not just this library: most keyed reads live in the
    // consumer scripts (DATABASE_URL in agent-up, HANDOVER/SLOT/PID/UDID in agent-status,
    // SLOT in agent-stop, PID in agent-reap). agent-reap's read only executes when a lock file
    // happens to exist, so a GNU form there could ship without ever being run.
    //
    // The pattern must avoid two opposite failure modes, and an earlier draft had BOTH at once:
    //
    //   FALSE POSITIVE: a key class of [A-Za-z0-9_]+ matches the warning comment a few lines up
    //   in agent-slot.sh, which quotes the banned form in order to ban it. The test then fails on
    //   a perfectly correct implementation, making the guard forbid its own explanatory text.
    //
    //   FALSE NEGATIVE: the same class cannot match sim-lock.sh's `sed -n "s/^$1=//{p;q;}"`,
    //   where the key is a shell variable rather than a literal. That was the real offender, and
    //   it survived precisely because the ban only looked for literal keys.
    //
    // So: strip full-line comments first, and accept any key expression up to the `=`.
    const GNU_SED = /s\/\^[^/]*=\/\/\{/;
    const dirs = [path.join(REPO, 'scripts'), path.join(REPO, 'scripts/lib')];
    const offenders: string[] = [];
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith('.sh')) continue;
        const full = path.join(dir, entry);
        if (!statSync(full).isFile()) continue;
        const code = readFileSync(full, 'utf8')
          .split('\n')
          .filter((line) => !/^\s*#/.test(line))
          .join('\n');
        if (GNU_SED.test(code)) offenders.push(path.relative(REPO, full));
      }
    }
    expect(offenders).toEqual([]);
  });
});

// agent_node_modules_stale and agent_handover_behind are load-bearing for a later task's
// agent-status.sh, which calls both on every run, but neither appeared anywhere in this file.
// A future edit to either would break that consumer silently. Real temp dirs and real mtimes,
// no mocks: an mtime heuristic is only tested by actual mtimes.
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

describe('agent_handover_behind', () => {
  // Target REPO, this worktree, not "$(agent_main_root)": the main worktree is shared with other
  // concurrent sessions and can be on a different branch at any moment, which would make this an
  // intermittent failure whose cause is not in this branch. agent_main_root's own resolution
  // behaviour is already covered by the "path derivation" describe block above; reserve it for
  // that, and give agent_handover_behind a fixed target here.
  it('prints a commit count for a handover with real history, without asserting a literal', () => {
    // The literal count grows with every commit on this branch, so only the shape is checked.
    const out = sh(`agent_handover_behind "${REPO}" README.md`);
    expect(out).toMatch(/^\d+$/);
  });

  it('returns non-zero and prints nothing for a path no commit has ever touched', () => {
    let output = '';
    let threw = false;
    try {
      output = execFileSync(
        'bash',
        ['-c', `. "${LIB}"; agent_handover_behind "${REPO}" docs/plans/definitely-not-a-real-handover.md`],
        { encoding: 'utf8', cwd: REPO },
      );
    } catch (e: any) {
      threw = true;
      output = e.stdout ? e.stdout.toString() : '';
    }
    expect(threw).toBe(true);
    expect(output).toBe('');
  });
});

// agent_branch_has_own_commits is the fix for agent-reap.sh's Finding A: `branch --merged main`
// lists any branch that is an ancestor of main INCLUSIVE, so a worktree cut from main with zero
// commits of its own is "fully merged" from the instant it exists, the same shape as a branch
// whose real work already landed. Tip comparison cannot tell the two apart either: a fast-forward
// or merge-commit merge leaves the feature branch's own tip exactly where it was created, in both
// cases. The branch's OWN reflog can: creating the branch writes exactly one entry (its
// creation), every commit made on the branch appends another, and merging it into main (either
// shape) never touches its own ref, only main's.
//
// A throwaway git repo under the OS tmpdir, never the real repo: task 9's own note about not
// provisioning worktrees in the real tree applies here as much as it did there. Built and removed
// by each test in a finally.
describe('agent_branch_has_own_commits (reflog discriminator, Finding A)', () => {
  function initFixtureRepo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'agent-slot-reflog-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: dir });
    return dir;
  }

  it('reads false for a branch freshly cut from main with zero commits of its own', () => {
    const repo = initFixtureRepo();
    const wt = path.join(tmpdir(), `agent-slot-reflog-wt-fresh-${process.pid}`);
    try {
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'fresh-branch', wt, 'main'], { cwd: repo });
      expect(sh(`agent_branch_reflog_count "${repo}" fresh-branch`)).toBe('1');
      expect(ok(`agent_branch_has_own_commits "${repo}" fresh-branch`)).toBe(false);
      // And it IS an ancestor of main, same shape a genuinely-merged branch would have: this is
      // exactly the ambiguity `branch --merged main` alone cannot resolve.
      expect(sh(`git -C "${repo}" branch --merged main --format='%(refname:short)'`)).toContain('fresh-branch');
    } finally {
      rmSync(wt, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reads true for a branch with real commits that was fast-forward merged into main', () => {
    const repo = initFixtureRepo();
    const wt = path.join(tmpdir(), `agent-slot-reflog-wt-ff-${process.pid}`);
    try {
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'ff-branch', wt, 'main'], { cwd: repo });
      execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'commit1'], { cwd: wt });
      execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'commit2'], { cwd: wt });
      execFileSync('git', ['merge', '--ff-only', '-q', 'ff-branch'], { cwd: repo });
      const count = Number(sh(`agent_branch_reflog_count "${repo}" ff-branch`));
      expect(count).toBeGreaterThanOrEqual(2);
      expect(ok(`agent_branch_has_own_commits "${repo}" ff-branch`)).toBe(true);
    } finally {
      rmSync(wt, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reads true for a branch with real commits merged into main via a merge commit (non-ff)', () => {
    const repo = initFixtureRepo();
    const wt = path.join(tmpdir(), `agent-slot-reflog-wt-merge-${process.pid}`);
    try {
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'merge-branch', wt, 'main'], { cwd: repo });
      execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'commit1'], { cwd: wt });
      execFileSync('git', ['merge', '--no-ff', '-q', '-m', 'merge it', 'merge-branch'], { cwd: repo });
      const count = Number(sh(`agent_branch_reflog_count "${repo}" merge-branch`));
      expect(count).toBeGreaterThanOrEqual(2);
      expect(ok(`agent_branch_has_own_commits "${repo}" merge-branch`)).toBe(true);
    } finally {
      rmSync(wt, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reads 0 and false for a branch that does not exist', () => {
    const repo = initFixtureRepo();
    try {
      expect(sh(`agent_branch_reflog_count "${repo}" no-such-branch`)).toBe('0');
      expect(ok(`agent_branch_has_own_commits "${repo}" no-such-branch`)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
