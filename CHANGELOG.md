# Changelog

All notable changes are documented here. Release checks are listed in `PRE-RELEASE.md` and
must be run against the exact release revision.

## 0.3.0 candidate

- Attach selected local runtime resources to existing worktrees and manage leases without creating or removing Git branches/worktrees.
- Add identity-checked process start, pause, release, expiry sweep, and an optional launchd example that the installer does not activate.
- Install the `agent-slots` facade and its runtime helpers while preserving user edits to managed files.
- Upgrade 0.2 install manifests and restore unchanged retired command wrappers safely.

## 0.2.0

- Adopted AgentSlots as the display name and `agentslots` as the repository and package name.
- Added a preview-first installer for a pinned local runtime and thin project wrappers.
- Added ownership checks for shared provisioning, process identity, Metro reuse and simulator resources.
- Added onboarding for AgentKeel coordination access and a runtime capability check.
- Made simulator release claim-aware, with a keep-device option and retained ownership on shutdown failure.
- Replaced generated task handovers with an optional pointer to an existing state document.
- Added concise Markdown contributor guidance and original SVG brand artwork.

## 0.1.0

- Added configurable database, port, path, mainline, env-key, slot-range, and worktree formulas.
- Added project hooks for dependency setup, code generation, servers, and dependency staleness.
- Added importable pg-boss isolation helpers and a live positive-control probe.
- Fixed simulator liveness so both the owner and recorded device must remain alive.
- Armed worktree rollback before creation and added disposable-repository integration tests.
- Added prerequisite and destructive-target safety checks.
- Added a runnable TypeScript/Vitest harness and macOS CI.
- Added ShellCheck to `npm run check` and repository metadata to `package.json`.
  ShellCheck is a Homebrew prerequisite, not an npm dependency.
- Replaced source-project names in the acceptance and queue-isolation documents with the example
  configuration's names.
