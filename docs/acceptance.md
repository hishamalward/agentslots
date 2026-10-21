# Acceptance status

The previous 0.2.0 runtime checks exercised the branch-creating and worktree-removing interface. That interface is retired; its results do not verify the current attach-only contract.

The 0.3.0 gate (`npm run check`) covers shell syntax/ShellCheck, TypeScript, 96 Vitest cases across 12 files and 7 Python tests. The two simulator shutdown-failure states run as separate cases with the existing per-case deadline; they retain the same ownership assertions. Check results for the intended revision on [the candidate PR](https://github.com/hishamalward/agentslots/pull/4) before merging or publishing. CI results are source verification, not an installed-host acceptance run.

The automated suites cover allocation, installer behavior and runtime lifecycle. In particular, the lifecycle regression pauses expired owned worktrees across different agent sessions while direct worktree commands still reject a session mismatch.

Disposable service smokes, separate from CI:

- The [recorded web-only demo](demo.md) served real HTTP, paused the owned process and released resources while retaining both Git worktrees; no database, queue or simulator was allocated.
- A temporary Git worktree attached web, started `/bin/sleep`, paused it, started it again, and paused it; both recorded leaders were gone afterward and the logs were distinct.
- A local PostgreSQL fixture used disposable source database `agentslots_src_1792105785_32177` and slot database `agentslots_slot_1792105785_32177_1` on `localhost:5432`. Queue attach copied the fixture row, wrote the slot `DATABASE_URL` and `PGBOSS_SCHEMA=pgboss_a1`; release restored the target env, dropped the slot database, and left the source row intact. Cleanup removed the source database; a follow-up catalog query found neither database.

The suite covers these acceptance boundaries:

- standalone attach accepts an existing linked worktree and never creates a branch or worktree;
- service selection allocates only the named resources, with queue selecting its database;
- heartbeat refreshes the lease, pin/unpin controls expiry eligibility, and sweep is dry-run unless `--yes` is explicit;
- release and sweep never remove Git worktrees or branches;
- ambiguous ownership, unknown process state and malformed lease metadata retain resources; release refuses any database without an exact ownership marker;
- installer preview/apply/update/uninstall carries the facade and all runtime helpers while preserving user edits.

No runtime savings or speedup is claimed until measured against a stated baseline on the current revision. Release verification must run against the exact candidate commit; no live simulator or installed-host cutover was performed.
