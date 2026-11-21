// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ locale: 'en-US', translate: (key: string) => key }) }));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({ useNavigate: () => ({ navigate: vi.fn() }) }));
vi.mock('react-i18next', async (original) => ({ ...(await original<object>()), useTranslation: () => ({ t: (key: string) => key }) }));

const { scheduleSlotShown, SessionScheduleSlot } = await import('./session-schedule-chip');
import type { SessionSchedule } from '@shared/core/automations/session-schedule';

// Most tasks have no schedule: while the machine has not answered, the composer keeps its place (❌ a band and a lift
// drawn for the placeholder, then withdrawn when the answer is "none").
describe('the schedule slot', () => {
  it('stays free while not known and when there is none; taken by schedules or by a failure', () => {
    expect(scheduleSlotShown({ state: 'unknown' })).toBe(false);
    expect(scheduleSlotShown({ state: 'value', value: [], stale: false, error: null })).toBe(false);
    expect(scheduleSlotShown({ state: 'value', value: [{ id: 's' } as SessionSchedule], stale: false, error: null })).toBe(true);
    expect(scheduleSlotShown({ state: 'error', error: new Error('offline') })).toBe(true);
    expect(scheduleSlotShown({ state: 'value', value: [], stale: false, error: new Error('offline') })).toBe(true);
  });

  it('read before, a re-read that fails: the chip stays and the failure is said beside it', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);
    const schedule = { id: 's', title: 'Check the build', trigger: { type: 'once', at: '2026-11-17T00:00:00Z' }, nextRunAt: null, lastRun: null } as unknown as SessionSchedule;
    await act(async () => root.render(React.createElement(SessionScheduleSlot, { machine: null, reading: { state: 'value', value: [schedule], stale: false, error: new Error('offline') } })));
    expect(host.querySelector('[data-testid="session-schedule-chip"]')?.textContent).toContain('Check the build');
    expect(host.querySelector('[data-refresh-failed]')).not.toBeNull();
    act(() => root.unmount());
    host.remove();
  });
});
