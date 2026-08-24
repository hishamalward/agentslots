# Contributing

Keep changes compatible with the macOS system Bash 3.2. Avoid Bash 4 features, GNU-only utility
flags, mutable registry files, and command strings executed through `eval`.

Before opening a change:

```bash
npm ci
npm run check
git diff --check
```

Tests that need Git worktrees must create a disposable repository under the OS temporary
directory. Automated tests must not boot a simulator, create a developer database, kill a real
listener, or provision a sibling worktree beside this checkout.

Changes to queue isolation should retain both directional assertions: another schema cannot fetch
the job, and the originating schema can. Changes to cleanup should default to dry-run or refusal
when ownership cannot be proven.
