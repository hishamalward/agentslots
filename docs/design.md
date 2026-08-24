# Design: the slot model

**Scope**: local development only. Nothing here changes production behavior.

## 1. The problem

Several agents can work one repository concurrently, launched as separate manual sessions. They
sabotage each other because they share mutable state that a git branch does not isolate.

The incident that motivated this was first diagnosed as "a cron schedule got rewritten." That
diagnosis was incomplete. The real cause was two dev servers running different code against one
shared Postgres-backed job queue. The queue handed a scheduled job to whichever server claimed it
first, and that server's handler was the stale one, with no due-check. A recurring job fired for
every user on the wrong day, which emptied the next scheduled window and silently moved a
measurement baseline.

Any shared queue plus divergent code reproduces this, whatever the schedule expression says.
Queue isolation is the fix; schedule discipline alone is not.

## 2. Verified facts, not assumptions

Before designing around a local environment, the actual facts of that environment were measured,
not assumed: which Postgres port was really in use, whether a template-database clone was viable
(it was not: the source database had live sessions holding it), how fast a `pg_dump | psql`
clone actually was (1.1 seconds), whether the ORM's CLI reads the same env file the app server
does (it did not, and that gap is exactly what section 4.4.3 below exists to close), and whether
the queue library's client actually supported a per-connection schema option (it did).

The general lesson, independent of any of those specific numbers: a design built on assumed facts
about the local environment will be wrong wherever the assumption was, and the wrongness will not
surface until someone hits it live. Measure first.

## 3. Principles

1. **A worktree is filesystem isolation only.** It fixes exactly one of five collision surfaces
   (filesystem, database, ports, job queue, and any exclusive device such as a simulator).
   Treating it as the whole answer is what left the other four unguarded.
2. **Derive state, write down intent.** These are opposite problems and need opposite treatment.
   *State* (what exists, what is running, which branch) is derived from the system (`git worktree
   list`, `lsof`, `psql -l`) and never written down, because a written copy drifts the moment
   reality moves. *Intent* (the goal, the plan, what is next, why a decision was made) cannot be
   derived from anything, so it must be written down, per stream, in version control. A single
   shared "what's in flight" note fails on all three counts at once: it is one file for every
   stream, it typically ends up excluded from version control (so it never travels with the work),
   and it mixes the two categories, so its stale state half destroys trust in its intent half.
3. **A lock file is a claim, not an authority.** Where a lock is unavoidable (an exclusive device
   such as a simulator), liveness is always re-verified against the OS, so a stale claim is
   detected and broken rather than trusted.
4. **Absence of configuration preserves today's behavior.** Every new environment variable
   defaults to the current value. The feature cannot break the normal path by being unset.
5. **Collisions must be loud.** Prefer a design that fails at setup over one that half-works and
   is discovered three hours into a debugging session.

## 4. Design

### 4.1 Two tiers, and the slot model

**A slot is a stack reservation, not a worktree identity.** This distinction is the whole economy
of the design: a worktree is cheap and everyone gets one, while ports and a database are scarce
and are claimed only by work that actually boots a server.

The evidence, from the source project: its entire unit test suite (hundreds of tests) passes in
single-digit seconds with no database URL configured at all. Provisioning a database for
test-driven work is pure waste when the tests never touch one.

| Tier | Command | Provisions | Cost |
|---|---|---|---|
| **Code** (default) | `agent-up.sh <branch>` | worktree, dependencies, generated code | seconds, no DB, no ports, no slot |
| **Stack** (opt-in) | `agent-up.sh <branch> --stack` | above, plus slot, database, env file, ports | closer to a second more |

Worktree directories are named from the branch, so the code tier needs no slot number at all. A
code worktree can be upgraded in place later with `--stack`, so choosing the cheap tier first is
never a decision you have to undo.

**Slots, claimed only by the stack tier:**

```
AGENT_SLOT=0   the main tree, the default, unchanged
AGENT_SLOT=N   a booted stack, N in 1..AGENT_SLOT_MAX
```

