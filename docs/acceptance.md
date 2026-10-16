# Acceptance status

The previous 0.2.0 runtime checks exercised the branch-creating and worktree-removing interface. That interface is retired; its results do not verify the current attach-only contract.

The 0.3.0 source candidate’s complete gate (`npm run check`) passed on macOS: shell syntax/ShellCheck, TypeScript, 95 Vitest tests across 12 files and 7 Python tests. This was verified at runtime revision `a98b4438e97a34c72c799ad4c6037b6622e2107a` by both [PR CI](https://github.com/hishamalward/agentslots/actions/runs/38840501116) and [push CI](https://github.com/hishamalward/agentslots/actions/runs/38840497670). The attach-status wording correction additionally passed its two-test integration suite, Bash syntax validation and ShellCheck; it changes only when the preparation suffix is printed. Exact-head checks are available on [the candidate PR](https://github.com/hishamalward/agentslots/pull/4). This is candidate evidence, not an installed or published release.

The automated suites cover allocation, installer behavior and runtime lifecycle. In particular, the lifecycle regression pauses expired owned worktrees across different agent sessions while direct worktree commands still reject a session mismatch.

Earlier disposable service smokes, separate from the CI evidence above:

- A temporary Git worktree attached web, started `/bin/sleep`, paused it, started it again, and paused it; both recorded leaders were gone afterward and the logs were distinct.
- A local PostgreSQL fixture used disposable source database `agentslots_src_1792105785_32177` and slot database `agentslots_slot_1792105785_32177_1` on `localhost:5432`. Queue attach copied the fixture row, wrote the slot `DATABASE_URL` and `PGBOSS_SCHEMA=pgboss_a1`; release restored the target env, dropped the slot database, and left the source row intact. Cleanup removed the source database; a follow-up catalog query found neither database.

The suite covers these acceptance boundaries:

- standalone attach accepts an existing linked worktree without Keel task/session IDs and never creates a branch or worktree;
- a Keel-managed worktree validates the recorded workspace identity;
- service selection allocates only the named resources, with queue selecting its database;
- heartbeat refreshes the lease, pin/unpin controls expiry eligibility, and sweep is dry-run unless `--yes` is explicit;
- release and sweep never remove Git worktrees or branches;
- ambiguous ownership, unknown process state and malformed lease metadata retain resources; release refuses any database without an exact ownership marker;
- installer preview/apply/update/uninstall carries the facade and all runtime helpers while preserving user edits.

No runtime savings or speedup is claimed until measured against a stated baseline on the current revision. Release verification must run against the exact candidate commit; no live simulator or installed-host cutover was performed.
