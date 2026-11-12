// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * #1925 The session page's half of an App's main page beside its bound conversation: the built-in assistant page's frame —
 * the conversation's column (a slot the shell draws the native conversation into) and the page as the collapsible panel —
 * only while the shell says that conversation may be drawn; otherwise the page alone, as any App's page. The panel's state
 * is kept on this computer, and what is drawn is reported to main, which tells the App's pages.
 */
const CHAT = '33000000-0000-4000-8000-000000000003';
const state = vi.hoisted(() => ({ pages: [] as Record<string, unknown>[], reports: [] as unknown[], searched: [] as string[] }));
vi.mock('@renderer/features/extensions/extension-shared-slot', () => ({
  ExtensionSharedSlot: (props: Record<string, unknown>) => { state.pages.push(props); return <div data-testid="app-page" />; },
}));
vi.mock('@renderer/features/global-search/search-session', () => ({ searchInChat: (chatId: string) => state.searched.push(chatId) }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { extensions: { reportConversationSurface: async (args: unknown) => { state.reports.push(args); return { success: true }; } } } }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate: vi.fn() } } }));

// The panel's own pages and their reads (app-host-layer.tsx): not this test's; their modules read the cloud on import.
vi.mock('@renderer/features/assistant/assistant-data', () => ({ useAssistantMachine: () => ({ data: undefined }) }));
vi.mock('@/components/assistant/AssistantProjectsLibrary', () => ({ AssistantProjectsLibrary: () => null }));
vi.mock('@/components/assistant/AssistantLibraryVolume', () => ({ AssistantLibraryVolume: () => null }));
vi.mock('@renderer/features/apps/assistant-app-counts', () => ({ AssistantAppCountsSource: () => null }));
const { AppConversationFrame } = await import('./app-conversation-frame');
const { applyExtensionHostAction } = await import('@renderer/features/extensions/host-action-handlers');
const { installShellSlots, readShellSlots } = await import('@/lib/shellSlots');
const { installAppConversationSurfaceBridge, publishAppConversationSurfaces } = await import('@/lib/appConversationSurfaceBridge');
const { CONVERSATION_SURFACE_PANEL_INSET: INSET } = await import('@shared/extensions/unread-binding');
installShellSlots();
installAppConversationSurfaceBridge();

let root: Root;
let element: HTMLDivElement;
const render = async () => { await act(async () => root.render(<AppConversationFrame extensionId="today" tabKind="today.main" />)); };
const find = (testId: string) => element.querySelector(`[data-testid="${testId}"]`);
const click = async (testId: string) => { await act(async () => (find(testId) as HTMLButtonElement).click()); };
const lastReport = () => state.reports.at(-1);

beforeEach(() => {
  state.pages.length = 0; state.reports.length = 0; state.searched.length = 0;
  localStorage.clear();
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await act(async () => publishAppConversationSurfaces({}));
  element.remove();
});

