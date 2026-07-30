# Quickstart

These command sequences are taken from the verification protocol that was actually run against
the source project (a Next.js/Prisma/pg-boss monorepo) before this was packaged, with paths
adjusted where the source repo's own layout leaked in. Where a command still assumes something
specific to that project (a database name, a monorepo subdirectory), it is called out. See
`PRE-RELEASE.md` for the full list of what has to become configuration before these are
project-agnostic.

## 1. Source the library and exercise the derivation contract

Every other script sources `scripts/lib/agent-slot.sh` and derives its values from it, so this is
the one thing worth checking works before anything else:

```bash
bash -c '. ./scripts/lib/agent-slot.sh
  echo "slot1: $(agent_db_name 1) $(agent_boss_schema 1) $(agent_web_port 1) $(agent_metro_port 1)"
  echo "slot0: $(agent_db_name 0) $(agent_boss_schema 0) $(agent_web_port 0) $(agent_metro_port 0)"'
```

In the source project this printed:

```
slot1: music_analytics_a1 pgboss_a1 3100 8181
slot0: music_analytics_dev pgboss 3000 8081
```

The `music_analytics_*` names are the source project's hardcoded database naming
(`scripts/lib/agent-slot.sh:47-48`); on a different project this line prints whatever name is
hardcoded there until that function is generalized (`PRE-RELEASE.md`).

## 2. Provision a code tier, then upgrade it to a stack

```bash
# refuses with no arguments, changes nothing
./scripts/agent-up.sh > /tmp/u 2>&1; echo "exit=$?"   # expect 2, usage printed

# code tier: a worktree, dependencies, generated code. No database, no slot, no ports.
./scripts/agent-up.sh <branch>

# upgrade the same worktree in place to a stack: claims a slot, database, ports and env file
./scripts/agent-up.sh <branch> --stack
```

The stack-tier step needs a reachable local Postgres and a `DATABASE_URL` in the main tree's env
file to derive the slot's own URL from (see `scripts/agent-up.sh:113-121`); it will refuse loudly
and change nothing if either is missing.

## 3. Start a server on the slot's own port

From inside the worktree the previous step created:

```bash
./scripts/agent-dev.sh          # refuses with the upgrade command if this worktree is code tier
```

A code-tier worktree refuses like this rather than booting and failing on every database route:

```
agent-dev: this worktree is code tier (no slot, no database)
run: scripts/agent-up.sh <branch> --stack
```

## 4. Read status

```bash
./scripts/agent-status.sh
```

This derives everything live (`git worktree list`, `lsof`, `psql -l`) and stores nothing, so it
cannot go stale. It names orphans unprompted: a merged branch whose slot is still provisioned, a
database with no matching worktree, a listening port with no worktree, a dead simulator lock.

## 5. Tear down

```bash
./scripts/agent-stop.sh <slot>    # kills this slot's processes; worktree and database survive
./scripts/agent-down.sh <slot>    # removes the worktree, drops the database; nothing survives
```

Verify the machine is back at its starting state:

```bash
git worktree list                                              # back to the pre-existing entries
psql -U <role> -lqt | cut -d'|' -f1 | grep -c '_a[0-9]' || true  # expect 0
```

Run the reaper (dry-run by default, so this is safe to run any time) to confirm nothing was left
behind:

```bash
./scripts/agent-reap.sh          # dry run: prints orphans and what would be reclaimed
./scripts/agent-reap.sh --yes    # actually destroys them, refusing anything unmerged or dirty
```

## 6. The load-bearing check: queue isolation

This is the check that reproduces the original incident and proves it cannot happen. It needs two
provisioned stacks and a small probe script that does not exist in this repo (see
`PRE-RELEASE.md`, "the test suite needing a harness"): enqueue a job against one slot's queue
schema and confirm the other slot's server never consumes it.

```bash
# provision two stacks first: ./scripts/agent-up.sh <branch-a> --stack, <branch-b> --stack
# then, reading DATABASE_URL and PGBOSS_SCHEMA back from each worktree's own env file
# (never hardcode them):
DATABASE_URL_A="..." PGBOSS_SCHEMA_A="pgboss_a<N>" \
DATABASE_URL_B="..." PGBOSS_SCHEMA_B="pgboss_a<M>" \
  npx tsx <path-to-a-queue-isolation-probe-script>
# expect: ISOLATION PASS, CONTROL PASS, exit 0
```

Run it once with `DATABASE_URL_A` and `DATABASE_URL_B` equal (same database, two schemas) before
trying the two-database case: that configuration is the one that actually tests the schema
option, not just database separation. See `docs/queue-isolation.md` for what this proves and why.

## 7. The simulator lock

Only relevant if the project drives a device simulator (the source project's is an iOS Simulator
for an Expo app):

```bash
./scripts/sim-lock.sh acquire <slot>    # refuses if another slot holds it, naming who and for how long
./scripts/sim-lock.sh status            # holder, liveness, age
./scripts/sim-lock.sh release <slot>    # releases; --force to override a mismatched slot
```

## Running the tests, once wired up

`tests/agent-slot.test.ts` and `tests/agent-up-preflight.test.ts` are vitest tests that shell out
to bash and assert against the derivation contract and the preflight refusals. They are the
reference test suite for this project, not a runnable one here: there is no `package.json`, no
vitest dependency, and both files resolve paths relative to the source monorepo's layout
(`apps/web/...`). Wiring up a test harness (a `package.json` with vitest, and adjusting the
path assumptions to wherever this is dropped into a real project) is a pre-release task; see
`PRE-RELEASE.md`. Once wired up, the source project ran them as:

```bash
cd apps/web && npx vitest run --reporter=dot
```
