# pg-boss integration

Import `pgBossOptions` when constructing the client and wrap only recurring-schedule registration
with `registerSchedulesForOwner`. Queue creation and workers stay outside the wrapper:

```ts
import { PgBoss } from 'pg-boss';
import {
  pgBossOptions,
  registerSchedulesForOwner,
} from './path/to/agent-slots/integrations/pg-boss/agent-slots';

const boss = new PgBoss(pgBossOptions(process.env.DATABASE_URL!));
await boss.start();

await boss.createQueue('daily-report');
await boss.work('daily-report', async ([job]) => handleReport(job));

await registerSchedulesForOwner(boss, async (owner) => {
  await owner.schedule('daily-report', '0 8 * * *');
});
```

Unset `AGENT_SLOT` and `PGBOSS_SCHEMA` preserve pg-boss's normal behavior. Nonzero slots use the
schema written by `agent-up.sh` and skip only recurring schedules. Run the live isolation probe
described in `docs/queue-isolation.md` before relying on this in a new application.
