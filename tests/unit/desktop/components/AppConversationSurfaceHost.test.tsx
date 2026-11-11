// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * #1925 The shell's half of an App's main page beside its bound conversation: it draws the native conversation into the
 * column the session page leaves, only for the conversation the host says this account may see beside that installed App.
 * Each App's column is kept or dropped by its own authority: another App installed, updated or removed leaves it mounted
 * (same instance, the draft in it kept); this App's revoke, unbind, switch-off, uninstall or update, and an account switch,
 * drop it at once; a new authority from main draws it anew. Leaving the conversation drops it too.
 */
const CHAT = '33000000-0000-4000-8000-000000000003';
const OTHER_CHAT = '44000000-0000-4000-8000-000000000004';
const placing = (id: string, version = '1.0.0') => ({ id, version, contributes: { conversationSurface: { binding: 'main', placement: 'side-panel' } } });
const plain = (id: string, version = '1.0.0') => ({ id, version, contributes: {} });
const state = vi.hoisted(() => ({
  owner: 'owner-a',
  chats: [] as { id: string }[],
  inventory: [] as object[],
  disabled: [] as string[],
  publishers: {} as Record<string, { id: string }>,
  panels: [] as Record<string, unknown>[],
  shown: [] as (string | null)[],
  mounts: 0,
  inventoryNotes: new Set<(note: { extensionId?: string }) => void>(),
}));
const query = vi.hoisted(() => vi.fn());
vi.mock('@/store/auth', () => ({ useAuth: () => ({ user: state.owner ? { id: state.owner } : null }) }));
vi.mock('@/store/chatContext', () => ({ useStoreValueBy: (read: (store: { chats: { id: string }[] }) => unknown) => read({ chats: state.chats }) }));
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn: vi.fn() }) }));
vi.mock('@/lib/onScreenChat', () => ({ useReportChatOnScreen: (shown: string | null) => { state.shown.push(shown); return shown; } }));
vi.mock('@/session/renderer/lib/ipc', () => ({
  rpc: { extensions: { conversationSurfaceBindings: query } },
  // Main's `extensionsInventoryChangedChannel`: it names the App whose grant, choice, switch or installation it changed.
  events: { on: (_channel: unknown, listener: (note: { extensionId?: string }) => void) => {
    state.inventoryNotes.add(listener);
    return () => { state.inventoryNotes.delete(listener); };
  } },
}));
vi.mock('@/session/renderer/features/extensions/installed-extensions-store', () => ({ installedExtensionsStore: {
  get manifests() { return state.inventory; },
  get origins() { return {}; },
  get publishers() { return state.publishers; },
  isEnabled: (id: string) => !state.disabled.includes(id),
} }));
// The native conversation as far as this test needs it: an instance with state of its own (a draft typed in its composer).
vi.mock('@/components/ChatAreaPanel', async () => {
  const { useEffect } = await import('react');
  return { ChatAreaPanel: (props: Record<string, unknown>) => {
    state.panels.push(props);
    useEffect(() => { state.mounts += 1; }, []);
    return (
      <div data-testid="native-conversation" data-chat={String(props.chatId)} data-hidden={String(props.hidden)}>
        <textarea data-testid="composer" defaultValue="" />
      </div>
    );
  } };
});

const { AppConversationSurfaceHost } = await import('../../../../apps/desktop/src/components/appSlot/AppConversationSurfaceHost');
const { readShellSlots } = await import('../../../../apps/desktop/src/lib/shellSlots');
const { appConversationSurfaceShows, readAppConversationSurfaceBridge } = await import('../../../../apps/desktop/src/lib/appConversationSurfaceBridge');

let root: Root;
let host: HTMLDivElement;
let column: HTMLDivElement;
const bindings = (ownerId = 'owner-a', entries: Record<string, string> = { today: CHAT }, authority = 'first') => ({ success: true, data: { ownerId,
  bindings: Object.fromEntries(Object.entries(entries).map(([id, chatId]) => [id, { ownerId, name: 'main', chatId, handle: `handle-${id}`, authority: `${authority}-${id}` }])) } });
/** The next read stays out until answered. */
const waiting = () => {
  let answer!: (value: unknown) => void;
  query.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
  return (value: unknown) => act(async () => answer(value));
};
const note = (extensionId: string) => act(async () => { for (const listener of state.inventoryNotes) listener({ extensionId }); });
// In the app the inventory is observable and the chat list a subscription; here a fresh handler is what re-renders the host.
const render = async (visible = true) => {
  await act(async () => root.render(<AppConversationSurfaceHost visible={visible} onOpenUserChat={() => undefined} />));
};
const drawn = () => column.querySelector('[data-testid="native-conversation"]');
const composer = () => column.querySelector<HTMLTextAreaElement>('[data-testid="composer"]');
const published = () => readAppConversationSurfaceBridge()?.getSnapshot();

