// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * Entry switch, the shell's half: whenever the window's assistant (account, found / none, its chat) or the assistant App
 * changes, main is asked to bring the trusted App's binding to that chat; its answer (trusted, being put in) is published for
 * the entries — per account, never another's. A sync main could not verify is asked again a few times, silently. And what the
 * built-in page did by being opened: its panel state carried over once, the local home refreshed when the App's page is up.
 */
const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER = '22000000-0000-4000-8000-000000000002';
const DM = '33000000-0000-4000-8000-000000000003';
const state = vi.hoisted(() => ({
  owner: '',
  notes: new Set<(note: { extensionId?: string }) => void>(),
  manifest: null as null | { id: string; version: string },
  answer: (args: { ownerId: string; chatId: string | null }) => ({ success: true, data: { ownerId: args.ownerId, extensionId: 'gugu-assistant', trusted: true, outcome: 'bound', changed: true } }) as unknown,
}));
const sync = vi.hoisted(() => vi.fn());
const handOver = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/store/auth', () => ({ useAuth: () => ({ user: state.owner ? { id: state.owner } : null }) }));
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }));
vi.mock('@/lib/assistantSetup', () => ({ refreshLocalAssistantHome: refresh }));
vi.mock('@/session/renderer/lib/stores/snapshot-registry', () => ({ snapshotRegistry: { register: vi.fn(() => () => undefined) } }));
vi.mock('@/session/renderer/lib/ipc', () => ({
  rpc: { extensions: { syncAssistantAppEntry: sync, handOverAssistantPage: handOver } },
  // Main's `extensionsInventoryChangedChannel` only: other modules listen to other channels through the same mock.
  events: { on: (channel: { name?: string }, listener: (note: { extensionId?: string }) => void) => {
    if (channel?.name !== 'extensions.inventory.changed') return () => undefined;
    state.notes.add(listener);
    return () => { state.notes.delete(listener); };
  } },
}));
vi.mock('@/session/renderer/features/extensions/installed-extensions-store', () => ({ installedExtensionsStore: {
  manifestFor: (id: string) => (id === 'gugu-assistant' ? state.manifest : null),
  get origins() { return { 'gugu-assistant': 'market' }; },
  isEnabled: () => true,
} }));

const { AssistantAppEntryHost } = await import('../../../../apps/desktop/src/components/appSlot/AssistantAppEntryHost');
const { installAssistantShellBridge, publishAssistantShell } = await import('../../../../apps/desktop/src/lib/assistantShellBridge');
const { publishAppConversationSurfaces, installAppConversationSurfaceBridge } = await import('../../../../apps/desktop/src/lib/appConversationSurfaceBridge');
const { readAssistantAppEntryBridge, readAssistantEntryTarget, ASSISTANT_APP_ID } = await import('../../../../apps/desktop/src/lib/assistantEntry');
const { appConversationPanelCollapsed } = await import('../../../../apps/desktop/src/session/renderer/features/apps/app-conversation-panel');
const { appState } = await import('../../../../apps/desktop/src/session/renderer/lib/stores/app-state');

const shell = (over: Record<string, unknown> = {}) => ({
  cloudAvailable: false, canHostHere: true, cloud: null, loadError: null,
  assistant: { id: 'assistant', display_name: 'Dot', avatar: null, created_at: null, agent_type: 'claude-code' },
  assistantState: 'found', ownerName: 'U', ownerId: OWNER, chatId: DM, setup: null, member: false, preparing: false,
  home: { kind: 'computer', deviceId: 'this', thisDevice: true, online: true }, ...over,
}) as never;
const word = () => readAssistantAppEntryBridge()?.getSnapshot() ?? null;
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };

let root: Root;
let container: HTMLElement;
async function mount() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<AssistantAppEntryHost />));
  await flush();
}

beforeEach(() => {
  // The shell installs it (AssistantShellHost); here, the test does.
  installAssistantShellBridge();
  installAppConversationSurfaceBridge();
  state.owner = OWNER;
  state.manifest = { id: ASSISTANT_APP_ID, version: '0.1.0' };
  sync.mockReset().mockImplementation(async (args: { ownerId: string; chatId: string | null }) => state.answer(args));
  refresh.mockClear();
  handOver.mockReset().mockResolvedValue({ success: true, data: { held: true } });
  publishAssistantShell(shell());
  publishAppConversationSurfaces({});
  localStorage.clear();
  appState.navigation.navigate('home');
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  publishAppConversationSurfaces({});
});

