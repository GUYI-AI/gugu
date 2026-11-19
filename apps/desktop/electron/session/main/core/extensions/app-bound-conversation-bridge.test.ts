import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #1927 The bridge's door for `gugu.bindings.list` / `read`: the App is the one the call came from, never one it names;
 * `chat:files` is asked at the door; only a page the person works reaches the binding — a page an agent works
 * (`app_check`) is not that account. What happens past the door is app-bound-conversation.test.ts's.
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
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'today', isExtensionSessionConfigured: () => true }));
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
const appBindingList = vi.fn(async (_id: string, args: { name: string }) => ({ name: args.name, state: 'unbound' }));
const appBindingRead = vi.fn(async (_id: string, args: { name: string }) => ({ name: args.name, state: 'missing' }));
const appBindingSurface = vi.fn(async (_id: string, _page: unknown, args: { name: string }) => ({ name: args.name, state: 'unbound' }));
const setBindingSurfacePanel = vi.fn(async (_id: string, _page: unknown, args: { name: string }) => ({ name: args.name, state: 'unbound' }));
vi.mock('./app-unread-bindings', () => ({ appBindingList, appBindingRead, appBindingSurface, setBindingSurfacePanel, appUnreadBinding: vi.fn() }));
const dispatchForApp = vi.fn(async () => ({ to: { binding: 'main' } }));
vi.mock('@main/core/extensions/extension-send', () => ({ dispatchForApp, messagesForApp: {} }));
const { answerCall } = await import('./extension-bridge');

const page = (operator: { kind: 'person' } | { kind: 'agent'; id: string }) => ({
  kind: 'page', extensionId: 'today', pageId: 41, gesture: true, filePage: () => ({}),
  binding: { extensionId: 'today', operator, conversation: null, widget: null, surface: null, tabName: 'main', tabId: 'dock' },
}) as never;
const read = { name: 'main', path: 'today.json', extensionId: 'someone-else' };

beforeEach(() => {
  granted.clear();
  appBindingList.mockClear();
  appBindingRead.mockClear();
  appBindingSurface.mockClear();
  setBindingSurfacePanel.mockClear();
  dispatchForApp.mockClear();
});

describe('the bridge door for the bound conversation\'s files', () => {
  it('a person\'s page with chat:files reaches it, as the App the call came from', async () => {
    granted.add('chat:files');
    expect(await answerCall(page({ kind: 'person' }), 'bindingsRead', read)).toEqual({ ok: true, value: { name: 'main', state: 'missing' } });
    expect(appBindingRead).toHaveBeenCalledExactlyOnceWith('today', read);
    expect(await answerCall(page({ kind: 'person' }), 'bindingsList', { name: 'main' })).toEqual({ ok: true, value: { name: 'main', state: 'unbound' } });
    expect(appBindingList).toHaveBeenCalledExactlyOnceWith('today', { name: 'main' });
  });

  it('without chat:files (chat:unread alone included), on a page an agent works, or off a page: refused, nothing asked', async () => {
    granted.add('chat:unread');
    for (const verb of ['bindingsList', 'bindingsRead']) {
      expect(await answerCall(page({ kind: 'person' }), verb, read)).toMatchObject({ ok: false, code: 'denied', message: expect.stringContaining('chat:files') });
    }
    granted.add('chat:files');
    for (const verb of ['bindingsList', 'bindingsRead']) {
      expect(await answerCall(page({ kind: 'agent', id: 'user:22000000-0000-4000-8000-000000000002' }), verb, read)).toMatchObject({ ok: false, code: 'denied' });
      for (const kind of ['background', 'program']) {
        expect(await answerCall({ kind, extensionId: 'today', pageId: -1, binding: null } as never, verb, read)).toMatchObject({ ok: false });
      }
    }
    expect(appBindingList).not.toHaveBeenCalled();
    expect(appBindingRead).not.toHaveBeenCalled();
  });

  it('a draft into the binding: a person\'s page is handed on; a page an agent works is refused at the bridge, unregistered or not', async () => {
    granted.add('chat:draft');
    const draft = { text: 'Ask', draft: true, to: { binding: 'main' } };
    expect(await answerCall(page({ kind: 'person' }), 'dispatch', draft)).toEqual({ ok: true, value: { to: { binding: 'main' } } });
    expect(dispatchForApp).toHaveBeenCalledOnce();
    dispatchForApp.mockClear();
    // No `agentPages` entry for this page (never registered, or gone): the bridge's own check still refuses it.
    expect(await answerCall(page({ kind: 'agent', id: 'user:22000000-0000-4000-8000-000000000002' }), 'dispatch', draft))
      .toMatchObject({ ok: false, code: 'denied', message: expect.stringContaining('agent works') });
    expect(dispatchForApp).not.toHaveBeenCalled();
  });
});

describe('the bridge door for the conversation beside the page (#1925)', () => {
  it('a person\'s page with chat:surface asks about itself — this App, this page — never one the call names', async () => {
    granted.add('chat:surface');
    const args = { name: 'main', extensionId: 'someone-else' };
    expect(await answerCall(page({ kind: 'person' }), 'bindingsSurface', args)).toEqual({ ok: true, value: { name: 'main', state: 'unbound' } });
    expect(appBindingSurface).toHaveBeenCalledExactlyOnceWith('today', expect.objectContaining({ tabName: 'main', tabId: 'dock' }), args);
    expect(await answerCall(page({ kind: 'person' }), 'bindingsSurfacePanel', { name: 'main', collapsed: true })).toMatchObject({ ok: true });
    expect(setBindingSurfacePanel).toHaveBeenCalledExactlyOnceWith('today', expect.objectContaining({ tabId: 'dock' }), { name: 'main', collapsed: true }, expect.any(Function));
  });

  it('without chat:surface (chat:unread, files or draft alone included), on a page an agent works, or off a page: refused', async () => {
    for (const word of ['chat:unread', 'chat:files', 'chat:draft']) granted.add(word);
    for (const verb of ['bindingsSurface', 'bindingsSurfacePanel']) {
      expect(await answerCall(page({ kind: 'person' }), verb, { name: 'main', collapsed: true })).toMatchObject({ ok: false, code: 'denied', message: expect.stringContaining('chat:surface') });
    }
    granted.add('chat:surface');
    for (const verb of ['bindingsSurface', 'bindingsSurfacePanel']) {
      expect(await answerCall(page({ kind: 'agent', id: 'user:22000000-0000-4000-8000-000000000002' }), verb, { name: 'main', collapsed: true })).toMatchObject({ ok: false, code: 'denied' });
      for (const kind of ['background', 'program']) {
        expect(await answerCall({ kind, extensionId: 'today', pageId: -1, binding: null } as never, verb, { name: 'main' })).toMatchObject({ ok: false });
      }
    }
    expect(appBindingSurface).not.toHaveBeenCalled();
    expect(setBindingSurfacePanel).not.toHaveBeenCalled();
  });
});
