# Release checklist

## Evidence from v0.1.0

The 0.1 release has historical evidence for shell and TypeScript checks, queue isolation, and a
live two-slot run. Dates, revisions, and limits are recorded in [acceptance.md](docs/acceptance.md).
Those results describe v0.1.0 and do not verify a later candidate.

## 0.2.0 candidate release checks

Before publishing a candidate:

- Run `npm ci`, `npm run check`, `git diff --check`, and `git fsck --full` from a clean checkout.
- Exercise the installer preview, apply, update refusal for a modified managed file, adoption
  backup, and uninstall restore/preserve paths in disposable fixture repositories.
- Run the queue positive-control probe against disposable PostgreSQL schemas if queue behavior or
  its integration changed.
- Run the local multi-slot lifecycle on macOS for the exact candidate revision. Record whether
  stack provisioning, ownership checks, pause, cleanup, and the simulator lock passed. Keep prior
  acceptance as historical evidence; do not merge it with a new run.
- For AgentKeel opened clones, verify local PostgreSQL and process inspection/cleanup under each
  host's normal sandbox. Code-tier host checks do not establish isolated stack support. Keep full
  sandbox acceptance pending while either host blocks a required local operation; never disable the
  sandbox or bypass ownership checks to make the run pass.
- Verify the installer uses the reviewed source revision and does not fetch an unpinned runtime.

The 0.2.0 release is pending until these checks are run and recorded against its exact commit.

## Publishing

Confirm the intended Git remote, public commit identity, version, and release notes. Push and create
the release tag through the hosting service after review.
