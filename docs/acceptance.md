# Acceptance results

## Version 0.2.0

Runtime revision `dbc09195e649fac9664439ab47cbfb14642efdc1`, verified 2026-10-08.
Documentation-only follow-ups do not change these tested runtime bytes.

| Check | Result |
|---|---|
| Automated checks | 134 tests in 11 files pass, plus Bash syntax, ShellCheck and TypeScript. [CI passes](https://github.com/hishamalward/agentslots/actions/runs/37725849192). |
| Onboarding | Installer fixtures cover policy preservation, coordination-directory grants, preview/apply, custom paths, and uninstall restoration. Capability checks cover local PostgreSQL, process identity and simulator discovery. |
| Resource ownership | Regression checks cover foreign workspaces, replaced processes, replaced simulator claims, and preservation of unmerged or dirty code. |
| Two-slot demo | Real local PostgreSQL databases and HTTP servers: both slots answer, stopping one leaves the other running, and both databases and worktrees are removed at the end. `docs/demo.gif` records this 0.2 runtime. |
| Live hosts | Code-tier and actual Listenality runtime cycles passed in real Claude Code and Codex sessions with normal hook trust; execution modes are stated below. |

### Listenality runtime acceptance

The adoption uses a disposable copy of Listenality and its actual Next, Expo and simulator
scripts. AgentSlots owns resources; the app owns its fixtures and launch sequence. No production
service or shared worktree is used for these checks.

Both hosts passed the same cycle on 2026-10-08:

1. Provision a sibling worktree and local PostgreSQL slot; run the simulator capability check.
2. Start Next and receive HTTP 200 with `db: true` from `/api/health`.
3. Start Metro, acquire and boot the exact locked device, launch the installed app, and capture
   its rendered Taste screen after bundle completion.
4. Run `sim-down`, `agent-stop`, and `agent-down`; verify free ports, a shut-down device, no lock,
   and absence of the task database and worktree.

Claude Code 2.1.293 used its ordinary host execution. Codex used an explicitly authorized,
per-session `:danger-full-access` profile; normal AgentKeel hooks and saved trust stayed enabled.
No global permission setting changed. These passes do **not** establish restricted-sandbox support.

Both screenshots show the app's “Developing your taste” loading state, without a red error
screen; Claude also showed a development-warning toast. Full data loading and product journeys
were not tested. The first Claude attempt ran out of disk space and was interrupted; its resources
were cleaned up before the successful confirmation. All acceptance runtime resources are released.
The health endpoint's LLM field checks configuration locally, not by calling an LLM.

### Execution modes

Ordinary macOS host access supports the required PostgreSQL, process inspection and simulator
operations. Run `scripts/agent-check.sh` (or `--simulator`) in the session that will do the work.
The installer configures AgentKeel's coordination-directory grant; it does not change host sandbox
permissions or grant task authorization.

The tested restricted profiles are **unsupported for the full runtime loop**. Earlier probes
found PostgreSQL blocked on both hosts. After a local-network grant, Codex could reach HTTP 200
but could not inspect processes for safe cleanup. CoreSimulator access was also refused in its
restricted profile; Claude's isolated database access remained unresolved. A worktree or writable
directory cannot grant those host services. Explicitly authorized host execution is a separate
mode, never an automatic fallback after refusal.

Earlier fixture checks also passed for AgentKeel clone identity, prelaunch stack attachment,
PostgreSQL provisioning and the queue positive control. Queue code has not changed in this
finishing pass. These checks do not establish sandboxed app or simulator support.

## Historical v0.1 evidence

Everything below this note is preserved from the v0.1.0 acceptance record. It is historical evidence,
including its partial judgments and documented limits, not a current product contract.


The table below preserves the original live acceptance run from the source project. The current
standalone repository also has an automated suite covering resource derivation, configuration,
simulator liveness, pg-boss schedule ownership, provisioning, refusal paths, and rollback. Run it
with `npm run check`; the database-backed positive-control probe remains an explicit
`npm run test:queue` check because it requires disposable PostgreSQL schemas.

## Standalone release verification

On 2026-08-23, commit `932ced6` was verified with the repository's current
`scripts/queue-isolation-check.mjs` against one newly created disposable PostgreSQL database and
two different schemas, `probe_a` and `probe_b`. `npm run test:queue` reported that schema B
consumed zero of schema A's jobs, schema A consumed its own job, and printed both
`ISOLATION PASS` and `CONTROL PASS` with exit status 0. The temporary database was removed after
the run and its absence was verified. Connection details and the generated job identifier are
intentionally not retained.

## Original source-project acceptance

This is the actual acceptance run against the machinery in this repository, on the source
project, reproduced here rather than paraphrased. Every row records the command that was run and
its actual output, not a judgement, except the two rows marked as judged. Ports, branch names,
outputs and exit statuses are reproduced exactly as produced. The only edit is naming: the source
project's database and worktree names are replaced with the ones `.agent-slots.conf.example`
would derive (`your_project_a1`, `your-project-accept-slot-one`), so the evidence reads against
the shipped example configuration rather than against a project this repository no longer
references.

| Check | Pass condition | Result | Evidence |
|---|---|---|---|
| Two slots provisioned on different branches | both boot, 3100 and 3200 both respond | PASS | `agent-up.sh chore/accept-slot-one --stack --handover ...` claimed slot 1 (port 3100), `agent-up.sh chore/accept-slot-two --stack` claimed slot 2 (port 3200). After booting both with `agent-dev.sh`: `curl -s -o /dev/null -w "%{http_code}"` gave `3100 -> 200` and `3200 -> 200`. |
| Databases distinct | writes in slot 1 invisible to slot 2 | PASS | `psql -d your_project_a1 -c "create table _probe(x int); insert into _probe values (1)"` -> `CREATE TABLE` / `INSERT 0 1`. `psql -d your_project_a2 -tAc "select count(*) from _probe"` -> `ERROR: relation "_probe" does not exist`. |
| Non-owner cron | `pgboss_a1.schedule` and `pgboss_a2.schedule` both empty | PASS | `select count(*) from pgboss_a1.schedule` -> `0`; `select count(*) from pgboss_a2.schedule` -> `0`, after the pre-boot drop and a positive control confirmed a running server actually created these schemas. |
| Main untouched | `pgboss.schedule` still has its original rows | PASS | `select count(*) from pgboss.schedule` on the main database -> `10`, both mid-run and again at final teardown. |
| **Queue isolation** | a job enqueued in slot 1 is never consumed by slot 2's server | PASS | Run 1 (one database `your_project_a1`, two schemas `pgboss_a1`/`pgboss_a2`, the load-bearing configuration): `enqueued d74093e2... in A (pgboss_a1)` / `B (pgboss_a2) consumed 0 job(s)` / `A consumed 1 job(s)` / `ISOLATION PASS` / `CONTROL PASS`, exit 0. Run 2 (two full databases): `enqueued d3bee9d4... in A (pgboss_a1)` / `B (pgboss_a2) consumed 0 job(s)` / `A consumed 1 job(s)` / `ISOLATION PASS` / `CONTROL PASS`, exit 0. Run 1 is the one that proves anything: it holds the database constant and varies only `PGBOSS_SCHEMA`, so it could not have passed against the pre-change code with the `schema` option reverted. |
| Simulator lock | slot 2 acquire refused while slot 1 holds it | PASS | `./scripts/sim-lock.sh acquire 1` -> `sim-lock: slot 1 holds the simulator, device AD20BAE1-...`; then `./scripts/sim-lock.sh acquire 2; echo "exit=$?"` -> `sim-lock: REFUSED. Slot 1 holds the simulator (pid 2127, device AD20BAE1-...) for 0 minutes.` / `exit=1`. |
| Stale lock | a lock whose pid is dead is broken automatically, with a message | PASS | Fabricated a lock with a dead pid. `sim-lock.sh status` -> `sim-lock: held by slot 1, pid 1896, device , for 0 minutes` / `sim-lock: holder is DEAD. The next acquire will break this lock.`; the next `acquire 1` -> `sim-lock: BREAKING a stale lock held by slot 1, pid 1896 (process is dead).` |
| Stop keeps state | RAM freed, worktree and database survive | PASS | `agent-stop.sh 1` -> `agent-stop: killing web on port 3100 (pids: 21037 )` / `slot 1 stopped. Worktree and database your_project_a1 survive.`; same for slot 2. After: worktrees still present, database still listed, both ports free. |
| Down destroys | no worktree, no database, no lock, no listening port | PASS | `agent-down.sh 1 --force` -> `agent-down: removing worktree .../your-project-accept-slot-one` / `agent-down: dropping database your_project_a1` / `slot 1 is gone. Nothing survives.`; identical for slots 2 and 3 (orphan fixture). Final check: no matching databases, `git worktree list` back to the original entries. |
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