| Resource | Formula | Slot 0 | Slot 1 | Slot 2 |
|---|---|---|---|---|
| Database | `<project>_a<N>` | `<project>_dev` | `..._a1` | `..._a2` |
| Web port | `3000 + 100N` | 3000 | 3100 | 3200 |
| Bundler port | `8081 + 100N` | 8081 | 8181 | 8281 |
| Job-queue schema | `pgboss_a<N>` | `pgboss` | `pgboss_a1` | `pgboss_a2` |
| Schedule owner | `N == 0` | yes | no | no |

Slot 0 carries three consequences, and they are the point of the design:

1. **Isolation is opt-in, and cheap by default.** Code-only work takes a worktree and nothing
   else. The expensive resources are paid for only when a stack is actually booted.
2. **The dangerous write has one owner.** Only slot 0 may write the queue's cron schedules.
3. **Nothing regresses.** Unset means slot 0, which is byte-identical to today.

### 4.2 A clean baseline is a prerequisite

The slot model derives every value from a baseline (the default database name, the default
ports, the local Postgres connection details). If that baseline is itself duplicated across
several files and has drifted, the slot model propagates the drift into every slot it derives. In
the source project this took the shape of a Postgres port written in six different places, five
of which had gone stale. The generalizable rule: **one document is the sole authority for local
dev facts, and everything else links to it rather than restating values.** A fact stored once
cannot disagree with itself. Doing this cleanup before building the slot machinery is worth
calling out as its own step, because a design built on a wrong baseline looks correct and behaves
wrong.

### 4.3 Provisioning

`agent-up.sh <branch> [--stack]`

**Preflight.** Refuses loudly and changes nothing if any check fails. A half-provisioned worktree
is worse than none because it looks ready and behaves wrong.

Code tier:

1. The worktree path does not already exist.
2. The branch is not already checked out in another worktree.

Stack tier adds:

3. A slot in the configured range is free (auto-assigned, lowest free).
4. Web and bundler ports are free.
5. The slot's database does not already exist.
6. The template database is reachable.

**Provision**, in order: create the worktree; clone dependencies; run the project's codegen step
(if any); write the slot's env file; clone the database; drop the inherited job-queue schema from
the clone.

**Dependencies are always cloned, never symlinked.** A symlink would cut setup time
significantly, but it reintroduces the exact failure this design exists to remove: any package
install in a symlinked worktree writes through to the main tree, and the package manager
reconciles the shared dependency tree against whichever worktree's lockfile is installing, so it
can *remove* packages another worktree still depends on. Paying the clone cost once is cheaper
than one silent cross-worktree dependency change. On a filesystem with copy-on-write support
(APFS on macOS), a clone is inode creation rather than data copying, so the cost is real but small
(under 20 seconds for tens of thousands of files in the source project).

Two mitigations for the symlink idea were considered and rejected, recorded so they are not
re-proposed: diffing the branch's lockfile against main before deciding to share is useless for
the common case, because a branch freshly cut from main has no diff yet, precisely when work is
starting; and there is no clean way to catch a dependency added mid-stream, because an ordinary
package install gives the package manager no reason to refuse.

