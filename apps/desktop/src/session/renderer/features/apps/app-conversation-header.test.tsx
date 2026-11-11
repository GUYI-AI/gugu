// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * #1925 (API 46) The host's row above the conversation beside an App (`conversationSurface.header: "assistant"`): the built-in
 * assistant page's own row (AssistantChatTop), drawn from the host's assistant data only while the shell publishes the row for
 * this App (main verified the account's own assistant chat) — gone at once when it stops. Its face and name tell the App
 * "profile" once (through main), the panel expanded and any host page closed; its gear opens the assistant's settings as the
 * one host page over the panel. Nothing of the assistant goes into what is reported for the App.
 */
const CHAT = '33000000-0000-4000-8000-000000000003';
const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER = '22000000-0000-4000-8000-000000000002';
const ASSISTANT = '44000000-0000-4000-8000-000000000004';
const WORK = 'a1000000-0000-4000-8000-0000000000a1';
const state = vi.hoisted(() => ({ reports: [] as Record<string, unknown>[], searched: [] as string[], faces: [] as Record<string, unknown>[] }));
vi.mock('@renderer/features/extensions/extension-shared-slot', () => ({ ExtensionSharedSlot: () => <div data-testid="app-page" /> }));
vi.mock('@renderer/features/global-search/search-session', () => ({ searchInChat: (chatId: string) => state.searched.push(chatId) }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { extensions: { reportConversationSurface: async (args: Record<string, unknown>) => { state.reports.push(args); return { success: true }; } } } }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate: vi.fn() } } }));
vi.mock('@renderer/utils/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/Avatar', () => ({ Avatar: (props: Record<string, unknown>) => { state.faces.push(props); return <span data-testid="face" />; } }));

// The panel's own pages and their reads (app-host-layer.tsx): not this test's; their modules read the cloud on import.
vi.mock('@renderer/features/assistant/assistant-data', () => ({ useAssistantMachine: () => ({ data: undefined }) }));
vi.mock('@/components/assistant/AssistantProjectsLibrary', () => ({ AssistantProjectsLibrary: () => null }));
vi.mock('@/components/assistant/AssistantLibraryVolume', () => ({ AssistantLibraryVolume: () => null }));
vi.mock('@renderer/features/apps/assistant-app-counts', () => ({ AssistantAppCountsSource: () => null }));
const { AppConversationFrame } = await import('./app-conversation-frame');
const { setAppConversationPanelCollapsed } = await import('./app-conversation-panel');
const { installShellSlots } = await import('@/lib/shellSlots');
const { installAppConversationSurfaceBridge, publishAppConversationSurfaces } = await import('@/lib/appConversationSurfaceBridge');
const { installAppHostLayerBridge, readAppHostLayerBridge, resetAppHostLayersForTest, setAppHostLayerAccount, setAppWorkRows } = await import('@/lib/appHostLayerBridge');
const { installAssistantShellBridge, publishAssistantShell } = await import('@/lib/assistantShellBridge');
installShellSlots();
installAppConversationSurfaceBridge();
installAppHostLayerBridge();
installAssistantShellBridge();

type Shell = Parameters<typeof publishAssistantShell>[0];
const shell = (over: Partial<Shell> = {}): Shell => ({
  cloudAvailable: true, canHostHere: true, cloud: null, loadError: null, ownerName: 'Me', ownerId: OWNER, chatId: CHAT,
  assistant: { id: ASSISTANT, display_name: 'Dot', avatar: 'face.png', created_at: null }, assistantState: 'found',
  home: null, setup: null, member: true, preparing: false, deviceCount: 1, ...over,
});
const ROW = { today: { kind: 'assistant' as const, ownerId: OWNER } };
let root: Root;
let element: HTMLDivElement;
const find = (testId: string) => element.querySelector(`[data-testid="${testId}"]`);
const click = async (testId: string) => { await act(async () => (find(testId) as HTMLButtonElement).click()); };
const render = async (headers: Record<string, { kind: 'assistant'; ownerId: string }> = ROW, snapshot: Shell = shell()) => {
  await act(async () => {
    publishAssistantShell(snapshot);
    publishAppConversationSurfaces({ today: CHAT }, headers);
    root.render(<AppConversationFrame extensionId="today" tabKind="today.main" />);
  });
};
const layers = () => readAppHostLayerBridge()!.getSnapshot();

beforeEach(() => {
  state.reports.length = 0; state.searched.length = 0; state.faces.length = 0;
  localStorage.clear();
  setAppConversationPanelCollapsed('today', false);
  resetAppHostLayersForTest();
  setAppHostLayerAccount(OWNER);
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await act(async () => publishAppConversationSurfaces({}));
  element.remove();
});

