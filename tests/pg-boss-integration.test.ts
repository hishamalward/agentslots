import { describe, expect, it, vi } from 'vitest';
import {
  isScheduleOwner,
  pgBossOptions,
  registerSchedulesForOwner,
} from '../integrations/pg-boss/agent-slots';

describe('pg-boss integration contract', () => {
  it('preserves the default pg-boss schema when configuration is absent', () => {
    expect(pgBossOptions('postgresql://localhost/app', {})).toEqual({
      connectionString: 'postgresql://localhost/app',
      schema: 'pgboss',
    });
  });

  it('uses the per-slot schema written by agent-up', () => {
    expect(pgBossOptions('postgresql://localhost/app_a2', { PGBOSS_SCHEMA: 'pgboss_a2' })).toEqual({
      connectionString: 'postgresql://localhost/app_a2',
      schema: 'pgboss_a2',
    });
  });

  it('treats only unset or literal slot 0 as the schedule owner', () => {
    expect(isScheduleOwner({})).toBe(true);
    expect(isScheduleOwner({ AGENT_SLOT: '0' })).toBe(true);
    expect(isScheduleOwner({ AGENT_SLOT: '1' })).toBe(false);
  });

  it('registers schedules for slot 0 and skips them for non-owner slots', async () => {
    const register = vi.fn(async () => undefined);
    const boss = { name: 'fake boss' };

    await expect(registerSchedulesForOwner(boss, register, { AGENT_SLOT: '1' })).resolves.toBe(false);
    expect(register).not.toHaveBeenCalled();

    await expect(registerSchedulesForOwner(boss, register, { AGENT_SLOT: '0' })).resolves.toBe(true);
    expect(register).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledWith(boss);
  });
});
