import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #1928 The bridge's door for the bound agent's schedules: the App is the one the call came from; `chat:schedules` /
 * `chat:schedules:control` are asked at the door; only a page the person works reaches them; a page's watches go with it.
 * What happens past the door is app-bound-schedules.db.test.ts's.
 */
const granted = new Set<string>();
vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US' },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  webContents: { fromId: () => undefined },
  shell: { openExternal: vi.fn() },
  clipboard: { writeText: vi.fn() },
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'routines', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null, runningExtensionBackgrounds: () => [] }));
vi.mock('@main/core/extensions/extension-programs', () => ({ extensionPrograms: {}, onExtensionProgramNotification: vi.fn() }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({
    get: () => ({}),
    isEnabled: () => true,
    hasCapability: (_id: string, wanted: string) => granted.has(wanted),
    grantedCapabilities: () => [...granted],
  }),
}));
const watch = vi.hoisted(() => ({ stops: [] as ReturnType<typeof vi.fn>[], hear: [] as (() => void)[], ended: [] as (() => void)[] }));
const appBoundSchedules = vi.fn(async (_id: string, args: { name: string }) => ({ name: args.name, state: 'unbound' }));
const appBoundScheduleControl = vi.fn(async (_id: string, args: { name: string }) => ({ name: args.name, status: 'missing' }));
const watchBoundSchedules = vi.fn(async (_id: string, _args: unknown, hear: () => void, ended: () => void) => {
  const stop = vi.fn();
  watch.stops.push(stop);
  watch.hear.push(hear);
  watch.ended.push(ended);
  return stop;
});
vi.mock('./app-bound-schedules', () => ({ appBoundSchedules, appBoundScheduleControl, watchBoundSchedules }));
const { answerCall, stopPageWatches } = await import('./extension-bridge');

const heard: unknown[] = [];
const page = (operator: { kind: 'person' } | { kind: 'agent'; id: string }, pageId = 41) => ({
  kind: 'page', extensionId: 'routines', pageId, gesture: false, filePage: () => ({}), hear: (event: unknown) => heard.push(event),
  binding: { extensionId: 'routines', operator, conversation: null, widget: null, surface: null },
}) as never;
const person = page({ kind: 'person' });
const agentWorked = page({ kind: 'agent', id: 'user:22000000-0000-4000-8000-000000000002' });
const change = { name: 'main', operationId: 'op-000001', op: 'pause', scheduleId: 'schedule:x', revision: 'r', extensionId: 'someone-else' };

beforeEach(() => {
  granted.clear();
  heard.length = 0;
  Object.assign(watch, { stops: [], hear: [], ended: [] });
  for (const fn of [appBoundSchedules, appBoundScheduleControl, watchBoundSchedules]) fn.mockClear();
});