**Cloning creates the inverse risk, which is handled.** A cloned dependency tree is a snapshot, so
rebasing onto a base branch that changed dependencies leaves the worktree's packages stale while
its lockfile moves ahead. The symptom is a confusing import or version error that looks like a
code bug. This is detectable (most package managers leave an internal marker file whose mtime can
be compared against the lockfile's), so the status script reports "dependencies may be stale, run
install" per worktree, and the merge sequence checks it after rebasing, before running tests.

**Choosing a tier: do not predict, default and upgrade.** Nobody has to guess at the start whether
a stream will need a stack. Every worktree starts at the code tier, and upgrades the moment a
concrete need appears: running a dev server, running a database migration, exercising the job
queue, or driving an exclusive device.

`agent-up.sh <branch> --stack` run inside an existing code worktree is idempotent: it skips the
worktree and dependency steps, and adds only the missing pieces. That is fast, so mid-stream
upgrades are cheap and the cheap first choice is never one you have to undo.

**The missing tier must fail loudly.** A code-tier worktree has no env file with a database URL
in it, so starting a dev server there would boot and then fail on every database-backed route,
which is a confusing symptom that reads like a code bug. So the dev-server and bundler scripts
check the tier first and refuse with the exact command to fix it:

```
this worktree is code tier (no slot, no database)
run: agent-up.sh <branch> --stack
```

There is no downgrade command. Dropping a database to reclaim disk space is not worth a script;
tearing a slot down and re-provisioning covers the rare case.

**The `DROP SCHEMA` step on the cloned database is not optional.** The dump carries the default
job-queue schema with its live cron rows. Dropping it means the queue library creates the slot's
own schema fresh, with an empty schedule table, so a non-owner agent runs no cron at all. Agents
trigger jobs explicitly instead. No agent's stack can spontaneously fire a scheduled job, which
removes the entire class of failure from section 1.

### 4.4 The production code change

Two changes, both defaulting to today's behavior when unset. Full detail, including why a second,
inversely-named variable is a trap: `docs/queue-isolation.md`.

1. The queue client's constructor takes a `schema` option, defaulting to the library's own default
   schema name, giving every slot its own namespace inside the same job-queue library.
2. A one-line guard before the schedule-registration calls: if the running slot is not slot 0, the
   function returns before registering any schedule. Unset means slot 0 means owner, so production
   and the main tree keep today's behavior with nothing configured.

Two more considerations that generalize past this specific queue library:

**Slot configuration must live wherever the ORM/CLI actually reads it**, not merely wherever the
app server reads it, if those two differ. In the source project, the ORM's CLI loaded one env
file and ignored a second, more locally-scoped one; had the slot override lived in the file the
CLI ignores, the app server and a database-migration command would have silently pointed at two
different databases from the same worktree, which is worse than the isolation problem this design
set out to solve.

**Ports go through explicit flags, not a generic `PORT` environment variable**, when whether the
dev server picks that variable up from an env file depends on load order that is easy to get
wrong; a port silently falling back to the default collides with the main stack, which is the
exact failure this prevents.

### 4.5 The exclusive-device lock

Some resources are genuinely exclusive and cannot be slotted at all. In the source project this
was an iOS Simulator, for two reasons that generalize to any physical or virtual device shared
across agents: an installed app identity is shared, so an install from one agent overwrites
another agent's install; and the simulator tooling's "currently booted device" shorthand is
ambiguous when two devices are booted, so commands can silently target the wrong one.

So: one such device at a time, enforced by a lock.

`sim-lock.sh <acquire|release|status> [slot]`

Lock file outside every worktree (so removing a worktree cannot orphan it, and every slot sees the
same lock). Contents: holding slot, pid, device id, acquired timestamp.

- **acquire**: if a lock exists, verify the holder is alive (process alive, and the device still
  reports booted). Alive means refuse, naming the holding slot, pid, and how long it has been
  held. Dead means the lock is stale: break it loudly, reporting who held it and that it was
  broken. Then boot the device and write the lock.
- **release**: verify the caller's slot matches the holder (refuse otherwise, with a force option
  to override), shut the device down, remove the lock file.
- **status**: print holder, liveness and age.

This is principle 3 in practice: the file is a claim, the OS is the authority. A crashed agent
cannot deadlock the device for everyone else.

### 4.6 Resource lifecycle: nothing outlives its task

Isolation creates resources, and resources that outlive their task are a leak. One booted slot in
the source project cost roughly 600 MB of RAM across a couple dozen processes, plus a
gigabyte-scale dependency tree (copy-on-write, so near-zero marginal disk at first) and a
double-digit-megabyte database. A few slots left running idle adds up to real, wasted RAM.

**Rule: every provisioned resource has exactly one owning slot and a defined end of life.**

There are two distinct endings, and conflating them is why orphans accumulate:

