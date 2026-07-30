# agent-slots

Several AI coding agents can work one repository, on one machine, at the same time, without
one of them running stale code against another one's job queue.

## Why

Two dev servers were running different code against one shared pg-boss (Postgres-backed) job
queue. The queue handed a scheduled job to whichever server claimed it first, and that server
happened to be running the stale handler, the one with no due-check. A "press an edition"
job fired for every user on the wrong day, which emptied the next scheduled composer window.
The incident was diagnosed at first as "a cron schedule got rewritten." That diagnosis was
wrong: the schedule was fine. The failure was shared runtime state: one queue, two servers,
and the queue does not know or care which server's code is current.

A git branch does not isolate anything at runtime; it is just a pointer. A git worktree isolates
the filesystem and nothing else. Five things collide when several agents work one project:

| Resource | Does a worktree isolate it? |
|---|---|
| Filesystem (working tree, checked-out files) | Yes, this is what a worktree is for |
| Database | No, every worktree still points at the same one |
| Ports (web server, bundler) | No, every worktree still tries to bind the same ones |
| Background job queue and its schedules | No, this is the resource that actually caused the incident |
| A physical or virtual device (here: the iOS Simulator) | No, and it cannot be duplicated at all |

Fixing the filesystem and calling the job done is what left the other four exposed. This repo
is the fix for all five: one integer, `AGENT_SLOT`, deterministically derives a worktree, a
database, two ports and a job-queue schema. Slot 0 is the original checkout, unchanged, and the
only slot allowed to own the queue's cron schedules. Every other slot gets its own of everything
and starts with an empty schedule table, so it cannot fire a cron job even by accident.

## Status

This runs, as shipped, in the single repository it was built for (a Next.js/Prisma/pg-boss
monorepo with an Expo mobile app). It is not yet parameterized for other projects: the database
naming scheme, the base ports, the worktree-naming prefix and a chunk of hardcoded `apps/web`
path segments are specific to that repo. `PRE-RELEASE.md` lists exactly what generalizing this
takes, with file and line references. Read that before adopting this anywhere else. The two
vitest test files under `tests/` do not run as-is here either (no `package.json`, no vitest, and
they resolve paths relative to the source monorepo); they are included as the reference test
suite, and wiring up a harness is also a `PRE-RELEASE.md` item.

None of this touches production. It is a local-development-only concern.

## Install / Setup

Requirements:

- macOS with the system bash (3.2). The scripts are written and verified against bash 3.2.57,
  not bash 5, and several of them depend on quirks of that specific version (see
  `docs/lessons.md`).
- BSD userland. `sed`, `stat` and friends are used in their BSD forms throughout; the GNU
  equivalents accept different flags and some of them fail outright on the syntax used here.
- Local PostgreSQL (a Homebrew service in the source project, but any locally reachable Postgres
  works once the connection details are configured).
- git with worktree support (any reasonably current git).

Copy `scripts/` into your project, keeping `scripts/lib/agent-slot.sh` at that path (every other
script sources it by relative path). See `QUICKSTART.md` for the commands that were actually run
to exercise this, and `PRE-RELEASE.md` for what needs to change before the scripts will target a
different project.

## Use

All nine scripts derive their values from `scripts/lib/agent-slot.sh`, the single shared
contract. Nothing here is scripted state; `agent-status.sh` asks the running system (`git
worktree list`, `lsof`, `psql`) every time it runs, so it cannot go stale the way a written
registry file would.

### The slot model

```
AGENT_SLOT=0   the main tree, the default, unchanged
AGENT_SLOT=N   a booted stack, N in 1..9
```

| Resource | Formula | Slot 0 | Slot 1 | Slot 2 |
|---|---|---|---|---|
| Database | `<name>_a<N>` | `<name>_dev` | `..._a1` | `..._a2` |
| Web port | `3000 + 100N` | 3000 | 3100 | 3200 |
| Bundler port | `8081 + 100N` | 8081 | 8181 | 8281 |
| Job-queue schema | `pgboss_a<N>` | `pgboss` | `pgboss_a1` | `pgboss_a2` |
| Schedule owner | `N == 0` | yes | no | no |

Unset means slot 0, which is byte-identical to today's single-agent behavior. Only slot 0 may
write cron schedules; every other slot's job-queue schema starts empty, so a non-owner agent
cannot fire a scheduled job even if its code is stale. This is the direct fix for the incident
above: see `docs/queue-isolation.md` for the actual 13-line change and why it works.

