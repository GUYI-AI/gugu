// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * #1925 (API 46) The session page's half of one of the assistant's tasks opened in an App's panel: the host action main sends
 * (`openWork` / `closeWork`, after its checks) goes to the shell's bridge, which refuses an account or a row it has not read;
 * while it holds one for this App, the panel leaves the cell the shell draws the built-in task window into — in place of the
 * App's page, as the built-in panel's task view does (the page's corner control gone, its own collapse) — and gives the page back after.
 */
const CHAT = '33000000-0000-4000-8000-000000000003';
const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER = '22000000-0000-4000-8000-000000000002';
const WORK = 'a1000000-0000-4000-8000-0000000000a1';
const state = vi.hoisted(() => ({ pages: [] as Record<string, unknown>[] }));
vi.mock('@renderer/features/extensions/extension-shared-slot', () => ({
  ExtensionSharedSlot: (props: Record<string, unknown>) => { state.pages.push(props); return <div data-testid="app-page" />; },
}));
vi.mock('@renderer/features/global-search/search-session', () => ({ searchInChat: vi.fn() }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { extensions: { reportConversationSurface: async () => ({ success: true }) } } }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate: vi.fn() } } }));

// The panel's own pages and their reads (app-host-layer.tsx): not this test's; their modules read the cloud on import.
vi.mock('@renderer/features/assistant/assistant-data', () => ({ useAssistantMachine: () => ({ data: undefined }) }));
vi.mock('@/components/assistant/AssistantProjectsLibrary', () => ({ AssistantProjectsLibrary: () => null }));
vi.mock('@/components/assistant/AssistantLibraryVolume', () => ({ AssistantLibraryVolume: () => null }));
vi.mock('@renderer/features/apps/assistant-app-counts', () => ({ AssistantAppCountsSource: () => null }));
const { AppConversationFrame } = await import('./app-conversation-frame');
const { AppHostLayerFrame: AppDockPage, resetMountedAppPagesForTest } = await import('./app-host-layer');
const { applyExtensionHostAction } = await import('@renderer/features/extensions/host-action-handlers');
const { installShellSlots, readShellSlots } = await import('@/lib/shellSlots');
const { installAppConversationSurfaceBridge, publishAppConversationSurfaces } = await import('@/lib/appConversationSurfaceBridge');
const { installAppHostLayerBridge, readAppHostLayerBridge, resetAppHostLayersForTest, setAppHostLayerAccount, setAppWorkRows } = await import('@/lib/appHostLayerBridge');
const { installAssistantShellBridge, publishAssistantShell } = await import('@/lib/assistantShellBridge');
installShellSlots();
installAssistantShellBridge();
installAppConversationSurfaceBridge();
installAppHostLayerBridge();

let root: Root;
let element: HTMLDivElement;
const find = (testId: string) => element.querySelector(`[data-testid="${testId}"]`);
const workAction = (extensionId: string, action: { kind: 'openWork'; ownerId: string; workId: string; sessionId: string } | { kind: 'closeWork' }) =>
  act(async () => { await applyExtensionHostAction({ origin: { extensionId, sessionId: null, tabId: 'dock' }, action }); });
const open = (extensionId = 'today', ownerId = OWNER) => workAction(extensionId, { kind: 'openWork', ownerId, workId: WORK, sessionId: 'exec-a' });

beforeEach(() => {
  state.pages.length = 0;
  localStorage.clear();
  resetAppHostLayersForTest();
  resetMountedAppPagesForTest();
  setAppHostLayerAccount(OWNER);
  // The window shows this account's assistant (a panel page is drawn only then).
  publishAssistantShell({ cloudAvailable: true, canHostHere: true, cloud: null, loadError: null, ownerName: 'Me', ownerId: OWNER, chatId: CHAT, chatReadFailed: false,
    assistant: { id: 'assistant-1', display_name: 'Dot', avatar: null, created_at: null }, assistantState: 'found', home: null, setup: null, member: true, preparing: false, deviceCount: 1, ownerAvatar: null } as never);
  // What the shell read: this account's rows, of which this one.
  setAppWorkRows({ ownerId: OWNER, assistantId: 'assistant-1', open: (workId: string, sessionId: string) => (workId === WORK && sessionId === 'exec-a'
    ? { workId, title: 'Compare three flights', outcome: 'active', assistantId: 'assistant-1', taskAgentId: 'agent-a', task: { deviceId: 'device-a', sessionId }, assistants: [] }
    : null) });
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await act(async () => publishAppConversationSurfaces({}));
  element.remove();
});

