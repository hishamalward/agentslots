# Configuration

`agent-slots` separates stable resource formulas from project-specific commands. Copy
`.agent-slots.conf.example` to `.agent-slots.conf` in the target repository, edit it, and commit
it. Every linked worktree loads the shared checkout's copy so a feature branch cannot silently
change resource formulas for itself. For an AgentKeel opened clone, `AGENT_REPO_ROOT` identifies
the shared checkout and its configuration. `AGENT_CONFIG=/absolute/path` selects a different file
and fails loudly if that file does not exist.

The configuration is shell code because Bash 3.2 has no safe array-valued environment variables.
Framework commands are functions, not strings passed through `eval`, so arguments retain their
boundaries.

## Resource values

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_MAIN_BRANCH` | `main` | Branch new work starts from and completed work is compared with |
| `AGENT_PROJECT_SLUG` | repository basename, normalized | Default database-name stem |
| `AGENT_DATABASE_MAIN` | `<slug>_dev` | Slot 0 database |
| `AGENT_DATABASE_PREFIX` | `<slug>_a` | Slot database prefix; the slot number is appended |
| `AGENT_PG_USER` | current OS user | PostgreSQL CLI role |
| `AGENT_APP_DIR` | `.` | Application directory containing the env file |
| `AGENT_ENV_FILE` | `.env` | Application env filename |
| `AGENT_CONFLICT_ENV_FILE` | empty | Optional second env filename that must not redefine the database URL |
| `AGENT_WEB_PORT_BASE` | `3000` | Slot 0 web port |
| `AGENT_METRO_PORT_BASE` | `8081` | Slot 0 secondary/bundler port |
| `AGENT_PORT_STEP` | `100` | Per-slot port increment |
| `AGENT_SLOT_MAX` | `9` | Highest assignable slot, at most 99 |
| `AGENT_WORKTREE_PREFIX` | `<repo-name>-` | Prefix for sibling worktree directories |
| `AGENT_SIM_LOCK` | `~/.agent-slots/simulator.lock` | Machine-wide exclusive-device lock |

The environment-key and queue-schema variables are documented inline in
`.agent-slots.conf.example`. Set `AGENT_QUEUE_SCHEMA_KEY` and
`AGENT_INHERITED_QUEUE_SCHEMA` to empty strings when the project has no namespaced job queue.

Port formulas belong to one repository. If more than one configured repository runs servers on the
same machine, set nonoverlapping `AGENT_WEB_PORT_BASE` and `AGENT_METRO_PORT_BASE` values. AgentSlots
assigns the numbers and checks availability during setup; the application binds ports when started.

Database names and unquoted schema names are restricted to letters, numbers, and underscores.
Application paths must stay inside the repository. Invalid configuration fails before the scripts
provision or destroy anything.

## Project hooks

The config may redefine five hooks:

- `agent_prepare_worktree <main> <worktree>` installs or clones dependencies and runs codegen.
- `agent_start_web <worktree> <port> [args...]` starts the web server.
- `agent_start_mobile <worktree> <port> [args...]` starts the optional secondary server.
- `agent_dependencies_stale <worktree>` returns success when dependencies need refreshing.
- `agent_after_slot_env <env-file> <slot> <web-port>` prints project-specific warnings after the
  slot env is written.

The generic setup hook is a no-op, so code-tier worktrees work for repositories without a build
step. Server hooks fail with an actionable message until configured. The example provides the
original Next.js, Prisma, Expo, and npm-workspaces behavior.

## AgentKeel opened clones

For an opened clone, AgentKeel owns creating, importing, and releasing the clone. AgentSlots only
attaches and releases its runtime resources. When the shared checkout has `agentkeel.json`, the
installer preserves its policy and adds the runtime coordination directory to its writable paths.
The default is `~/.agent-slots`; for custom `AGENT_SIM_LOCK`, supply its absolute parent with
`install.py --coordination-dir`. The installer does not source the shell configuration to guess it.
This grants coordination-file access and does not add the shared checkout or its `.git` directory.

Before launching the sandbox command printed by `task.py open ... --print-only`, a human can attach
the stack with:

```sh
AGENT_REPO_ROOT=/path/to/shared/repository \
  scripts/agent-up.sh feat/example --workspace /path/to/opened/clone --stack
```

The runtime reads project formulas and hooks from the shared checkout. `agent-down.sh` releases
the clone's database and processes but deliberately retains the clone; import the reviewed commit
with `task.py import <task-id> --sha <full-commit-id>`, then remove the clone with
`task.py release <task-id>`. Run the capability check inside the host session before runtime work.
Current restricted host profiles do not support the full stack/simulator path when local
PostgreSQL, process inspection, or CoreSimulator is denied. Ordinary macOS host access is the
supported runtime mode. AgentKeel authorization does not change the host sandbox.

A Codex named profile with the project in writable roots can still block `ps` and CoreSimulator.
An explicitly authorized session using `permissions.default_permissions = ":danger-full-access"`
has full host access; this is not a fine-grained grant. AgentSlots never selects that mode,
changes global host settings, or relaunches a session to bypass a refusal.

## Coordination locks

The default machine-wide simulator lock is `~/.agent-slots/simulator.lock`. Lifecycle commands also
serialize work per canonical Git repository with a mutex under `~/.agent-slots/repos/`, keyed by the
SHA-256 of Git's common directory. With a custom `AGENT_SIM_LOCK`, the `repos/` directory is under
that lock file's parent. Nested lifecycle commands inherit the open lock descriptor so a reaper can
call teardown without deadlocking. The simulator lock has a separate mutex beside it (by default
`~/.agent-slots/simulator.lock.mutex`). These are coordination lock files, not a resource registry
or service, and AgentSlots does not write task state into shared `.git` metadata.

## Required tools

All modes require Git, macOS Bash 3.2, and Python 3.10 or newer for workspace identity checks.
Status needs a reachable local PostgreSQL server, `psql`, and `lsof`. Stack operations also need
`createdb`, `dropdb`, and `pg_dump`. Simulator operations require Xcode's `xcrun` and `jq`.
Scripts check these prerequisites before depending on their output, so a missing command is never
mistaken for a free database, port, or device.

## Check the active host

Run these commands from the project in the same host session that will perform the work:

```sh
scripts/agent-check.sh --code       # Git, Python, configuration and coordination writes
scripts/agent-check.sh              # also process inspection and local PostgreSQL role
scripts/agent-check.sh --simulator  # also CoreSimulator service and available devices
```

The check uses the configured PostgreSQL role, requires CREATEDB, and refuses remote libpq
connection overrides. It does not read or print application database URLs. It verifies command
exit statuses and actual process/device results, so denied inspection cannot appear as an empty,
available resource. Failures distinguish missing tools from inaccessible host capabilities.

The check creates the configured coordination directory if missing, then creates and removes one
private file there to prove the host write grant. It does not touch runtime lock files, provision
slots, boot devices, or execute project hooks. Setup hooks and app readiness still require their
own verification. Exit statuses: 0 ready, 1 failed prerequisite, 2 invalid options. It never
escalates permissions or automatically retries outside the active sandbox.
