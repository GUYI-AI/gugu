import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionHostAction } from '@shared/extensions/host-actions';

/**
 * #1925 The bridge's door for `gugu.assistant.*`: the App is the one the call came from, never one it names; its
 * capability is asked at the door, `open` and `advanceSetup` only inside the person's gesture; only a page the person
 * works reaches the assistant. What `open` asks is handed to the window that draws the page, as the action main decided.
 * What happens past the door is app-assistant-binding.test.ts's.
 */
const granted = new Set<string>();
const focus = vi.hoisted(() => ({ focused: true }));
vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US' },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  // The page's own webContents (pageId 41): whether it has the focus now.
  webContents: { fromId: (id: number) => (id === 41 ? { isFocused: () => focus.focused, isDestroyed: () => false } : undefined) },
  shell: { openExternal: vi.fn() },
  clipboard: { writeText: vi.fn() },
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'assistant-app', isExtensionSessionConfigured: () => true }));
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
const OWNER = '11000000-0000-4000-8000-000000000001';
const appAssistantStatus = vi.fn(async (_id: string, args: { name: string }) => ({ name: args.name, state: 'unbound' }));
const appAssistantOpen = vi.fn(async (_id: string, args: { screen: string }, act: (action: ExtensionHostAction) => Promise<unknown>) => {
  await act({ kind: 'openAssistantScreen', screen: args.screen as never, ownerId: OWNER });
});
const appAssistantAdvanceSetup = vi.fn(async (_id: string, _args: unknown, act: (action: ExtensionHostAction) => Promise<unknown>) => {
  await act({ kind: 'advanceAssistantSetup', next: 'ready', ownerId: OWNER });
});
const appAssistantRename = vi.fn(async (_id: string, args: { text: string }, act: (action: ExtensionHostAction) => Promise<unknown>) => {
  await act({ kind: 'renameAssistant', text: args.text, ownerId: OWNER });
  return 'renamed';
});
const appAssistantFigure = vi.fn(async (_id: string, args: { figure: { x: number; y: number; size: number } | null }, act: (action: ExtensionHostAction) => Promise<unknown>) => {
  await act({ kind: 'assistantFigure', figure: args.figure, ownerId: OWNER, who: 'assistant' });
});
const appAssistantConnect = vi.fn(async (_id: string, args: { id: string }, act: (action: ExtensionHostAction) => Promise<unknown>) => {
  await act({ kind: 'openAssistantConnector', id: args.id, ownerId: OWNER });
});
vi.mock('./app-assistant-binding', () => ({ appAssistantStatus, appAssistantOpen, appAssistantAdvanceSetup, appAssistantRename, appAssistantFigure, appAssistantConnect }));
const { answerCall, setExtensionBridgeHost } = await import('./extension-bridge');
const deliver = vi.fn(async () => undefined);
setExtensionBridgeHost({ deliver, presentation: () => ({}) as never, selfGuguNumber: () => null } as never);

const page = (operator: { kind: 'person' } | { kind: 'agent'; id: string }, gesture = true, metrics = { visible: true, width: 400, height: 600 }) => ({
  kind: 'page', extensionId: 'assistant-app', pageId: 41, gesture, filePage: () => ({}),
  binding: { extensionId: 'assistant-app', operator, conversation: null, widget: null, surface: null, tabId: 'tab-1', embedderId: 7, metrics },
}) as never;
const agent = { kind: 'agent' as const, id: 'user:22000000-0000-4000-8000-000000000002' };
const called = () => appAssistantStatus.mock.calls.length + appAssistantOpen.mock.calls.length + appAssistantAdvanceSetup.mock.calls.length + appAssistantRename.mock.calls.length + appAssistantFigure.mock.calls.length + appAssistantConnect.mock.calls.length;

beforeEach(() => {
  granted.clear();
  appAssistantStatus.mockClear();
  appAssistantOpen.mockClear();
  appAssistantAdvanceSetup.mockClear();
  appAssistantRename.mockClear();
  appAssistantFigure.mockClear();
  appAssistantConnect.mockClear();
  deliver.mockClear();
  focus.focused = true;
});

