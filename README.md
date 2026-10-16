<p align="center"><img src="docs/agentslots-banner-light-asset.svg" alt="AgentSlots, local runtime resources for linked worktrees" width="100%"></p>

<p align="center">
  <a href="https://github.com/hishamalward/agentslots/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/hishamalward/agentslots?color=087e82"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/hishamalward/agentslots?color=087e82"></a>
  <img alt="macOS" src="https://img.shields.io/badge/platform-macOS-152f38">
  <img alt="Bash 3.2" src="https://img.shields.io/badge/Bash-3.2-152f38">
</p>

AgentSlots attaches local runtime resources to an **existing linked Git worktree**. It works with standalone worktrees as well as AgentKeel tasks; standalone use does not require an AgentKeel task or session ID. Select only what the work needs: web/mobile ports, a local database, a queue schema, or dependency preparation. AgentSlots does not create branches or worktrees, manage tasks or plans, or remove Git worktrees.

It is a small local runtime tool. It does not orchestrate agents or grant project permissions.

## Attach resources

Install the pinned runtime into the project as described in the [quickstart](QUICKSTART.md), then attach resources to an existing worktree:

```sh
scripts/agent-slots attach --worktree /path/to/existing-worktree --service web --service db
```

Service flags are selective and repeatable: `web`, `db`, `queue`, and `mobile`. The queue service uses a separate database schema and also selects its backing database. With no `--service`, attach selects no service resources such as a database, process or port. Add `--prepare` to run the configured dependency/code generation hook without allocating any services.

Use `scripts/agent-slots status --repo /path/to/project` to inspect resources and `scripts/agent-slots start web --worktree PATH` or `start mobile --worktree PATH` to start configured processes. After `pause`, run `start` again to resume. AgentSlots assigns port values and checks availability; the application binds them. Set nonoverlapping port ranges for repositories that run at the same time.

## Resource lifecycle

```sh
scripts/agent-slots pause --worktree /path/to/existing-worktree
scripts/agent-slots heartbeat --worktree /path/to/existing-worktree
scripts/agent-slots pin --worktree /path/to/existing-worktree
scripts/agent-slots unpin --worktree /path/to/existing-worktree
scripts/agent-slots sweep                 # dry run
scripts/agent-slots release --worktree /path/to/existing-worktree
```

`pause` stops only processes whose PID and process-start identity AgentSlots recorded; the database, env values, slot claim and worktree remain available for resume with `start`. A failed start keeps its intent and log for inspection; check `status` and the recorded log before retrying or releasing. Attach writes only its configured AgentSlots-managed keys in the worktree env file; it does not copy other values or credentials from the main worktree. Heartbeat refreshes its 30-minute lease; pin keeps it out of expiry cleanup until unpinned. `sweep` reports expired, unpinned leases by default; `--yes` attempts the same identity-checked pause, never Git cleanup. A repository sweep examines expired worktrees across owner sessions, including when invoked from another agent session; direct worktree commands still enforce the caller’s session. `release` removes only runtime resources whose ownership is proven. Git worktree removal remains the caller's responsibility.

No background daemon is installed. Heartbeats represent active use and must come from the caller; scheduling heartbeat would keep idle resources alive. An optional native launchd example schedules repository-scoped `sweep --yes`; AgentSlots never installs or activates it.

## What it isolates

| Resource | Behavior |
|---|---|
| Worktree files | Supplied by Git; AgentSlots attaches without creating or deleting the worktree |
| Web and mobile ports | Derived from configured formulas and checked for availability; the app binds them |
| PostgreSQL | A separate local database when `db` is selected |
| pg-boss | Optional per-worktree schema; recurring schedules remain owned by the configured main slot |
| Simulator | Optional exclusive device lock using the existing `sim-lock` command |

This is local development coordination, not a security boundary. It cannot prevent a project from connecting to shared services or using shared credentials.

## Install and configure

From a reviewed AgentSlots checkout, preview and apply the pinned runtime installer:

```sh
python3 install.py --repo /path/to/project
python3 install.py --repo /path/to/project --apply
```

The installer and ownership checks require Python 3.10 or newer. Updates are explicit and preserve user edits to managed files. See the [quickstart](QUICKSTART.md) and [configuration guide](docs/configuration.md). Project formulas and trusted shell hooks live in `.agent-slots.conf`; credentials belong in the project's normal env files.

The supported runtime platform is macOS with system Bash 3.2 and BSD utilities. PostgreSQL tools and `lsof` are needed for database/status operations; simulator checks need Xcode command-line tools and `jq`.

## Works with AgentKeel

[AgentKeel](https://github.com/hishamalward/agentkeel) manages task scope and permissions. AgentKeel or a human creates the Git worktree; AgentSlots attaches and releases runtime resources for the path supplied with `--worktree`. `release` never removes the Git worktree. See the [quickstart](QUICKSTART.md#attach-an-agentkeel-worktree) for the handoff.

## Documentation

- [Quickstart](QUICKSTART.md)
- [Configuration](docs/configuration.md)
- [Design](docs/design.md)
- [Queue isolation](docs/queue-isolation.md)
- [Development environment](docs/dev-environment.md)
- [Acceptance evidence](docs/acceptance.md)
- [Optional launchd sweep](docs/launchd-scheduling.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License

MIT
