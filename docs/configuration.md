# Configuration

AgentSlots attaches to an existing Git linked worktree. It reads the project's `.agent-slots.conf` from the shared repository (or `AGENT_REPO_ROOT` when the supplied worktree is outside the shared checkout). `AGENT_CONFIG=/absolute/path` selects an alternate configuration and fails if it is missing.

The configuration is trusted Bash code because macOS Bash 3.2 has no safe array-valued environment variables. Project commands are functions rather than strings passed through `eval`; review changes before running them and keep credentials in application env files.

## Resource settings

| Variable | Purpose |
|---|---|
| `AGENT_PROJECT_SLUG` | Default database name stem |
| `AGENT_DATABASE_MAIN` | Source local database copied when `db` or `queue` is selected |
| `AGENT_DATABASE_PREFIX` | Per-worktree database name stem |
| `AGENT_PG_USER` | PostgreSQL CLI role |
| `AGENT_APP_DIR`, `AGENT_ENV_FILE` | Application directory and env file |
| `AGENT_CONFLICT_ENV_FILE` | Optional env file that must not redefine the database URL |
| `AGENT_WEB_PORT_BASE`, `AGENT_METRO_PORT_BASE`, `AGENT_PORT_STEP` | Per-worktree port formulas |
| `AGENT_SLOT_MAX` | Highest assignable resource slot |
| `AGENT_SLOT_KEY`, `AGENT_DATABASE_URL_KEY`, `AGENT_PUBLIC_URL_KEY` | App env keys AgentSlots writes |
| `AGENT_QUEUE_SCHEMA_KEY`, `AGENT_QUEUE_SCHEMA_MAIN`, `AGENT_QUEUE_SCHEMA_PREFIX`, `AGENT_INHERITED_QUEUE_SCHEMA` | Optional queue schema isolation |
| `AGENT_SIM_LOCK` | Machine-wide exclusive simulator lock path |
| `AGENT_LEASE_SECONDS` | Runtime lease duration in seconds; default 1800 (30 minutes) |

The example `.agent-slots.conf.example` documents the Next.js, Prisma, pg-boss, Expo and npm-workspaces hooks. Disable queue variables with empty strings when the project does not use a namespaced queue. Database/schema identifiers accept letters, numbers and underscores. App paths must remain inside the repository.

Port formulas are local to a repository. Repositories that run simultaneously need nonoverlapping port ranges. AgentSlots checks port availability when attaching but the application's server binds the port.

## Project hooks

Projects may define hooks for dependency/code generation preparation, server launch, dependency freshness, and post-environment warnings. The default prepare hook does nothing; server hooks require project configuration. `attach --prepare` runs setup without allocating runtime services. The prepare hook runs with the primary worktree as its current directory and receives the primary and target worktree paths; attach returns to the target worktree after it finishes. `attach --service ...` provisions only the requested service resources. Attach writes only AgentSlots-managed keys to the target's configured env file; other values and credentials must already be available through the project's normal setup.

See `.agent-slots.conf.example` for the current hook signatures and behavior.

## AgentKeel policy integration

When `agentkeel.json` exists, the installer preserves its current contents and adds the coordination directory to `writable` when needed. The default is `~/.agent-slots`; for a custom `AGENT_SIM_LOCK`, pass `--coordination-dir` with its absolute parent. The installer does not source `.agent-slots.conf` to infer executable configuration. This grant permits coordination-file access; it does not grant host process, PostgreSQL, simulator or Git metadata access.

AgentKeel owns task permissions and worktree lifecycle. AgentSlots attaches to an existing linked worktree and releases runtime resources only. It never imports code or deletes Git branches/worktrees.

## Coordination and lease state

Local locks and per-worktree lease markers coordinate concurrent attach, heartbeat, pin, pause, release and sweep operations. Git worktree state is still read from Git, process ownership from the operating system, and database state from PostgreSQL. The markers are not a task registry or daemon. Uncertain ownership or liveness causes cleanup to refuse safely.

The default lease is 30 minutes. Heartbeat is an explicit CLI call, not an automatically installed background process. Pin marks an intentionally idle runtime so sweep skips it until unpinned. Configure lease duration for the project's expected session cadence and only schedule periodic CLI calls through a reviewed native scheduler if desired.

## Required tools and capability checks

Git, macOS system Bash 3.2 and Python 3.10+ are required. Database operations need local PostgreSQL and its client tools; port/process checks need `lsof`; simulator operations need Xcode's `xcrun` and `jq`.

Run checks in the same host session that will run the work:

```sh
scripts/agent-check.sh --code
scripts/agent-check.sh
scripts/agent-check.sh --simulator
```

These commands diagnose host capabilities. They do not provision services, execute project setup hooks, grant permissions, or retry outside the host sandbox.
