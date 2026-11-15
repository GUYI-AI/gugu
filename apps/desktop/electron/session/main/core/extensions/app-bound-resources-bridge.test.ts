import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #1927 (42) The bridge's door for the bound conversation's agent resources: the App is the one the call came from, never one
 * it names; `chat:resources` / `chat:resources:write` are asked at the door; only a page the person works reaches them — a
 * page an agent works (`app_check`) is not that account. A watch's events go to the page that asked, and its page going
 * takes the watch with it. What happens past the door is app-bound-resources.test.ts's.
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
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'assistant', isExtensionSessionConfigured: () => true }));
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
const verbs = vi.hoisted(() => ({
  appResourceList: vi.fn(async (_id: string, args: { name: string }) => ({ name: args.name, domain: 'memory', state: 'unbound' })),
  appResourceRead: vi.fn(async (_id: string, args: { name: string }) => ({ name: args.name, domain: 'memory', key: 'a.md', state: 'missing', revision: '0' })),
  appResourceSave: vi.fn(async (_id: string, args: { name: string }) => ({ name: args.name, domain: 'memory', key: 'a.md', state: 'conflict' })),
  appResourceRemove: vi.fn(async (_id: string, args: { name: string }) => ({ name: args.name, domain: 'memory', key: 'a.md', state: 'conflict' })),
  appResourceWatch: vi.fn(async (_id: string, _page: number, args: { name: string }, hear: (watchId: string, event: unknown) => void) => {
    hear('1', { name: args.name, state: 'changed' });
    return { name: args.name, state: 'watching' };
  }),
}));
vi.mock('./app-bound-resources', () => verbs);
const stopped = vi.hoisted(() => [] as number[]);
vi.mock('./app-resource-watches', () => ({ stopResourceWatches: (pageId: number) => stopped.push(pageId) }));
const { answerCall, stopPageWatches } = await import('./extension-bridge');

const page = (operator: { kind: 'person' } | { kind: 'agent'; id: string }, hear = vi.fn()) => ({
  kind: 'page', extensionId: 'assistant', pageId: 41, gesture: false, filePage: () => ({}), hear,
  binding: { extensionId: 'assistant', operator, conversation: null, widget: null, surface: null },
}) as never;
const change = { name: 'main', domain: 'memory', key: 'a.md', operationId: '55000000-0000-4000-8000-000000000005', expectedRevision: '0', content: 'x', extensionId: 'someone-else' };
const calls: [string, Record<string, unknown>, keyof typeof verbs][] = [
  ['bindingsResources', { name: 'main', domain: 'memory' }, 'appResourceList'],
  ['bindingsResource', { name: 'main', domain: 'memory', key: 'a.md' }, 'appResourceRead'],
  ['bindingsSave', change, 'appResourceSave'],
  ['bindingsRemove', { ...change, content: undefined }, 'appResourceRemove'],
];

beforeEach(() => {
  granted.clear();
  for (const fn of Object.values(verbs)) fn.mockClear();
  stopped.length = 0;
});

describe('the bridge door for the bound conversation\'s agent resources', () => {
  it('a person\'s page with the grant reaches them, as the App the call came from', async () => {
    granted.add('chat:resources'); granted.add('chat:resources:write');
    for (const [verb, args, handler] of calls) {
      expect(await answerCall(page({ kind: 'person' }), verb, args)).toMatchObject({ ok: true });
      expect(verbs[handler]).toHaveBeenCalledExactlyOnceWith('assistant', args);
    }
    const hear = vi.fn();
    expect(await answerCall(page({ kind: 'person' }, hear), 'bindingsWatch', { watchId: '1', name: 'main', on: true })).toEqual({ ok: true, value: { name: 'main', state: 'watching' } });
    expect(verbs.appResourceWatch).toHaveBeenCalledWith('assistant', 41, { watchId: '1', name: 'main', on: true }, expect.any(Function));
    expect(hear).toHaveBeenCalledExactlyOnceWith({ type: 'bindingResources', watchId: '1', event: { name: 'main', state: 'changed' } });
    stopPageWatches(41);
    expect(stopped).toEqual([41]);
  });

  it('reading needs chat:resources and changing chat:resources:write; an agent\'s page, a background page and a program reach nothing', async () => {
    granted.add('chat:unread'); granted.add('chat:files');
    for (const [verb, args] of [...calls, ['bindingsWatch', { watchId: '1', name: 'main', on: true }] as const]) {
      expect(await answerCall(page({ kind: 'person' }), verb, args)).toMatchObject({ ok: false, code: 'denied', message: expect.stringContaining('chat:resources') });
    }
    granted.add('chat:resources');
    expect(await answerCall(page({ kind: 'person' }), 'bindingsSave', change)).toMatchObject({ ok: false, code: 'denied', message: expect.stringContaining('chat:resources:write') });
    granted.add('chat:resources:write');
    for (const [verb, args] of [...calls, ['bindingsWatch', { watchId: '1', name: 'main', on: true }] as const]) {
      expect(await answerCall(page({ kind: 'agent', id: 'user:22000000-0000-4000-8000-000000000002' }), verb, args)).toMatchObject({ ok: false, code: 'denied' });
      for (const kind of ['background', 'program']) {
        expect(await answerCall({ kind, extensionId: 'assistant', pageId: -1, binding: null } as never, verb, args)).toMatchObject({ ok: false });
      }
    }
    for (const fn of Object.values(verbs)) expect(fn).not.toHaveBeenCalled();
  });
});
