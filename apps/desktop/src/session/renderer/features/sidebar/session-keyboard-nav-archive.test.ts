// @vitest-environment jsdom
import { observable } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * behavior session-page「键盘导航」 ⌃X⌃X archives the open task, then moves on to the next item of the list the user sees,
 * as the old sidebar did. #2548 that list is the one list, whose rows (and their ⌘↓ order) are the shell's chat list:
 * the next row there, the one before it at the end, and the New task page only when there is no other row.
 */

const navigation = observable({
  currentViewId: 'session' as string,
  viewParamsStore: { session: { projectId: 'p1', sessionId: 's1' } } as Record<string, unknown>,
});
const navigateTransient = vi.fn();
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { navigation: Object.assign(navigation, { navigateTransient }) },
  sidebarStore: { expandedProjectIds: new Set() },
}));
const archiveSessionNow = vi.hoisted(() => vi.fn());
vi.mock('@renderer/features/sessions/archive-session-flow', () => ({ archiveSessionNow }));
vi.mock('./with-mounted-session', () => ({
  withMountedSession: (_projectId: string, _sessionId: string, run: () => void) => run(),
}));
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({ getSessionView: () => undefined }));
vi.mock('@renderer/features/chats/open-chat', () => ({ openChatOnScreen: vi.fn() }));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ showModal: vi.fn() }));

const { sessionKeyboardNav } = await import('./session-keyboard-nav');
const { installOneListNeighbour } = await import('@/lib/sidebarChatsBridge');

let uninstall: (() => void) | undefined;
beforeEach(() => {
  archiveSessionNow.mockClear();
  navigateTransient.mockClear();
});
afterEach(() => uninstall?.());

const archiveTwice = () => {
  expect(sessionKeyboardNav.pressArchive()).toBe(true);
  expect(sessionKeyboardNav.pressArchive()).toBe(true);
};

describe('⌃X⌃X on the open task', () => {
  it('archives it and opens the one list\'s next row, not the New task page', () => {
    const neighbour = vi.fn(() => true);
    uninstall = installOneListNeighbour(neighbour);
    archiveTwice();
    expect(archiveSessionNow).toHaveBeenCalledWith({ projectId: 'p1', sessionId: 's1', withChildren: false });
    expect(neighbour).toHaveBeenCalledTimes(1);
    expect(navigateTransient).not.toHaveBeenCalled();
  });

  it('with no other row in the one list, goes to the New task page (as the old sidebar did with nothing next)', () => {
    uninstall = installOneListNeighbour(() => false);
    archiveTwice();
    expect(archiveSessionNow).toHaveBeenCalledTimes(1);
    expect(navigateTransient).toHaveBeenCalledWith('new-session');
  });
});
