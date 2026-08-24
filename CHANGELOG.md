# Changelog

All notable changes are documented here.

## 0.1.0

- Added configurable database, port, path, mainline, env-key, slot-range, and worktree formulas.
- Added project hooks for dependency setup, code generation, servers, and dependency staleness.
- Added importable pg-boss isolation helpers and a live positive-control probe.
- Fixed simulator liveness so both the owner and recorded device must remain alive.
- Armed worktree rollback before creation and added disposable-repository integration tests.
- Added prerequisite and destructive-target safety checks.
- Added a runnable TypeScript/Vitest harness and macOS CI.
