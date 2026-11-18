// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { observable, runInAction } from 'mobx';
import { readProjectGroupChats, readProjectGroupMembers } from '@/lib/projectGroupChatsBridge';
import { SidebarStore } from '@renderer/features/sidebar/sidebar-store';
import { groupInviteAccess } from '@/lib/groupMemberPermissions';
import { ProjectGroupsStore, projectGroupsStore } from './project-groups-store';
import { AccountProjectsStore } from './account-projects-store';
import type { AccountProject } from '@gugu/core/cloud/deviceProjects';

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: {},
  onMachineEvent: () => () => {},
  rpcOn: () => ({ projects: { listProjectGroupBindings: async () => ({ success: true, data: [] }) } }),
}));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: {} }));
vi.mock('@renderer/features/sessions/acp/acp-chat-store', () => ({ AcpChatStore: class {} }));
vi.mock('@renderer/features/sessions/acp/acp-chat-panel', () => ({ AcpChatPanel: () => null }));

type ProjectManager = ConstructorParameters<typeof SidebarStore>[0];
const project = (id: string, kind?: string) => ({
  id, name: id, createdAt: '2026-01-01T00:00:00.000Z', data: { kind }, mountedProject: null,
});

/** 侧栏的项目行来自账号上的项目;这里给定那份,项目表照用例改。 */
function sidebarWith(projects: ProjectManager['projects'], list: AccountProject[]): SidebarStore {
  const accounts = new AccountProjectsStore();
  const sidebar = new SidebarStore({ projects } as unknown as ProjectManager, accounts);
  accounts.attach({ projects, machineOf: (id) => sidebar.machines?.machineOf(id) ?? null, connected: () => false });
  runInAction(() => {
    accounts.list = list;
    accounts.localDeviceId = 'this-computer';
    accounts.status = 'ready';
  });
  return sidebar;
}
const local = (localProjectId: string) => ({ deviceId: 'this-computer', localProjectId });

describe('project group visibility across Projects and Chats', () => {
  it('only hides groups with a project row, including when rows arrive or disappear after bindings', async () => {
    const projects = observable.map([
      ['visible-project', project('visible-project')],
      ['workspace-project', project('workspace-project', 'workspace')],
    ]);
    const groups = new ProjectGroupsStore();
    const sidebar = sidebarWith(projects as never, [
      { chatId: 'visible-group', name: 'visible', archived: false, activeAt: '2026-01-01T00:00:00.000Z', bindings: [local('visible-project')] },
      { chatId: 'hidden-group', name: 'hidden', archived: false, activeAt: '2026-01-01T00:00:00.000Z', bindings: [local('hidden-project')] },
    ]);
    sidebar.machines = { machineOf: () => null, label: () => null, homeDir: () => null };
    groups.start(() => [], () => [], () => sidebar.sidebarProjects.map(({ id }) => id));
    await groups.refresh(null);
    groups.applyBindings(null, [
      { projectId: 'visible-project', chatId: 'visible-group' },
      { projectId: 'hidden-project', chatId: 'hidden-group' },
      { projectId: 'workspace-project', chatId: 'workspace-group' },
    ]);

    // hidden-group has no local project here: its row is the group itself, which is not a project row of any binding.
    expect(sidebar.sidebarProjects.map(({ id }) => id)).toEqual(['visible-project', 'hidden-group']);
    expect([...readProjectGroupChats()]).toEqual(['visible-group']);
    expect(groups.projectOfChat('hidden-group')).toBe('hidden-project');
    expect(groups.rowProjectOfChat('visible-group')).toBe('visible-project');
    expect(groups.rowProjectOfChat('hidden-group')).toBeUndefined();
    expect(groups.rowProjectOfChat('workspace-group')).toBeUndefined();

    runInAction(() => projects.set('hidden-project', project('hidden-project')));
    expect(new Set(readProjectGroupChats())).toEqual(new Set(['visible-group', 'hidden-group']));
    expect(groups.rowProjectOfChat('hidden-group')).toBe('hidden-project');
    runInAction(() => projects.delete('hidden-project'));
    expect([...readProjectGroupChats()]).toEqual(['visible-group']);
    expect(groups.rowProjectOfChat('hidden-group')).toBeUndefined();
  });

  it('keeps one project group when its representative row changes and preserves hidden-project members', async () => {
    const projects = observable.map([
      ['local-project', project('local-project')],
      ['remote-project', project('remote-project')],
    ]);
    const groups = new ProjectGroupsStore();
    const sidebar = sidebarWith(projects as never, [{
      chatId: 'shared-group', name: 'shared', archived: false, activeAt: '2026-01-01T00:00:00.000Z',
      bindings: [local('local-project'), { deviceId: 'other-device', localProjectId: 'remote-project' }, local('hidden-project')],
    }]);
    sidebar.machines = {
      machineOf: (id) => id === 'remote-project' ? 'other-device' : null,
      label: () => null, homeDir: () => null, connected: () => false,
    };
    const sessions = () => [{ projectId: 'hidden-project', sessionId: 'session-agent', agentUserId: 'agent' }];
    groups.start(() => [], sessions, () => sidebar.sidebarProjects.map(({ id }) => id));
    await groups.refresh(null);
    groups.applyBindings(null, ['local-project', 'remote-project', 'hidden-project'].map((projectId) => ({ projectId, chatId: 'shared-group' })));

    expect(sidebar.sidebarProjects.map(({ id }) => id)).toEqual(['local-project']);
    expect([...readProjectGroupChats()]).toEqual(['shared-group']);
    expect(groups.rowProjectOfChat('shared-group')).toBe('local-project');
    expect(readProjectGroupMembers().get('shared-group')).toEqual(['agent']);
    runInAction(() => projects.delete('local-project'));
    expect(sidebar.sidebarProjects.map(({ id }) => id)).toEqual(['remote-project']);
    expect([...readProjectGroupChats()]).toEqual(['shared-group']);
    expect(groups.rowProjectOfChat('shared-group')).toBe('remote-project');
    runInAction(() => projects.delete('remote-project'));
    expect([...readProjectGroupChats()]).toEqual([]);
    expect(groups.rowProjectOfChat('shared-group')).toBeUndefined();
    expect(readProjectGroupMembers().get('shared-group')).toEqual(['agent']);
  });

  it('keeps human invitations disabled for a bound group without a project row', () => {
    projectGroupsStore.applyBindings(null, [{ projectId: 'hidden-project', chatId: 'hidden-group' }]);
    try {
      expect(projectGroupsStore.rowProjectOfChat('hidden-group')).toBeUndefined();
      expect(projectGroupsStore.projectOfChat('hidden-group')).toBe('hidden-project');
      expect(groupInviteAccess('hidden-group', 'group', { my_role: 'owner', can_manage: true, allow_member_invite: true }))
        .toEqual({ projectGroup: true, showInvite: true, canInviteHumans: false });
    } finally {
      projectGroupsStore.applyBindings(null, []);
    }
  });
});
