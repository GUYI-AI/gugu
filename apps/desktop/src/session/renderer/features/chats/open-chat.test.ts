import { beforeEach, expect, it, vi } from 'vitest';
const host = vi.hoisted(() => ({
  owned: vi.fn(), show: vi.fn(), beside: vi.fn(), project: vi.fn(), screen: vi.fn(), focus: vi.fn(),
}));
vi.mock('@/lib/composerEntryFocus', () => ({ requestComposerEntryFocus: host.focus }));
vi.mock('@/lib/ownedAgentConversation', () => ({ openOwnedAgentEntry: host.owned }));
vi.mock('@renderer/app/screen-layout-actions', () => ({
  isScreenView: host.screen, showOnScreen: host.show, showBesideOnScreen: host.beside,
}));
vi.mock('@renderer/features/projects/stores/project-groups-store', () => ({
  projectGroupsStore: { rowProjectOfChat: host.project, projectOfChat: () => 'bound-project' },
}));
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { navigation: { currentViewId: 'screen' } },
}));
import { openChatOnScreen } from './open-chat';
beforeEach(() => {
  vi.resetAllMocks(); host.screen.mockReturnValue(true);
});
it('keeps ordinary owned-agent navigation on its existing task', () => {
  host.owned.mockReturnValue(true);
  openChatOnScreen('owned-dm', false);
  expect(host.owned).toHaveBeenCalledWith('owned-dm', undefined, undefined, undefined, undefined);
  expect(host.show).not.toHaveBeenCalled();
  expect(host.focus).not.toHaveBeenCalled();
});
it('opens owned DM resources in the existing native session without an IM block', () => {
  host.owned.mockReturnValue(true);
  openChatOnScreen('owned-dm', false, 'resource');
  expect(host.owned).toHaveBeenCalledExactlyOnceWith('owned-dm', undefined, undefined, undefined, 'resource');
  expect(host.show).not.toHaveBeenCalled();
  expect(host.beside).not.toHaveBeenCalled();
  expect(host.focus).not.toHaveBeenCalled();
});
it('keeps group files in their project block and preserves ordinary beside entry', () => {
  host.project.mockReturnValue('sidebar-project');
  openChatOnScreen('group', false, 'resource');
  expect(host.show).toHaveBeenCalledWith({ kind: 'project', projectId: 'sidebar-project' });
  expect(host.focus).toHaveBeenCalledExactlyOnceWith(null);
  host.focus.mockClear();
  host.project.mockReturnValue(null);
  openChatOnScreen('human-dm', true);
  expect(host.beside).toHaveBeenCalledWith({ kind: 'chat', chatId: 'human-dm' });
  expect(host.focus).toHaveBeenCalledExactlyOnceWith('chat:human-dm');
});
it('opens a bound group with no project row as a chat', () => {
  openChatOnScreen('bound-without-row', false);
  expect(host.show).toHaveBeenCalledWith({ kind: 'chat', chatId: 'bound-without-row' });
  expect(host.focus).toHaveBeenCalledExactlyOnceWith('chat:bound-without-row');
});
it('a DM opened from a profile card inside a group (within) is where that group is left: switching away and back returns to it', async () => {
  const { screenLayout } = await import('@renderer/app/screen-layout');
  host.show.mockImplementation((content) => screenLayout.show(content));
  const shown = () => screenLayout.order.map((id) => screenLayout.blocks.get(id)).map((block) => (block?.kind === 'chat' ? block.chatId : block?.kind));
  openChatOnScreen('group-1', false);
  openChatOnScreen('dm-from-card', false, undefined, true);
  expect(shown()).toEqual(['dm-from-card']);
  openChatOnScreen('group-2', false);
  openChatOnScreen('group-1', false);
  expect(shown(), 'group-1 comes back to the DM opened inside it').toEqual(['dm-from-card']);
  openChatOnScreen('group-1', false);
  expect(shown(), 'its row again = the group itself').toEqual(['group-1']);
});
