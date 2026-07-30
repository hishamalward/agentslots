# Queue isolation

This is the piece of the design with the least prior art and the most transferable value: how to
make a shared, Postgres-backed job queue safe for several agents to run against concurrently,
without duplicating the whole database. The production-code change in the source project was 13
lines, in one file (`lib/jobs/boss.ts` in that project, using the `pg-boss` library). Reproduced
here exactly as it shipped:

```diff
 export function getBoss(): PgBoss {
   if (!_boss) {
-    _boss = new PgBoss(process.env.DATABASE_URL!);
+    // PGBOSS_SCHEMA gives each agent slot its own queue schema (spec 4.4.1). Unset means
+    // 'pgboss', pg-boss's own default, so prod and the main tree are unchanged.
+    _boss = new PgBoss({
+      connectionString: process.env.DATABASE_URL!,
+      schema: process.env.PGBOSS_SCHEMA ?? 'pgboss',
+    });
     _boss.on('error', (err) => console.error('[pg-boss]', err));
   }
   return _boss;
@@
     await boss.work('anon-janitor', anonJanitorHandler);
     await boss.work('poll-coverage-janitor', pollCoverageJanitorHandler);

+    // Only slot 0 owns the cron schedules (spec 4.4.2). Unset means '0' means owner, so prod,
+    // CI and the main tree are unchanged. A non-owner slot still creates queues and works jobs
+    // above; it just never writes a schedule row, which is why a cloned database has its
+    // inherited pgboss schema dropped at provision time.
+    if ((process.env.AGENT_SLOT ?? '0') !== '0') return boss;
+
     // A1: 30-min floor for idle users; the mobile foreground trigger tightens it further
     // for active users (apps/mobile/lib/poll-trigger.ts -> POST /api/export/poll-history).
     await boss.schedule('poll-all-play-history', '*/30 * * * *');
```

## The two halves

**The per-slot `schema` option.** `pg-boss` (like several other Postgres-backed queue libraries)
supports pointing its client at a named schema instead of its default, which means every table,
index and function the library creates lives in that schema, fully separated from any other
schema in the same database. This is what makes it possible to give every agent slot its own
queue namespace *inside one shared database*, rather than needing a fully separate database per
slot just for queue isolation. A job enqueued through a client configured for `pgboss_a1` is
invisible to a client configured for `pgboss_a2` or for the default `pgboss` schema, even though
all three point at the exact same Postgres instance and (in the general case) the exact same
database.

**The `AGENT_SLOT` cron-ownership guard.** Separating the queue's data is necessary but not
sufficient: something also has to decide which slot is allowed to *register* recurring schedules,
because a fresh queue schema starts with no schedules in it (a clone of the production database
inherits schedule rows from whatever it was cloned from, unless those are dropped, which is a
separate provisioning step described in `docs/design.md` section 4.3). The one-line guard above
means only slot 0 (the unset, default case) ever calls the library's schedule-registration
function at all. Every other slot creates its queues and processes jobs handed to it normally; it
simply never writes a cron row, so it can never spontaneously trigger a scheduled job on its own.

## The invariant

**Absence of configuration preserves existing behavior exactly.** An unset `AGENT_SLOT`
environment variable is treated as `'0'`, which is the schedule owner. An unset `PGBOSS_SCHEMA`
environment variable falls back to `'pgboss'`, which is the library's own default schema name.
Together, this means a deployment, a CI run, or the original single-agent local checkout that has
never heard of any of this needs to change nothing: it behaves exactly as it did before this
change existed, because every new variable it would need to set is unset, and unset means the old
behavior.

## The inverted-polarity trap

An earlier draft of this exact change used a second, differently-named variable instead of reading
`AGENT_SLOT` directly: something like `BOSS_SCHEDULE_OWNER=$AGENT_SLOT`, guarding the schedule
calls on whether that second variable equals `'0'` to mean "not the owner." Read that condition
again: it disables the schedule registration on slot 0, and only slot 0, which is the one place
schedules are actually supposed to run. Two variables encoding the same fact in opposite
directions (`AGENT_SLOT=0` means *is* the owner; `BOSS_SCHEDULE_OWNER=0` was meant to mean *is not*
the owner) is exactly the kind of thing that reads fine at a glance and is backwards the moment you
trace what it actually evaluates to. The bug it would have produced is the worst possible shape for
this design: recurring jobs silently stop firing, in the one environment, the main tree, that
nobody is watching for that failure because nobody expects it to be the one that's different.

The fix that closes this off is not "be more careful with the second variable." It is not
introducing a second variable in the first place. Store the one fact (which slot owns the
schedule) exactly once, and read it directly wherever it is needed. If you find yourself deriving
a second, differently-named variable from an existing one specifically to invert its meaning,
that is the moment to stop and ask why the second variable needs to exist at all.

## Where this generalizes

None of the above is specific to `pg-boss`. It applies to any Postgres-backed (or more generally,
any queue backed by a datastore that supports a namespace, schema, or prefix concept) job queue
where:

1. the client library accepts a configurable schema, namespace, or key-prefix option, and
2. something in the application registers recurring or scheduled work at startup.

The pattern is: give every isolated instance its own namespace via (1), and gate the
schedule-registration calls in (2) behind a single, directly-read "am I the owner" signal that
defaults, when unset, to exactly the behavior that existed before isolation was introduced.
