# Pre-release gap list

This is the honest list of what stands between what is in this repository today and something a
stranger can drop into their own project. It is deliberately the most useful document here right
now: read it before assuming any script "just works" outside the project it was built for.

## Every project-specific literal that must become configuration

Two values are already overridable, at the top of `scripts/lib/agent-slot.sh`:

- `scripts/lib/agent-slot.sh:14` : `AGENT_PG_USER="${AGENT_PG_USER:-tracker}"`, the local
  Postgres role. Override with the environment variable of the same name.
- `scripts/lib/agent-slot.sh:20` : `AGENT_SIM_LOCK="${AGENT_SIM_LOCK:-$HOME/.music_analytics/sim.lock}"`,
  the simulator lock's path. Override with the environment variable of the same name (also useful
  for pointing a test at a scratch file instead of the real, possibly concurrently held, path).

Everything below this line is **not** yet overridable and is hardcoded. Verified by grep against
the copied scripts in this repository, not estimated:

### Database names

`scripts/lib/agent-slot.sh:46-49`, the `agent_db_name` function:

```sh
agent_db_name() {
  if [ "$1" = "0" ]; then printf 'music_analytics_dev\n'
  else printf 'music_analytics_a%s\n' "$1"; fi
}
```

`music_analytics_dev` and the `music_analytics_a<N>` pattern are hardcoded to the source project's
name. This is the single point of concentration for the database-naming scheme: every other script
calls this function rather than constructing a database name itself, so generalizing it here is a
one-function change (plus the ports below, and the worktree prefix). Two references to
`music_analytics` also appear in comments (`agent-up.sh:309-312`) that would need updating to stay
accurate, though they are not executed code.

### Base ports

`scripts/lib/agent-slot.sh:58-62`, the `agent_web_port` and `agent_metro_port` functions:

```sh
agent_web_port() { printf '%s\n' "$(( 3000 + 100 * $1 ))"; }
agent_metro_port() { printf '%s\n' "$(( 8081 + 100 * $1 ))"; }
```

