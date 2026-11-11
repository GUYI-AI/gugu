// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * #1925 The shell's half of an App's main page beside its bound conversation: it draws the native conversation into the
 * column the session page leaves, only for the conversation the host says this account may see beside that installed App
 * — and drops it at once on an account switch, an inventory or grant change (read again), or leaving the conversation.
 */
const CHAT = '33000000-0000-4000-8000-000000000003';
const OTHER_CHAT = '44000000-0000-4000-8000-000000000004';
const placing = (id: string) => ({ id, contributes: { conversationSurface: { binding: 'main', placement: 'side-panel' } } });
const state = vi.hoisted(() => ({
  owner: 'owner-a',
  chats: [] as { id: string }[],
  inventory: [] as object[],
  disabled: [] as string[],
  panels: [] as Record<string, unknown>[],
  shown: [] as (string | null)[],
}));
const query = vi.hoisted(() => vi.fn());
vi.mock('@/store/auth', () => ({ useAuth: () => ({ user: state.owner ? { id: state.owner } : null }) }));
vi.mock('@/store/chatContext', () => ({ useStoreValueBy: (read: (store: { chats: { id: string }[] }) => unknown) => read({ chats: state.chats }) }));
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn: vi.fn() }) }));
vi.mock('@/lib/onScreenChat', () => ({ useReportChatOnScreen: (shown: string | null) => { state.shown.push(shown); return shown; } }));
vi.mock('@/session/renderer/lib/ipc', () => ({ rpc: { extensions: { conversationSurfaceBindings: query } } }));
vi.mock('@/session/renderer/features/extensions/installed-extensions-store', () => ({ installedExtensionsStore: {
  get manifests() { return state.inventory; },
  isEnabled: (id: string) => !state.disabled.includes(id),
} }));
vi.mock('@/components/ChatAreaPanel', () => ({ ChatAreaPanel: (props: Record<string, unknown>) => {
  state.panels.push(props);
  return <div data-testid="native-conversation" data-chat={String(props.chatId)} data-hidden={String(props.hidden)} />;
} }));

const { AppConversationSurfaceHost } = await import('../../../../apps/desktop/src/components/appSlot/AppConversationSurfaceHost');
const { readShellSlots } = await import('../../../../apps/desktop/src/lib/shellSlots');
const { appConversationSurfaceShows, readAppConversationSurfaceBridge } = await import('../../../../apps/desktop/src/lib/appConversationSurfaceBridge');

let root: Root;
let host: HTMLDivElement;
let column: HTMLDivElement;
const bindings = (ownerId = 'owner-a', entries: Record<string, string> = { today: CHAT }) => ({ success: true, data: { ownerId,
  bindings: Object.fromEntries(Object.entries(entries).map(([id, chatId]) => [id, { ownerId, name: 'main', chatId, handle: `handle-${id}` }])) } });
// In the app the inventory is observable and the chat list a subscription; here a fresh handler is what re-renders the host.
const render = async (visible = true) => {
  await act(async () => root.render(<AppConversationSurfaceHost visible={visible} onOpenUserChat={() => undefined} />));
};
const drawn = () => column.querySelector('[data-testid="native-conversation"]');
const published = () => readAppConversationSurfaceBridge()?.getSnapshot();

beforeEach(async () => {
  Object.assign(state, { owner: 'owner-a', chats: [{ id: CHAT }], inventory: [placing('today')], disabled: [], panels: [], shown: [] });
  query.mockReset().mockResolvedValue(bindings());
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  column = document.createElement('div'); document.body.append(column);
  // The session page's App frame left the column for `today`.
  await act(async () => readShellSlots()!.setSlot('app-conversation:today', column));
});
afterEach(async () => {
  await act(async () => readShellSlots()!.setSlot('app-conversation:today', null));
  await act(async () => root.unmount());
  host.remove(); column.remove();
});