| Event | Command | What happens | What survives |
|---|---|---|---|
| Task done for now, agent idle | `agent-stop.sh <N>` | kill the dev server and bundler, shut the device, release the device lock | worktree and database, so work resumes instantly |
| Branch merged or abandoned | `agent-down.sh <N>` | everything above, then remove the worktree, drop the database, prune | nothing |

**Stop when you pause. Down when you merge.** A merged branch whose slot is still provisioned is
the orphan case: the work is already merged, so the worktree and database are pure waste.

**Orphan detection.** The status script flags, without being asked: a slot database with no
matching worktree; a worktree whose branch is fully merged (the merged-but-not-torn-down case); a
listening slot port with no matching worktree; a device lock whose holder process is dead; a
worktree with no live process, showing reclaimable disk.

`agent-reap.sh` acts on those findings. It is dry-run by default, printing each orphan, why it is
considered one, and what it would reclaim. `--yes` executes.

**The reaper's safety rule mirrors `git branch -d`: it refuses to destroy a worktree whose branch
is not fully merged, and refuses any worktree with uncommitted changes.** Automated cleanup that
can eat unmerged work is worse than the orphans it prevents. Anything it refuses is reported
loudly rather than skipped silently, so a genuinely stuck slot is visible instead of invisible.

**Merge is the trigger.** Finishing a branch means running the teardown command as part of the
merge, not later. Since manual sessions cannot be enforced, the status script names
merged-but-live slots every time it runs, so the reminder arrives without anyone having to
remember it.

### 4.7 One handover per stream: continuing someone else's work

A status command answers "what is running." It cannot answer "what was this for, how far did it
get, and what comes next," because none of that is derivable. A new session picking up a branch
needs exactly that.

**One document does this: a per-stream handover.** An earlier draft of this design split state and
intent into two separate documents. That was wrong twice over, and both errors are recorded here
so the split is not re-proposed:

1. It invented a second artifact against a working single-document convention. Two documents means
   two places to update, and the smaller one rots first.
2. It dropped the "what's done" section on the theory that commit history derives it. Commit
   history does not: it shows which commits landed, not that a given planned task actually passed
   its own acceptance check. Which planned task is complete is intent, not state, so it must be
   written down. This was the "derive state, write down intent" principle misapplied to the intent
   side.

**Path**: one file per stream, named from the stream, committed to its own branch, so two streams
cannot collide, its history is reviewable, and merging the branch brings it along automatically.

**It survives the merge** and becomes the record, marked with its outcome. A later session reading
a finished-and-merged handover should be able to tell it is finished from the document itself.

**Sections**, adapted from the project's most structured existing handover template:

```markdown
# <stream>: handover

Goal: one sentence. What is true when this stream is done.
Status: in progress | MERGED <date> | abandoned <date and why>
Spec: link to the design doc, if any.

## The shape of it in one paragraph
## Current state in code        <- the ledger: what is built, task by task, with verify status
## What will bite                <- the gotchas that cost the last agent a debugging round
## Not built, in the order I would build it
## In flight                     <- the one thing being worked on right now
## Blocked                       <- what, and on what or whom
## What is decided (do not re-litigate)
## Open questions                <- for whoever owns the decision
## Verification protocol
```

`## What will bite` is the most useful section in the whole document and has no equivalent
anywhere else; see `docs/lessons.md` for what it captured on this project.

**The rule that survives from the earlier draft: no derivable state.** No branch names, no ports,
no slot numbers, no "the tree currently sits on." The status command answers those accurately,
and a second written copy is a lie waiting to happen. This is what keeps the two systems
complementary rather than competing.

**Staleness is detectable, so it gets detected.** The handover is committed, so the last commit
touching it can be compared against the branch tip. The status command reports "handover is N
commits behind" per worktree. That is a derived fact *about* an intent document, which is the
right division of labor: the system cannot know what you meant, but it can know you have not said
anything in twenty commits.

**Update points**: after finishing any item, and always before stopping or tearing down a slot.
Session task lists (the ephemeral, per-session todos an agent keeps) are invisible to every other
session, so they get flushed into the handover before a session ends. An unflushed task list is
lost work.

### 4.8 Branching and merging

