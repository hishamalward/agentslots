# Contributing

Keep the runtime compatible with macOS system Bash 3.2 and BSD utilities. Avoid Bash 4 features,
GNU-only flags, mutable resource registries, and shell command strings executed through `eval`.

Before opening a change, run the repository checks and inspect the diff:

```sh
npm ci
npm run check
git diff --check
```

Tests that need Git worktrees must create a disposable repository. Automated tests should not boot
a simulator, create a developer database, kill a real listener, or provision a worktree beside the
source checkout.

For queue changes, retain both assertions: another schema cannot fetch the job, and the originating
schema can. For cleanup changes, test contention and preserve the default refusal when ownership is
unclear.

Keep AgentSlots focused on local runtime resources. Use the project's existing state record for
plans and progress; `--state` may point to it, but the runtime should not generate another task
record.