describe('the native conversation beside an App\'s page', () => {
  it('is drawn only for a granted, bound App, in its own column, as the ordinary conversation', async () => {
    await render();
    expect(drawn()?.getAttribute('data-chat')).toBe(CHAT);
    expect(published()).toEqual({ today: CHAT });
    expect(state.panels.at(-1)).toMatchObject({ chatId: CHAT, viewportKey: 'app-conversation:today', hidden: false });
    expect(query).toHaveBeenCalledExactlyOnceWith({ ownerId: 'owner-a' });
  });

  it('is not drawn for an App that does not place its page there, or is switched off, or has no granted binding', async () => {
    state.inventory = [{ id: 'today', contributes: {} }];
    await render();
    expect(drawn()).toBeNull(); expect(query).not.toHaveBeenCalled(); expect(published()).toEqual({});
    state.inventory = [placing('today')]; state.disabled = ['today'];
    await render();
    expect(drawn()).toBeNull(); expect(published()).toEqual({});
    state.inventory = [placing('today')]; state.disabled = [];
    query.mockResolvedValue({ success: true, data: { ownerId: 'owner-a', bindings: {} } });
    await render();
    expect(drawn()).toBeNull(); expect(published()).toEqual({});
  });

  it('an App cannot have another conversation drawn: only its own column, its own binding, this account\'s', async () => {
    // Another App's grant is not this App's: its column stays empty.
    query.mockResolvedValue(bindings('owner-a', { other: OTHER_CHAT }));
    state.inventory = [placing('today'), placing('other')]; state.chats = [{ id: CHAT }, { id: OTHER_CHAT }];
    await render();
    expect(drawn()).toBeNull();
    expect(published()).toEqual({ other: OTHER_CHAT });
    // A binding written for another account, or under another name, is not drawn.
    state.inventory = [placing('today')];
    query.mockResolvedValue({ success: true, data: { ownerId: 'owner-a', bindings: { today: { ownerId: 'owner-b', name: 'main', chatId: CHAT, handle: 'h' } } } });
    await render(); expect(drawn()).toBeNull();
    state.inventory = [placing('today')];
    query.mockResolvedValue({ success: true, data: { ownerId: 'owner-a', bindings: { today: { ownerId: 'owner-a', name: 'other', chatId: CHAT, handle: 'h' } } } });
    await render(); expect(drawn()).toBeNull();
  });

  it('a withdrawn grant, a cleared choice or an uninstall (the inventory changes) takes the column away before the new read', async () => {
    await render(); expect(drawn()).not.toBeNull();
    let pending!: (value: unknown) => void;
    query.mockImplementationOnce(() => new Promise((resolve) => { pending = resolve; }));
    state.inventory = [placing('today')];
    await render();
    expect(drawn()).toBeNull(); expect(published()).toEqual({});
    expect(appConversationSurfaceShows(CHAT)).toBe(false);
    await act(async () => pending({ success: true, data: { ownerId: 'owner-a', bindings: {} } }));
    expect(drawn()).toBeNull();
    // Uninstalled: nothing placed, nothing asked, nothing drawn.
    state.inventory = [];
    await render(); expect(drawn()).toBeNull(); expect(published()).toEqual({});
  });

  it('an account switch takes it away at once and the old account\'s late answer is not used', async () => {
    let old!: (value: unknown) => void;
    query.mockImplementationOnce(() => new Promise((resolve) => { old = resolve; }));
    await render(); expect(drawn()).toBeNull();
    state.owner = 'owner-b';
    query.mockResolvedValue(bindings('owner-b', {}));
    await render();
    await act(async () => old(bindings('owner-a')));
    expect(drawn()).toBeNull(); expect(published()).toEqual({});
    state.owner = '';
    await render(); expect(drawn()).toBeNull();
  });

  it('leaving the conversation (it is gone from the chat list) takes the column away without another read', async () => {
    await render(); expect(drawn()).not.toBeNull();
    state.chats = [];
    await render();
    expect(drawn()).toBeNull(); expect(published()).toEqual({}); expect(query).toHaveBeenCalledOnce();
  });

  it('opening the App confirms nothing read: the conversation is seen only while the session page is on screen', async () => {
    await render(false);
    expect(drawn()?.getAttribute('data-hidden')).toBe('true');
    expect(state.shown.filter(Boolean)).toEqual([]);
    await render(true);
    expect(drawn()?.getAttribute('data-hidden')).toBe('false');
    expect(state.shown.at(-1)).toBe(CHAT);
  });

  it('a draft for that conversation lands in the composer drawn there only while it is drawn', async () => {
    expect(appConversationSurfaceShows(CHAT)).toBe(false);
    await render();
    expect(appConversationSurfaceShows(CHAT)).toBe(true);
    expect(appConversationSurfaceShows(OTHER_CHAT)).toBe(false);
    await act(async () => readShellSlots()!.setSlot('app-conversation:today', null));
    expect(appConversationSurfaceShows(CHAT)).toBe(false);
  });
});