**One slug derives everything**, for new streams. Pick a stream name in kebab-case, carrying no
date and no phase number, and derive the branch name, the handover path and the worktree path from
it consistently. Stripping the branch-type prefix (`feat/`, `fix/`, and so on) from the branch name
yields the slug, and therefore the handover path, which is exactly the derivation
`scripts/lib/agent-slot.sh` implements.

**Phases stay inside one stream.** A stream keeps one slug and one handover across its phases, with
each phase as a section in the ledger. If a phase genuinely needs its own branch, the phase suffix
strips back to the same slug and the same handover. A stream that spawns a second handover has
usually become two streams.

**Existing names are not migrated.** Renaming a project's existing plan documents to match a new
convention rewrites every reference to them for purely cosmetic gain. The convention applies to new
streams; a per-worktree pointer file (gitignored, dies with the worktree) covers legacy streams
whose handover does not follow the naming convention.

**Three things at once means three branches, three worktrees, and usually zero or one slot.** Most
streams are code-only, so they take a worktree and nothing else. A slot is claimed only by the
stream that actually boots a server.

**No integration branch.** Trunk-based: every branch merges to the mainline directly, and conflicts
are resolved on the branch before the merge, not in a shared staging area. A shared staging branch
is a second place for conflicts to live and rot, and with only a handful of concurrent streams it
does not pay for itself.

The merge sequence, and the reason it is strict:

```
git fetch origin
git rebase origin/main          # or merge main in, resolve here
agent-status.sh                 # did the rebase move the lockfile past the dependency tree?
<package manager> install       # only if the line above says stale
<test command>                  # the fast, DB-free suite
# main must move, never whatever tree this happens to run in. Find the worktree that has
# main checked out and merge there; if none does, main is safe to fast-forward directly.
agent-down.sh <N>                # if the branch held a slot
```

The staleness check sits between the rebase and the tests deliberately. A rebase that pulls in a
dependency change leaves a cloned dependency tree behind the lockfile, and the resulting test
failures look like code bugs rather than environment drift.

**If the mainline auto-deploys on every push**, then a broken merge is a broken production, not
just a broken build, which is the reason conflicts are resolved on the branch: the branch can be
red for an hour, the mainline cannot be red for a minute.

**Side missions.** A side mission is just another branch, and the only real question is what it
branches from: an independent one takes a new worktree from the mainline and merges on its own
schedule; one genuinely built on unmerged work branches from the parent stream, merges back into it
first, then the parent merges to the mainline. Default to branching from the mainline unless the
side mission literally cannot compile without the unmerged code; branching from a feature branch
couples two things that did not need coupling, and the coupling only shows up at merge time.

**Never nest a worktree inside a worktree.** Take a sibling directory, always.

### 4.9 Protocol summary

The status script reads `git worktree list`, `lsof` and the database's own catalog, and prints
which slots exist, on what branch, which ports are live and which databases exist. It stores
nothing, so it cannot go stale. An agent picking a slot asks reality, not a document.

Short enough to read before starting work:

1. Code and tests need no slot, just a worktree: `agent-up.sh <branch>`.
2. Booting a stack adds the stack tier: `agent-up.sh <branch> --stack`. The slot is assigned for
   you, lowest free.
3. Only slot 0 writes cron schedules, and that follows from one variable alone. Never introduce a
   second variable for it (see `docs/queue-isolation.md`).
4. An exclusive device requires `sim-lock.sh acquire <N>`. Release when done.
5. In your own worktree, broad-add commits are safe. In a tree you do not own, use explicit paths.
6. Never point a local server at a shared or production backend. Local is the only sanctioned
   local backend.
7. **Stop when you pause, down when you merge.** `agent-stop.sh <N>` kills your processes and
   frees the RAM. `agent-down.sh <N>` destroys the slot entirely, and is part of merging, not an
   afterthought. Leaving a merged slot provisioned is the orphan case.
8. Run `agent-status.sh` before claiming a slot. It names orphans and reclaimable resources.
9. Read your stream's handover before your first write, and update its ledger before you stop.
10. Branch from the mainline unless your work literally cannot compile without someone's unmerged
    code. Rebase onto the mainline and run the tests before merging, never after.

