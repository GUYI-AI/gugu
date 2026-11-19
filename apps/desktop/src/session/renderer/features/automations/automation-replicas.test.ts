import { QueryObserver } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What 已安排 shows of a machine follows that machine's automation events while shown (each model's `watch`); what it
 * held is read again when shown again (events missed while nobody listened).
 */
const io = vi.hoisted(() => ({ schedules: vi.fn(), latest: vi.fn(), listeners: new Map<string, Set<(event: unknown) => void>>() }));
vi.mock('@renderer/lib/ipc', () => ({
  rpcOn: () => ({ automations: { listSessionSchedules: io.schedules, getLatestRun: io.latest } }),
  onMachineEvent: (_machine: unknown, channel: { name: string }, listener: (event: unknown) => void) => {
    const set = io.listeners.get(channel.name) ?? new Set();
    io.listeners.set(channel.name, set.add(listener));
    return () => { set.delete(listener); };
  },
}));

const { followRendererSession, queryClient } = await import('@/lib/replica');
const { automationLatestRun, sessionSchedules } = await import('./automation-replicas');
const { automationChangedChannel, automationRunChangedChannel } = await import('@shared/core/automations/automationEvents');

const show = (model: { options: (key: never) => object; key: (...args: never[]) => unknown }, ...args: unknown[]) =>
  new QueryObserver(queryClient, model.options(model.key(...(args as never[])) as never) as never).subscribe(() => {});
const emit = (channel: { name: string }, event: unknown) => io.listeners.get(channel.name)?.forEach((listener) => listener(event));

beforeEach(() => {
  queryClient.clear();
  io.listeners.clear();
  io.schedules.mockReset();
  io.latest.mockReset();
  followRendererSession('SIGNED_IN', 'tester');
});

describe('automation readings', () => {
  it('a machine\'s schedules are read again on its events while shown, and when shown again', async () => {
    io.schedules.mockResolvedValue([]);
    const off = show(sessionSchedules, 'local');
    await vi.waitFor(() => expect(io.schedules).toHaveBeenCalledTimes(1));
    emit(automationChangedChannel, { automationId: 'a-1' });
    await vi.waitFor(() => expect(io.schedules).toHaveBeenCalledTimes(2));
    off();
    expect(io.listeners.get(automationChangedChannel.name)?.size ?? 0).toBe(0);
    const again = show(sessionSchedules, 'local');
    await vi.waitFor(() => expect(io.schedules).toHaveBeenCalledTimes(3));
    again();
  });

  it('a run event puts the run it carries as the latest one (❌ read again)', async () => {
    io.latest.mockResolvedValue(null);
    const off = show(automationLatestRun, 'local', 'a-1');
    await vi.waitFor(() => expect(io.latest).toHaveBeenCalledTimes(1));
    emit(automationRunChangedChannel, { automationId: 'a-1', run: { id: 'run-2' } });
    expect(automationLatestRun.peek('local', 'a-1')).toMatchObject({ state: 'value', value: { id: 'run-2' } });
    expect(io.latest).toHaveBeenCalledTimes(1);
    off();
  });
});
