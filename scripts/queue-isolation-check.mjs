#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';

const {
  DATABASE_URL_A,
  DATABASE_URL_B = DATABASE_URL_A,
  PGBOSS_SCHEMA_A,
  PGBOSS_SCHEMA_B,
} = process.env;

if (!DATABASE_URL_A || !PGBOSS_SCHEMA_A || !PGBOSS_SCHEMA_B) {
  console.error(
    'usage: DATABASE_URL_A=... [DATABASE_URL_B=...] PGBOSS_SCHEMA_A=... PGBOSS_SCHEMA_B=... npm run test:queue',
  );
  process.exit(2);
}
if (PGBOSS_SCHEMA_A === PGBOSS_SCHEMA_B) {
  console.error('queue-isolation: schema A and schema B must differ');
  process.exit(2);
}

const queue = `agent-isolation-${randomUUID()}`;
const bossA = new PgBoss({ connectionString: DATABASE_URL_A, schema: PGBOSS_SCHEMA_A });
const bossB = new PgBoss({ connectionString: DATABASE_URL_B, schema: PGBOSS_SCHEMA_B });

try {
  await Promise.all([bossA.start(), bossB.start()]);
  await Promise.all([bossA.createQueue(queue), bossB.createQueue(queue)]);
  const id = await bossA.send(queue, { probe: true });
  if (!id) throw new Error('pg-boss did not create the control job');

  const consumedByB = await bossB.fetch(queue, { batchSize: 1 });
  const consumedByA = await bossA.fetch(queue, { batchSize: 1 });

  console.log(`enqueued ${id} in A (${PGBOSS_SCHEMA_A})`);
  console.log(`B (${PGBOSS_SCHEMA_B}) consumed ${consumedByB.length} job(s)`);
  console.log(`A (${PGBOSS_SCHEMA_A}) consumed ${consumedByA.length} job(s)`);

  if (consumedByB.length !== 0) throw new Error('ISOLATION FAIL: B consumed A\'s job');
  console.log('ISOLATION PASS');
  if (consumedByA.length !== 1 || consumedByA[0].id !== id) {
    throw new Error('CONTROL FAIL: A could not consume its own job');
  }
  console.log('CONTROL PASS');
} finally {
  await Promise.allSettled([bossA.stop(), bossB.stop()]);
}
