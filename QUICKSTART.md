# Quickstart

AgentSlots supports macOS with system Bash 3.2. The installer and runtime ownership checks need Python 3.10 or newer and Git. Database operations need a local PostgreSQL server and its client tools; process and port checks need `lsof`. Simulator checks need Xcode command-line tools and `jq`.

## 1. Preview and install

Clone a reviewed AgentSlots checkout, then preview and apply the runtime in your project:

```sh
python3 install.py --repo /path/to/project
python3 install.py --repo /path/to/project --apply
```

The installer places the pinned runtime under `.agents/agentslots/`, adds the `scripts/agent-slots` facade and the capability-check/device-lock commands, and adds a managed guidance block to `AGENTS.md` without replacing other instructions. It copies `.agent-slots.conf.example` only if project configuration is missing. It does not fetch updates, change host settings or commit for you.

If `agentkeel.json` exists, the installer preserves its policy and may add the configured coordination directory to `writable`. For a custom `AGENT_SIM_LOCK`, pass `--coordination-dir /absolute/path/to/its/parent` to preview and apply. The installer does not source project shell configuration to infer this path.

If scripts collide with installed wrappers, inspect them and use `--adopt-existing` only when you intend to replace them. The manifest retains original bytes and modes for uninstall. A reviewed clean source checkout makes the recorded revision reproducible; when `source_dirty` is true, manifest hashes describe the installed payload.

## 2. Configure

Edit `.agent-slots.conf` for database names, app paths, port formulas, dependency preparation and project server hooks. Treat it as trusted Bash code and keep secrets in application env files. Preparation hooks run from the primary worktree and receive its path and target worktree path; after the hook, attach continues from the target worktree. See [configuration](docs/configuration.md).

Review and commit the runtime, wrappers, manifest, configuration and guidance before creating future worktrees, so they receive the installed setup. Verify that `.agent` is ignored:

```sh
git check-ignore -q .agent
```

## 3. Attach to an existing worktree

AgentSlots never creates a branch or worktree. Create or select one through Git, AgentKeel or your existing workflow, then attach only the resources the work needs. Standalone use requires no AgentKeel task/session IDs:

```sh
scripts/agent-check.sh --code
scripts/agent-slots attach --worktree /path/to/existing-worktree
```

With no service flags, attach selects no database, processes, ports or device. To prepare dependencies/code generation without allocating services, add `--prepare`:

```sh
scripts/agent-slots attach --worktree /path/to/existing-worktree --prepare
```

Select runtime services explicitly and repeat `--service` as needed:

```sh
scripts/agent-slots attach --worktree /path/to/existing-worktree --service web --service db
scripts/agent-slots attach --worktree /path/to/existing-worktree --service queue
scripts/agent-slots attach --worktree /path/to/existing-worktree --service mobile
```

`queue` selects its database as well as its per-worktree schema. `mobile` configures the Metro port; device locking remains a separate `sim-lock` operation. AgentSlots assigns port values, checks availability and writes only its configured managed keys in the target worktree env file; it does not copy other values or credentials from the main worktree. Your application starts and binds its own servers. Configure nonoverlapping port ranges in projects that run servers at the same time.

Before runtime work, check capabilities in the same host session that will run commands:

```sh
scripts/agent-check.sh
scripts/agent-check.sh --simulator
```

These checks report local permissions and prerequisites; AgentSlots never changes the host sandbox or retries outside it. A restricted host profile that blocks PostgreSQL, process inspection or CoreSimulator cannot run the corresponding service.

## Attach an AgentKeel worktree

AgentKeel owns task permissions and creates the task worktree. AgentSlots accepts the existing linked worktree path, whether it was created by AgentKeel or independently:

```sh
scripts/agent-slots attach --worktree /path/to/agentkeel-task-worktree --service web --service db
```

AgentSlots coordinates runtime resources only. `scripts/agent-slots release --worktree PATH` leaves Git branch and worktree cleanup to AgentKeel or the caller. The installer may add the coordination path to an existing `agentkeel.json`; review that policy change. It does not grant host permissions or add access to `.git`.

## 4. Inspect, pause, and release

Inspect repository resources with:

```sh
scripts/agent-slots status --repo /path/to/project
```

Start a configured server from the attached worktree:

```sh
scripts/agent-slots start web --worktree /path/to/existing-worktree
scripts/agent-slots start mobile --worktree /path/to/existing-worktree  # optional mobile hook
```

Pause only AgentSlots-recorded processes while retaining the database, env values, slot claim and Git worktree. Run `start` again to resume:

```sh
scripts/agent-slots pause --worktree /path/to/existing-worktree
scripts/agent-slots start web --worktree /path/to/existing-worktree
```

A failed start retains its intent and log for inspection. Check `status` and the recorded log before retrying or releasing that runtime.

Heartbeat refreshes the worktree's lease; call it periodically while active. Pin a long-running or intentionally idle runtime so expiry cleanup skips it, and unpin it when normal expiry should resume:

```sh
scripts/agent-slots heartbeat --worktree /path/to/existing-worktree
scripts/agent-slots pin --worktree /path/to/existing-worktree
scripts/agent-slots unpin --worktree /path/to/existing-worktree
```

Sweep is a dry run by default. Review candidates and use `--yes` only when you want expired, unpinned runtime processes paused. It does not release databases or remove worktrees. Ownership uncertainty or failed safety checks retain resources:

```sh
scripts/agent-slots sweep
scripts/agent-slots sweep --yes
```

Release runtime resources explicitly when finished; this never removes the Git worktree:

```sh
scripts/agent-slots release --worktree /path/to/existing-worktree
```

No daemon or scheduler is installed. Heartbeat represents active use; do not schedule it unconditionally. For optional repository-scoped idle cleanup, see [the launchd sweep example](docs/launchd-scheduling.md). Review its `--yes` behavior and lease cadence; the installer never installs or activates it.

## 5. Update or uninstall

Run the installer from a reviewed newer checkout. It refuses to overwrite edited vendored runtime files; reconcile local changes first. Preview uninstall before applying it:

```sh
python3 install.py --repo /path/to/project --uninstall
python3 install.py --repo /path/to/project --uninstall --apply
```

Uninstall restores original files where they remain unchanged, removes the unchanged managed guidance block, and preserves edits and user-owned project state. It does not remove existing Git worktrees or branches.

## 6. Check this repository

```sh
npm ci
npm run check
```

Automated tests use temporary Git repositories and mocked simulator output. The optional queue probe requires disposable PostgreSQL schemas; see [queue isolation](docs/queue-isolation.md).
