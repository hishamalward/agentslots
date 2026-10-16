# Development environment

The installer and runtime workspace-ownership checks require Python 3.10 or newer. This repository's
own checks require macOS, system Bash 3.2, Node.js 22.12 or newer, npm, and ShellCheck
(`brew install shellcheck`). Run:

```bash
npm ci
npm run check
```

`npm run check` includes the shell checks, Python safety suite, TypeScript type check and Vitest tests.

The unit and temporary-repository integration tests do not touch a developer database or boot a
simulator. The optional live queue test requires PostgreSQL 13 or newer and two schema names; see
`docs/queue-isolation.md`.

Projects adopting the scripts define their local database, app paths, ports, and framework hooks
in a tracked `.agent-slots.conf`; see `docs/configuration.md`. Credentials stay in the project's
configured application env file and are copied with the database name rewritten for each slot.
