// @vitest-environment jsdom
// #2548 固定到左侧栏, what the one list asks of a pinned agent's session (sidebar-pin-actions).
import { observable, runInAction } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  nodeById: new Map<string, { item: { projectId: string } }>(),
  setPinned: vi.fn<(sessionId: string, pinned: boolean) => Promise<void>>(),
  toast: vi.fn(),
}));
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { navigation: { navigate: vi.fn() } },
  sidebarStore: { placement: { get nodeById() { return state.nodeById; } } },
}));
vi.mock('./with-mounted-session', () => ({
  withMountedSession: (_projectId: string, _sessionId: string, run: (session: unknown, manager: unknown) => void) =>
    run({}, { setSessionPinnedToSidebar: state.setPinned }),
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: state.toast }));
vi.mock('@renderer/localization/locale-store', () => ({ translateSessionMessage: (key: string) => key }));
vi.mock('@renderer/features/chats/open-chat', () => ({ openChatOnScreen: vi.fn() }));
vi.mock('@renderer/features/sessions/open-session-in-session', () => ({ openSessionInSessionWhenReady: vi.fn() }));
vi.mock('@renderer/features/sessions/stores/session-registry', () => ({ sessionRegistry: { get: () => undefined } }));
vi.mock('./inner-sidebar-anchor', () => ({ innerSidebarChat: observable.box<{ chatId: string } | null>(null) }));

const { setPinnedToSidebar, unpinSessionFromSidebar } = await import('./sidebar-pin-actions');

beforeEach(() => {
  runInAction(() => state.nodeById.set('s1', { item: { projectId: 'p1' } }));
  state.setPinned.mockReset();
  state.toast.mockReset();
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
