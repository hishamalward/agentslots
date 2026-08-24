# agent-slots

Per-agent isolation for parallel AI coding agents: one integer derives a worktree, a database,
two ports, and a job-queue schema.

**Problem.** A Git worktree isolates files and nothing else. Two agents on two branches still
share one PostgreSQL database, one set of ports, and one job queue. This repository exists
because of a real incident: two dev servers running different code against one pg-boss queue.
The queue handed a scheduled job to the server with the stale handler, which ran it for every
user on the wrong day. The first diagnosis, "a cron schedule got rewritten," was wrong.

**Approach.** One integer, `AGENT_SLOT`, deterministically derives everything a running agent
needs: a sibling worktree, a cloned database, a web port, a bundler port, and a queue schema.
Slot 0 is the original checkout and the only slot allowed to register recurring schedules; every
other slot works jobs but never writes a schedule row. State is derived live from Git, listening
ports, and PostgreSQL, never from a registry file that can drift.

**Result.** Several agents on one Mac, each with its own of everything. The live acceptance run
in [docs/acceptance.md](docs/acceptance.md) provisioned two stacks on ports 3100 and 3200 with
distinct databases, proved a job enqueued in one queue schema is invisible to the other, and tore
both down with nothing left behind.

## Demo

![agent-up, agent-status, and agent-stop across two slots](docs/demo.gif)

Two stack slots provisioned from one checkout, each server answering with its own database, then
slot 1 stopped while slot 2 keeps running. Recorded with the scripts in this repository against a
disposable fixture project and a local PostgreSQL; output is real, lightly trimmed.

## What it protects

| Resource | Isolation |
|---|---|
| Files | Git worktree per branch |
| PostgreSQL data | Database per stack slot |
| Web and bundler processes | Deterministic ports per slot |
| Namespaced job queues | Schema per slot |
| Recurring schedules | Slot 0 is the only owner |
| iOS Simulator or another exclusive device | Atomic, owner-and-device-verified lock |

The scripts are intended for local development. They do not alter production infrastructure.

## Status

Built for and used in one repository on one Mac. It targets the macOS system Bash 3.2 and BSD
userland and has been run only there. Configuration, project hooks, and the test harness were
generalized for this release; the release checklist and what was generalized are in
[PRE-RELEASE.md](PRE-RELEASE.md). This repository covers runtime isolation only; the process side
(spec gates, quality gates, blast-radius guardrails) lives in a separate framework repository that
will be linked here once it is public.

## Requirements

- macOS with the system Bash 3.2 and BSD userland
- Git with worktree support
- `lsof`
- PostgreSQL client tools for stack slots: `psql`, `createdb`, `dropdb`, and `pg_dump`
- Xcode command-line tools and `jq` only when using the simulator lock
- Node.js 22.12 or newer and ShellCheck (`brew install shellcheck`) only for this repository's
  own checks and optional live pg-boss probe

Every executable checks the tools needed by its own mode before trusting their output.

## Install

Copy `scripts/` and `integrations/` into the target project. Then:

1. Copy `.agent-slots.conf.example` to `.agent-slots.conf`.
2. Replace the example database names and project paths.
3. Adapt the setup and server hook functions to the project's frameworks.
4. Commit `.agent-slots.conf`; it should contain no credentials.
5. Add `.agent` to the target project's `.gitignore`.
6. Apply the queue integration when the project runs scheduled background work.

The scripts refuse to provision when `.agent` is not ignored, the configured main branch does not
exist, required tools are absent, or configuration could escape the repository. See
[configuration](docs/configuration.md) and the [quickstart](QUICKSTART.md).

## Use

Create a cheap code-only worktree:

```bash
./scripts/agent-up.sh feat/my-change
```

This creates a sibling worktree, runs the configured setup hook, writes an ignored `.agent`
marker, and creates a commit-ready handover template when one does not already exist. It claims no
database or ports.

Upgrade that worktree to a complete stack when needed:

```bash
./scripts/agent-up.sh feat/my-change --stack
```

The upgrade chooses the lowest free slot, derives its database and ports, rewrites only the
configured slot-owned env keys, clones the main development database, and removes the configured
inherited queue schema before the stack can start.

From inside the worktree:

```bash
./scripts/agent-dev.sh
./scripts/agent-mobile.sh       # only when a mobile/secondary hook is configured
```

Inspect and clean up:

```bash
./scripts/agent-status.sh
./scripts/agent-stop.sh 1       # stop processes; retain worktree and database
./scripts/agent-down.sh 1       # remove worktree and database
./scripts/agent-reap.sh         # safe dry-run for orphans
./scripts/agent-reap.sh --yes   # execute only proven-safe cleanup
```

The reaper refuses live ports, dirty worktrees, unmerged branches, ambiguous reflog history, and
re-provisioned merged branches. It never kills an unidentified listener.

## Queue isolation

Database separation is not enough when divergent servers share a queue. The application must also
construct pg-boss with the slot schema and prevent nonzero slots from registering recurring
schedules. Import the tested helpers in
[integrations/pg-boss](integrations/pg-boss/README.md).

Run the live positive-control probe against two schemas before adopting the integration:

```bash
DATABASE_URL_A='postgresql://localhost/project_dev' \
PGBOSS_SCHEMA_A=pgboss_probe_a \
PGBOSS_SCHEMA_B=pgboss_probe_b \
npm run test:queue
```

Using the same database URL for both clients is the strongest test because only the schema varies.
The probe fails unless client B sees zero jobs and client A can fetch its own job. Details are in
[queue isolation](docs/queue-isolation.md).

## Simulator lock

```bash
./scripts/sim-lock.sh acquire 1
./scripts/sim-lock.sh status
./scripts/sim-lock.sh release 1
```

Acquisition uses an atomic hard-link claim. During boot, the live owner PID protects the claim;
afterward both the owner PID and recorded device must remain alive. A crashed owner therefore
cannot strand a booted simulator, and a stopped device cannot leave a false live lock.

## Verification

```bash
npm ci
npm run check
```

The check runs Bash syntax validation under the macOS system Bash, ShellCheck at warning level,
TypeScript type checking, and the complete Vitest suite. Tests use temporary Git repositories and
mocked simulator output; they do not create development databases, worktrees beside this
repository, or boot a device.

The optional database-backed queue probe is deliberately separate as `npm run test:queue`.
Historical live acceptance evidence from the source project remains in
[docs/acceptance.md](docs/acceptance.md).

## Design

- State is derived live from Git, listening ports, PostgreSQL, and the simulator—not copied into a
  registry file that can drift.
- Intent lives in one tracked handover per stream.
- Missing slot environment variables preserve slot-0 application behavior.
- Destructive cleanup defaults to refusal or dry-run.
- Framework-specific commands are Bash functions in project configuration, never strings sent
  through `eval`.

See the complete [design rationale](docs/design.md) and [debugging lessons](docs/lessons.md).
For whoever owns this next: [docs/learning/how-it-works.html](docs/learning/how-it-works.html) is the tour that lets you
defend every number without opening the code; `docs/design.md` is the contract.

Contributions should follow [CONTRIBUTING.md](CONTRIBUTING.md). Security issues and the trust model
for project configuration are documented in [SECURITY.md](SECURITY.md). Release changes are in
[CHANGELOG.md](CHANGELOG.md).

## License

MIT
