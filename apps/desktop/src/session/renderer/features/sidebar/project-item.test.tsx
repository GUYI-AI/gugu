// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  navigate: vi.fn(), expand: vi.fn(), toggle: vi.fn(), beside: vi.fn(), show: vi.fn(), screen: false, topicSplit: vi.fn(),
  group: undefined as string | undefined,
  signals: null as null | { groupUnread: Map<string, number>; groupCallingTopic: Map<string, { chatId: string; name: string }> },
}));
vi.mock('@renderer/features/projects/hooks/use-confirm-delete-project', () => ({ useConfirmDeleteProject: () => vi.fn() }));
vi.mock('@renderer/features/projects/stores/project', () => ({ isUnregisteredProject: () => false }));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectStore: () => ({ id: 'business', name: 'Research', state: 'unmounted', data: { path: '/research' } }),
  getGitRepositoryStore: () => null, projectViewKind: () => 'idle_unmounted',
}));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: state.navigate }),
  useWorkspaceSlots: () => ({ currentView: 'new-session' }),
}));
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { navigation: { currentViewId: 'new-session' } },
  sidebarStore: { expandedProjectIds: new Set(), homeLayout: { homeRows: new Set(), standIns: new Map() },
    needsYouCountForProject: () => 0, projectMembersOf: () => ['business'], hasNameTwin: () => false, rowProjectIdOf: (id: string) => id,
    ensureProjectExpanded: state.expand, toggleProjectExpanded: state.toggle },
}));
vi.mock('@renderer/app/screen-layout-actions', () => ({ isScreenView: () => state.screen, showBesideOnScreen: state.beside, showOnScreen: state.show }));
vi.mock('@renderer/app/screen-layout', () => ({ screenLayout: { focusedBlockId: null, blocks: new Map() } }));
vi.mock('@/lib/composerVerbBridge', () => ({ readComposerVerb: () => null, setComposerVerb: vi.fn() }));
vi.mock('@renderer/features/projects/project-task-entry', () => ({ prepareProjectTask: vi.fn() }));
vi.mock('@renderer/features/sessions/composer-drafts', () => ({ composerDrafts: { get: () => '' }, projectDraftKey: () => '' }));
vi.mock('@/components/chat/ProjectRowContextMenu', () => ({
  ProjectRowContextMenu: ({ disabled, children }: { disabled: boolean; children: React.ReactNode }) => <div data-context-disabled={String(disabled)}>{children}</div>,
}));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: { machineOfProject: () => ({ id: 'assistant-device', assistantHome: true, label: 'Assistant' }),
    connectionState: () => 'connected', device: () => ({ label: 'Assistant' }) },
}));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => 'assistant-device' } }));
vi.mock('./session-keyboard-nav', () => ({ sessionKeyboardNav: { cursor: null, syncCursorFromPointer: vi.fn() } }));
vi.mock('./project-row-parts', () => ({ ProjectNeedsYouDot: () => null, ProjectRowTitle: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock('./sidebar-list-switch', () => ({ SidebarUnreadCount: () => null }));
vi.mock('@/lib/sidebarChatsBridge', () => ({ useSidebarChatSignals: () => state.signals }));
vi.mock('@/lib/topicSplitRequest', () => ({ requestTopicSplit: state.topicSplit }));
vi.mock('@renderer/features/projects/stores/project-groups-store', () => ({ projectGroupsStore: { chatIdOf: () => state.group } }));
vi.mock('./use-session-drop-target', () => ({ useSessionDropTarget: () => ({ bind: () => ({}) }) }));
vi.mock('@renderer/features/sessions/set-session-parent-flow', () => ({ moveSessionUnder: vi.fn() }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));

import { SidebarProjectItem } from './project-item';

it('opens an actual project on the assistant device and retains its project controls', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<SidebarProjectItem projectId="business" />));
    expect(host.querySelector('[data-context-disabled="false"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="sidebar.newSessionIn"]')).not.toBeNull();
    await act(async () => (host.querySelector('[data-project-row="business"]') as HTMLElement).click());
    expect(state.show).toHaveBeenCalledWith({ kind: 'project', projectId: 'business' });
    expect(state.expand).not.toHaveBeenCalled();
    expect(state.toggle).not.toHaveBeenCalled();
    state.screen = true;
    await act(async () => host.querySelector('[data-project-row="business"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })));
    expect(state.beside).toHaveBeenCalledWith({ kind: 'project', projectId: 'business' });
    expect(state.show).toHaveBeenCalledTimes(1);
    await act(async () => (host.querySelector('[aria-label="sidebar.newSessionIn"]') as HTMLElement).click());
    expect(state.expand).not.toHaveBeenCalled();
    expect(state.toggle).not.toHaveBeenCalled();
  } finally {
    state.screen = false;
    await act(async () => root.unmount());
    host.remove();
  }
});

// owner 11-07「红点消不掉」: the row's count includes a topic calling you, and topics are not rows under the project — the
// row itself is the way into that topic.
it('a project row whose count comes from a topic calling you opens that topic beside its group', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  state.group = 'business-group';
  try {
    // Control: the count is the group's own main line — only the group opens.
    state.signals = { groupUnread: new Map([['business-group', 2]]), groupCallingTopic: new Map() };
    await act(async () => root.render(<SidebarProjectItem projectId="business" />));
    await act(async () => (host.querySelector('[data-project-row="business"]') as HTMLElement).click());
    expect(state.show).toHaveBeenLastCalledWith({ kind: 'project', projectId: 'business' });
    expect(state.topicSplit).not.toHaveBeenCalled();
    state.signals = { groupUnread: new Map([['business-group', 1]]), groupCallingTopic: new Map([['business-group', { chatId: 'topic-1', name: 'Release' }]]) };
    // The row is an observer (memoized): remount so it reads the new signals.
    await act(async () => root.render(<SidebarProjectItem key="calling" projectId="business" />));
    await act(async () => (host.querySelector('[data-project-row="business"]') as HTMLElement).click());
    expect(state.topicSplit).toHaveBeenCalledWith({ chatId: 'topic-1', name: 'Release', sourceChatId: 'business-group', focusComposer: true });
    expect(state.show).toHaveBeenLastCalledWith({ kind: 'project', projectId: 'business' });
  } finally {
    state.group = undefined;
    state.signals = null;
    await act(async () => root.unmount());
    host.remove();
  }
});
