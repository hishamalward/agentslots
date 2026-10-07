# Quickstart

AgentSlots supports macOS with system Bash 3.2. The installer and runtime ownership checks need
Python 3.10 or newer and Git. Status and stack commands also need a reachable local PostgreSQL
server, `lsof`, and PostgreSQL client tools (`psql`, `createdb`, `dropdb`, and `pg_dump`).
Simulator locking needs Xcode command-line tools and `jq`.

## 1. Preview and install

Clone a reviewed AgentSlots Git checkout, then preview the changes for your project:

```sh
python3 install.py --repo /path/to/project
```

Review the preview, then apply it:

```sh
python3 install.py --repo /path/to/project --apply
```

The installer places the pinned runtime under `.agents/agentslots/`, creates small project
wrappers, and adds an AgentSlots guidance block to `AGENTS.md` without replacing your other
instructions. It copies `.agent-slots.conf.example` to `.agent-slots.conf` only when the project
configuration is missing. It does not fetch or update AgentSlots automatically.

If the project already has scripts with AgentSlots names, the default is to refuse. Review the
collision and choose an explicit migration only if those scripts are the ones you want to replace:

```sh
python3 install.py --repo /path/to/project --adopt-existing --apply
```

The install manifest records original script bytes and modes so uninstall can restore them. It
also records the runtime version, source revision, and managed-file hashes in
`.agents/agentslots-install.json`.

## 2. Configure the project

Edit `.agent-slots.conf` to set database names, application paths, env file, and project hook
functions. Treat this file as trusted Bash code. Keep credentials in the application's env file.
Review and commit the installed runtime, wrappers, manifest, configuration and instruction changes
before creating worktrees: new worktrees receive committed files. Ensure `.agent` is ignored:

```sh
git check-ignore -q .agent
```

See [configuration](docs/configuration.md) for each variable and hook.

## 3. Create a code worktree

```sh
scripts/agent-up.sh feat/example
```

This creates a sibling worktree and runs the configured setup hook. It does not assign stack
ports or a database. To connect the worktree with an existing project state document, pass its path:

```sh
scripts/agent-up.sh feat/example --state docs/260901-feature-state.html
```

The state pointer is optional and refers to a document already maintained by the project.

### Attach a stack to an AgentKeel opened clone

AgentKeel creates the isolated clone and prints its launch command. AgentSlots attaches runtime
resources to it; AgentKeel remains responsible for importing reviewed code and removing the clone.
Before opening the clone, append `~/.agent-slots` to the existing `writable` array in the shared
checkout's `agentkeel.json`. Merge this entry into the list and preserve every existing path. This
grants the isolated session access to AgentSlots coordination files: per-repository lifecycle locks
and the machine-wide simulator lock. Do not add the shared checkout or its `.git` directory. This uses AgentKeel's existing writable-path setting;
it adds no permission system.

Use the `task.py` path shown by AgentKeel. The human creates the clone and prints its sandbox
launch command (choose `--host claude` for Claude Code):

```sh
task.py open example --host codex --size medium --allow implement --print-only
```

Before running the printed launcher command, attach a stack using the shared checkout as the
configuration authority:

```sh
AGENT_REPO_ROOT=/path/to/shared/repository \
  scripts/agent-up.sh feat/example --workspace /path/to/opened/clone --stack
```

Then run the sandbox launch command printed by `task.py open`. The human sets `AGENT_REPO_ROOT`
for provisioning; the opened clone record identifies its shared repository for later runtime
commands.

The shared directory coordinates AgentSlots' per-repository lifecycle locks and the machine-wide
simulator lock. CoreSimulator services and caches may need additional platform-managed writable
roots. Simulator boot inside an isolated session has not been verified. Full host sandbox stack
acceptance remains pending; see [acceptance evidence](docs/acceptance.md).

When work is ready to finish, `scripts/agent-down.sh <slot>` releases the database and processes
but retains the opened clone. Run `task.py import <task-id> --sha <full-commit-id>` for the
reviewed commit, then `task.py release <task-id>` to remove the clone. Do not use AgentSlots to
remove an AgentKeel clone.

## 4. Add a stack when needed

Upgrade the same worktree when the task needs to run the app or database:

```sh
scripts/agent-up.sh feat/example --stack
```

AgentSlots chooses the lowest available slot, clones the configured local database, writes the
slot's env values, and assigns its configured port numbers. Port numbers are checked during setup,
then bound by the application when it starts. Set disjoint port ranges for repositories that run
concurrently. Check the result with:

```sh
scripts/agent-status.sh
```

From inside the worktree, start configured servers:

```sh
scripts/agent-dev.sh
scripts/agent-mobile.sh  # only when a secondary hook is configured
```

## 5. Pause or finish

Pause a stack and keep its worktree and database:

```sh
scripts/agent-stop.sh 1
```

After work is preserved, release the stack and remove its linked worktree:

```sh
scripts/agent-down.sh 1
```

The reaper previews possible orphans by default. Review each reason before using `--yes` to clean
up resources.

## 6. Update or uninstall

To update, use a reviewed newer AgentSlots checkout and rerun the installer. It refuses to
overwrite edited runtime files. It updates the managed guidance block while preserving surrounding
`AGENTS.md` text, and retains edits to project configuration and `.gitignore`:

```sh
python3 install.py --repo /path/to/project --apply
```

Uninstall first previews what would be removed or restored:

```sh
python3 install.py --repo /path/to/project --uninstall
```

Apply only after reviewing the preview:

```sh
python3 install.py --repo /path/to/project --uninstall --apply
```

Uninstall restores original project scripts and the exact original `AGENTS.md` when unchanged. If
you edited that file, it removes only the unchanged AgentSlots guidance block and preserves your
text. A configuration created by the installer is removed only if it is unchanged; user edits and
project state documents named by `--state` are preserved.

## 7. Check this repository

For changes to AgentSlots itself:

```sh
npm ci
npm run check
```

The automated checks use temporary Git repositories and mocked simulator output. The optional
queue probe needs disposable PostgreSQL schemas; see [queue isolation](docs/queue-isolation.md).