describe('the host\'s row above the conversation', () => {
  it('without the row: search and expand only, as before — no face, no gear', async () => {
    await render({});
    expect(find('app-conversation-search')).not.toBeNull();
    expect(find('app-conversation-identity')).toBeNull();
    expect(find('app-conversation-identity-state')).toBeNull();
    expect(find('app-conversation-gear')).toBeNull();
  });

  it('with it, over the account\'s own assistant chat: the built-in row — face and name from the host, search, gear', async () => {
    await render();
    const top = element.querySelector('.ta-chat-top')!;
    expect(top.parentElement?.getAttribute('data-testid')).toBe('app-conversation-column');
    expect(find('app-conversation-identity')!.className).toBe('ta-identity');
    expect(find('app-conversation-identity')!.textContent).toBe('Dot');
    expect(state.faces.at(-1)).toMatchObject({ name: 'Dot', avatarUrl: 'face.png', seed: ASSISTANT, size: 48, isAgent: true, harnessBadge: false });
    expect([...top.querySelectorAll('.ta-chat-actions > button')].map((button) => button.getAttribute('data-testid'))).toEqual(['app-conversation-search', 'app-conversation-gear']);
    await click('app-conversation-search');
    expect(state.searched).toEqual([CHAT]);
  });

  it('goes at once when the shell stops publishing it (another account, the grant, the App), and the gear with it', async () => {
    await render();
    expect(find('app-conversation-identity')).not.toBeNull();
    await act(async () => publishAppConversationSurfaces({ today: CHAT }));
    expect(find('app-conversation-identity')).toBeNull();
    expect(find('app-conversation-gear')).toBeNull();
  });

  it('as the built-in page says it while it cannot show the assistant: reading, none, unreadable, preparing — no gear', async () => {
    const cases: [Partial<Shell>, string][] = [
      [{ assistant: null, assistantState: 'loading' }, 'loading'],
      [{ assistant: null, assistantState: 'none' }, 'none'],
      [{ assistant: null, assistantState: 'unreadable' }, 'unreadable'],
      [{ assistant: null, assistantState: 'none', preparing: true }, 'preparing'],
      [{ chatId: null }, 'loading'],
      // The shell still shows the account before: nothing of that one's assistant.
      [{ ownerId: OTHER }, 'loading'],
    ];
    for (const [over, said] of cases) {
      state.faces.length = 0;
      await render(ROW, shell(over));
      expect(find('app-conversation-identity-state')?.getAttribute('data-state')).toBe(said);
      expect(find('app-conversation-identity-state')?.getAttribute('role')).toBe('status');
      expect(find('app-conversation-identity')).toBeNull();
      expect(find('app-conversation-gear')).toBeNull();
      expect(state.faces).toEqual([]);
    }
    // The shell's own assistant chat is another conversation: nothing in the middle at all.
    await render(ROW, shell({ chatId: '99000000-0000-4000-8000-000000000099' }));
    expect(find('app-conversation-identity')).toBeNull();
    expect(find('app-conversation-identity-state')).toBeNull();
    expect(find('app-conversation-gear')).toBeNull();
  });
});

describe('what its controls do', () => {
  it('face and name: the panel expanded, any host page closed, and the App told "profile" once through main — nothing else', async () => {
    setAppConversationPanelCollapsed('today', true);
    setAppWorkRows({ ownerId: OWNER, assistantId: ASSISTANT, open: (workId, sessionId) => ({ workId, title: 'x', assistantId: ASSISTANT, taskAgentId: null, task: { deviceId: 'd', sessionId }, assistants: [] }) });
    await render();
    await act(async () => readAppHostLayerBridge()!.open('today', { kind: 'work', ownerId: OWNER, workId: WORK, sessionId: 'exec-a' }));
    expect(find('app-conversation-panel')).toBeNull();
    await click('app-conversation-identity');
    expect(layers()).toEqual({});
    expect(find('app-conversation-panel')).not.toBeNull();
    const told = state.reports.filter((report) => report.intent);
    expect(told).toEqual([{ extensionId: 'today', tabKind: 'today.main', tabId: 'dock', shown: { chatId: CHAT, collapsed: false }, intent: 'profile' }]);
    // What main is handed names nothing of the assistant; the App hears only the intent (app-surface-intent-bridge.test.ts).
    for (const secret of [ASSISTANT, 'Dot', 'face.png', OWNER]) expect(JSON.stringify(state.reports)).not.toContain(secret);
  });

  it('the gear: the assistant\'s settings, the one host page over the panel, in place of a task; back closes it', async () => {
    setAppConversationPanelCollapsed('today', true);
    setAppWorkRows({ ownerId: OWNER, assistantId: ASSISTANT, open: (workId, sessionId) => ({ workId, title: 'x', assistantId: ASSISTANT, taskAgentId: null, task: { deviceId: 'd', sessionId }, assistants: [] }) });
    await render();
    await act(async () => readAppHostLayerBridge()!.open('today', { kind: 'work', ownerId: OWNER, workId: WORK, sessionId: 'exec-a' }));
    expect(find('app-conversation-panel')).toBeNull();
    await click('app-conversation-gear');
    expect(layers()).toEqual({ today: { kind: 'assistant-settings', ownerId: OWNER } });
    expect(find('app-conversation-panel')).not.toBeNull();
    expect(find('app-host-layer-assistant-settings')).not.toBeNull();
    expect(find('app-work-chat')).toBeNull();
    expect(find('app-page')).toBeNull();
    await click('app-host-layer-back');
    expect(layers()).toEqual({});
    expect(find('app-page')).not.toBeNull();
    // Nothing about it is reported as the conversation's: no intent from the gear.
    expect(state.reports.filter((report) => report.intent)).toEqual([]);
  });

  it('the gear for an account this window no longer shows opens nothing', async () => {
    await render();
    setAppHostLayerAccount(OTHER);
    await click('app-conversation-gear');
    expect(layers()).toEqual({});
  });
});
