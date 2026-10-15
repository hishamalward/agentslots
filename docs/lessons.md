# Lessons from the shell implementation

AgentSlots targets the Bash and command-line tools shipped with macOS. These lessons came from real failures in that environment and still apply to resource lifecycle code.

## Bash traps need explicit ownership

`ERR` traps have exceptions. A failure inside a function or subshell needs `set -E` for trap inheritance. A failing command in a non-final `&&` or `||` position may skip the trap. Calling `exit` from a function does not trigger it. Cleanup commands can also fail and accidentally start a second rollback.

Provisioning code should track which resources this invocation actually created. Rollback should check those flags and guard best-effort cleanup commands. Avoid hiding a failure by adding a broad `|| true` to the operation that establishes ownership.

## Test the platform's actual utilities

macOS ships BSD `sed`, `stat`, and other tools whose accepted flags can differ from GNU versions. A command that succeeds with Homebrew GNU utilities may fail or return a different value under the system utility. Run shell checks with the target Bash and test the command form on macOS.

## Kill listeners by observed ownership

Development server commands often spawn grandchildren. `$!` can refer to a wrapper process, not the process holding the port. Before stopping a server, inspect the listener on the configured port and verify that the worktree owns it. Never kill by a guessed command-line pattern.

## Concurrency must be deterministic

A cleanup path should be tested against a competing provisioner. Record ownership only after a successful create, then verify it again before deleting. The same principle applies to databases, env files, locks and processes: uncertain ownership should retain the resource.

## Keep responsibility boundaries small

AgentKeel or a developer owns task permissions and Git worktree lifecycle. AgentSlots attaches and releases runtime resources for an existing worktree. Project goals and progress stay in the project's existing state document; AgentSlots does not create plans or handovers.
