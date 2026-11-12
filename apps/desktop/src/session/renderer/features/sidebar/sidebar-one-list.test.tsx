// @vitest-environment jsdom
// GUYI-AI/gugu#2548 rows of the one list that are not a conversation yet (a project without its group chat, the sample):
// drawn as conversation rows, always after every conversation row, and the keyboard chain holds exactly those projects.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  projects: [] as string[],
  groups: new Map<string, string>(),
  listedGroups: null as ReadonlySet<string> | null,
  sampleShown: false,
  setOneListProjects: vi.fn(),
}));
vi.mock('@/lib/sidebarChatsBridge', () => ({
  useSidebarChatSignals: () => ({ listedGroups: state.listedGroups, chatsUnread: 3, groupUnread: new Map([['chat-1', 2], ['chat-2', 4]]), groupCallingTopic: new Map() }),
}));
vi.mock('@renderer/features/projects/stores/project-groups-store', () => ({
  projectGroupsStore: { chatIdOf: (id: string) => state.groups.get(id), bindingKnown: () => true },
}));
vi.mock('@renderer/features/sample-project/use-sample-project', () => ({
  useSampleProject: () => ({ shown: state.sampleShown, settled: true, owner: { id: 'me', name: 'Me', avatarUrl: null } }),
}));
vi.mock('@renderer/lib/stores/app-state', () => ({
  sidebarStore: {
    get sidebarProjects() { return state.projects.map((id) => ({ id })); },
    setOneListProjects: state.setOneListProjects,
  },
}));
// The chat list is drawn into this slot by the shell's tree (ChatListPanel, its own tests); here it stands for every
// activity-sorted conversation row.
vi.mock('./sidebar-chats-section', () => ({
  SidebarChatsSection: ({ unread }: { unread: number }) => <div data-region="sidebar-chat-list" data-unread={unread} />,
}));
vi.mock('./project-item', () => ({
  SidebarProjectItem: ({ projectId }: { projectId: string }) => <div data-row={`project:${projectId}`} />,
}));
vi.mock('./sample-project-row', () => ({ SampleProjectSidebar: () => <div data-row="sample" /> }));

const { SidebarOneList } = await import('./sidebar-one-list');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  state.projects = ['with-group', 'no-group-b', 'no-group-a'];
  state.groups = new Map([['with-group', 'chat-1'], ['no-group-b', 'chat-reserved']]);
  state.listedGroups = new Set(['chat-1']);
  state.sampleShown = true;
  state.setOneListProjects.mockClear();
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
  it('come after every conversation row: projects without a group chat (sidebar order), then the sample', async () => {
    await render();
    expect(order()).toEqual(['conversations', 'project:no-group-b', 'project:no-group-a', 'sample']);
  });

  it('a project whose group chat is in the list is that conversation row, not one of these', async () => {
    state.listedGroups = new Set(['chat-1', 'chat-reserved']);
    await render();
    expect(order()).toEqual(['conversations', 'project:no-group-a', 'sample']);
  });

  it('draw nothing of their own until the chat list has loaded, and no sample when it is not shown', async () => {
    state.listedGroups = null;
    state.sampleShown = false;
    await render();
    expect(order()).toEqual(['conversations']);
  });

  it('the conversations keep their 「对话」 header, its number the two old tabs\' unread counts added up (the list holds both)', async () => {
    await render();
    const list = host.querySelector<HTMLElement>('[data-region="sidebar-chat-list"]')!;
    expect(list.dataset.unread).toBe('9');
  });

  it('the task page\'s keyboard chain holds exactly the project rows drawn here, and nothing once the list is gone', async () => {
    await render();
    expect(state.setOneListProjects).toHaveBeenLastCalledWith(['no-group-b', 'no-group-a']);
    act(() => root.unmount());
    expect(state.setOneListProjects).toHaveBeenLastCalledWith(null);
    root = createRoot(host);
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
