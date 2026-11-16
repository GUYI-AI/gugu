import { describe, expect, it } from 'vitest';
import { scheduleSlotShown } from './session-schedule-chip';
import type { SessionSchedule } from '@shared/core/automations/session-schedule';

// Most tasks have no schedule: while the machine has not answered, the composer keeps its place (❌ a band and a lift
// drawn for the placeholder, then withdrawn when the answer is "none").
describe('the schedule slot', () => {
  it('stays free while not known and when there is none; taken by schedules or by a failure', () => {
    expect(scheduleSlotShown({ state: 'unknown' })).toBe(false);
    expect(scheduleSlotShown({ state: 'value', value: [], stale: false, error: null })).toBe(false);
    expect(scheduleSlotShown({ state: 'value', value: [{ id: 's' } as SessionSchedule], stale: false, error: null })).toBe(true);
    expect(scheduleSlotShown({ state: 'error', error: new Error('offline') })).toBe(true);
  });
});
