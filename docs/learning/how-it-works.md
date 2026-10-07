# How AgentSlots works

AgentSlots gives each coding task a separate filesystem and, when needed, separate local runtime
resources. A worktree is cheap. A database and server ports are added only when a task needs to
run the app.

## The two tiers

A code-tier worktree contains the branch's files and runs the project's optional setup hook. It
claims no database or ports. Stack tier upgrades that worktree with the lowest available slot,
cloned database, configured env values, and port numbers derived from the slot. Ports are checked
during setup and bound by the app when it starts. Repositories sharing a machine need disjoint port
ranges.

`AGENT_SLOT=0` identifies the original checkout. Nonzero values identify stack slots. Only slot 0
may register recurring pg-boss schedules. The rest of the queue clients use separate schemas, so
jobs from one slot are not consumed by another.

## Where behavior lives

- `scripts/lib/agent-slot.sh` contains resource formulas, configuration validation, and probes of
  Git, ports, PostgreSQL, and the simulator.
- `scripts/agent-up.sh` checks prerequisites and provisions a code worktree or upgrades it to a
  stack.
- `scripts/agent-dev.sh` and `scripts/agent-mobile.sh` pass configured ports to project hooks.
- `scripts/agent-status.sh` reports the current worktrees and resources from the system.
- `scripts/agent-stop.sh` pauses a stack; `scripts/agent-down.sh` releases its resources.
- `scripts/agent-reap.sh` identifies likely orphans and defaults to a dry run.
- `integrations/pg-boss/` contains optional queue helpers and a disposable live probe.

Project-specific paths, formulas, and shell hooks live in `.agent-slots.conf`. It is Bash code and
should be reviewed before use. The runtime does not store a second resource registry: Git, the
operating system, and PostgreSQL are the source of truth.

## AgentKeel opened clones

AgentKeel's existing `task.py open ... --print-only` flow creates the clone and prints the exact
sandbox launcher. A human can attach its stack before running that command by setting
`AGENT_REPO_ROOT` to the shared checkout and passing the clone with `--workspace`. AgentSlots reads
the shared configuration and guards runtime ownership. AgentKeel still imports reviewed work and
releases the clone; `agent-down.sh` releases the database and processes while retaining clone code.
See the [quickstart](../../QUICKSTART.md) for the exact command sequence.

## Current verification status

Automated checks exercise the shell, TypeScript helpers, and temporary Git fixtures. The database
probe requires disposable PostgreSQL schemas. [Acceptance evidence](../acceptance.md) separates current candidate results from historical 0.1
runs and names the unresolved host-sandbox limits.
