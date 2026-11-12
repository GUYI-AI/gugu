// @vitest-environment jsdom
// GUYI-AI/gugu#2548 rows of the one list that are not a conversation yet (an account project whose group chat is not in
// the chat list, a task with no agent identity, the sample): drawn as conversation rows, always after every conversation
// row.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  /** The account project rows (sidebarStore.sidebarProjects), each with its project group. */
  projects: [] as { id: string; chatId: string }[],
  listedGroups: null as ReadonlySet<string> | null,
  /** Top-level standalone tasks whose session has no 咕咕 identity (sidebarStore.tasksWithoutAgent). */
  tasks: [] as { projectId: string; sessionId: string }[],
  sampleShown: false,
  accountStatus: 'ready' as 'loading' | 'ready' | 'error',
  leftOpen: true,
}));
vi.mock('@/lib/sidebarChatsBridge', () => ({
  useSidebarChatSignals: () => ({ listedGroups: state.listedGroups, chatsUnread: 3, groupUnread: new Map([['chat-1', 2], ['chat-2', 4]]), groupCallingTopic: new Map() }),
}));
vi.mock('@renderer/features/projects/stores/account-projects-store', () => ({
  accountProjectsStore: { get status() { return state.accountStatus; } },
}));
vi.mock('@renderer/features/projects/components/account-projects-error', () => ({
  AccountProjectsError: () => <p data-row="account-projects-error" />,
}));
vi.mock('@renderer/lib/layout/layout-provider', () => ({ useWorkspaceLayoutContext: () => ({ isLeftOpen: state.leftOpen }) }));
vi.mock('@renderer/features/sample-project/use-sample-project', () => ({
  useSampleProject: () => ({ shown: state.sampleShown, settled: true, owner: { id: 'me', name: 'Me', avatarUrl: null } }),
}));
vi.mock('@renderer/lib/stores/app-state', () => ({
  sidebarStore: {
    get sidebarProjects() { return state.projects; },
    get tasksWithoutAgent() { return state.tasks; },
  },
}));
// The chat list is drawn into this slot by the shell's tree (ChatListPanel, its own tests); here it stands for every
// activity-sorted conversation row.
vi.mock('./sidebar-chats-section', () => ({
  SidebarChatsSection: () => <div data-region="sidebar-chat-list" />,
}));
vi.mock('./project-item', () => ({
  SidebarProjectItem: ({ projectId }: { projectId: string }) => <div data-row={`project:${projectId}`} />,
}));
vi.mock('./sample-project-row', () => ({ SampleProjectSidebar: () => <div data-row="sample" /> }));
vi.mock('./one-list-task-row', () => ({
  OneListTaskRow: ({ sessionId }: { sessionId: string }) => <div data-row={`task:${sessionId}`} />,
}));

const { SidebarOneList } = await import('./sidebar-one-list');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  state.projects = [{ id: 'with-group', chatId: 'chat-1' }, { id: 'no-group-b', chatId: 'chat-b' }, { id: 'no-group-a', chatId: 'chat-a' }];
  state.listedGroups = new Set(['chat-1']);
  state.tasks = [];
  state.sampleShown = true;
  state.accountStatus = 'ready';
  state.leftOpen = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = () => act(async () => root.render(<SidebarOneList />));
/** Everything the list draws, top to bottom: the conversation rows' slot, then each row of its own. */
const order = () => [...host.querySelectorAll<HTMLElement>('[data-region="sidebar-chat-list"], [data-row]')].map((node) => node.dataset.row ?? 'conversations');

describe('rows that are not a conversation yet', () => {
  it('come after every conversation row: account projects whose group chat is not listed (sidebar order), then the sample', async () => {
    await render();
    expect(order()).toEqual(['conversations', 'project:no-group-b', 'project:no-group-a', 'sample']);
  });

  // A standalone task is its agent's conversation row; one whose session has no identity has no conversation to be.
  it('a top-level task with no agent identity is a row of its own, after the projects and before the sample', async () => {
    state.tasks = [{ projectId: 'workspace', sessionId: 'pty-new' }, { projectId: 'workspace', sessionId: 'pty-old' }];
    await render();
    expect(order()).toEqual(['conversations', 'project:no-group-b', 'project:no-group-a', 'task:pty-new', 'task:pty-old', 'sample']);
  });

  it('a project whose group chat is in the list is that conversation row, not one of these', async () => {
    state.listedGroups = new Set(['chat-1', 'chat-b']);
    await render();
    expect(order()).toEqual(['conversations', 'project:no-group-a', 'sample']);
  });

  it('the account project list unread: the list ends with that line and its retry, not on the rail', async () => {
    state.accountStatus = 'error';
    await render();
    expect(order()).toEqual(['conversations', 'project:no-group-b', 'project:no-group-a', 'sample', 'account-projects-error']);
    // The list is an observer (memoized) over plain test state: remount so it reads the new state.
    state.projects = [];
    state.sampleShown = false;
    await act(async () => root.render(<SidebarOneList key="no-rows" />));
    expect(order()).toEqual(['conversations', 'account-projects-error']);
    state.leftOpen = false;
    await act(async () => root.render(<SidebarOneList key="rail" />));
    expect(order()).toEqual(['conversations']);
  });

  it('draw nothing of their own until the chat list has loaded, and no sample when it is not shown', async () => {
    state.listedGroups = null;
    state.sampleShown = false;
    await render();
    expect(order()).toEqual(['conversations']);
  });
});

describe('they are drawn as a project group\'s conversation row is (ListRow + project cover), not as the old folder row', () => {
  it('cover, name, time, then the chip and the preview in the list row\'s slots; a click opens, ⌘ click opens beside', async () => {
    const { OneListProjectRow } = await import('./project-row-parts');
    const open = vi.fn();
    await act(async () => root.render(<OneListProjectRow name="Weekend" coverId="sample-project" tag="Sample" time="14:34" preview="Codex 6: Three files" selected onOpen={open} />));
    const row = host.querySelector<HTMLElement>('[data-slot="list-row"]')!;
    expect(row.className).toContain('gg-list-row');
    expect(row.dataset.selected).toBe('true');
    expect(row.querySelector('.gg-list-row-leading svg.gg-project-avatar')).not.toBeNull();
    expect(row.querySelector('.gg-list-row-title')!.textContent).toBe('Weekend');
    expect(row.querySelector('.gg-list-row-meta')!.textContent).toBe('14:34');
    const subtitle = row.querySelector('.gg-list-row-subtitle')!;
    expect(subtitle.querySelector('.gg-chip')!.textContent).toBe('Sample');
    expect(subtitle.textContent).toBe('Sample Codex 6: Three files');
    await act(async () => row.click());
    await act(async () => { row.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })); });
    expect(open.mock.calls).toEqual([[false], [true]]);
  });

  it('a project with no group chat yet: no time, an empty preview line (nothing said), same two lines', async () => {
    const { OneListProjectRow } = await import('./project-row-parts');
    await act(async () => root.render(<OneListProjectRow name="App" coverId="project-app" preview="" selected={false} onOpen={vi.fn()} />));
    const row = host.querySelector<HTMLElement>('[data-slot="list-row"]')!;
    expect(row.querySelector('.gg-list-row-leading svg.gg-project-avatar')).not.toBeNull();
    expect(row.querySelector('.gg-chip')).toBeNull();
    expect(row.querySelector('.gg-list-row-meta')).toBeNull();
    expect(row.querySelectorAll('.gg-list-row-line')).toHaveLength(2);
    expect(row.querySelector('.gg-list-row-subtitle')!.textContent).toBe('');
  });
});
