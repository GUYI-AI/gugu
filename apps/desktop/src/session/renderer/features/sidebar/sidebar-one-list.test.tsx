// @vitest-environment jsdom
// GUYI-AI/gugu#2548 rows of the one list that are not a conversation yet: an account project whose group chat is not in
// the chat list stands among the conversation rows (in the place the chat list leaves for it); a task with no agent
// identity and the sample are drawn as conversation rows after every conversation row.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  /** The account project rows (sidebarStore.sidebarProjects), each with its project group. */
  projects: [] as { id: string; chatId: string }[],
  /** The shell slots: the places the chat list left for project rows, under oneListProjectSlotKey. */
  slots: new Map<string, HTMLElement>(),
  /** Top-level standalone tasks whose session has no 咕咕 identity (sidebarStore.tasksWithoutAgent). */
  tasks: [] as { projectId: string; sessionId: string }[],
  sampleShown: false,
  accountStatus: 'ready' as 'loading' | 'ready' | 'error',
  leftOpen: true,
}));
vi.mock('@/lib/shellSlots', () => ({ readShellSlots: () => ({ subscribeSlots: () => () => {}, getSlots: () => state.slots }) }));
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
// activity-sorted conversation row, with the places it left for project rows between them.
vi.mock('./sidebar-chats-section', () => ({
  SidebarChatsSection: () => <div data-region="sidebar-chat-list" ref={(element) => { if (element) for (const slot of state.slots.values()) element.append(slot); }} />,
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
  state.slots = new Map();
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
/** A place the chat list left for a project row among its conversation rows. */
const slot = (chatId: string) => {
  const element = document.createElement('div');
  element.dataset.oneListProject = chatId;
  state.slots.set(`one-list-project:${chatId}`, element);
  return element;
};

describe('rows that are not a conversation yet', () => {
  it('the sample comes after every conversation row', async () => {
    await render();
    expect(order()).toEqual(['conversations', 'sample']);
  });

  // The chat list places them by time (ChatListPanel, lib/sidebarOneList placeProjectLines); this side draws the row.
  it('an account project whose group chat is not listed is drawn into the place the chat list left for it, among its rows', async () => {
    const b = slot('chat-b');
    const a = slot('chat-a');
    await render();
    expect(b.querySelector('[data-row]')?.getAttribute('data-row')).toBe('project:no-group-b');
    expect(a.querySelector('[data-row]')?.getAttribute('data-row')).toBe('project:no-group-a');
    expect(host.querySelector('[data-sidebar-one-list-tail] [data-row^="project:"]')).toBeNull();
  });

  it('other shell slots are not project places', async () => {
    const other = document.createElement('div');
    state.slots.set('chat:chat-b', other);
    await render();
    expect(other.childElementCount).toBe(0);
  });

  it('a place for a project that has just left the account project list stays empty (the chat list drops it next)', async () => {
    const gone = slot('chat-gone');
    await render();
    expect(gone.childElementCount).toBe(0);
  });

  // A standalone task is its agent's conversation row; one whose session has no identity has no conversation to be.
  it('a top-level task with no agent identity is a row of its own, after the conversations and before the sample', async () => {
    state.tasks = [{ projectId: 'workspace', sessionId: 'pty-new' }, { projectId: 'workspace', sessionId: 'pty-old' }];
    await render();
    expect(order()).toEqual(['conversations', 'task:pty-new', 'task:pty-old', 'sample']);
  });

  it('the account project list unread: the list ends with that line and its retry, not on the rail', async () => {
    state.accountStatus = 'error';
    await render();
    expect(order()).toEqual(['conversations', 'sample', 'account-projects-error']);
    // The list is an observer (memoized) over plain test state: remount so it reads the new state.
    state.sampleShown = false;
    await act(async () => root.render(<SidebarOneList key="no-rows" />));
    expect(order()).toEqual(['conversations', 'account-projects-error']);
    state.leftOpen = false;
    await act(async () => root.render(<SidebarOneList key="rail" />));
    expect(order()).toEqual(['conversations']);
  });

  it('no sample when it is not shown', async () => {
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

  it('a project with no group chat yet: nothing said, so an empty preview line, same two lines (no time given = none shown)', async () => {
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
