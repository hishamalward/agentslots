<p align="center"><img src="docs/agentslots-banner-light-asset.svg" alt="AgentSlots, local runtime isolation for concurrent coding agents" width="100%"></p>

<p align="center">
  <a href="https://github.com/hishamalward/agentslots/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/hishamalward/agentslots?color=087e82"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/hishamalward/agentslots?color=087e82"></a>
  <img alt="macOS" src="https://img.shields.io/badge/platform-macOS-152f38">
  <img alt="Bash 3.2" src="https://img.shields.io/badge/Bash-3.2-152f38">
</p>

AgentSlots gives each coding task an isolated local workspace. A Git worktree separates files;
AgentSlots can also assign a database, port numbers, a job-queue schema, and an exclusive simulator
when the task needs to run the app.

It is one small runtime tool. It does not orchestrate agents, assign tasks, or manage permissions.

## Demo

![Two stack slots running independently, then one stopped while the other keeps running](docs/demo.gif)

The installed runtime provisions two real local stack slots, then stops
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

The tool targets macOS system Bash 3.2 and BSD command-line utilities. Stack operations also need
PostgreSQL client tools and `lsof`. Simulator locking needs Xcode command-line tools and `jq`.

## Works with AgentKeel

[AgentKeel](https://github.com/hishamalward/agentkeel) manages task scope, permissions, reviews
and shipping checks. AgentSlots manages each task's local workspace and runtime resources,
including cleanup. For an existing AgentKeel project, the installer preserves its policy and
adds the runtime coordination directory to `agentkeel.json` writable paths. AgentKeel keeps
ownership of clone import and removal. See the [setup guide](QUICKSTART.md) for installation,
host access and attaching runtime resources to an AgentKeel clone.

## Host access for local runtime

Claude Code and Codex can both run the full local lifecycle: provision a stack, start the app,
use the simulator, and release the resources. The host session must allow local database
connections, process inspection and Apple's simulator services.

The tested restricted sandbox profiles block some of that access. This is a host permission
setting, not a model limitation. AgentSlots checks access and manages resources; AgentKeel
checks task permissions. Neither can override the operating system's sandbox.

Choose an authorized runtime session, then run `scripts/agent-check.sh --simulator` inside it
before starting the app. The [runtime setup steps](QUICKSTART.md#runtime-sessions-servers-databases-and-simulators)
explain the tested Codex launch setting and its broader access. AgentSlots never changes host
permissions automatically. Project-specific test results belong in the [acceptance record](docs/acceptance.md).

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