### Two tiers

A worktree is cheap (roughly 20 seconds in the source project: `git worktree add` plus cloning
`node_modules` plus a codegen step) and everyone gets one. A database and two ports are scarce
and cost real setup time (a database clone in the source project), so they are claimed only by
work that actually needs to boot a server.

| Tier | Command | Provisions | Claims a slot? |
|---|---|---|---|
| **Code** (default) | `agent-up.sh <branch>` | worktree, dependencies, generated code | No |
| **Stack** (opt-in) | `agent-up.sh <branch> --stack` | everything above, plus database, ports, env file | Yes |

A code-tier worktree upgrades in place to stack tier later with the same command plus `--stack`,
so picking the cheap tier first is never a decision you have to undo. `agent-dev.sh` and
`agent-mobile.sh` refuse to start a server on a code-tier worktree and print the exact upgrade
command, rather than booting and then failing on every database-backed route.

### Command reference

| Script | What it does | Usage |
|---|---|---|
| `scripts/agent-up.sh` | Provisions a worktree (code tier), or adds a slot, database, ports and env file to one (`--stack`) | `agent-up.sh <branch> [--stack] [--handover <path>] [--spec <path>]` |
| `scripts/agent-status.sh` | Prints every worktree, its tier, slot, branch, live ports and orphans, derived from the running system | `agent-status.sh` |
| `scripts/agent-dev.sh` | Starts the web dev server on this worktree's slot port; refuses on a code-tier worktree | `agent-dev.sh` |
| `scripts/agent-mobile.sh` | Starts the bundler on this worktree's slot port; refuses on a code-tier worktree | `agent-mobile.sh` |
| `scripts/agent-stop.sh` | Kills this slot's processes and releases the simulator lock if it holds one; worktree and database survive | `agent-stop.sh <slot>` |
| `scripts/agent-down.sh` | Ends a slot's life entirely: stop, then remove the worktree, drop the database | `agent-down.sh <slot> [--force]` |
| `scripts/agent-reap.sh` | Finds and (with `--yes`) destroys orphaned slots: dry-run by default, refuses anything not fully merged or with uncommitted changes | `agent-reap.sh [--yes]` |
| `scripts/sim-lock.sh` | Exclusive lock for the one resource that cannot be slotted, a device simulator | `sim-lock.sh <acquire\|release\|status> [slot]` |
| `scripts/lib/agent-slot.sh` | The shared derivation contract every other script sources | sourced, never run directly |

## What it looks like

`agent-status.sh` derives and prints, live, every worktree with its tier, branch, slot, ports and
whether it is an orphan (a merged branch whose slot is still provisioned, a database with no
matching worktree, a dead simulator lock, and so on). There is no dashboard or screenshot here:
the entire point of the design is that this state is never written down, only ever asked for, so
the only faithful "what it looks like" is the command's own text output on a real run, and that
output names real branches and paths from the source project. `docs/acceptance.md` has the actual
runs, evidence and all, verbatim from the source project.

## Design notes

- **Derive state, never write it down; write down intent, never derive it.** These are opposite
  problems. What exists and what is running is asked of the system every time (`git worktree
  list`, `lsof`, `psql -l`), because a written copy drifts the moment reality moves. What the work
  is for and what is next cannot be derived from anything, so a per-stream handover document
  carries that instead. `docs/design.md` has the full reasoning, including the abandoned design
  that mixed the two.
- **A lock file is a claim, not an authority.** The simulator lock always re-verifies its holder
  against the OS (process alive, device still booted) before trusting it, so a crashed agent
  cannot strand the lock for everyone else.
- **Absence of configuration preserves today's behavior.** Every environment variable this design
  introduces defaults to the value that already existed. The feature cannot break the normal path
  by being unset.
- **Collisions fail loudly, at setup, or not at all.** A preflight check that refuses and changes
  nothing beats a half-provisioned worktree that looks ready and behaves wrong three hours later.
- Full design rationale, including the founder rulings behind each locked-in choice: `docs/design.md`.
- The debugging cost of getting this wrong, preserved in detail: `docs/lessons.md`.
- The one piece of production code this required, and why a second, differently-named variable
  would have silently disabled cron on the one slot that must run it: `docs/queue-isolation.md`.

## License

MIT
