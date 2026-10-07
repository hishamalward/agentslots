# Lessons from the shell implementation

AgentSlots targets the Bash and command-line tools shipped with macOS. These lessons came from real
failures in that environment and are useful when changing provisioning or cleanup code.

## Bash traps need explicit ownership

`ERR` traps have exceptions. A failure inside a function or subshell needs `set -E` for trap
inheritance. A failing command in a non-final `&&` or `||` position may skip the trap. Calling
`exit` from a function does not trigger it. Cleanup commands can also fail and accidentally start a
second rollback.

Provisioning code should track which resources this invocation actually created. Rollback should
check those flags and guard best-effort cleanup commands. Avoid hiding a failure by adding a broad
`|| true` to the operation that establishes ownership.

## Test the platform's actual utilities

macOS ships BSD `sed`, `stat`, and other tools whose accepted flags can differ from GNU versions.
A command that succeeds on a developer's Homebrew GNU tool may fail or return the wrong value under
the system utility. Run shell checks with the target Bash and test the command form on macOS.

When using search-and-replace to fix a repeated pattern, check the cases the search could not match,
such as a variable used where the other sites use a literal.

## Kill listeners by observed ownership

Development server commands often spawn grandchildren. `$!` can refer to a wrapper process, not the
process holding the port. Before stopping a server, inspect the listener on the configured port and
verify that the slot owns it. Never kill by a guessed command-line pattern.

## Concurrency must be deterministic

A cleanup path should be tested against a competing provisioner. Marking a worktree as created
before Git creates it can make a losing invocation remove the winner's worktree during rollback.
The same principle applies to databases, env files, and locks: record ownership only after a
successful create, then verify that ownership again before deleting.

## Keep the tool's responsibility small

The runtime can report what Git, the operating system, and PostgreSQL currently contain. Project
goals and progress belong in the project's existing state document; they are not runtime resource
state. A worktree may use `--state` to point at an existing record, but AgentSlots should not
create a second planning or handover system.