`3000` and `8081` are hardcoded base ports (a Next.js default and an Expo/Metro default,
respectively). A project using different default ports for its web server and its bundler needs
both of these changed, and every script that prints these numbers back to the operator
(`agent-up.sh`'s summary output, `agent-dev.sh`, `agent-mobile.sh`) inherits the new values
automatically once the function changes, since none of them hardcode the numbers themselves.

### The worktree naming prefix

`scripts/lib/agent-slot.sh:74-76`, the `agent_worktree_path` function:

```sh
agent_worktree_path() {
  printf '%s/ma-%s\n' "$(dirname "$(agent_main_root)")" "$(agent_branch_slug "$1")"
}
```

The `ma-` prefix (short for the source project's name) is hardcoded. This is the one other
concentration point: every worktree this system creates or looks for goes through this function.

### The monorepo subdirectory, `apps/web`

This is the largest and most spread-out assumption. The source project is an npm-workspaces
monorepo where the actual application (and its env file, its Prisma schema, its Next.js dev
server) lives under `apps/web/`, and the mobile app lives under `apps/mobile/`. Verified counts,
by grep against each copied script:

| File | `apps/web` references | `apps/mobile` references |
|---|---|---|
| `scripts/agent-up.sh` | 23 | 0 |
| `scripts/agent-dev.sh` | 1 | 0 |
| `scripts/agent-mobile.sh` | 0 | 1 |
| `scripts/lib/agent-slot.sh` | 4 | 0 |
| `scripts/agent-status.sh`, `agent-stop.sh`, `agent-down.sh`, `agent-reap.sh`, `sim-lock.sh` | 0 | 0 |

(23 in `agent-up.sh`, 1 in `agent-dev.sh` and 4 in the library all match a prior inventory of this
same gap exactly; the one addition here is `agent-mobile.sh`'s single `apps/mobile` reference,
which that inventory did not call out.)

The heaviest concentration is `agent-up.sh`'s 23 references, covering: the `.env.local` preflight
refusal (`agent-up.sh:91-92`), reading the source env file to derive a slot's own
(`agent-up.sh:117-121`), the `cd` into the app directory before running codegen
(`agent-up.sh:228`), and every line that writes or edits the slot's own env file
(`agent-up.sh:234-296`, roughly a dozen references clustered here alone). `agent-slot.sh`'s 4
references are both in `agent_tier_of_worktree` and `agent_slot_of_worktree`
(`scripts/lib/agent-slot.sh:140-167`), which both read `"$1/apps/web/.env"` to decide a worktree's
tier and slot.

A project that is not an `apps/web` + `apps/mobile` monorepo, or one where the app is at the repo
root, needs all of these changed. Given how concentrated they are inside `agent-up.sh` and the two
`agent_*_of_worktree` functions in the library, the more maintainable fix is probably a single
`AGENT_APP_DIR` (and, if mobile support is kept, `AGENT_MOBILE_DIR`) variable read once at the top
of each script, rather than editing each of the 28 call sites individually.

### The OAuth redirect URI note (a limit, not purely a config gap)

`scripts/agent-up.sh:288-297` prints a note that `SPOTIFY_REDIRECT_URI` and `GOOGLE_REDIRECT_URI`
still point at port 3000 after a slot's env file is written, because those two values are
registered with the respective OAuth providers and rewriting them to a slot's own port would just
make the provider reject the callback. This is specific to the source project's use of Spotify and
Google sign-in; a project using different (or no) OAuth providers needs this whole check either
removed or rewritten to name whatever equivalent provider-registered URLs it has, if any. This one
is not really a "make it configurable" item: the underlying limit (an OAuth redirect URI cannot be
slotted; platform sign-in stays a slot-0 activity) is real and will recur for any project using
third-party OAuth, just under different variable names.

## Framework and library assumptions, and which scripts hold them

- **Next.js.** `agent-dev.sh:39` execs `npx next dev -p "$PORT"`. A project not using Next.js
  needs this line (and the whole script's port-forwarding logic around it) replaced with its own
  dev-server invocation.
- **Expo / Metro.** `agent-mobile.sh:39` execs `npx expo start --port "$PORT"`. Same story if the
  project's mobile stack, or its bundler, is not Expo.
- **Prisma.** `agent-up.sh:229` runs `npx prisma generate` as the codegen step for a freshly cloned
  worktree, and the surrounding comments (`agent-up.sh:216-218`) explain why this is safe (Prisma
  generates into a path inside the worktree, not into `node_modules`, so generated clients cannot
  collide between worktrees). A project using a different ORM, or none, needs this step replaced
  or removed, and the safety reasoning re-checked for whatever codegen step replaces it (does the
  new project's codegen also write somewhere worktree-local, or could it write into a shared,
  cloned `node_modules` and collide?).
- **pg-boss, and Postgres generally.** The database provisioning in `agent-up.sh` (`createdb`,
  `pg_dump | psql`, the explicit `DROP SCHEMA IF EXISTS pgboss CASCADE` at `agent-up.sh:314`) is
  written directly against `psql`/`createdb`/`dropdb` and against pg-boss's specific default
  schema name, `pgboss`. A project using a different job-queue library, a different schema-naming
  convention, or a non-Postgres queue backend needs this whole block rewritten; the *pattern* (per
  slot: clone the database, then drop the inherited schedule schema so a non-owner slot cannot
  fire cron) is documented project-agnostically in `docs/queue-isolation.md`, but the actual SQL
  and CLI calls here are Postgres/pg-boss-specific.
- **npm workspaces.** The dependency-cloning loop in `agent-up.sh:208-214` walks the tree looking
  for `node_modules` directories up to 3 levels deep (`find "$MAIN" -maxdepth 3 -type d -name
  node_modules -prune`), which assumes an npm-workspaces-style layout with a root `node_modules`
  plus possible per-workspace ones. A single-package repo, or one using a different package
  manager's workspace layout (pnpm's content-addressed store, for instance, works completely
  differently and this cloning strategy would not apply as-is), needs this step reconsidered from
  scratch rather than lightly adjusted.

## The test suite needs a harness

`tests/agent-slot.test.ts` and `tests/agent-up-preflight.test.ts` are real vitest tests that
exercise the shell library and the preflight refusals by shelling out to bash. As included in this
repository they will not run: there is no `package.json`, no vitest dependency installed, and both
files resolve paths relative to the source monorepo's layout (they expect to find `apps/web/`
relative to a project root, and use paths like `apps/web/.env` in their own fixtures). Before these
can run in a new project:

1. Add a `package.json` with a `vitest` dev dependency (and a `test` script).
2. Fix up the path assumptions in both files to match wherever this repo's `scripts/` directory is
   actually dropped, and to whatever the target project's own `apps/web`-equivalent (or lack
   thereof, once the `AGENT_APP_DIR` generalization above happens) actually is.
