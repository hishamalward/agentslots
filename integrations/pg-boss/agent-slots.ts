export type AgentEnvironment = Record<string, string | undefined>;

/** Constructor options that isolate every pg-boss table and job by agent slot. */
export function pgBossOptions(
  connectionString: string,
  env: AgentEnvironment = process.env,
): { connectionString: string; schema: string } {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  return {
    connectionString,
    schema: env.PGBOSS_SCHEMA || 'pgboss',
  };
}

/** Unset preserves the pre-agent-slots behavior: production, CI, and slot 0 own schedules. */
export function isScheduleOwner(env: AgentEnvironment = process.env): boolean {
  return (env.AGENT_SLOT ?? '0') === '0';
}

/**
 * Run schedule registration only for the owner while leaving queues and workers available in
 * every slot. Returning a boolean makes the skipped branch observable in tests and startup logs.
 */
export async function registerSchedulesForOwner<T>(
  boss: T,
  register: (boss: T) => Promise<void>,
  env: AgentEnvironment = process.env,
): Promise<boolean> {
  if (!isScheduleOwner(env)) return false;
  await register(boss);
  return true;
}