## 5. Acceptance test

Reproduce the original incident and prove it cannot happen. The full results, with real evidence
from a live run, are in `docs/acceptance.md`.

| Check | Pass condition |
|---|---|
| Two slots provisioned on different branches | both boot, and both respond |
| Databases distinct | writes in one slot are invisible to the other |
| Non-owner schedule | non-owner slots' schedule tables are both empty |
| Main untouched | the main database's schedule table is unchanged |
| **Queue isolation** | a job enqueued in one slot is never consumed by another slot's server |
| Exclusive-device lock | a second slot's acquire is refused while the first holds it |
| Stale lock | a lock whose holder is dead is broken automatically, with a message |
| Stop keeps state | stopping frees the RAM, worktree and database survive, work resumes |
| Down destroys | teardown leaves no worktree, no database, no lock, no listening port |
| Orphan detection | a merged branch with a live slot is reported unprompted |
| **Reaper safety** | the reaper refuses an unmerged branch or a dirty worktree, and says so |
| No leaks after a full cycle | provision two slots, merge both, reap: everything back to baseline |
| Handover isolation | two streams edit their own handovers concurrently with no conflict |
| Handover travels | merging a branch brings its handover along with the work |
| Ledger is honest | a task marked done in the handover has actually passed its verify gate |
| Staleness detected | the status command reports the handover is N commits behind |
| Code tier is cheap | the plain provisioning command creates no database, claims no slot |
| Tier upgrade | `--stack` on an existing worktree adds the stack without redoing the worktree |
| Missing tier is loud | starting a server on a code-tier worktree refuses and names the fix |
| Stale deps caught | the status command flags a dependency tree that may be stale before tests run |
| **Cold pickup** | a session given only a branch name, its handover and the status output can state the goal, what is done, what is in flight and what is next, without asking |

The queue isolation row is the whole design in one assertion. The no-leaks row is the one that
keeps the machine usable a month from now.

## 6. Known limits

Stated plainly, because a design that oversells its guarantees is worse than one that does not.

- **A shared or production backend is still shared.** Nothing mechanically stops an agent from
  pointing a local server at it; that stays a protocol rule enforced by discipline, not code.
- **API quotas and any metered spend are global.** Two agents doing the same metered work burn one
  budget twice as fast.
- **Slot 0 remains a shared tree.** Two agents both working slot 0 collide exactly as before. This
  makes isolation available and cheap, not mandatory.
- **Manual sessions cannot be enforced.** Launch is by hand, so nothing stops a session skipping a
  step it never read. This system rewards correct use; it does not prevent misuse. Enforcement
  would need hooks into the launching tool, which is out of scope here.

## 7. Design decisions locked in during this work

- A shared staging or "integration" branch was considered and rejected: trunk-based, rebase onto
  the mainline and resolve conflicts there, is the simpler discipline for a small number of
  concurrent streams.
- One document per stream carries both the plan and the ledger, rather than a separate plan
  document plus a separate progress note. The single-document convention already existed for other
  work in the source project and was extended here rather than replaced.
- Dependencies are always cloned into a new worktree, never symlinked, despite the extra seconds of
  setup cost, because a symlink reintroduces the cross-worktree dependency corruption this design
  exists to prevent.
- One slug derives the branch, handover and worktree paths, for new streams only; existing streams
  keep their names and rely on a per-worktree pointer file instead of a rename.
- The handover template combines an existing project's most complete template with four additions
  the multi-agent case specifically needs (Status, In flight, Blocked, Open questions).

## 8. What is not in this repository

The corresponding "clean up the local dev baseline first" work (section 4.2) was a set of
project-specific documentation and config fixes and is not included here, since none of it applies
outside the source project. What generalizes from it is principle 4.2's own rule: keep local dev
facts in exactly one place. This repository ships the configurable shell machinery, a project
adapter example, importable pg-boss integration helpers, and an executable positive-control probe.