describe('an App\'s main page beside its bound conversation', () => {
  it('unbound or not granted: the page opens alone, as any App\'s page, and no column is left', async () => {
    await render();
    expect(find('app-conversation-surface')).toBeNull();
    expect(find('app-page')).not.toBeNull();
    expect(state.pages.at(-1)).toEqual({ tabKind: 'today.main', tabId: 'dock' });
    expect(readShellSlots()!.getSlots().has('app-conversation:today')).toBe(false);
    expect(lastReport()).toEqual({ extensionId: 'today', tabKind: 'today.main', tabId: 'dock', shown: null });
  });

  it('granted and bound: the conversation\'s column and the page as the panel on its right, as the assistant page has them', async () => {
    await act(async () => publishAppConversationSurfaces({ today: CHAT }));
    await render();
    const frame = find('app-conversation-surface')!;
    expect(frame.className).toBe('ta-app');
    expect(frame.getAttribute('data-panel')).toBe('open');
    expect([...frame.children].map((child) => child.className)).toEqual(['ta-chat-col', 'ta-panel']);
    expect(readShellSlots()!.getSlots().get('app-conversation:today')?.className).toBe('ta-chat');
    expect(find('app-conversation-panel')!.contains(find('app-page'))).toBe(true);
    expect(lastReport()).toEqual({ extensionId: 'today', tabKind: 'today.main', tabId: 'dock', shown: { chatId: CHAT, collapsed: false } });
    await click('app-conversation-search');
    expect(state.searched).toEqual([CHAT]);
  });

  it('the page fills the panel from its top; the collapse control sits over the very corner the App is told (panel.inset)', async () => {
    await act(async () => publishAppConversationSurfaces({ today: CHAT }));
    await render();
    const panel = find('app-conversation-panel')!;
    // No row of the host's above the page: the page's own top row is where the built-in panel's top row is.
    expect(panel.querySelector('.ta-panel-top')).toBeNull();
    expect(panel.firstElementChild!.contains(find('app-page'))).toBe(true);
    const corner = find('app-conversation-panel-corner') as HTMLElement;
    expect(corner.parentElement).toBe(panel);
    expect(corner.contains(find('app-conversation-panel-collapse'))).toBe(true);
    expect({ position: corner.style.position, top: corner.style.top, right: corner.style.right, width: corner.style.width, height: corner.style.height })
      .toEqual({ position: 'absolute', top: '0px', right: '0px', width: `${INSET.right}px`, height: `${INSET.top}px` });
    expect(INSET).toEqual({ top: 52, right: 48 });
    // Over the page, which is drawn in the root layer; only the control itself takes clicks.
    expect(corner.style.zIndex).toBe('var(--z-pane-resident-chrome)');
    expect(corner.style.pointerEvents).toBe('none');
    expect((find('app-conversation-panel-collapse') as HTMLElement).style.pointerEvents).toBe('auto');
  });

  // Real window (verify-pass1 11-b): the built-in panel is a card with rounded corners; the App's page in it was square,
  // being drawn in the root layer, outside the card's clip. Its slot now carries the card's inside corners, which the root
  // layer draws the page with (page-corners.ts). Control (the parent commit): no rule gave the page's slot any corners.
  it('the page\'s place in the panel has the card\'s inside corners, from the built-in panel\'s own CSS values', async () => {
    await act(async () => publishAppConversationSurfaces({ today: CHAT }));
    await render();
    const anchor = find('app-conversation-panel')!.querySelector('[data-app-page-anchor]');
    expect(anchor?.contains(find('app-page'))).toBe(true);
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(`${process.cwd()}/apps/desktop/src/session/renderer/features/assistant/assistant-today.css`, 'utf8');
    const panel = /\n\.ta-panel \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(panel).toContain('border: 1px solid var(--ta-panel-border);');
    expect(panel).toContain('border-radius: var(--ta-radius-panel);');
    expect(panel).toContain('overflow: hidden;');
    expect(css).toContain('.ta-panel [data-app-page-anchor] [data-extension-slot] { border-radius: calc(var(--ta-radius-panel) - 1px); }');
    expect(css).toMatch(/--ta-radius-panel: 20px;/);
  });

  it('collapse round-trips: the frame\'s buttons, the App\'s own setPanel, remembered on this computer, told to main', async () => {
    await act(async () => publishAppConversationSurfaces({ today: CHAT }));
    await render();
    await click('app-conversation-panel-collapse');
    expect(find('app-conversation-panel')).toBeNull();
    expect(find('app-conversation-surface')!.getAttribute('data-panel')).toBe('closed');
    expect(localStorage.getItem('gugu.app.today.panel')).toBe('closed');
    expect(lastReport()).toMatchObject({ shown: { chatId: CHAT, collapsed: true } });
    await click('app-conversation-panel-expand');
    expect(find('app-conversation-panel')).not.toBeNull();
    expect(find('app-conversation-panel-expand')).toBeNull();
    expect(lastReport()).toMatchObject({ shown: { chatId: CHAT, collapsed: false } });
    // The App's `gugu.bindings.setPanel`, main having checked the page is drawn there: the window's host action.
    await act(async () => { await applyExtensionHostAction({ origin: { extensionId: 'today', sessionId: null, tabId: 'dock' }, action: { kind: 'conversationPanel', collapsed: true } }); });
    expect(find('app-conversation-panel')).toBeNull();
    expect(lastReport()).toMatchObject({ shown: { collapsed: true } });
    // Another App's action is that App's panel, not this one's.
    await act(async () => { await applyExtensionHostAction({ origin: { extensionId: 'other', sessionId: null, tabId: 'dock' }, action: { kind: 'conversationPanel', collapsed: false } }); });
    expect(find('app-conversation-panel')).toBeNull();
    // Opened again later: as it was left.
    await act(async () => root.unmount());
    root = createRoot(element);
    await render();
    expect(find('app-conversation-panel')).toBeNull();
    expect(find('app-conversation-panel-expand')).not.toBeNull();
  });

  it('the conversation no longer allowed (grant, choice, account, membership): the column goes, the page stays, main hears it', async () => {
    await act(async () => publishAppConversationSurfaces({ today: CHAT }));
    await render();
    expect(find('app-conversation-surface')).not.toBeNull();
    await act(async () => publishAppConversationSurfaces({}));
    expect(find('app-conversation-surface')).toBeNull();
    expect(find('app-page')).not.toBeNull();
    expect(readShellSlots()!.getSlots().has('app-conversation:today')).toBe(false);
    expect(lastReport()).toMatchObject({ shown: null });
    // Left (another view): main hears it is not drawn.
    await act(async () => publishAppConversationSurfaces({ today: CHAT }));
    state.reports.length = 0;
    await act(async () => root.unmount());
    expect(lastReport()).toMatchObject({ shown: null });
    root = createRoot(element);
  });
});