describe('the bridge door for the bound agent\'s schedules', () => {
  it('a person\'s page with the grants reaches them as the App the call came from, without a gesture', async () => {
    granted.add('chat:schedules').add('chat:schedules:control');
    expect(await answerCall(person, 'bindingsSchedules', { name: 'main' })).toEqual({ ok: true, value: { name: 'main', state: 'unbound' } });
    expect(appBoundSchedules).toHaveBeenCalledExactlyOnceWith('routines', { name: 'main' });
    expect(await answerCall(person, 'bindingsScheduleControl', change)).toEqual({ ok: true, value: { name: 'main', status: 'missing' } });
    expect(appBoundScheduleControl).toHaveBeenCalledExactlyOnceWith('routines', change);
  });

  it('inspecting needs chat:schedules, changing chat:schedules:control — neither covers the other, nor does chat:unread', async () => {
    granted.add('chat:unread').add('chat:schedules');
    expect(await answerCall(person, 'bindingsScheduleControl', change)).toMatchObject({ ok: false, code: 'denied', message: expect.stringContaining('chat:schedules:control') });
    granted.delete('chat:schedules');
    granted.add('chat:schedules:control');
    for (const [verb, args] of [['bindingsSchedules', { name: 'main' }], ['bindingsSchedulesWatch', { name: 'main', on: true }]] as const) {
      expect(await answerCall(person, verb, args)).toMatchObject({ ok: false, code: 'denied', message: expect.stringContaining('chat:schedules') });
    }
    expect(appBoundSchedules).not.toHaveBeenCalled();
    expect(appBoundScheduleControl).not.toHaveBeenCalled();
    expect(watchBoundSchedules).not.toHaveBeenCalled();
  });

  it('a page an agent works, a background page and a program reach none of it', async () => {
    granted.add('chat:schedules').add('chat:schedules:control');
    for (const [verb, args] of [['bindingsSchedules', { name: 'main' }], ['bindingsSchedulesWatch', { name: 'main', on: true }], ['bindingsScheduleControl', change]] as const) {
      expect(await answerCall(agentWorked, verb, args)).toMatchObject({ ok: false, code: 'denied', message: expect.stringContaining('agent works') });
      for (const kind of ['background', 'program']) {
        expect(await answerCall({ kind, extensionId: 'routines', pageId: -1, binding: null } as never, verb, args)).toMatchObject({ ok: false });
      }
    }
    expect(appBoundSchedules).not.toHaveBeenCalled();
    expect(appBoundScheduleControl).not.toHaveBeenCalled();
    expect(watchBoundSchedules).not.toHaveBeenCalled();
  });

  it('one watch per page and binding: it tells the page which binding changed, and goes with the page or its unsubscribe', async () => {
    granted.add('chat:schedules');
    expect(await answerCall(person, 'bindingsSchedulesWatch', { name: 'main', on: true })).toEqual({ ok: true, value: undefined });
    expect(await answerCall(person, 'bindingsSchedulesWatch', { name: 'main', on: true })).toEqual({ ok: true, value: undefined });
    expect(watchBoundSchedules).toHaveBeenCalledOnce();
    expect(watchBoundSchedules.mock.calls[0]!.slice(0, 2)).toEqual(['routines', { name: 'main' }]);
    watch.hear[0]!();
    expect(heard).toEqual([{ type: 'schedulesChanged', binding: 'main' }]);
    expect(await answerCall(person, 'bindingsSchedulesWatch', { name: 'main', on: false })).toEqual({ ok: true, value: undefined });
    expect(watch.stops[0]).toHaveBeenCalledOnce();
    // Again, then the page goes: its watch goes with it.
    await answerCall(person, 'bindingsSchedulesWatch', { name: 'main', on: true });
    stopPageWatches(41);
    expect(watch.stops[1]).toHaveBeenCalledOnce();
    // A watch that ended itself (its authority gone) is set up anew when asked again.
    await answerCall(person, 'bindingsSchedulesWatch', { name: 'main', on: true });
    watch.ended[2]!();
    await answerCall(person, 'bindingsSchedulesWatch', { name: 'main', on: true });
    expect(watchBoundSchedules).toHaveBeenCalledTimes(4);
  });

  it('a page that goes while its watch is being set up does not keep it', async () => {
    granted.add('chat:schedules');
    let release!: () => void;
    watchBoundSchedules.mockImplementationOnce(async (_id, _args, hear, ended) => {
      await new Promise<void>((resolve) => { release = resolve; });
      const stop = vi.fn();
      watch.stops.push(stop);
      watch.hear.push(hear);
      watch.ended.push(ended);
      return stop;
    });
    const asked = answerCall(page({ kind: 'person' }, 42), 'bindingsSchedulesWatch', { name: 'main', on: true });
    await vi.waitFor(() => expect(watchBoundSchedules).toHaveBeenCalledOnce());
    stopPageWatches(42);
    release();
    await asked;
    expect(watch.stops[0]).toHaveBeenCalledOnce();
  });
});
