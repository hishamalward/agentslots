# Design: local runtime slots

AgentSlots separates the local resources that a Git worktree cannot. It is intended for parallel
coding tasks on one developer machine.

## The collision

A Git worktree isolates files. It does not separate a local database, server ports, a database-backed
job queue, or an exclusive device. If two servers run different code against the same queue, either
server can claim a job created for the other version of the application.

AgentSlots derives resource names from one integer, `AGENT_SLOT`. A code-only worktree needs no
slot. A stack slot assigns the additional resources needed to run the project.

## Two tiers

| Tier | Provisions | Use it when |
|---|---|---|
| Code | A sibling Git worktree and configured setup hook | Editing code or running tests that need no app server |
| Stack | A code worktree, slot number, database, env values, and configured ports | Running a server, migration, local queue, or another database-backed task |

Start in code tier and upgrade in place when the task needs a stack. That keeps the common path
cheap and leaves databases and ports for tasks that use them.

Slot 0 is the original checkout. It keeps the project's existing resource values and is the only
slot allowed to register recurring queue schedules. Nonzero slots get their own resource values.
The project configuration controls formulas and framework-specific commands.

## Resource boundaries

| Resource | Isolation |
|---|---|
| Source files | One sibling worktree per branch |
| Database | A cloned local database per stack slot |
| Server ports | Values derived from the slot number and checked during setup; the app binds them when started |
| pg-boss queue | A schema per slot; only slot 0 registers schedules |
| Simulator | One machine-wide lock, checked against its owner and device |

Port formulas are per repository. Concurrent repositories need nonoverlapping web and bundler port
ranges. AgentSlots assigns port numbers and checks them during setup; it does not bind them.

These are coordination boundaries for trusted local work. They are not a security boundary between
hostile processes. A user can still point a local server at a shared backend, and external API
quotas remain shared.

## Derive observations, verify ownership

Worktrees, listening ports, databases, and simulator state are read from Git and the operating
system when commands run. AgentSlots does not need a registry that can drift from those sources.

Destructive actions require evidence that a resource belongs to the slot. If ownership is unclear,
cleanup refuses and explains what to inspect. The reaper is a dry run unless explicitly told to
act, and it does not kill an unidentified listener.

Lifecycle commands serialize by canonical Git repository with a stable lock file under
`~/.agent-slots/repos/`, named from the SHA-256 of Git's common directory. With a custom
`AGENT_SIM_LOCK`, the `repos/` directory sits beside that lock. Nested calls inherit the open lock
descriptor so cleanup chains do not deadlock. The machine-wide simulator lock uses a separate mutex beside its lock file.
These files coordinate access; they are not a resource registry or daemon, and the shared `.git`
metadata is not used for lifecycle locks.

Provisioning checks its prerequisites before writing state. If a later step fails, rollback removes
only resources created by that invocation and restores any env file it changed. A failed attempt
must not tear down a competing invocation's resources.

## Project configuration

The tracked `.agent-slots.conf` supplies resource formulas and shell functions for dependency setup,
code generation, and server startup. It is sourced as Bash, so treat it as executable trusted code.
Keep credentials in the project's env file, not in this configuration.

The shared scripts target macOS system Bash 3.2 and BSD utilities. Project hooks keep framework
commands outside the shared runtime. The default setup hook is a no-op; a project adds only the
hooks it needs.

## Queue isolation

A separate database alone is not sufficient if two queue clients still use a shared schema. For
pg-boss, each slot uses its own schema. A nonzero slot may process jobs in that schema but must not
register recurring schedules. Provisioning removes the inherited queue schema from a cloned
database so schedule rows from the source cannot fire in a non-owner slot.

The invariant is: unset `AGENT_SLOT` preserves the existing single-checkout behavior, while a
nonzero slot has a separate queue namespace and cannot create recurring schedule rows. See
[queue isolation](queue-isolation.md) for the integration and a positive-control probe.

## Resource lifecycle

Pausing a task should release its running processes and exclusive device while retaining the
worktree and database for a quick resume. Finishing or abandoning a task should release the stack
and remove its worktree only after its changes are preserved. These operations have different
lifecycles, so the owner chooses the appropriate command.

Orphan reporting exists to make leftovers visible. Automated cleanup must refuse dirty worktrees,
unmerged branches, live listeners, and resources whose ownership cannot be established. A harmless
orphan is safer than deleting another task's work.

## Limits

- Slot 0 remains a shared checkout. Two sessions that both use it can still collide.
- AgentSlots cannot force a session to follow its instructions or keep it from using a shared
  backend.
- Database isolation does not isolate external services or API quotas.
- The supported platform is macOS. Other operating systems and cloud/container backends are outside
  this release's scope.
