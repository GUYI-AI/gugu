// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * #1925 (API 46) The session page's half of one of the assistant's tasks opened in an App's panel: the host action main sends
 * (`openWork` / `closeWork`, after its checks) goes to the shell's bridge, which refuses an account or a row it has not read;
 * while it holds one for this App, the panel leaves the cell the shell draws the built-in task window into — in place of the
 * App's page, as the built-in panel's task view does (the host's corner control gone, its own collapse) — and gives the page back after.
 */
const CHAT = '33000000-0000-4000-8000-000000000003';
const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER = '22000000-0000-4000-8000-000000000002';
const WORK = 'a1000000-0000-4000-8000-0000000000a1';
const state = vi.hoisted(() => ({ pages: [] as Record<string, unknown>[] }));
vi.mock('@renderer/features/extensions/extension-shared-slot', () => ({
  ExtensionSharedSlot: (props: Record<string, unknown>) => { state.pages.push(props); return <div data-testid="app-page" />; },
}));
// #1925 (44) The page stands in its host layer frame (app-host-layer, tested in appHostLayer1925): with no layer open,
// that is the page's shared slot.
vi.mock('./app-host-layer', () => ({
  AppHostLayerFrame: ({ tabKind }: { tabKind: string }) => { state.pages.push({ tabKind, tabId: 'dock' }); return <div data-testid="app-page" />; },
}));
vi.mock('@renderer/features/global-search/search-session', () => ({ searchInChat: vi.fn() }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { extensions: { reportConversationSurface: async () => ({ success: true }) } } }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate: vi.fn() } } }));

const { AppConversationFrame } = await import('./app-conversation-frame');
const { AppDockPage } = await import('./app-work-slot');
const { applyExtensionHostAction } = await import('@renderer/features/extensions/host-action-handlers');
const { installShellSlots, readShellSlots } = await import('@/lib/shellSlots');
const { installAppConversationSurfaceBridge, publishAppConversationSurfaces } = await import('@/lib/appConversationSurfaceBridge');
const { installAppWorkChatBridge, readAppWorkChatBridge, resetAppWorkChatsForTest, setAppWorkRows } = await import('@/lib/appWorkChatBridge');
installShellSlots();
installAppConversationSurfaceBridge();
installAppWorkChatBridge();

let root: Root;
let element: HTMLDivElement;
const find = (testId: string) => element.querySelector(`[data-testid="${testId}"]`);
const workAction = (extensionId: string, action: { kind: 'openWork'; ownerId: string; workId: string; sessionId: string } | { kind: 'closeWork' }) =>
  act(async () => { await applyExtensionHostAction({ origin: { extensionId, sessionId: null, tabId: 'dock' }, action }); });
const open = (extensionId = 'today', ownerId = OWNER) => workAction(extensionId, { kind: 'openWork', ownerId, workId: WORK, sessionId: 'exec-a' });

beforeEach(() => {
  state.pages.length = 0;
  localStorage.clear();
  resetAppWorkChatsForTest();
  // What the shell read: this account's rows, of which this one.
  setAppWorkRows({ ownerId: OWNER, assistantId: 'assistant-1', open: (workId, sessionId) => (workId === WORK && sessionId === 'exec-a'
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
    const cell = readShellSlots()!.getSlots().get('app-work:today');
    expect(cell?.className).toBe('ta-task-chat-slot');
    expect(find('app-conversation-panel')!.contains(cell!)).toBe(true);
    expect(find('app-page')).toBeNull();
    // The corner control over the page goes with the page: the task window has its own collapse.
    expect(find('app-conversation-panel-corner')).toBeNull();
    // The conversation's column stays as it was.
    expect(readShellSlots()!.getSlots().has('app-conversation:today')).toBe(true);
    await act(async () => (find('app-work-panel-collapse') as HTMLButtonElement).click());
    expect(find('app-conversation-panel')).toBeNull();
    expect(readShellSlots()!.getSlots().has('app-work:today')).toBe(false);
    // Still open: expanded again, the task is where it was left.
    await act(async () => (find('app-conversation-panel-expand') as HTMLButtonElement).click());
    expect(find('app-work-chat')).not.toBeNull();
    await workAction('today', { kind: 'closeWork' });
    expect(find('app-work-chat')).toBeNull();
    expect(find('app-page')).not.toBeNull();
    expect(find('app-conversation-panel-corner')).not.toBeNull();
    expect(readShellSlots()!.getSlots().has('app-work:today')).toBe(false);
  });

  it('a page standing alone (no conversation beside it, or none declared): the cell takes the page\'s place, then gives it back', async () => {
    for (const page of [<AppConversationFrame key="frame" extensionId="today" tabKind="today.main" />, <AppDockPage key="dock" extensionId="today" tabKind="today.main" />]) {
      await act(async () => root.render(page));
      expect(find('app-page')).not.toBeNull();
      await open();
      expect(find('app-page')).toBeNull();
      expect(readShellSlots()!.getSlots().get('app-work:today')?.className).toBe('ta-task-chat-slot');
      await workAction('today', { kind: 'closeWork' });
      expect(find('app-page')).not.toBeNull();
      expect(state.pages.at(-1)).toEqual({ tabKind: 'today.main', tabId: 'dock' });
    }
  });

  it('each App\'s own: another App\'s open or close is that App\'s panel, never this one\'s', async () => {
    await act(async () => root.render(<AppDockPage extensionId="today" tabKind="today.main" />));
    await open('other');
    expect(find('app-page')).not.toBeNull();
    expect(Object.keys(readAppWorkChatBridge()!.getSnapshot())).toEqual(['other']);
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
    expect(find('app-page')).not.toBeNull();
    expect(readAppWorkChatBridge()!.getSnapshot()).toEqual({});
  });
});