describe('a task of the assistant in an App\'s panel', () => {
  it('beside the conversation: the panel\'s cell in place of the page and its corner control, its own collapse; closed, the page is back', async () => {
    await act(async () => publishAppConversationSurfaces({ today: CHAT }));
    await act(async () => root.render(<AppConversationFrame extensionId="today" tabKind="today.main" />));
    expect(find('app-work-chat')).toBeNull();
    await open();
    const cell = readShellSlots()!.getSlots().get('app-host-layer:today');
    expect(cell?.className).toBe('ta-task-chat-slot');
    expect(find('app-conversation-panel')!.contains(cell!)).toBe(true);
    expect(find('app-page')).toBeNull();
    // The page's corner control goes with the page; the task view has its own collapse.
    expect(find('app-conversation-panel-corner')).toBeNull();
    // The conversation's column stays as it was.
    expect(readShellSlots()!.getSlots().has('app-conversation:today')).toBe(true);
    await act(async () => (find('app-work-panel-collapse') as HTMLButtonElement).click());
    expect(find('app-conversation-panel')).toBeNull();
    expect(readShellSlots()!.getSlots().has('app-host-layer:today')).toBe(false);
    // Still open: expanded again, the task is where it was left.
    await act(async () => (find('app-conversation-panel-expand') as HTMLButtonElement).click());
    expect(find('app-work-chat')).not.toBeNull();
    await workAction('today', { kind: 'closeWork' });
    expect(find('app-work-chat')).toBeNull();
    expect(find('app-page')).not.toBeNull();
    expect(find('app-conversation-panel-corner')).not.toBeNull();
    expect(readShellSlots()!.getSlots().has('app-host-layer:today')).toBe(false);
  });

  it('a page standing alone (no conversation beside it, or none declared): the cell takes the page\'s place, then gives it back', async () => {
    for (const page of [<AppConversationFrame key="frame" extensionId="today" tabKind="today.main" />, <AppDockPage key="dock" extensionId="today" tabKind="today.main" />]) {
      await act(async () => root.render(page));
      expect(find('app-page')).not.toBeNull();
      await open();
      expect(find('app-page')).toBeNull();
      expect(readShellSlots()!.getSlots().get('app-host-layer:today')?.className).toBe('ta-task-chat-slot');
      await workAction('today', { kind: 'closeWork' });
      expect(find('app-page')).not.toBeNull();
      expect(state.pages.at(-1)).toEqual({ tabKind: 'today.main', tabId: 'dock' });
    }
  });

  it('the App\'s page gone (another tab): a task stays, back where it was with the page; a panel page goes with it', async () => {
    await act(async () => root.render(<AppDockPage extensionId="today" tabKind="today.main" />));
    await open();
    await act(async () => root.render(<div />));
    expect(readAppHostLayerBridge()!.getSnapshot().today?.kind).toBe('work');
    await act(async () => root.render(<AppDockPage extensionId="today" tabKind="today.main" />));
    expect(find('app-work-chat')).not.toBeNull();
    await act(async () => readAppHostLayerBridge()!.open('today', { kind: 'assistant-settings', ownerId: OWNER }));
    await act(async () => root.render(<div />));
    expect(readAppHostLayerBridge()!.getSnapshot()).toEqual({});
  });

  it('each App\'s own: another App\'s open or close is that App\'s panel, never this one\'s', async () => {
    await act(async () => root.render(<AppDockPage extensionId="today" tabKind="today.main" />));
    await open('other');
    expect(find('app-page')).not.toBeNull();
    expect(Object.keys(readAppHostLayerBridge()!.getSnapshot())).toEqual(['other']);
    await open();
    await workAction('other', { kind: 'closeWork' });
    expect(find('app-work-chat')).not.toBeNull();
  });

  it('the shell refuses an account it does not show, or a row it did not read: the action fails and nothing is drawn', async () => {
    await act(async () => root.render(<AppDockPage extensionId="today" tabKind="today.main" />));
    await expect(open('today', OTHER)).rejects.toThrow(/account/);
    await expect(workAction('today', { kind: 'openWork', ownerId: OWNER, workId: WORK, sessionId: 'exec-b' })).rejects.toThrow(/not in the work list/);
    setAppWorkRows(null);
    await expect(open()).rejects.toThrow();
    // Not signed in, or another account signed in: no page of the host's opens at all.
    setAppHostLayerAccount(null);
    expect(() => readAppHostLayerBridge()!.open('today', { kind: 'assistant-settings', ownerId: OWNER })).toThrow(/account/);
    setAppHostLayerAccount(OTHER);
    expect(() => readAppHostLayerBridge()!.open('today', { kind: 'assistant-settings', ownerId: OWNER })).toThrow(/account/);
    expect(find('app-page')).not.toBeNull();
    expect(readAppHostLayerBridge()!.getSnapshot()).toEqual({});
  });

  it('one host page at a time: the settings page replaces a task and a task the settings; closeWork takes a task only', async () => {
    await act(async () => publishAppConversationSurfaces({ today: CHAT }));
    await act(async () => root.render(<AppConversationFrame extensionId="today" tabKind="today.main" />));
    await open();
    expect(find('app-work-chat')).not.toBeNull();
    await act(async () => readAppHostLayerBridge()!.open('today', { kind: 'assistant-settings', ownerId: OWNER }));
    expect(find('app-work-chat')).toBeNull();
    expect(find('app-host-layer-assistant-settings')).not.toBeNull();
    expect(readAppHostLayerBridge()!.getSnapshot().today).toEqual({ kind: 'assistant-settings', ownerId: OWNER });
    // The App's closeWork never takes away a page the person opened.
    await workAction('today', { kind: 'closeWork' });
    expect(find('app-host-layer-assistant-settings')).not.toBeNull();
    // A task opened over it: the settings go.
    await open();
    expect(find('app-host-layer-assistant-settings')).toBeNull();
    expect(find('app-work-chat')).not.toBeNull();
    expect(Object.keys(readAppHostLayerBridge()!.getSnapshot())).toEqual(['today']);
  });

  it('the settings page as the built-in panel draws it: its top row (back, collapse), its title, the cell; back closes it', async () => {
    await act(async () => publishAppConversationSurfaces({ today: CHAT }));
    await act(async () => root.render(<AppConversationFrame extensionId="today" tabKind="today.main" />));
    await act(async () => readAppHostLayerBridge()!.open('today', { kind: 'assistant-settings', ownerId: OWNER }));
    const page = find('app-host-layer-assistant-settings')!;
    expect(page.className).toBe('ta-page');
    expect(page.querySelector('.ta-page-title')?.textContent).toBeTruthy();
    expect(readShellSlots()!.getSlots().get('app-host-layer:today')).toBe(find('app-host-layer-cell'));
    expect(find('app-page')).toBeNull();
    expect(find('app-conversation-panel-corner')).toBeNull();
    await act(async () => (find('app-host-layer-collapse') as HTMLButtonElement).click());
    expect(find('app-conversation-panel')).toBeNull();
    await act(async () => (find('app-conversation-panel-expand') as HTMLButtonElement).click());
    await act(async () => (find('app-host-layer-back') as HTMLButtonElement).click());
    expect(readAppHostLayerBridge()!.getSnapshot()).toEqual({});
    expect(find('app-page')).not.toBeNull();
  });
});

