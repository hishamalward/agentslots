# Lessons

Every entry below cost a real debugging round on the source project. All of it is verified on the
system bash macOS ships, specifically bash 3.2.57, not a newer bash installed alongside it and not
bash 5. If you are reading this because a guard "isn't firing" or a script silently corrupted
something, check whether you are running these scripts under a different bash first: several of
these behaviors are version-specific, and bash 3.2 is what `scripts/agent-up.sh` and friends are
written and verified against.

## Four ways a bash guard silently does nothing

`agent-up.sh` provisions a worktree in several steps and needs a rollback if any step after the
first fails, so a failed provision never leaves a half-built worktree that looks ready and behaves
wrong. Getting that rollback to actually fire, every time it should and never when it should not,
took four separate rounds of review to close, because bash's `ERR` trap has four distinct ways to
silently not run:

1. **No `set -E` means the `ERR` trap is not inherited into functions or subshells.** Without it, a
   failure inside a function call or a `( ... )` subshell can trip `set -e` and abort the script,
   while the trap set at the top level never fires and the rollback never runs.
   `scripts/agent-up.sh` sets `set -Eeuo pipefail` deliberately, deviating from a more familiar
   `set -euo pipefail`. Do not "correct" it back; that E is load-bearing.

2. **A non-final command of an `&&` or `||` list is exempt from `ERR`, even with `-E`.** `( cd X &&
   cmd )` skips the rollback if `cd` fails, because `cd` is not the last command in that list. The
   fix is not a smarter trap; it is not writing the pattern in the first place. Use two separate
   statements: `cd X` on its own line, then `cmd` on the next. That makes `cd`'s failure the whole
   (and therefore non-exempt) command.

3. **`exit` inside a function bypasses `ERR` entirely.** Any `fail()` helper that calls `exit`
   after the trap is armed leaks whatever the rollback was supposed to clean up, silently. Any
   `fail`-style call made after the trap is set has to call the rollback function explicitly before
   exiting; the trap will not do it.

4. **The inverse failure is worse: an unguarded cleanup line can fire a spurious rollback that
   destroys a resource that was provisioned correctly.** `rm -f` on a file with, say, a permission
   problem still returns nonzero. If that line sits inside the code region the `ERR` trap is armed
   for, its nonzero exit trips the trap and undoes work that had already succeeded. Every
   cleanup-only statement in the trap-armed region has to end `2>/dev/null || true`, including on
   the success path, not only inside the rollback function itself.

None of these four is hypothetical. Each was found by a review pass actually reading the script
against these specific failure shapes, not by reading the plan that described the intended
behavior; the intended behavior read fine on paper every time.

## macOS is BSD userland, not GNU

`sed`, `stat`, and several other common tools differ in flag support and even in what syntax is
accepted at all between the BSD versions macOS ships and the GNU versions common on Linux and
frequently installed alongside macOS's own. The concrete trap: reading a value out of a `KEY=value`
line has to be written

```sh
sed -n '/^KEY=/{s///p;q;}' file
```

The more natural-looking form

```sh
sed -n 's/^KEY=//{p;q;}' file
```

is a GNU extension, and BSD sed rejects it outright with `bad flag in substitute command`. A
revision to this project's scripts introduced that second form in about twenty places while trying
to remove a theoretical `SIGPIPE` hazard from a `sed | head` pipeline that, on the actual file sizes
involved (a couple hundred bytes), could never actually fire. Every keyed read using the broken form
would have returned empty, and every port or slot value derived from it would have silently
collapsed to whatever the empty-string default was, which in this project's case was the main
tree's own port. Do not fix a hazard the measured inputs make unreachable, and when you do touch
code like this, run it on the actual target shell before trusting that it "should" work the same as
elsewhere.

## A find-and-replace is itself a change that needs verifying against what it did not match

The sweep that fixed the GNU-sed mistake above caught nineteen of twenty sites. The twentieth used
a shell variable as the substitution key (`s/^$1=//{p;q;}` inside a function) rather than a literal
string, so the search pattern used to find and fix the other nineteen never matched it. A trailing
`|| true` on that same line swallowed the resulting error, so the mistake did not even announce
itself with a script failure; it just returned the wrong (empty) value quietly. When you fix a
pattern by search-and-replace, explicitly check what the search term could not have matched, not
just what it did.

## A guard written in the same pass as its own fix can inherit the fix's blind spot

A test was added specifically to ban the GNU-only sed form above. It had two failure modes at
once, both introduced in the same commit that was supposed to close the original mistake: it
matched a comment that quotes the banned form in order to warn against it (so it failed on
correct, intentional code), and it could not match the variable-keyed site described above (so it
missed the real remaining offender). A guard is not exempt from the review a fix needs; if
anything it needs more scrutiny, because it is trusted afterward as evidence the class of bug is
closed.

## Never assume a file is tracked by version control

Run the tool's own "is this ignored" check before writing any logic that assumes a file's tracked
status one way or the other. A machine-wide, user-level ignore file, invisible from inside any
individual repository's working tree, excluded a settings file this project assumed was tracked. A
project-level ignore rule, buried well into a long `.gitignore`, excluded another file the plan
assumed would be committed. Both wrong assumptions shipped into a plan before anyone checked; both
were only caught by actually running the ignore-check command against the real path.

Relevant here specifically: an env-file backup this design makes during a stack upgrade is written
outside the worktree entirely (to the system temp directory), specifically because an untracked
file sitting inside the worktree makes the worktree-removal command refuse to remove it, and makes
the orphan reaper treat the whole worktree as dirty and refuse to reap it.

## The main working tree can move under you

If several agents share one machine, the primary checkout's current branch is not a safe constant
to hardcode into a fixture or a test. It changed branches more than once during this project's own
development. Every script and every test here derives the main worktree's current branch at
runtime instead of assuming a fixed name, and guards the detached-HEAD case explicitly.

## A dev server is a grandchild process

A typical "run the dev server" command (for example, a framework's own dev-server wrapper) forks a
child process, which itself forks the actual listener, whose process name in `ps` output matches
neither the original command you ran nor anything obviously derived from the port number. Do not
try to track it with a shell's `$!` (that only captures the immediate child, not the grandchild
that is actually listening) and do not try to kill it with a pattern match against the original
command line (`pkill -f "the original command -p N"` will not match the grandchild's own argv
either). The reliable approach is to kill by whatever is actually listening on the port, and then
wait for the port to actually clear before proceeding, rather than assuming the kill was
instantaneous. A server process that lingers after a kill signal holds its database connections
open, and the next attempt to drop that database will fail with a "still in use" error that looks
unrelated to the kill that preceded it.

## A killed subagent (or any interrupted automation) leaks resources

If whatever is running these scripts (a CI job, an automated agent, a script driving a script) is
itself killed or interrupted mid-run, it can leave a worktree half-provisioned and an edit
uncommitted, with nothing automatically noticing. Check `git worktree list` and the database
server's own list of databases after any interrupted run; do not assume a clean state just because
nothing reported an error.

## General framing

Every one of the above was found by a review pass or a live failure, not by reading a plan or a
spec and reasoning about intended behavior. Intended behavior reads fine on paper every time; the
shell's actual exemptions, the actual OS-level differences, and the actual process tree shape are
what bite. If you adapt these scripts for a different bash version, a different OS userland
(Linux/GNU rather than macOS/BSD), or a different dev-server toolchain, re-verify each of the above
against that specific target rather than assuming the same shape holds; several of them are exact
opposites of what you would guess from first principles (BSD sed's stricter syntax being the
correct choice here, not the "obviously more standard" GNU form, is the clearest example).