beforeEach(async () => {
  Object.assign(state, { owner: 'owner-a', chats: [{ id: CHAT }], inventory: [placing('today')], disabled: [], publishers: {}, panels: [], shown: [], mounts: 0 });
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
    state.inventory = [plain('today')];
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
    query.mockResolvedValue({ success: true, data: { ownerId: 'owner-a', bindings: { today: { ownerId: 'owner-b', name: 'main', chatId: CHAT, handle: 'h', authority: 'a' } } } });
    await render(); expect(drawn()).toBeNull();
    state.inventory = [placing('today')];
    query.mockResolvedValue({ success: true, data: { ownerId: 'owner-a', bindings: { today: { ownerId: 'owner-a', name: 'other', chatId: CHAT, handle: 'h', authority: 'a' } } } });
    await render(); expect(drawn()).toBeNull();
  });

  it('another App installed, updated, switched or removed leaves it mounted: the same instance, the draft in it kept', async () => {
    await render();
    const typed = composer()!; typed.value = 'half a sentence';
    const mounted = state.mounts;
    // Installed: the inventory changes and is read again; while that read is out, and after it answers the same, it stays.
    const installed = waiting();
    state.inventory = [placing('today'), plain('other')];
    await render();
    expect(composer()).toBe(typed);
    await installed(bindings());
    // Updated, and main names it (its grant, its switch): only that App is read again.
    state.inventory = [placing('today'), plain('other', '2.0.0')];
    await render(); await note('other');
    // Another App placing its page beside its own binding comes and goes: not this column's business.
    query.mockResolvedValue(bindings('owner-a', { today: CHAT, more: OTHER_CHAT }));
    state.inventory = [placing('today'), plain('other', '2.0.0'), placing('more')]; state.chats = [{ id: CHAT }, { id: OTHER_CHAT }];
    await render();
    query.mockResolvedValue(bindings());
    state.inventory = [placing('today'), plain('other', '2.0.0')]; await note('more');
    await render();
    // Removed; and a read that fails meanwhile takes nothing back.
    query.mockResolvedValue({ success: false, error: 'offline' });
    state.inventory = [placing('today')]; await note('other');
    await render();
    expect(composer()).toBe(typed);
    expect(typed.value).toBe('half a sentence');
    expect(state.mounts).toBe(mounted);
    expect(published()).toEqual({ today: CHAT });
    expect(query.mock.calls.length).toBeGreaterThan(3);
  });

  it('a withdrawn grant, a cleared choice or a switch of this App (main names it) takes the column away before the new read', async () => {
    await render(); const typed = composer()!;
    for (const [answer, drawnAfter] of [[{ success: true, data: { ownerId: 'owner-a', bindings: {} } }, false], [bindings('owner-a', { today: CHAT }, 'second'), true]] as const) {
      const read = waiting();
      await note('today');
      expect(drawn()).toBeNull(); expect(published()).toEqual({});
      expect(appConversationSurfaceShows(CHAT)).toBe(false);
      await read(answer);
      expect(drawn() !== null).toBe(drawnAfter);
    }
    // Drawn again under the new grant: a new conversation instance, not the old one with its draft.
    expect(composer()).not.toBe(typed);
  });

  it('switched off, uninstalled, updated or reinstalled from elsewhere, this App\'s column goes at once', async () => {
    await render();
    // Switched off, then on; uninstalled, then installed again: only a new read brings it back, not what was read before.
    for (const [off, on] of [[() => { state.disabled = ['today']; }, () => { state.disabled = []; }], [() => { state.inventory = []; }, () => { state.inventory = [placing('today')]; }]]) {
      off(); await render(); expect(drawn()).toBeNull(); expect(published()).toEqual({});
      const back = waiting();
      on(); await render(); expect(drawn()).toBeNull();
      await back(bindings()); expect(drawn()).not.toBeNull();
    }
    // Its update, or the same bundle from another publisher: gone before the read, drawn anew once main answers.
    for (const [index, change] of [() => { state.inventory = [placing('today', '2.0.0')]; }, () => { state.publishers = { today: { id: 'someone-else' } }; state.inventory = [placing('today', '2.0.0')]; }].entries()) {
      const typed = composer();
      const read = waiting();
      const renders = state.panels.length;
      change(); await render();
      // Not drawn again even once, in the very render that sees the change.
      expect(drawn()).toBeNull(); expect(state.panels.length).toBe(renders);
      await read(bindings('owner-a', { today: CHAT }, `after-${index}`));
      expect(drawn()).not.toBeNull(); expect(composer()).not.toBe(typed);
    }
    // Reinstalled as it was: main answers a new authority for it, so it is a new conversation instance.
    const typed = composer();
    query.mockResolvedValue(bindings('owner-a', { today: CHAT }, 'reinstalled'));
    state.inventory = [placing('today', '2.0.0')]; await render();
    expect(drawn()).not.toBeNull(); expect(composer()).not.toBe(typed);
  });

  it('an account switch takes it away at once and the old account\'s late answer is not used', async () => {
    const old = waiting();
    await render(); expect(drawn()).toBeNull();
    state.owner = 'owner-b';
    query.mockResolvedValue(bindings('owner-b', {}));
    await render();
    await old(bindings('owner-a'));
    expect(drawn()).toBeNull(); expect(published()).toEqual({});
    state.owner = '';
    await render(); expect(drawn()).toBeNull();
  });

  it('switching back to an account does not reuse what was read for it before', async () => {
    await render(); expect(drawn()).not.toBeNull();
    // The other account's own read never answers.
    query.mockResolvedValue({ success: false, error: 'offline' });
    state.owner = 'owner-b'; await render(); expect(drawn()).toBeNull();
    const again = waiting();
    state.owner = 'owner-a'; await render();
    expect(drawn()).toBeNull();
    await again(bindings());
    expect(drawn()).not.toBeNull();
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
