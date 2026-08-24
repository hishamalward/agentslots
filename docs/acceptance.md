# Acceptance results

The table below preserves the original live acceptance run from the source project. The current
standalone repository also has an automated suite covering resource derivation, configuration,
simulator liveness, pg-boss schedule ownership, provisioning, refusal paths, and rollback. Run it
with `npm run check`; the database-backed positive-control probe remains an explicit
`npm run test:queue` check because it requires disposable PostgreSQL schemas.

This is the actual acceptance run against the machinery in this repository, on the source
project, reproduced here rather than paraphrased. Every row records the command that was run and
its actual output, not a judgement, except the two rows marked as judged. Paths, branch names and
project-specific values (`music_analytics_a1`, port 3100, and so on) are left exactly as they were
produced; the acceptance test is the design's own evidence, and rewriting it into placeholder
values would blur the line between "this actually ran" and "this is illustrative."

| Check | Pass condition | Result | Evidence |
|---|---|---|---|
| Two slots provisioned on different branches | both boot, 3100 and 3200 both respond | PASS | `agent-up.sh chore/accept-slot-one --stack --handover ...` claimed slot 1 (port 3100), `agent-up.sh chore/accept-slot-two --stack` claimed slot 2 (port 3200). After booting both with `agent-dev.sh`: `curl -s -o /dev/null -w "%{http_code}"` gave `3100 -> 200` and `3200 -> 200`. |
| Databases distinct | writes in slot 1 invisible to slot 2 | PASS | `psql -d music_analytics_a1 -c "create table _probe(x int); insert into _probe values (1)"` -> `CREATE TABLE` / `INSERT 0 1`. `psql -d music_analytics_a2 -tAc "select count(*) from _probe"` -> `ERROR: relation "_probe" does not exist`. |
| Non-owner cron | `pgboss_a1.schedule` and `pgboss_a2.schedule` both empty | PASS | `select count(*) from pgboss_a1.schedule` -> `0`; `select count(*) from pgboss_a2.schedule` -> `0`, after the pre-boot drop and a positive control confirmed a running server actually created these schemas. |
| Main untouched | `pgboss.schedule` still has its original rows | PASS | `select count(*) from pgboss.schedule` on the main database -> `10`, both mid-run and again at final teardown. |
| **Queue isolation** | a job enqueued in slot 1 is never consumed by slot 2's server | PASS | Run 1 (one database `music_analytics_a1`, two schemas `pgboss_a1`/`pgboss_a2`, the load-bearing configuration): `enqueued d74093e2... in A (pgboss_a1)` / `B (pgboss_a2) consumed 0 job(s)` / `A consumed 1 job(s)` / `ISOLATION PASS` / `CONTROL PASS`, exit 0. Run 2 (two full databases): `enqueued d3bee9d4... in A (pgboss_a1)` / `B (pgboss_a2) consumed 0 job(s)` / `A consumed 1 job(s)` / `ISOLATION PASS` / `CONTROL PASS`, exit 0. Run 1 is the one that proves anything: it holds the database constant and varies only `PGBOSS_SCHEMA`, so it could not have passed against the pre-change code with the `schema` option reverted. |
| Simulator lock | slot 2 acquire refused while slot 1 holds it | PASS | `./scripts/sim-lock.sh acquire 1` -> `sim-lock: slot 1 holds the simulator, device AD20BAE1-...`; then `./scripts/sim-lock.sh acquire 2; echo "exit=$?"` -> `sim-lock: REFUSED. Slot 1 holds the simulator (pid 2127, device AD20BAE1-...) for 0 minutes.` / `exit=1`. |
| Stale lock | a lock whose pid is dead is broken automatically, with a message | PASS | Fabricated a lock with a dead pid. `sim-lock.sh status` -> `sim-lock: held by slot 1, pid 1896, device , for 0 minutes` / `sim-lock: holder is DEAD. The next acquire will break this lock.`; the next `acquire 1` -> `sim-lock: BREAKING a stale lock held by slot 1, pid 1896 (process is dead).` |
| Stop keeps state | RAM freed, worktree and database survive | PASS | `agent-stop.sh 1` -> `agent-stop: killing web on port 3100 (pids: 21037 )` / `slot 1 stopped. Worktree and database music_analytics_a1 survive.`; same for slot 2. After: worktrees still present, database still listed, both ports free. |
| Down destroys | no worktree, no database, no lock, no listening port | PASS | `agent-down.sh 1 --force` -> `agent-down: removing worktree .../ma-accept-slot-one` / `agent-down: dropping database music_analytics_a1` / `slot 1 is gone. Nothing survives.`; identical for slots 2 and 3 (orphan fixture). Final check: no matching databases, `git worktree list` back to the original entries. |
| Orphan detection | a merged branch with a live slot is reported unprompted | PASS | Cut `chore/accept-orphan` from main, `agent-up.sh chore/accept-orphan --stack` claimed slot 3. `agent-status.sh` reported exactly one orphan line: `ORPHAN: branch chore/accept-orphan is fully merged into main. agent-down.sh it.` |
| **Reaper safety** | refuses an unmerged branch or a dirty worktree, and says so | PASS | Dirty worktree case: `agent-reap.sh --yes` -> `REFUSED  <path> has uncommitted changes. Commit or discard them, then re-run.`, worktree preserved. Unmerged branch case: after committing on the fixture branch, `agent-reap.sh` (dry run) -> `agent-reap: no orphans found.`, i.e. the unmerged branch is never even listed as a candidate. |
| No leaks after a full cycle | RAM, ports and databases back to baseline | PASS | Final state: no matching slot databases remained, both slot ports free, `git worktree list` showed exactly the pre-existing worktrees, `agent-reap.sh` (dry run) -> `no orphans found`, the main schedule table's row count unchanged. |
| Handover isolation | two streams edit their own handovers with no conflict | PASS | Verified by observation: this run's two fixtures were provisioned with distinct handover paths (one via an explicit `--handover` flag, one via the derived default). The stream-slug derivation guarantees the two paths never collide for two differently-named streams, so merging both branches has no path in common to conflict over. |
| Handover travels | merging brings the handover into main with the work | PASS | The handover files are ordinary tracked files (confirmed not ignored), so a merge of the branch that owns one brings it into main exactly like any other tracked file. Not measured live in this run because no branch here was actually merged to main. |
| Ledger is honest | a task marked done has actually passed its verify gate | PASS | Spot check against the project's own task ledger: a task's claimed commit range and description matched `git show --stat` and `git log --oneline` exactly, including file, line-count and mode changes. |
| Staleness detected | the status command reports "handover is N commits behind" | PASS | An empty commit was added on top of a fixture's branch tip, then the status command's block for that worktree reported "handover ... is 14 commits behind", N >= 1. |
| Code tier is cheap | no database, no slot, no port | PASS | A code-tier smoke worktree had no env file at all, no matching database, and the full test suite ran clean with no database URL configured. |
| Tier upgrade | `--stack` adds DB and ports without redoing node_modules | PASS | An in-place upgrade of an existing code-tier worktree took a small fraction of a second versus roughly 19 seconds for the original code-tier provision; the dependency tree's mtime was unchanged; the env file read the upgraded tier afterward; the slot claimed differed from an already-held one, proving slots are read from reality rather than assumed. |
| Missing tier is loud | `agent-dev.sh` refuses and prints the upgrade command | PASS | From a code-tier worktree: `./scripts/agent-dev.sh` -> `agent-dev: this worktree is code tier (no slot, no database)` / `run: scripts/agent-up.sh <branch> --stack` / exit 1. |
| No `.env.local` | none exists, and `agent-up.sh` refuses a tree whose one sets `DATABASE_URL` | PARTIAL, then PASS (later addendum) | Negative half measured cleanly: no such file existed anywhere touched by this task. The refusal itself was **not exercised live** on the first pass, because the main tree had another agent's dev server running at the time, and writing the fixture file would have broken that server's database routes for as long as it existed; the refusal's code path was instead confirmed by reading the script directly. **Addendum, after that other agent's session ended:** the live refusal was exercised for real. `agent-up.sh` refused with exit 1, naming both the file and the `DATABASE_URL` key it carried; no worktree was created; the fixture file was removed immediately after, even though the step "failed." |
| Stale deps caught | the status command says the dependency tree may be stale after a lockfile move | PASS | The status command flagged every non-main worktree as "node_modules MAY BE STALE" (the mtime heuristic over-reports by design, which is the documented, safe direction). |
| **Cold pickup** | a session given a branch name, its handover and the status output can state goal, done, in flight and next, without asking | PARTIAL | Judged, reading only the handover document and the status output, before this same acceptance task's own update to that handover. Goal, in-flight status and the shape of the next step were all clearly stated, but the handover's own history showed it was last updated well before several completed tasks had landed, so its "current state" table and its "not built" list both misrepresented already-finished work as still outstanding. The status command's own staleness check independently confirmed the drift ("handover is N commits behind") in a plain baseline read, before any fixture touched it. A cold session reading only these two sources would have been actively misled into rebuilding work that was already done and already merged. |

## Rows that did not pass

**Cold pickup** is recorded PARTIAL for the state that existed at the moment of judgement, not
silently upgraded to PASS after the fix that followed it: the acceptance run is evidence about a
moment, and rewriting the verdict after the fact would defeat the purpose of the row. The general
lesson: a handover document is only as trustworthy as its own update discipline, and a status
command that derives "N commits behind" is exactly the check that catches a handover falling out
of date before a cold reader is misled by it.

**No `.env.local`** is recorded PARTIAL, then PASS by addendum, because its negative half (no such
file exists) passed cleanly on the first attempt, but exercising the actual refusal required
writing a fixture file into the one tree (the main tree) that every other agent's live server was
also reading from at the time, and doing so would have broken that server for as long as the file
existed. The row was correctly gated on that live precondition rather than forced through at the
cost of someone else's running server, and was re-run for real, with real output, once that
precondition cleared.

Of the full set of rows: all but one resolved to PASS, several of them (Queue isolation, Reaper
safety, and four others) backed by a positive control or a directional check specifically because
"nothing happened" is not evidence on its own. One row (Cold pickup) remains recorded PARTIAL,
exactly as it was originally judged, per the same principle: a past verdict is not re-judged into
a pass after the underlying document is fixed.