/**
 * Owner 11-12「设置里面不应该有咕咕设置吧?」: the assistant's setup, its settings (资料) and its connected apps open over its
 * App's panel when the App asks (`gugu.assistant.open`, the host action main sends after its checks), never in Settings.
 */
describe('the assistant\'s own pages over the App\'s panel, asked by the App', () => {
  const shown = (over: Record<string, unknown>) => publishAssistantShell({ cloudAvailable: true, canHostHere: true, cloud: null, loadError: null, ownerName: 'Me',
    ownerId: OWNER, chatId: null, chatReadFailed: false, assistant: null, assistantState: 'none', home: null, setup: 'shell', member: true, preparing: false,
    deviceCount: 1, ownerAvatar: null, ...over } as never);
  const ask = (screen: string, ownerId = OWNER) => act(async () => {
    await applyExtensionHostAction({ origin: { extensionId: 'today', sessionId: null, tabId: 'dock' }, action: { kind: 'openAssistantScreen', screen, ownerId } as never });
  });
  const opened = () => readAppHostLayerBridge()!.getSnapshot().today?.kind ?? null;

  it('开通 with no assistant yet: the setup guide over the App\'s intro; back gives the intro again', async () => {
    shown({});
    await act(async () => root.render(<AppDockPage extensionId="today" tabKind="today.main" />));
    await ask('setup');
    expect(opened()).toBe('assistant-setup');
    const page = find('app-host-layer')!;
    expect(page.getAttribute('data-layer')).toBe('assistant-setup');
    // The guide's own card heads it: no panel title, the shell's cell centred where the intro was.
    expect(find('app-host-layer-assistant-setup')).not.toBeNull();
    expect(page.querySelector('.ta-page-title')).toBeNull();
    expect(readShellSlots()!.getSlots().get('app-host-layer:today')).toBe(find('app-host-layer-cell'));
    expect(find('app-page')).toBeNull();
    await act(async () => (find('app-host-layer-back') as HTMLButtonElement).click());
    expect(opened()).toBeNull();
    expect(find('app-page')).not.toBeNull();
  });

  it('the setup guide closes once the assistant is there: the App draws the steps after it', async () => {
    shown({});
    await act(async () => root.render(<AppDockPage extensionId="today" tabKind="today.main" />));
    await ask('setup');
    expect(opened()).toBe('assistant-setup');
    await act(async () => shown({ assistant: { id: 'assistant-1', display_name: 'Dot', avatar: null, created_at: null }, assistantState: 'found', chatId: CHAT, setup: 'connect' }));
    expect(opened()).toBeNull();
    expect(find('app-page')).not.toBeNull();
  });

  it('while it is still being read the guide waits (the page says so), it is not closed as gone', async () => {
    shown({ assistantState: 'loading', setup: null });
    await act(async () => root.render(<AppDockPage extensionId="today" tabKind="today.main" />));
    await ask('setup');
    expect(opened()).toBe('assistant-setup');
  });

  it('with the assistant there: setup and move are its settings page, connected apps its own titled page', async () => {
    await act(async () => root.render(<AppDockPage extensionId="today" tabKind="today.main" />));
    for (const [screen, kind] of [['setup', 'assistant-settings'], ['move', 'assistant-settings'], ['settings', 'assistant-settings'], ['connected-apps', 'assistant-connected-apps']] as const) {
      await ask(screen);
      expect(opened()).toBe(kind);
      expect(find(`app-host-layer-${kind}`)?.querySelector('.ta-page-title')?.textContent).toBeTruthy();
      expect(readShellSlots()!.getSlots().get('app-host-layer:today')).toBe(find('app-host-layer-cell'));
    }
  });

  it('a page of the assistant needs it there; another account, or the App\'s page not on screen, opens nothing', async () => {
    shown({});
    await act(async () => root.render(<AppDockPage extensionId="today" tabKind="today.main" />));
    for (const screen of ['settings', 'move', 'connected-apps', 'projects']) await expect(ask(screen)).rejects.toThrow(/assistant/);
    await expect(ask('setup', OTHER)).rejects.toThrow(/account/);
    await act(async () => root.render(<div />));
    await expect(ask('setup')).rejects.toThrow(/not on screen/);
    expect(readAppHostLayerBridge()!.getSnapshot()).toEqual({});
  });
});
