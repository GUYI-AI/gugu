import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionHostActionResult } from '@shared/extensions/host-actions';

/**
 * #1925 (API 46) The bridge's door for `gugu.bindings.work` / `openWork` / `closeWork`, and how `onWorkChanged` is told. The
 * App is the one the call came from, never one it names; `chat:work` is asked at the door, `openWork` only in the person's
 * click; only a page the person works reaches the binding — a page an agent works (`app_check`), the background page and a
 * program reach none of it. What happens past the door is app-work-binding.test.ts's.
 */
const granted = new Set<string>();
const sent = new Map<number, unknown[]>();
const contentsOf = (id: number) => ({
  id, isDestroyed: () => false, hostWebContents: { id: 42 }, session: { id }, once: () => undefined, on: () => undefined,
  send: (_channel: string, event: unknown) => sent.set(id, [...(sent.get(id) ?? []), event]),
});
vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US' },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  webContents: { fromId: (id: number) => contentsOf(id) },
  shell: { openExternal: vi.fn() },
  clipboard: { writeText: vi.fn() },
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'tasks', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null, runningExtensionBackgrounds: () => [] }));
vi.mock('@main/core/extensions/extension-programs', () => ({ extensionPrograms: {}, onExtensionProgramNotification: vi.fn() }));
const installed = vi.hoisted(() => ({ value: true }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({
    get: () => ({ manifest: { id: 'tasks', name: 'Tasks', apiVersion: 46, permissions: { bindings: [{ name: 'main', kind: 'conversation', actions: ['unread', 'work'] }] } } }),
    isInstalled: () => installed.value,
    isEnabled: () => true,
    hasCapability: (_id: string, wanted: string) => granted.has(wanted),
    grantedCapabilities: () => [...granted],
  }),
}));
const answer = vi.hoisted(() => ({ value: { name: 'main', state: 'unbound' } as Record<string, unknown>, gate: null as Promise<void> | null }));
const appBindingWork = vi.fn(async (_id: string, args: { name: string }) => ({ ...answer.value, name: args.name }));
const appBindingWorkHeard = vi.fn(async (_id: string, name: string) => {
  if (answer.gate) await answer.gate;
  return { ...answer.value, name };
});
const appOpenWork = vi.fn(async (_id: string, _page: unknown, _args: unknown, act: (action: unknown) => Promise<unknown>) => { await act({ kind: 'openWork', ownerId: 'o', workId: 'w', sessionId: 's' }); });
const appCloseWork = vi.fn(async (_id: string, _args: unknown, act: (action: unknown) => Promise<unknown>) => { await act({ kind: 'closeWork' }); });
vi.mock('./app-work-binding', () => ({
  appBindingWork, appBindingWorkHeard, appOpenWork, appCloseWork,
  workBindingName: (manifest: { permissions?: { bindings?: { name: string; actions: string[] }[] } }) =>
    manifest.permissions?.bindings?.[0]?.actions.includes('work') ? manifest.permissions.bindings[0]!.name : null,
}));
const { answerCall, bindExtensionSurface, pushBindingWork, setExtensionBridgeHost, unbindExtensionSurface } = await import('./extension-bridge');

const deliver = vi.fn<(_origin: unknown, _action: unknown) => Promise<ExtensionHostActionResult>>(() => Promise.resolve());
const page = (operator: { kind: 'person' } | { kind: 'agent'; id: string }, gesture = true) => ({
  kind: 'page', extensionId: 'tasks', pageId: 41, gesture, filePage: () => ({}),
  binding: { extensionId: 'tasks', operator, conversation: null, widget: null, surface: null, tabName: 'main', tabId: 'dock', embedderId: 42 },
}) as never;
const AGENT = { kind: 'agent', id: 'user:22000000-0000-4000-8000-000000000002' } as const;
const HANDLE = 'wAAAAAAAAAAAAAAAAAAAAAA';
const VERBS: [string, Record<string, unknown>][] = [['bindingsWork', { name: 'main' }], ['bindingsOpenWork', { name: 'main', handle: HANDLE }], ['bindingsCloseWork', { name: 'main' }]];
const workEvents = (id: number) => (sent.get(id) ?? []).filter((event) => (event as { type?: string }).type === 'bindingWork');

beforeEach(() => {
  granted.clear();
  sent.clear();
  installed.value = true;
  answer.value = { name: 'main', state: 'unbound' };
  answer.gate = null;
  for (const fn of [appBindingWork, appBindingWorkHeard, appOpenWork, appCloseWork, deliver]) fn.mockClear();
  setExtensionBridgeHost({ deliver, selfGuguNumber: () => undefined, presentation: () => ({ locale: 'en', themeMode: 'light' as const, fullscreen: false, windowFocused: true }) });
});

