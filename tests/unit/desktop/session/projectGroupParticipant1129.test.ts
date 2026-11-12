import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ rows: new Map<string, string>(), returned: vi.fn() }));
vi.mock('@renderer/lib/stores/app-state', () => ({ sidebarStore: { rowProjectIdOf: (id: string) => state.rows.get(id) ?? id } }));
vi.mock('@renderer/app/screen-layout-actions', () => ({ returnToScreen: state.returned }));
import { runInAction } from 'mobx';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';
import { accountProjectsStore } from '@renderer/features/projects/stores/account-projects-store';
import { screenLayout } from '@renderer/app/screen-layout';
import { groupParticipantPanes } from '@renderer/features/chats/group-participant-panes';
import { showGroupParticipant } from '@renderer/features/chats/group-participant-actions';
const first = { kind: 'project', projectId: 'first-bound-project' } as const;
const visible = { kind: 'project', projectId: 'visible-project' } as const;
const target = { kind: 'session', projectId: visible.projectId, sessionId: 'project-session-agent' } as const;
beforeEach(() => {
  vi.clearAllMocks(); state.rows.clear();
  groupParticipantPanes.useAccount('project-name-click-probe');
  projectGroupsStore.applyBindings(null, [
    { projectId: first.projectId, chatId: 'shared-project-group' },
    { projectId: visible.projectId, chatId: 'shared-project-group' },
  ]);
  // Which group a project on screen belongs to is the account's answer.
  runInAction(() => {
    accountProjectsStore.localDeviceId = 'this-computer';
    accountProjectsStore.list = [{
      chatId: 'shared-project-group', name: 'shared', archived: false,
      bindings: [first.projectId, visible.projectId].map((localProjectId) => ({ deviceId: 'this-computer', localProjectId })),
    }];
  });
});
afterEach(() => {
  for (const block of [...screenLayout.blocks.values(), ...screenLayout.parkedContents]) screenLayout.forgetContent(block);
  groupParticipantPanes.useAccount(null); projectGroupsStore.applyBindings(null, []); accountProjectsStore.clear();
});
it('opens beside a project group with one canonical visible project', () => {
  screenLayout.show(first);
  showGroupParticipant('shared-project-group', target);
  expect(screenLayout.order.map(id => screenLayout.blocks.get(id))).toEqual([first, target]);
  expect(state.returned).toHaveBeenCalledOnce();
});
it('opens beside the currently visible project when the first binding names another project', () => {
  screenLayout.show(visible);
  // Both are real bindings to the same group; the visible source is not necessarily the first one.
  expect(projectGroupsStore.projectOfChat('shared-project-group')).toBe(first.projectId);
  showGroupParticipant('shared-project-group', target);
  expect(screenLayout.order.map(id => screenLayout.blocks.get(id))).toEqual([visible, target]);
  expect(state.returned).toHaveBeenCalledOnce();
});
it('also opens when both devices resolve to the same visible sidebar row', () => {
  state.rows.set(first.projectId, visible.projectId);
  screenLayout.show(visible);
  showGroupParticipant('shared-project-group', target);
  expect(screenLayout.order.map(id => screenLayout.blocks.get(id))).toEqual([visible, target]);
});
it('keeps using the visible project after a newly available local project becomes the representative', () => {
  // Before: the visible project (on a connected machine) represents the project; after: the newly local one does.
  state.rows = new Map([[first.projectId, visible.projectId]]);
  screenLayout.show(visible);
  state.rows = new Map([[visible.projectId, first.projectId]]);
  showGroupParticipant('shared-project-group', target);
  expect(screenLayout.order.map(id => screenLayout.blocks.get(id))).toEqual([visible, target]);
});
it('uses a still-visible chat block after its project binding arrives', () => {
  const source = { kind: 'chat', chatId: 'shared-project-group' } as const;
  screenLayout.show(source);
  showGroupParticipant('shared-project-group', target);
  expect(screenLayout.order.map(id => screenLayout.blocks.get(id))).toEqual([source, target]);
});
it('keeps an ordinary group on its existing path', () => {
  const ordinary = { kind: 'chat', chatId: 'ordinary' } as const;
  screenLayout.show(ordinary);
  showGroupParticipant('ordinary', target);
  expect(screenLayout.order.map(id => screenLayout.blocks.get(id))).toEqual([ordinary, target]);
});
it('does not navigate after the source group is no longer visible', () => {
  screenLayout.show({ kind: 'project', projectId: 'unrelated' });
  showGroupParticipant('shared-project-group', target);
  expect(screenLayout.sessions).toHaveLength(0);
  expect(state.returned).not.toHaveBeenCalled();
});
