# Acceptance status

The previous 0.2.0 runtime checks exercised the branch-creating and worktree-removing interface. That interface is retired; its results do not verify the current attach-only contract.

For the current 0.3.0 candidate, focused allocation, installer and runtime lifecycle checks plus disposable local service smokes have passed on the current working tree. The complete repository gate (`npm run check`) passed on macOS: shell syntax/ShellCheck, TypeScript, and 94 Vitest tests across 12 files, plus six Python tests. The final shutdown-edge fix then passed the expanded seven-test Python suite. This evidence belongs to the 0.3.0 source candidate; it is not an installed or published release.

Current focused evidence:

- `npx vitest run tests/attach-allocation.test.ts`: 10 tests passed, including absolute worktree attach from outside Git, prepare hook current directory, selective port-only allocation, creation ambiguity, OID checks and env rollback.
- `npx vitest run tests/install.test.ts`: 14 tests passed, including copying the facade and Python runtime helper.
- `npx vitest run tests/runtime-lifecycle.test.ts`: 2 tests passed. A temporary Git worktree smoke also attached web, started `/bin/sleep`, paused it, started it again, and paused it; both recorded leaders were gone afterward and the logs were distinct.
- Live PostgreSQL attach/release smoke used disposable source database `agentslots_src_1792105785_32177` and slot database `agentslots_slot_1792105785_32177_1` on local `localhost:5432`. Queue attach copied the fixture row, wrote `DATABASE_URL` for the slot and `PGBOSS_SCHEMA=pgboss_a1`; release restored the target env, dropped the slot database, and left the source row intact. Cleanup removed the source database; a follow-up catalog query found neither database.
- The focused Python safety suite passed 7 tests after the process-group shutdown regression was added.

The suite covers these acceptance boundaries:

- standalone attach accepts an existing linked worktree without Keel task/session IDs and never creates a branch or worktree;
- a Keel-managed worktree validates the recorded workspace identity;
- service selection allocates only the named resources, with queue selecting its database;
- heartbeat refreshes the lease, pin/unpin controls expiry eligibility, and sweep is dry-run unless `--yes` is explicit;
- release and sweep never remove Git worktrees or branches;
- ambiguous ownership, unknown process state and malformed lease metadata retain resources; release refuses any database without an exact ownership marker;
- installer preview/apply/update/uninstall carries the facade and all runtime helpers while preserving user edits.

No runtime savings or speedup is claimed until measured against a stated baseline on the current revision. Release verification must run against the exact candidate commit; no live simulator or installed-host cutover was performed.
