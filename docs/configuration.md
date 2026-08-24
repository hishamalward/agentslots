# Configuration

`agent-slots` separates stable resource formulas from project-specific commands. Copy
`.agent-slots.conf.example` to `.agent-slots.conf` in the target repository, edit it, and commit
it. Every linked worktree loads the main worktree's copy so a feature branch cannot silently
change resource formulas for itself. `AGENT_CONFIG=/absolute/path` selects a different file and
fails loudly if that file does not exist.

The configuration is shell code because Bash 3.2 has no safe array-valued environment variables.
Framework commands are functions, not strings passed through `eval`, so arguments retain their
boundaries.

## Resource values

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_MAIN_BRANCH` | `main` | Branch new work starts from and completed work is compared with |
| `AGENT_PROJECT_SLUG` | repository basename, normalized | Default database-name stem and lock namespace |
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
| `AGENT_SIM_LOCK` | `~/.agent-slots/<slug>.sim.lock` | Machine-wide exclusive-device lock |

The environment-key and queue-schema variables are documented inline in
`.agent-slots.conf.example`. Set `AGENT_QUEUE_SCHEMA_KEY` and
`AGENT_INHERITED_QUEUE_SCHEMA` to empty strings when the project has no namespaced job queue.

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

## Required tools

All modes require Git and macOS Bash 3.2. Stack operations require PostgreSQL's `psql`, `createdb`,
`dropdb`, and `pg_dump`, plus `lsof`. Simulator operations require Xcode's `xcrun` and `jq`.
Scripts check these prerequisites before depending on their output, so a missing command is never
mistaken for a free database, port, or device.
