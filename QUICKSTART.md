# Quickstart

## 1. Configure the target project

```bash
cp .agent-slots.conf.example .agent-slots.conf
```

Edit the database names, application paths, and hook functions. Commit the file; credentials stay
in the application's configured env file, not in `.agent-slots.conf`.

Ensure `.agent` is ignored:

```bash
git check-ignore -q .agent
```

See `docs/configuration.md` for every variable and hook.

## 2. Verify the derivation contract

```bash
bash -c '. ./scripts/lib/agent-slot.sh
  agent_config_validate
  printf "slot1: %s %s %s %s\n" \
    "$(agent_db_name 1)" "$(agent_boss_schema 1)" \
    "$(agent_web_port 1)" "$(agent_metro_port 1)"'
```

Confirm the output matches the configured database, schema, and port formulas before provisioning.

## 3. Provision code, then a stack

```bash
./scripts/agent-up.sh feat/example
./scripts/agent-up.sh feat/example --stack
```

The first command creates a worktree and handover without scarce runtime resources. The second
upgrades the same worktree with a database and ports. Stack preflight refuses without changing
state when PostgreSQL, the source env, the main database, a port, or a configured prerequisite is
unavailable.

## 4. Run and inspect

From inside the new worktree:

```bash
./scripts/agent-dev.sh
```

From any worktree:

```bash
./scripts/agent-status.sh
```

The status output is derived from the running system and identifies missing databases, idle
stacks, stale dependency snapshots, merged branches, orphaned resources, and simulator locks.

## 5. Stop or destroy

```bash
./scripts/agent-stop.sh 1
./scripts/agent-down.sh 1
```

`stop` retains the database and worktree for fast resume. `down` removes both and refuses a dirty
worktree unless `--force` is explicitly supplied.

The reaper is dry-run by default:

```bash
./scripts/agent-reap.sh
./scripts/agent-reap.sh --yes
```

## 6. Verify queue isolation

Apply the helper under `integrations/pg-boss/`, provision two test schemas, and run:

```bash
DATABASE_URL_A='postgresql://localhost/project_dev' \
PGBOSS_SCHEMA_A=pgboss_probe_a \
PGBOSS_SCHEMA_B=pgboss_probe_b \
npm run test:queue
```

Keep `DATABASE_URL_B` unset for the load-bearing same-database test. Set it only for an additional
two-database run. Expect `ISOLATION PASS`, `CONTROL PASS`, and exit 0.

## 7. Run repository checks

```bash
npm ci
npm run check
```

The automated suite is self-contained. It does not touch a developer database or simulator.
