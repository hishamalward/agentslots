# Release checklist

## Evidence from v0.1.0

The 0.1 release has historical evidence for shell and TypeScript checks, queue isolation, and a
live two-slot run. Dates, revisions, and limits are recorded in [acceptance.md](docs/acceptance.md).
Those results describe v0.1.0 and do not verify a later candidate.

## Release checks

Before publishing a release:

- Run `npm ci`, `npm run check`, `git diff --check`, and `git fsck --full` from a clean checkout.
- Exercise the installer preview, apply, update refusal for a modified managed file, adoption
  backup, existing AgentKeel policy preservation/coordination grants, and uninstall
  restore/preserve paths in disposable fixture repositories.
- Run `scripts/agent-check.sh --code`, the default stack check, and `--simulator` in the actual
  host session. Record failures without permission escalation; a successful ordinary-host check
  does not establish support under a restricted profile.
- Run the queue positive-control probe against disposable PostgreSQL schemas if queue behavior or
  its integration changed.
- Run the local multi-slot lifecycle on macOS for the exact candidate revision. Record whether
  stack provisioning, ownership checks, pause, cleanup, and the simulator lock passed. Keep prior
  acceptance as historical evidence; do not merge it with a new run.
- For AgentKeel opened clones, record local PostgreSQL, process inspection/cleanup, and
  CoreSimulator results under each host's active profile. Code-tier checks do not establish full
  runtime support. Current restricted profiles that deny a prerequisite are unsupported. Explicitly
  authorized full host access is a separate mode and must be labeled as such; never automatically
  switch profiles, bypass trust, or weaken ownership checks to make a run pass.
- Verify the installer uses the reviewed source revision and does not fetch an unpinned runtime.

Record these checks against the release commit. When only documentation changes after a runtime
acceptance run, identify the tested runtime revision and verify that its executable files are unchanged.

## Publishing

Confirm the intended Git remote, public commit identity, version, and release notes. Push and create
the release tag through the hosting service after review.