describe('asking main to bind the trusted App', () => {
  it('asks with the window\'s assistant chat, publishes main\'s answer for this account', async () => {
    await mount();
    expect(sync).toHaveBeenLastCalledWith({ ownerId: OWNER, chatId: DM });
    expect(word()).toEqual({ ownerId: OWNER, trusted: true });
  });

  it('asks again when the assistant goes (closed: no chat) and comes back, and not while it is still being read', async () => {
    await mount();
    sync.mockClear();
    await act(async () => publishAssistantShell(shell({ assistant: null, assistantState: 'none', chatId: null })));
    await flush();
    expect(sync).toHaveBeenLastCalledWith({ ownerId: OWNER, chatId: null });
    sync.mockClear();
    await act(async () => publishAssistantShell(shell({ assistantState: 'loading', chatId: null })));
    await flush();
    expect(sync).not.toHaveBeenCalled();
    await act(async () => publishAssistantShell(shell({ chatId: '44000000-0000-4000-8000-000000000004' })));
    await flush();
    expect(sync).toHaveBeenLastCalledWith({ ownerId: OWNER, chatId: '44000000-0000-4000-8000-000000000004' });
  });

  it('asks again when that App changes (installed, its grant or choice), not when another does', async () => {
    await mount();
    sync.mockClear();
    await act(async () => { for (const note of state.notes) note({ extensionId: 'other-app' }); });
    await flush();
    expect(sync).not.toHaveBeenCalled();
    await act(async () => { for (const note of state.notes) note({ extensionId: ASSISTANT_APP_ID }); });
    await flush();
    expect(sync).toHaveBeenCalledOnce();
  });

  it('follows the account: the old answer goes at once, a late one for it is not used', async () => {
    await mount();
    let late: (value: unknown) => void = () => undefined;
    sync.mockImplementationOnce(() => new Promise((resolve) => { late = resolve; }));
    state.owner = OTHER;
    await act(async () => publishAssistantShell(shell({ ownerId: OTHER })));
    await act(async () => root.render(<AssistantAppEntryHost />));
    await flush();
    expect(sync).toHaveBeenLastCalledWith({ ownerId: OTHER, chatId: DM });
    expect(word()).toBeNull();
    late(state.answer({ ownerId: OWNER, chatId: DM }));
    await flush();
    // The answer was about the other account: nothing is published for this one.
    expect(word()).toBeNull();
  });

  it('asks again, a few times, what main could not verify; never says anything', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    sync.mockImplementation(async (args: { ownerId: string }) => ({ success: true, data: { ownerId: args.ownerId, extensionId: ASSISTANT_APP_ID, trusted: true, outcome: 'unverified', changed: false } }));
    await mount();
    expect(sync).toHaveBeenCalledTimes(1);
    for (const wait of [5_000, 30_000, 120_000]) {
      await act(async () => { vi.advanceTimersByTime(wait); });
      await flush();
    }
    expect(sync).toHaveBeenCalledTimes(4);
    await act(async () => { vi.advanceTimersByTime(600_000); });
    await flush();
    expect(sync).toHaveBeenCalledTimes(4);
  });

  // verify-pass1 D4: the assistant's chat is known before the assistant is ready; main binds the App only once it is ready for that
  // chat (`pending` before). The window asks again at once when the setup moves on (its step, or no longer being made), and,
  // like what main could not verify, a few times by itself.
  it('asks again, a few times, while main says the assistant is not ready for its chat yet', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    sync.mockImplementation(async (args: { ownerId: string }) => ({ success: true, data: { ownerId: args.ownerId, extensionId: ASSISTANT_APP_ID, trusted: true, outcome: 'pending', changed: false } }));
    await mount();
    expect(sync).toHaveBeenCalledTimes(1);
    for (const wait of [5_000, 30_000, 120_000]) {
      await act(async () => { vi.advanceTimersByTime(wait); });
      await flush();
    }
    expect(sync).toHaveBeenCalledTimes(4);
    await act(async () => { vi.advanceTimersByTime(600_000); });
    await flush();
    expect(sync).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['its step moves on', { setup: 'shell', preparing: true }, { setup: 'connect', preparing: true }],
    ['it is no longer being made', { setup: 'shell', preparing: true }, { setup: 'shell', preparing: false }],
  ])('asks again at once when the setup moves on: %s; not for what changes nothing', async (_what, before, after) => {
    publishAssistantShell(shell(before))
    await mount();
    sync.mockClear();
    await act(async () => publishAssistantShell(shell({ ...before, ownerName: 'Another name' })));
    await flush();
    expect(sync).not.toHaveBeenCalled();
    await act(async () => publishAssistantShell(shell(after)));
    await flush();
    expect(sync).toHaveBeenCalledOnce();
    expect(sync).toHaveBeenLastCalledWith({ ownerId: OWNER, chatId: DM });
  });

  it('a window without its host bridge: logged, nothing thrown', async () => {
    sync.mockImplementation(() => { throw new Error('electronAPI.invoke is unavailable'); });
    await mount();
    expect(word()).toBeNull();
  });
});