3. Confirm both files' fixtures still make sense once the database-naming and port-formula
   generalizations above are made; `tests/agent-slot.test.ts` asserts against literal
   `music_analytics_*` database names in several places (for example `agent_db_name 0` expected
   to equal `'music_analytics_dev'`) that would need to track whatever the new project's naming
   scheme produces instead.

## Anything else a stranger would trip on

- **The queue-isolation probe script referenced in `QUICKSTART.md` and `docs/design.md`/section 5
  of the acceptance table does not exist in this repository.** The source project has a small
  `apps/web/scripts/agent-queue-isolation-check.ts` that enqueues a job against one schema and
  confirms it is never consumed by a client configured for a different schema; that script is
  project-specific (it imports the project's own pg-boss wrapper) and was not copied here. Anyone
  adopting this design needs to write an equivalent probe against their own queue client. The
  shape of it is described in `docs/queue-isolation.md`.
- **`scripts/docs-kb.mjs` was deliberately not copied**, per this packaging task's own instruction;
  it is unrelated to the slot machinery (a documentation knowledge-base tool) and living next to
  these scripts in the source repo only by directory proximity, not by design relationship.
- **The reflog-based discriminators inside `agent-reap.sh` and the library
  (`agent_branch_reflog_count`, `agent_branch_has_own_commits`,
  `agent_worktree_provisioned_after_tip` in `scripts/lib/agent-slot.sh:191-242`) rely on git
  reflogs, which are local-only and expire on a default schedule (roughly 90 days).** This is not
  a bug to fix; it is a real, stated limit of the reaper's safety net that a new adopter should
  know about before trusting it on a very old, rarely-gc'd branch.
- **The slot range is hardcoded to 1..9** (`scripts/lib/agent-slot.sh:127`,
  `for n in 1 2 3 4 5 6 7 8 9`), a single-digit assumption baked into the loop itself (and implicitly
  into `agent_slot_valid`'s `[0-9]` pattern at `scripts/lib/agent-slot.sh:25-30`). A project
  expecting more than 9 concurrent agents needs this loop and pattern widened, and should also
  reconsider whether the two-digit port and database-name formulas still produce sensible,
  non-colliding values past slot 9.
- **`scripts/agent-up.sh:154` and other rollback/cleanup lines assume `dropdb`, `createdb`,
  `pg_dump` and `psql` are all on `PATH`** with no explicit check; a machine without a local
  Postgres client toolchain installed gets an opaque "command not found" rather than a clear
  preflight message naming the missing dependency.
- **Everything here assumes macOS with BSD userland and bash 3.2** (see `docs/lessons.md` for why,
  in detail). Porting this to Linux is not a matter of copying the scripts over; several `sed` and
  `stat` invocations use BSD-specific forms that either behave differently or fail outright under
  GNU coreutils, and would need to be identified and rewritten, not merely "tested to see if they
  still work."
