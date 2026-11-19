import { describe, expect, it, vi } from 'vitest';
import { createGugu } from './create-gugu';

/**
 * #1928 `gugu.bindings.schedules` / `controlSchedule` / `onSchedulesChanged(name, fn)` as a page has them: one host watch
 * per binding however many handlers, the raw event kept off `gugu`, and a refused watch reported, not thrown.
 */
type Bindings = {
  schedules(name: string): Promise<unknown>;
  controlSchedule(name: string, change: Record<string, unknown>): Promise<unknown>;
  onSchedulesChanged(name: unknown, fn: unknown): () => void;
};

function host(watchSchedules = vi.fn(async (_name: string, _on: boolean) => undefined)) {
  let heard!: (binding: string) => void;
  const reportError = vi.fn(async () => undefined);
  const schedules = vi.fn(async (name: string) => ({ name, state: 'unbound' }));
  const controlSchedule = vi.fn(async (_name: string, _change: Record<string, unknown>) => Promise.reject({ code: 'denied', message: 'no' }));
  const gugu = createGugu({
    appFiles: {}, reportError,
    bindings: { get: vi.fn(), schedules, watchSchedules, controlSchedule },
    onSchedulesChanged: (fn: (binding: string) => void) => { heard = fn; return () => undefined; },
  } as never, {} as never) as unknown as { bindings: Bindings } & Record<string, unknown>;
  return { gugu, watchSchedules, reportError, schedules, controlSchedule, hear: (binding: string) => heard(binding) };
}

describe('gugu.bindings and the bound agent\'s schedules', () => {
  it('one host watch per binding: each handler hears its binding, the last unsubscribe lets go', async () => {
    const { gugu, watchSchedules, hear } = host();
    expect(gugu.onSchedulesChanged).toBeUndefined();
    const first = vi.fn(), second = vi.fn();
    const stopFirst = gugu.bindings.onSchedulesChanged('main', first);
    const stopSecond = gugu.bindings.onSchedulesChanged('main', second);
    expect(watchSchedules.mock.calls).toEqual([['main', true]]);
    hear('main');
    hear('other');
    expect(first.mock.calls).toEqual([[{ name: 'main' }]]);
    expect(second.mock.calls).toEqual([[{ name: 'main' }]]);
    stopFirst();
    stopFirst();
    expect(watchSchedules).toHaveBeenCalledTimes(1);
    stopSecond();
    expect(watchSchedules.mock.calls.at(-1)).toEqual(['main', false]);
    hear('main');
    expect(first).toHaveBeenCalledOnce();
    expect(() => gugu.bindings.onSchedulesChanged('', vi.fn())).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(() => gugu.bindings.onSchedulesChanged('main', 'not a function')).toThrow(expect.objectContaining({ code: 'invalid' }));
  });

  it('a watch the host refuses is the App\'s reported error; list and control pass through, their refusals coded', async () => {
    const { gugu, reportError, schedules, controlSchedule } = host(vi.fn(async () => Promise.reject(new Error('Not permitted: chat:schedules'))));
    gugu.bindings.onSchedulesChanged('main', vi.fn());
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith(expect.stringContaining('gugu.bindings.onSchedulesChanged(main): Not permitted')));
    expect(await gugu.bindings.schedules('main')).toEqual({ name: 'main', state: 'unbound' });
    expect(schedules).toHaveBeenCalledWith('main');
    await expect(gugu.bindings.controlSchedule('main', { operationId: 'op-000001', op: 'remove' })).rejects.toMatchObject({ code: 'denied' });
    expect(controlSchedule).toHaveBeenCalledWith('main', { operationId: 'op-000001', op: 'remove' });
  });
});
