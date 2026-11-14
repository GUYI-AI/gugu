// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  navigate: vi.fn(), expand: vi.fn(), beside: vi.fn(), show: vi.fn(), screen: false, topicSplit: vi.fn(),
  /** The account project rows (sidebarStore.sidebarProjects). */
  rows: [] as Array<{ kind: 'group' | 'local'; id: string; chatId: string; name: string }>,
  openChat: vi.fn(),
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
  sidebarStore: { get sidebarProjects() { return state.rows; }, expandedProjectIds: new Set(),
    projectMembersOf: () => ['business'], rowProjectIdOf: (id: string) => id,
    ensureProjectExpanded: state.expand },
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
vi.mock('@/lib/sidebarChatsBridge', () => ({ useSidebarChatSignals: () => state.signals }));
vi.mock('@/lib/topicSplitRequest', () => ({ requestTopicSplit: state.topicSplit }));
vi.mock('@renderer/features/chats/open-chat', () => ({ openChatOnScreen: state.openChat }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));

import { SidebarProjectItem } from './project-item';

it('opens an actual project on the assistant device and keeps its project menu', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<SidebarProjectItem projectId="business" />));
    expect(host.querySelector('[data-context-disabled="false"]')).not.toBeNull();
    await act(async () => (host.querySelector('[data-project-row="business"]') as HTMLElement).click());
    expect(state.show).toHaveBeenCalledWith({ kind: 'project', projectId: 'business' });
    expect(state.expand).not.toHaveBeenCalled();
    state.screen = true;
    await act(async () => host.querySelector('[data-project-row="business"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })));
    expect(state.beside).toHaveBeenCalledWith({ kind: 'project', projectId: 'business' });
    expect(state.show).toHaveBeenCalledTimes(1);
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
  state.rows = [{ kind: 'local', id: 'business', chatId: 'business-group', name: 'Research' }];
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
    state.rows = [];
    state.signals = null;
    await act(async () => root.unmount());
    host.remove();
  }
});

// 项目与机器解耦:账号上的项目在这一端一个本地项目都没有(哪台上都没有文件夹)也有一行,点开是它的项目群。
// #2548 it is a row of the one list like any other: it opens, it does not drag out.
it('a project without any local project is a row named after the project that opens its group chat', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  state.rows = [{ kind: 'group', id: 'chat-paper', chatId: 'chat-paper', name: 'Paper' }];
  try {
    await act(async () => root.render(<SidebarProjectItem projectId="chat-paper" />));
    const row = host.querySelector('[data-project-row="chat-paper"]') as HTMLElement;
    expect(row.getAttribute('data-project-chat')).toBe('chat-paper');
    expect(row.textContent).toContain('Paper');
    expect(row.draggable).toBe(false);
    await act(async () => row.click());
    expect(state.openChat).toHaveBeenCalledWith('chat-paper', false);
    expect(state.show).not.toHaveBeenCalledWith({ kind: 'project', projectId: 'chat-paper' });
  } finally {
    state.rows = [];
    await act(async () => root.unmount());
    host.remove();
  }
});
