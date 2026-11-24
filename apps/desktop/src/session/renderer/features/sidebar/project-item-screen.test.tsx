// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Real navigation, screen layout and screen actions; only the project's own stores and row chrome are stand-ins.
vi.mock('@renderer/lib/layout/navigation-provider', async () => {
  const { appState } = await import('@renderer/lib/stores/app-state');
  return {
    useNavigate: () => ({ navigate: appState.navigation.navigate.bind(appState.navigation) }),
    useWorkspaceSlots: () => ({ currentView: appState.navigation.currentViewId }),
    useParams: (view: string) => ({ params: (appState.navigation.viewParamsStore as Record<string, unknown>)[view] ?? {} }),
  };
});
vi.mock('@renderer/features/projects/hooks/use-confirm-delete-project', () => ({ useConfirmDeleteProject: () => vi.fn() }));
vi.mock('@renderer/features/projects/stores/project', () => ({ isUnregisteredProject: () => false }));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectStore: () => ({ id: 'trial', name: 'Trial', state: 'mounted', data: { path: '/trial' } }),
  getGitRepositoryStore: () => null, projectViewKind: () => 'ready',
}));
vi.mock('@renderer/features/projects/project-presence', () => ({ projectPresence: () => 'present' }));
vi.mock('@/components/chat/ProjectRowContextMenu', () => ({ ProjectRowContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
// The chat list's signals and the chat opener: a topic calling you is reached through its project row (below).
const chats = vi.hoisted(() => ({ openChat: vi.fn(), rows: null as unknown[] | null, signals: null as null | { groupUnread: Map<string, number>; groupCallingTopic: Map<string, { chatId: string; name: string }> } }));
// The account's project rows, when a case names them; else the real store's.
vi.mock('@renderer/lib/stores/app-state', async (original) => {
  const real = await original<typeof import('@renderer/lib/stores/app-state')>();
  const sidebarStore = new Proxy(real.sidebarStore, { get: (target, key) => key === 'sidebarProjects' && chats.rows ? chats.rows : Reflect.get(target, key, target) });
  return { ...real, sidebarStore };
});
vi.mock('@/lib/sidebarChatsBridge', async (original) => ({ ...(await original<object>()), useSidebarChatSignals: () => chats.signals }));
vi.mock('@renderer/features/chats/open-chat', async (original) => ({ ...(await original<object>()), openChatOnScreen: chats.openChat }));

import { appState } from '@renderer/lib/stores/app-state';
import { screenLayout } from '@renderer/app/screen-layout';
import { ensureScreenLayoutSync } from '@renderer/app/screen-layout-actions';
import { SidebarProjectItem } from './project-item';

it('a project row click puts the project block on screen even when navigation already names that project', async () => {
  for (const view of ['home', 'project', 'session', 'chat', 'screen'] as const) appState.navigation.registerView(view);
  ensureScreenLayoutSync();
  appState.navigation.navigate('project', { projectId: 'trial' });
  // Navigation and screen disagree: navigation is on the project while only one of its sessions fills the screen.
  screenLayout.show({ kind: 'session', projectId: 'trial', sessionId: 'dsh-1' });
  expect(appState.navigation.currentViewId).toBe('project');
  expect(screenLayout.blocks.get(screenLayout.focusedBlockId!)).toEqual({ kind: 'session', projectId: 'trial', sessionId: 'dsh-1' });

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<SidebarProjectItem projectId="trial" />));
    const row = host.querySelector('[data-project-row="trial"]') as HTMLElement;
    // The row does not claim to be what is on screen.
    expect(row.hasAttribute('data-selected')).toBe(false);
    await act(async () => row.click());
    expect(screenLayout.blocks.get(screenLayout.focusedBlockId!)).toEqual({ kind: 'project', projectId: 'trial' });
    expect(appState.navigation.currentViewId).toBe('project');
    expect(row.dataset.selected).toBe('true');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

// owner 11-07「红点消不掉」, #62: the row's count includes a topic calling you, and topics are not rows under the project —
// the row itself is the way into that topic, which opens as the main conversation.
it('a project row whose count comes from a topic calling you opens that topic as the main conversation', async () => {
  chats.rows = [{ kind: 'local', id: 'trial', chatId: 'trial-group', name: 'Trial' }];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    // Control: the count is the group's own main line — the project opens, no chat.
    chats.signals = { groupUnread: new Map([['trial-group', 2]]), groupCallingTopic: new Map() };
    await act(async () => root.render(<SidebarProjectItem projectId="trial" />));
    await act(async () => (host.querySelector('[data-project-row="trial"]') as HTMLElement).click());
    expect(chats.openChat).not.toHaveBeenCalled();
    chats.signals = { groupUnread: new Map([['trial-group', 1]]), groupCallingTopic: new Map([['trial-group', { chatId: 'topic-1', name: 'Release' }]]) };
    // The row is an observer (memoized): remount so it reads the new signals.
    await act(async () => root.render(<SidebarProjectItem key="calling" projectId="trial" />));
    await act(async () => (host.querySelector('[data-project-row="trial"]') as HTMLElement).click());
    expect(chats.openChat).toHaveBeenCalledExactlyOnceWith('topic-1', false);
  } finally {
    chats.rows = null;
    chats.signals = null;
    await act(async () => root.unmount());
    host.remove();
  }
});
