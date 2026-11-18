// @vitest-environment jsdom
// #2548 固定到左侧栏, what the one list asks of a pinned agent's session (sidebar-pin-actions).
import { observable, runInAction } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  nodeById: new Map<string, { item: { projectId: string } }>(),
  setPinned: vi.fn<(sessionId: string, pinned: boolean) => Promise<void>>(),
  toast: vi.fn(),
}));
/** The main area: the navigation's view and its parameters, as the task page's navigation store holds them. */
const navigation = vi.hoisted(() => ({ currentViewId: 'home', viewParamsStore: {} as Record<string, unknown>, navigate: (_viewId: string, _params?: unknown) => {} }));
vi.mock('@renderer/lib/stores/app-state', async () => {
  const { observable, runInAction } = await import('mobx');
  const live = observable(navigation, { navigate: false });
  live.navigate = vi.fn((viewId: string, params?: unknown) => runInAction(() => {
    live.currentViewId = viewId;
    live.viewParamsStore = { ...live.viewParamsStore, [viewId]: params };
  }));
  return { appState: { navigation: live }, sidebarStore: { placement: { get nodeById() { return state.nodeById; } } } };
});
vi.mock('./with-mounted-session', () => ({
  withMountedSession: (_projectId: string, _sessionId: string, run: (session: unknown, manager: unknown) => void) =>
    run({}, { setSessionPinnedToSidebar: state.setPinned }),
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: state.toast }));
vi.mock('@renderer/utils/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('@renderer/localization/locale-store', () => ({ translateSessionMessage: (key: string) => key }));
const openChatOnScreen = vi.hoisted(() => vi.fn());
vi.mock('@renderer/features/chats/open-chat', () => ({ openChatOnScreen }));
const openSessionInSessionWhenReady = vi.hoisted(() => vi.fn());
vi.mock('@renderer/features/sessions/open-session-in-session', () => ({ openSessionInSessionWhenReady }));
vi.mock('@renderer/features/sessions/stores/session-registry', () => ({ sessionRegistry: { get: () => undefined } }));
vi.mock('./inner-sidebar-anchor', () => ({ innerSidebarChat: observable.box<{ chatId: string } | null>(null) }));

const { openSidebarPin, setPinnedToSidebar, unpinSessionFromSidebar } = await import('./sidebar-pin-actions');
const { appState } = await import('@renderer/lib/stores/app-state');
const { innerSidebarChat } = await import('./inner-sidebar-anchor');

beforeEach(() => {
  runInAction(() => state.nodeById.set('s1', { item: { projectId: 'p1' } }));
  state.setPinned.mockReset();
  state.toast.mockReset();
  openChatOnScreen.mockReset();
  // Opening a chat on screen takes the main area to it (open-chat → showOnScreen → followFocus), synchronously.
  openChatOnScreen.mockImplementation((chatId: string) => appState.navigation.navigate('chat', { chatId }));
  openSessionInSessionWhenReady.mockReset();
  runInAction(() => innerSidebarChat.set(null));
  appState.navigation.navigate('home');
  vi.mocked(appState.navigation.navigate).mockClear();
});
afterEach(() => state.nodeById.clear());

describe('a refused pin or unpin is said, not swallowed', () => {
  it('the session menu\'s pin and the one list\'s unpin: the host\'s refusal comes up as a toast', async () => {
    state.setPinned.mockRejectedValue(new Error('Session s1 has a parent session'));
    setPinnedToSidebar('p1', 's1', true);
    unpinSessionFromSidebar('s1');
    await vi.waitFor(() => expect(state.toast).toHaveBeenCalledTimes(2));
    expect(state.setPinned.mock.calls).toEqual([['s1', true], ['s1', false]]);
    expect(state.toast.mock.calls.map(([options]) => [options.title, options.description, options.variant])).toEqual([
      ['task.pinToSidebarFailed', 'Session s1 has a parent session', 'destructive'],
      ['task.unpinFromSidebarFailed', 'Session s1 has a parent session', 'destructive'],
    ]);
  });

  it('a write that lands says nothing', async () => {
    state.setPinned.mockResolvedValue(undefined);
    setPinnedToSidebar('p1', 's1', true);
    await Promise.resolve();
    await Promise.resolve();
    expect(state.toast).not.toHaveBeenCalled();
  });
});

// The pinned rows are published from an effect, so for a moment the shell can still draw a row whose session the sidebar
// no longer holds (archived elsewhere, its machine's list gone). Using that row says so; it does not throw from the click.
describe('a pinned row a moment behind the sidebar', () => {
  it('clicking it or unpinning it says the task is no longer in the list, and opens or writes nothing', () => {
    expect(() => openSidebarPin('s-gone', 'room')).not.toThrow();
    expect(() => unpinSessionFromSidebar('s-gone')).not.toThrow();
    expect(openChatOnScreen).not.toHaveBeenCalled();
    expect(state.setPinned).not.toHaveBeenCalled();
    expect(state.toast.mock.calls.map(([options]) => [options.title, options.variant])).toEqual([
      ['task.pinnedSessionGone', 'destructive'],
      ['task.pinnedSessionGone', 'destructive'],
    ]);
  });
});

// The column settles on the home only once it is shown, which can take a while (chat summaries, the project list). What
// the user opens meanwhile is what they want: the pinned agent is no longer theirs to open once the main area moved on.
describe('opening a pinned agent waits for its home\'s column, and only while the main area stays there', () => {
  const columnSettles = () => runInAction(() => innerSidebarChat.set({ kind: 'group', chatId: 'room' }));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('the column settles on the home: the pinned session opens in it', async () => {
    openSidebarPin('s1', 'room');
    expect(openChatOnScreen).toHaveBeenCalledWith('room', false);
    columnSettles();
    await settle();
    expect(appState.navigation.navigate).toHaveBeenLastCalledWith('session', { projectId: 'p1', sessionId: 's1' });
    expect(openSessionInSessionWhenReady).toHaveBeenCalledWith({ projectId: 'p1', sessionId: 's1' });
  });

  it('the user opens something else and then that same group before the column settles: the pinned session does not take over', async () => {
    openSidebarPin('s1', 'room');
    appState.navigation.navigate('chat', { chatId: 'other' });
    appState.navigation.navigate('chat', { chatId: 'room' });
    columnSettles();
    await settle();
    expect(appState.navigation.navigate).not.toHaveBeenCalledWith('session', expect.anything());
    expect(openSessionInSessionWhenReady).not.toHaveBeenCalled();
  });
});
