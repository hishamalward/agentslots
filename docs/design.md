# Design: attach local resources to worktrees

A Git linked worktree separates source files. It does not give a local app its own database, port values, queue namespace or exclusive device. AgentSlots attaches those runtime resources to a worktree that already exists.

## Responsibility boundary

AgentSlots does not create branches or worktrees, manage task plans, or remove Git worktrees. A caller such as AgentKeel or a developer creates the linked worktree and passes its path to `scripts/agent-slots`. AgentSlots may prepare dependencies or allocate selected runtime resources. Its `release` and `sweep` operations affect runtime resources only.

Service selection is explicit: `web`, `db`, `queue` and `mobile`. No service flag means no runtime resource allocation. Queue selection also provisions a database because its schema needs a backing database. Mobile selects its configured Metro port; simulator exclusivity remains the separate `sim-lock` operation. `--prepare` runs the project's dependency/code generation hook without allocating services.

## Ownership and leases

Attach records enough local ownership and liveness information to manage resources safely. Heartbeat refreshes the timestamp; pin suppresses lease expiry cleanup. Sweep is dry-run by default. With `--yes`, it attempts to pause only expired, unpinned leases: it stops processes only when both PID and process-start identity match the recorded owner. Pause retains database, env values, slot claim and worktree. Release separately removes only resources whose ownership markers and process identities are verified. Malformed/future state, unknown process liveness or uncertain ownership keeps resources in place.

These markers coordinate AgentSlots commands; they do not duplicate Git's worktree registry or provide general task state. State is observed from Git, the operating system and PostgreSQL when possible. A harmless leftover is safer than removing another process's resource.

No background daemon is installed. Heartbeat and sweep are explicit commands. A user may arrange native scheduling, but the package does not activate a LaunchAgent or other recurring job.

## Resource boundaries

| Resource | Behavior |
|---|---|
| Source files | Existing linked worktree supplied by the caller; never deleted by AgentSlots |
| Web/mobile ports | Configured numbers checked for availability; application binds them |
| PostgreSQL | Local per-worktree database when `db` or `queue` is selected |
| pg-boss queue | Optional schema per worktree; only the configured owner slot registers recurring schedules |
| Simulator | Optional separate exclusive lock, checked against process/device ownership |

This is local coordination for trusted development, not isolation from hostile processes or shared external services. It does not stop a local app from using production credentials or shared APIs.

## Failure and rollback

Provisioning checks prerequisites before writing state and tracks resources created by the current operation. Failure cleanup removes only resources that operation can prove it created. Concurrent or ambiguous ownership must refuse rather than tear down a competing invocation's resources.

The supported target is macOS system Bash 3.2 and BSD userland. See [configuration](configuration.md) for project hooks, leases and capability checks, and [acceptance evidence](acceptance.md) for verification status.
