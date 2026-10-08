<p align="center"><img src="docs/agentslots-banner-light-asset.svg" alt="AgentSlots, local runtime isolation for concurrent coding agents" width="100%"></p>

<p align="center">
  <a href="https://github.com/hishamalward/agentslots/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/hishamalward/agentslots?color=087e82"></a>
  <img alt="macOS" src="https://img.shields.io/badge/platform-macOS-152f38">
  <img alt="Bash 3.2" src="https://img.shields.io/badge/Bash-3.2-152f38">
</p>

AgentSlots gives each coding task an isolated local workspace. A Git worktree separates files;
AgentSlots can also assign a database, port numbers, a job-queue schema, and an exclusive simulator
when the task needs to run the app.

It is one small runtime tool. It does not orchestrate agents, assign tasks, or manage permissions.

**Host support:** runtime operations require ordinary macOS host access. The actual Listenality stack and
simulator lifecycle passed on both Codex and Claude Code with normal hook trust in that mode.
Full stack and simulator work under the
current restricted host profiles is unsupported: those profiles can block local PostgreSQL,
process inspection, or CoreSimulator. Run the capability check in the session that will do the
work. See [acceptance evidence](docs/acceptance.md).

## Demo

![Two stack slots running independently, then one stopped while the other keeps running](docs/demo.gif)

Recorded v0.2 demo: the installed runtime provisions two real local stack slots, then stops
and releases them independently. Uses disposable PostgreSQL databases and minimal HTTP servers.

## Start small, add a stack when needed

A code-only worktree is quick and uses no database or ports:

```bash
scripts/agent-check.sh --code
scripts/agent-up.sh feat/my-change
```

When the task needs a local server or database, upgrade that worktree in place:

```bash
scripts/agent-check.sh
scripts/agent-up.sh feat/my-change --stack
```

AgentSlots assigns the lowest available slot and derives its resource names from `AGENT_SLOT`.
Slot 0 stays the original checkout. With the application-side pg-boss integration, only slot 0
registers recurring queue schedules.

For an AgentKeel opened clone, attach its runtime before starting the printed launcher. Set
`AGENT_REPO_ROOT` to the shared checkout and pass the clone to `--workspace`; AgentKeel continues to
own clone import and removal. The [quickstart](QUICKSTART.md) covers the sequence and runtime
coordination settings.

```bash
scripts/agent-status.sh
scripts/agent-dev.sh
scripts/agent-stop.sh 1       # pause; keep the worktree and database
scripts/agent-down.sh 1       # release resources after work is preserved
```

`agent-reap.sh` reports possible orphans as a dry run. It only cleans resources when their
ownership and safe removal can be established.

## What gets separated

| Resource | Per task behavior |
|---|---|
| Files | A sibling Git worktree per branch |
| PostgreSQL | A separate cloned database for each stack slot |
| Web and bundler | Port numbers derived from the slot and checked at setup; AgentSlots does not bind them |
| pg-boss | With application-side integration, a separate schema; only slot 0 registers recurring schedules |
| Exclusive simulator | One atomic lock with owner and device checks |

Port formulas are per repository. Configure nonoverlapping web and bundler ranges when multiple
repositories run servers on the same machine. AgentSlots assigns port numbers and checks availability
during setup; the application binds them when it starts.

This is local development coordination. It does not isolate hostile processes or prevent a user
from configuring a server to point at a shared or production service.

## Install and configure

From a reviewed AgentSlots checkout, preview and apply the pinned runtime installer:

```bash
python3 install.py --repo /path/to/project
python3 install.py --repo /path/to/project --apply
```

The installer and runtime ownership checks need Python 3.10 or newer. Updates are explicit, never
automatic. See the [quickstart](QUICKSTART.md) for installation, migration, updates and removal.
Project formulas and framework hooks live in `.agent-slots.conf`; review this trusted shell code
and keep credentials in the project's env file.

For an existing AgentKeel project, the installer preserves its policy and adds only the runtime
coordination directory to `agentkeel.json` writable paths. AgentKeel task authorization and host
sandbox access are separate requirements; AgentSlots does not change the host's permissions.

The tool targets macOS system Bash 3.2 and BSD command-line utilities. Stack operations also need
PostgreSQL client tools and `lsof`. Simulator locking needs Xcode command-line tools and `jq`.

## Queue integration

For projects that use pg-boss, the optional helpers and live positive-control probe are documented
in [queue isolation](docs/queue-isolation.md). The probe needs disposable PostgreSQL schemas.

## Documentation

- [Quickstart](QUICKSTART.md)
- [Configuration](docs/configuration.md)
- [Design](docs/design.md)
- [Queue isolation](docs/queue-isolation.md)
- [Development environment](docs/dev-environment.md)
- [Acceptance evidence](docs/acceptance.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License

MIT