describe('the bridge door for the person\'s own assistant', () => {
  it('a person\'s page with assistant:status reads it, as the App the call came from, without a gesture', async () => {
    granted.add('assistant:status');
    const args = { name: 'main', extensionId: 'someone-else' };
    expect(await answerCall(page({ kind: 'person' }, false), 'assistantStatus', args)).toEqual({ ok: true, value: { name: 'main', state: 'unbound' } });
    expect(appAssistantStatus).toHaveBeenCalledExactlyOnceWith('assistant-app', args);
  });

  it('open: in a click, with assistant:open — handed to the window drawing that page as the action main decided, answered with nothing', async () => {
    granted.add('assistant:open');
    expect(await answerCall(page({ kind: 'person' }), 'assistantOpen', { name: 'main', screen: 'close' })).toEqual({ ok: true, value: undefined });
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ extensionId: 'assistant-app', tabId: 'tab-1', embedderId: 7 }),
      { kind: 'openAssistantScreen', screen: 'close', ownerId: OWNER },
    );
    expect(await answerCall(page({ kind: 'person' }), 'assistantAdvanceSetup', { name: 'main', next: 'ready' })).toEqual({ ok: true, value: undefined });
    expect(deliver).toHaveBeenLastCalledWith(expect.objectContaining({ embedderId: 7 }), { kind: 'advanceAssistantSetup', next: 'ready', ownerId: OWNER });
  });

  it('open and advanceSetup outside a gesture: refused before anything is asked', async () => {
    granted.add('assistant:open');
    for (const [verb, args] of [['assistantOpen', { name: 'main', screen: 'setup' }], ['assistantAdvanceSetup', { name: 'main', next: 'done' }]] as const) {
      expect(await answerCall(page({ kind: 'person' }, false), verb, args)).toMatchObject({ ok: false, code: 'denied', message: expect.stringContaining('gesture') });
    }
    expect(called()).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('without the grant (the other one, or chat:unread alone, included): refused by name, nothing asked', async () => {
    granted.add('chat:unread');
    granted.add('assistant:status');
    expect(await answerCall(page({ kind: 'person' }), 'assistantOpen', { name: 'main', screen: 'move' })).toMatchObject({ ok: false, code: 'denied', message: expect.stringContaining('assistant:open') });
    expect(await answerCall(page({ kind: 'person' }), 'assistantAdvanceSetup', { name: 'main', next: 'ready' })).toMatchObject({ ok: false, code: 'denied', message: expect.stringContaining('assistant:open') });
    granted.clear();
    granted.add('assistant:open');
    expect(await answerCall(page({ kind: 'person' }), 'assistantStatus', { name: 'main' })).toMatchObject({ ok: false, code: 'denied', message: expect.stringContaining('assistant:status') });
    expect(called()).toBe(0);
  });

  it('a page an agent works, a background page and a program reach none of it', async () => {
    for (const word of ['assistant:status', 'assistant:open']) granted.add(word);
    for (const [verb, args] of [['assistantStatus', { name: 'main' }], ['assistantOpen', { name: 'main', screen: 'close' }], ['assistantAdvanceSetup', { name: 'main', next: 'done' }]] as const) {
      expect(await answerCall(page(agent), verb, args)).toMatchObject({ ok: false, code: 'denied' });
      for (const kind of ['background', 'program']) {
        expect(await answerCall({ kind, extensionId: 'assistant-app', pageId: -1, binding: null } as never, verb, args)).toMatchObject({ ok: false, code: 'invalid' });
      }
    }
    expect(called()).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('the bridge door for rename', () => {
  it('in a click, with assistant:rename: answered with the closed result, the rename handed to the window drawing that page', async () => {
    granted.add('assistant:rename');
    expect(await answerCall(page({ kind: 'person' }), 'assistantRename', { name: 'main', text: 'Pip' })).toEqual({ ok: true, value: 'renamed' });
    expect(deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ embedderId: 7 }), { kind: 'renameAssistant', text: 'Pip', ownerId: OWNER });
  });

  it('outside a gesture, without its own grant (open is not enough), or from a page an agent works: refused, nothing asked', async () => {
    granted.add('assistant:rename');
    expect(await answerCall(page({ kind: 'person' }, false), 'assistantRename', { name: 'main', text: 'Pip' })).toMatchObject({ ok: false, code: 'denied', message: expect.stringContaining('gesture') });
    expect(await answerCall(page(agent), 'assistantRename', { name: 'main', text: 'Pip' })).toMatchObject({ ok: false, code: 'denied' });
    granted.clear();
    granted.add('assistant:open');
    expect(await answerCall(page({ kind: 'person' }), 'assistantRename', { name: 'main', text: 'Pip' })).toMatchObject({ ok: false, code: 'denied', message: expect.stringContaining('assistant:rename') });
    expect(called()).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('the bridge door for the figure', () => {
  const WHERE = { x: 24, y: 40, size: 96 };
  it('with assistant:status, no gesture: handed to the window drawing that page, as the App the call came from', async () => {
    granted.add('assistant:status');
    expect(await answerCall(page({ kind: 'person' }, false), 'assistantFigure', { name: 'main', figure: WHERE })).toEqual({ ok: true, value: undefined });
    expect(appAssistantFigure).toHaveBeenCalledExactlyOnceWith('assistant-app', { name: 'main', figure: WHERE }, expect.any(Function));
    expect(deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ embedderId: 7, tabId: 'tab-1' }), { kind: 'assistantFigure', figure: WHERE, ownerId: OWNER, who: 'assistant' });
  });

  it('without assistant:status (open or rename are not it), from a page an agent works, a background page or a program: refused, nothing asked', async () => {
    granted.add('assistant:open');
    granted.add('assistant:rename');
    expect(await answerCall(page({ kind: 'person' }), 'assistantFigure', { name: 'main', figure: WHERE })).toMatchObject({ ok: false, code: 'denied', message: expect.stringContaining('assistant:status') });
    granted.add('assistant:status');
    expect(await answerCall(page(agent), 'assistantFigure', { name: 'main', figure: WHERE })).toMatchObject({ ok: false, code: 'denied' });
    for (const kind of ['background', 'program']) {
      expect(await answerCall({ kind, extensionId: 'assistant-app', pageId: -1, binding: null } as never, 'assistantFigure', { name: 'main', figure: WHERE })).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(called()).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('the bridge door for connect', () => {
  it('in a click, with assistant:open: the connect dialog handed to the window drawing that page', async () => {
    granted.add('assistant:open');
    expect(await answerCall(page({ kind: 'person' }), 'assistantConnect', { name: 'main', id: 'feishu' })).toEqual({ ok: true, value: undefined });
    expect(deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ embedderId: 7 }), { kind: 'openAssistantConnector', id: 'feishu', ownerId: OWNER });
  });

  it('outside a gesture, without assistant:open (status is not it), or from a page an agent works: refused, nothing asked', async () => {
    granted.add('assistant:open');
    expect(await answerCall(page({ kind: 'person' }, false), 'assistantConnect', { name: 'main', id: 'feishu' })).toMatchObject({ ok: false, code: 'denied', message: expect.stringContaining('gesture') });
    expect(await answerCall(page(agent), 'assistantConnect', { name: 'main', id: 'feishu' })).toMatchObject({ ok: false, code: 'denied' });
    granted.clear();
    granted.add('assistant:status');
    expect(await answerCall(page({ kind: 'person' }), 'assistantConnect', { name: 'main', id: 'feishu' })).toMatchObject({ ok: false, code: 'denied', message: expect.stringContaining('assistant:open') });
    expect(called()).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('the bridge door for gugu.toast', () => {
  it('no capability: the person\'s page, on screen and focused, hands the text to the window drawing it', async () => {
    expect(await answerCall(page({ kind: 'person' }, false), 'toast', { text: 'Changes saved' })).toEqual({ ok: true, value: undefined });
    expect(deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ extensionId: 'assistant-app', embedderId: 7 }), { kind: 'toast', text: 'Changes saved' });
  });

  it('a page an agent works, a page off screen or without the focus, a background page or a program: no toast', async () => {
    focus.focused = true;
    expect(await answerCall(page(agent), 'toast', { text: 'one' })).toMatchObject({ ok: false, code: 'denied' });
    expect(await answerCall(page({ kind: 'person' }, false, { visible: false, width: 400, height: 600 }), 'toast', { text: 'two' })).toMatchObject({ ok: false, code: 'denied' });
    expect(await answerCall(page({ kind: 'person' }, false, { visible: true, width: 0, height: 0 }), 'toast', { text: 'three' })).toMatchObject({ ok: false, code: 'denied' });
    focus.focused = false;
    expect(await answerCall(page({ kind: 'person' }), 'toast', { text: 'four' })).toMatchObject({ ok: false, code: 'denied' });
    for (const kind of ['background', 'program']) {
      expect(await answerCall({ kind, extensionId: 'assistant-app', pageId: -1, binding: null } as never, 'toast', { text: 'five' })).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(deliver).not.toHaveBeenCalled();
  });
});