describe('what opening the built-in page did', () => {
  it('carries the built-in panel state over once, when the App becomes where the entry goes', async () => {
    localStorage.setItem('gugu.assistant.panel', 'closed');
    await mount();
    expect(localStorage.getItem(`gugu.app.${ASSISTANT_APP_ID}.panel`)).toBeNull();
    await act(async () => publishAppConversationSurfaces({ [ASSISTANT_APP_ID]: DM }));
    await flush();
    expect(readAssistantEntryTarget().kind).toBe('app');
    expect(localStorage.getItem(`gugu.app.${ASSISTANT_APP_ID}.panel`)).toBe('closed');
    expect(appConversationPanelCollapsed(ASSISTANT_APP_ID)).toBe(true);
    // Once: the App's own state stands from then on, whatever the built-in page stored later.
    localStorage.setItem(`gugu.app.${ASSISTANT_APP_ID}.panel`, 'open');
    localStorage.setItem('gugu.assistant.panel', 'closed');
    await act(async () => publishAppConversationSurfaces({}));
    await act(async () => publishAppConversationSurfaces({ [ASSISTANT_APP_ID]: DM }));
    await flush();
    expect(localStorage.getItem(`gugu.app.${ASSISTANT_APP_ID}.panel`)).toBe('open');
  });

  // The built-in page's view is gone: a restored snapshot still holds its last tab, kept until handed over.
  const retired = (tab: string) => appState.navigation.restoreSnapshot({ viewParams: { assistant: { tab } } as never });

  it('hands the built-in page\'s last tab to the App once for this account, when the App becomes where the entry goes', async () => {
    retired('memory');
    await mount();
    expect(handOver).not.toHaveBeenCalled();
    await act(async () => publishAppConversationSurfaces({ [ASSISTANT_APP_ID]: DM }));
    await flush();
    expect(handOver).toHaveBeenCalledExactlyOnceWith({ ownerId: OWNER, tab: 'memory' });
    expect(localStorage.getItem(`gugu.assistant.handedOver:${OWNER}`)).toBe('1');
    // Never again for this account.
    await act(async () => publishAppConversationSurfaces({}));
    await act(async () => publishAppConversationSurfaces({ [ASSISTANT_APP_ID]: DM }));
    await flush();
    expect(handOver).toHaveBeenCalledOnce();
  });

  it('keeps the tab and asks again on a later run when main did not hold it (the App still going in)', async () => {
    handOver.mockResolvedValue({ success: true, data: { held: false } });
    retired('tasks');
    await mount();
    await act(async () => publishAppConversationSurfaces({ [ASSISTANT_APP_ID]: DM }));
    await flush();
    expect(handOver).toHaveBeenCalledOnce();
    expect(localStorage.getItem(`gugu.assistant.handedOver:${OWNER}`)).toBeNull();
    // A later run: the snapshot no longer holds the retired view; the kept tab is handed over.
    await act(async () => root.unmount());
    handOver.mockReset().mockResolvedValue({ success: true, data: { held: true } });
    appState.navigation.restoreSnapshot({ viewParams: {} });
    await mount();
    await flush();
    expect(handOver).toHaveBeenCalledExactlyOnceWith({ ownerId: OWNER, tab: 'tasks' });
    expect(localStorage.getItem(`gugu.assistant.handedOver:${OWNER}`)).toBe('1');
  });

  it('hands nothing for 动态 (the default) or when nothing was stored, and does not ask again', async () => {
    retired('today');
    await mount();
    await act(async () => publishAppConversationSurfaces({ [ASSISTANT_APP_ID]: DM }));
    await flush();
    expect(handOver).not.toHaveBeenCalled();
    expect(localStorage.getItem(`gugu.assistant.handedOver:${OWNER}`)).toBe('1');
  });

  it('refreshes the assistant\'s home on this computer when the App\'s page is up, as the built-in page did on opening', async () => {
    publishAppConversationSurfaces({ [ASSISTANT_APP_ID]: DM });
    await mount();
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => appState.navigation.navigate('app', { appId: ASSISTANT_APP_ID }));
    await flush();
    expect(refresh).toHaveBeenCalledWith('claude');
    // Living elsewhere: nothing to refresh here.
    refresh.mockClear();
    await act(async () => appState.navigation.navigate('home'));
    await act(async () => publishAssistantShell(shell({ home: { kind: 'cloud', deviceId: 'cloud', thisDevice: false, online: true } })));
    await act(async () => appState.navigation.navigate('app', { appId: ASSISTANT_APP_ID }));
    await flush();
    expect(refresh).not.toHaveBeenCalled();
  });
});