describe('the bridge door for the assistant\'s work', () => {
  it('a person\'s page with chat:work reaches it as the App the call came from, and the window is asked as that page\'s', async () => {
    granted.add('chat:work');
    const args = { name: 'main', extensionId: 'someone-else' };
    expect(await answerCall(page({ kind: 'person' }), 'bindingsWork', args)).toEqual({ ok: true, value: { name: 'main', state: 'unbound' } });
    expect(appBindingWork).toHaveBeenCalledExactlyOnceWith('tasks', args);
    expect(await answerCall(page({ kind: 'person' }), 'bindingsOpenWork', { name: 'main', handle: HANDLE })).toMatchObject({ ok: true });
    expect(appOpenWork).toHaveBeenCalledExactlyOnceWith('tasks', expect.objectContaining({ tabId: 'dock' }), { name: 'main', handle: HANDLE }, expect.any(Function));
    expect(deliver).toHaveBeenLastCalledWith(expect.objectContaining({ extensionId: 'tasks', tabId: 'dock', embedderId: 42 }), { kind: 'openWork', ownerId: 'o', workId: 'w', sessionId: 's' });
    expect(await answerCall(page({ kind: 'person' }, false), 'bindingsCloseWork', { name: 'main' })).toMatchObject({ ok: true });
    expect(deliver).toHaveBeenLastCalledWith(expect.objectContaining({ extensionId: 'tasks' }), { kind: 'closeWork' });
  });

  it('openWork only in the person\'s click', async () => {
    granted.add('chat:work');
    expect(await answerCall(page({ kind: 'person' }, false), 'bindingsOpenWork', { name: 'main', handle: HANDLE }))
      .toMatchObject({ ok: false, code: 'denied', message: expect.stringContaining('gesture') });
    expect(appOpenWork).not.toHaveBeenCalled();
  });

  it('without chat:work (every other binding grant included), on a page an agent works, or off a page: refused, nothing asked', async () => {
    for (const word of ['chat:unread', 'chat:files', 'chat:draft', 'chat:surface', 'chat:read', 'agents:read:all-machines']) granted.add(word);
    for (const [verb, args] of VERBS) {
      expect(await answerCall(page({ kind: 'person' }), verb, args)).toMatchObject({ ok: false, code: 'denied', message: expect.stringContaining('chat:work') });
    }
    granted.add('chat:work');
    for (const [verb, args] of VERBS) {
      expect(await answerCall(page(AGENT), verb, args)).toMatchObject({ ok: false, code: 'denied' });
      for (const kind of ['background', 'program']) {
        expect(await answerCall({ kind, extensionId: 'tasks', pageId: -1, binding: null } as never, verb, args)).toMatchObject({ ok: false });
      }
    }
    for (const fn of [appBindingWork, appOpenWork, appCloseWork, deliver]) expect(fn).not.toHaveBeenCalled();
  });
});

describe('onWorkChanged: told to the pages the person works', () => {
  const PERSON = 71, AGENT_PAGE = 72;
  beforeEach(async () => {
    await bindExtensionSurface({ webContentsId: PERSON, extensionId: 'tasks', tabId: 'dock', tabKind: 'tasks.main' });
    await bindExtensionSurface({ webContentsId: AGENT_PAGE, extensionId: 'tasks', tabId: 'check', tabKind: 'tasks.main', operator: AGENT });
    sent.clear();
  });

  it('each new answer to the person\'s page, never to a page an agent works; the same answer twice is told once', async () => {
    answer.value = { name: 'main', state: 'ready', items: [], stale: false, open: null };
    await pushBindingWork('tasks');
    expect(workEvents(PERSON)).toEqual([{ type: 'bindingWork', work: answer.value }]);
    expect(workEvents(AGENT_PAGE)).toEqual([]);
    await pushBindingWork('tasks');
    expect(workEvents(PERSON)).toHaveLength(1);
    answer.value = { name: 'main', state: 'unavailable', open: null };
    await pushBindingWork('tasks');
    expect(workEvents(PERSON)).toEqual([{ type: 'bindingWork', work: { name: 'main', state: 'ready', items: [], stale: false, open: null } }, { type: 'bindingWork', work: answer.value }]);
    unbindExtensionSurface(PERSON);
    unbindExtensionSurface(AGENT_PAGE);
  });

  it('changes while one is being told are told once more after it, the newest; an App gone is told nothing', async () => {
    let release!: () => void;
    answer.gate = new Promise((resolve) => { release = resolve; });
    answer.value = { name: 'main', state: 'unavailable', open: null };
    const first = pushBindingWork('tasks');
    void pushBindingWork('tasks');
    void pushBindingWork('tasks');
    answer.value = { name: 'main', state: 'ready', items: [], stale: true, open: null };
    release();
    answer.gate = null;
    await first;
    expect(appBindingWorkHeard).toHaveBeenCalledTimes(2);
    expect(workEvents(PERSON).at(-1)).toEqual({ type: 'bindingWork', work: answer.value });
    installed.value = false;
    appBindingWorkHeard.mockClear();
    await pushBindingWork('tasks');
    expect(appBindingWorkHeard).not.toHaveBeenCalled();
    unbindExtensionSurface(PERSON);
    unbindExtensionSurface(AGENT_PAGE);
  });
});
