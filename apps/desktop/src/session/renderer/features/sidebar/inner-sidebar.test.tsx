// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation';
import { observable, runInAction } from 'mobx';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const running = presentAgentStatus({ reading: { status: 'working', detail: null } });
const waiting = presentAgentStatus({ reading: { status: 'needs_user', detail: 'question' } });
const idle = presentAgentStatus({ reading: { status: 'idle', detail: null } });
type Item = {
  id: string;
  projectId: string;
  parentSessionId?: string | null;
  isPinned: boolean;
  time: number;
  presentation: typeof running | null;
  unseen: boolean;
  title: string;
};
const item = (id: string, projectId: string, presentation: Item['presentation'] = idle, time = 0): Item => ({
  id,
  projectId,
  isPinned: false,
  time,
  presentation,
  unseen: false,
  title: id,
});

// The column is an observer: what it reads must be observable for a change to redraw it (as in the app).
type Live = { currentViewId: string; viewParamsStore: Record<string, unknown>; shownMore: Set<string> };
const state = vi.hoisted(() => ({
  live: null as unknown as Live,
  items: [] as Item[],
  agents: new Map<string, string>(),
  projectChats: new Map<string, string>(),
  openChatOnScreen: vi.fn(),
  prepareProjectTask: vi.fn(),
  toggleIdleExpanded: vi.fn(),
}));
vi.mock('@renderer/lib/layout/layout-provider', () => ({ SIDEBAR_DEFAULT_WIDTH_PX: 260 }));
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({ translate: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${Object.values(params).join(',')}` : key) }),
}));
vi.mock('@renderer/features/sessions/stores/session-agent-bindings', () => ({
  sessionAgentBindings: { bindingFor: (id: string) => (state.agents.has(id) ? { agentUserId: state.agents.get(id) } : undefined) },
}));
vi.mock('@renderer/features/projects/stores/project-groups-store', () => ({
  projectGroupsStore: {
    chatIdOf: (projectId: string) => state.projectChats.get(projectId),
    rowProjectOfChat: (chatId: string) => [...state.projectChats].find(([, chat]) => chat === chatId)?.[0],
    projectOfChat: () => undefined,
  },
}));
vi.mock('@renderer/features/chats/open-chat', () => ({ openChatOnScreen: (...args: unknown[]) => state.openChatOnScreen(...args) }));
vi.mock('@renderer/features/chats/chat-tabs/chat-layouts', () => ({ openInfoTab: vi.fn() }));
vi.mock('@renderer/features/projects/project-task-entry', () => ({ prepareProjectTask: (...args: unknown[]) => state.prepareProjectTask(...args) }));
vi.mock('@renderer/features/projects/components/project-menu', () => ({ ProjectMenuItems: () => null }));
// The sample project's column has its own file (sample-inner-sidebar.test.tsx); here no account shows the sample.
vi.mock('@renderer/features/sample-project/use-sample-project', () => ({ useSampleProject: () => ({ shown: false, settled: true, owner: null }) }));
vi.mock('./sample-inner-sidebar', () => ({ SampleInnerSidebar: () => null }));
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { get navigation() { return state.live; } },
  sidebarStore: {
    get placement() {
      return { nodeById: new Map(state.items.map((entry) => [entry.id, { item: entry, children: [] }])) };
    },
    get sidebarProjects() {
      return [...state.projectChats.keys()].map((id) => ({ id }));
    },
    projectMembersOf: (row: string) => [row],
    rowProjectIdOf: (id: string) => id,
    remoteSession: () => null,
    expandedSessionIds: new Set<string>(),
    get idleExpandedProjectIds() { return state.live.shownMore; },
    toggleSessionExpanded: vi.fn(),
    toggleIdleExpanded: (key: string) => state.toggleIdleExpanded(key),
  },
}));
vi.mock('./sidebar-session-item', () => ({
  SidebarSessionItem: ({ sessionId, agentAvatar }: { sessionId: string; agentAvatar?: boolean }) => (
    <div data-session-row={sessionId} data-agent-avatar={agentAvatar === true || undefined} />
  ),
}));
vi.mock('./sidebar-session-branch-view', () => ({
  SidebarSessionBranchCount: ({ summary, label }: { summary: { total: number; active: { count: number }[] }; label: string }) => (
    <span data-agents-pill={`${summary.total}|${summary.active[0]?.count ?? 0}`} aria-label={label} />
  ),
}));

state.live = observable({ currentViewId: 'chat', viewParamsStore: {}, shownMore: new Set<string>() });
state.toggleIdleExpanded.mockImplementation((key: string) => runInAction(() => {
  if (state.live.shownMore.has(key)) state.live.shownMore.delete(key);
  else state.live.shownMore.add(key);
}));
const { publishChatSummaries } = await import('@/lib/chatSummariesBridge');
const { readComposerVerb, setComposerVerb } = await import('@/lib/composerVerbBridge');
const { setInnerSidebarTopicsAll, publishInnerSidebarTopicsView, useInnerSidebarChat } = await import('@/lib/innerSidebarBridge');
const { installShellSlots, readShellSlots } = await import('@/lib/shellSlots');
const { InnerSidebar, innerSidebarChat } = await import('./inner-sidebar');

let host: HTMLDivElement;
let root: Root;
const counts = () => (window as unknown as Record<string, unknown>).__GUGU_MY_CHAT_AGENT_COUNTS__ as ReadonlyMap<string, unknown>;
const filterQuery = () => (window as unknown as Record<string, { query: string } | undefined>).__GUGU_INNER_SIDEBAR_FILTER__?.query;
const sections = () => [...host.querySelectorAll<HTMLElement>('[data-inner-sidebar-section]')].map((section) => section.dataset.innerSidebarSection);
const sessionRows = () => [...host.querySelectorAll<HTMLElement>('[data-session-row]')].map((row) => row.dataset.sessionRow);
const moreRows = () => [...host.querySelectorAll<HTMLElement>('[data-more-row]')].map((row) => row.textContent);
const render = () => act(async () => root.render(<InnerSidebar />));
const topicsView = (chatId: string, fields: { total: number; hidden: number; matched?: number; calling?: number }) =>
  act(() => publishInnerSidebarTopicsView({ chatId, matched: fields.total, calling: 0, ...fields }));
let shellColumnChat: string | null = null;
function ShellProbe() {
  shellColumnChat = useInnerSidebarChat();
  return null;
}

beforeEach(() => {
  installShellSlots();
  runInAction(() => {
    state.live.shownMore.clear();
  });
  state.openChatOnScreen.mockClear();
  state.prepareProjectTask.mockClear();
  state.items = [item('mine-in-group', 'p-x', running), item('mine-elsewhere', 'p-y'), item('shop-task', 'p-shop', running), item('shop-idle', 'p-shop')];
  state.agents = new Map([['mine-in-group', 'agent-a'], ['mine-elsewhere', 'agent-b']]);
  state.projectChats = new Map([['p-shop', 'shop-chat']]);
  publishChatSummaries([
    { id: 'group', kind: 'group', name: 'Planning', unread_count: 0, member_user_ids: ['agent-a', 'human', 'someone-elses-agent'] },
    { id: 'shop-chat', kind: 'group', name: 'Shop', unread_count: 0, member_user_ids: ['agent-a'] },
    { id: 'dm', kind: 'dm', unread_count: 0 },
  ]);
  topicsView('group', { total: 2, hidden: 0 });
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  act(() => setInnerSidebarTopicsAll(null));
  setComposerVerb('group', null);
});

const go = (currentViewId: string, viewParamsStore: Record<string, unknown>) =>
  act(() => runInAction(() => Object.assign(state.live, { currentViewId, viewParamsStore })));
const openChat = (chatId: string) => go('chat', { chat: { chatId } });
const openProject = (projectId: string) => go('project', { project: { projectId } });
const openSession = (sessionId: string) => go('session', { session: { sessionId } });
const typeFilter = async (text: string) => {
  const input = host.querySelector<HTMLInputElement>('[data-inner-sidebar-filter] input, input[data-inner-sidebar-filter]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('inner sidebar', () => {
  it('a group: its own head row, then Topics, then My agents with only my agents that are members, and the total | running pill', async () => {
    openChat('group');
    await render();
    const column = host.querySelector<HTMLElement>('[data-region="inner-sidebar"]')!;
    expect(column.dataset.innerSidebarKind).toBe('group');
    expect(host.querySelector('[data-inner-head="group"]')?.textContent).toContain('Planning');
    expect(sections()).toEqual(['topics', 'agents']);
    expect(host.textContent).toContain('sidebar.myAgents');
    expect(sessionRows()).toEqual(['mine-in-group']);
    expect(host.querySelector('[data-agents-pill]')?.getAttribute('data-agents-pill')).toBe('1|1');
    expect(readShellSlots()!.getSlots().has('inner-topics:group')).toBe(true);
  });

  it('a project: Agents above Topics — its own sessions plus my agents among the project group members', async () => {
    openProject('p-shop');
    await render();
    expect(sections()).toEqual(['agents', 'topics']);
    expect(host.textContent).toContain('sidebar.agents');
    expect(sessionRows()).toEqual(['mine-in-group', 'shop-task', 'shop-idle']);
  });

  it("agent rows lead with the agent's own avatar: every row asks the session row for it (mock v33)", async () => {
    openProject('p-shop');
    await render();
    const rows = [...host.querySelectorAll<HTMLElement>('[data-session-row]')];
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.dataset.agentAvatar === 'true')).toBe(true);
  });

  it('the head row is the chat itself: selected while its chat is open, a click goes back to it, the pen starts a new agent there', async () => {
    openChat('group');
    await render();
    const head = () => host.querySelector<HTMLElement>('[data-inner-head="group"] [data-slot="button"]')!;
    expect(head().dataset.active).toBe('true');
    openSession('mine-in-group');
    await render();
    expect(head().dataset.active).toBeUndefined();
    await act(async () => head().click());
    expect(state.openChatOnScreen).toHaveBeenCalledWith('group', false);

    await act(async () => host.querySelector<HTMLElement>('[data-inner-head-new-agent]')!.click());
    expect(readComposerVerb('group')).toBe('task');
    expect(host.querySelector('[data-inner-head-actions]')).not.toBeNull();

    openProject('p-shop');
    await render();
    await act(async () => host.querySelector<HTMLElement>('[data-inner-head-new-agent]')!.click());
    expect(state.prepareProjectTask).toHaveBeenCalledWith('p-shop');
    expect(state.openChatOnScreen).toHaveBeenLastCalledWith('shop-chat', false);
  });

  it('All › keeps what sits above Topics and hides what sits below; ‹ Back brings it back; 「All N topics」 under the rows does the same', async () => {
    topicsView('group', { total: 9, hidden: 6 });
    openChat('group');
    await render();
    const drill = () => host.querySelector<HTMLElement>('[data-inner-topics-drill]')!;
    expect(drill().dataset.innerTopicsDrill).toBe('all');
    expect(moreRows()).toEqual(['sidebar.allTopicsCount:9']);
    await act(async () => drill().click());
    expect(sections()).toEqual(['topics']);
    expect(drill().dataset.innerTopicsDrill).toBe('back');
    expect(moreRows()).toEqual([]);
    await act(async () => drill().click());
    expect(sections()).toEqual(['topics', 'agents']);
    await act(async () => host.querySelector<HTMLElement>('[data-more-row="chat:group:topics"]')!.click());
    expect(drill().dataset.innerTopicsDrill).toBe('back');
    await act(async () => drill().click());

    topicsView('shop-chat', { total: 9, hidden: 6 });
    openProject('p-shop');
    await render();
    await act(async () => drill().click());
    expect(sections()).toEqual(['agents', 'topics']);
  });

  it('no All › when level one already shows every topic', async () => {
    topicsView('group', { total: 2, hidden: 0 });
    openChat('group');
    await render();
    expect(host.querySelector('[data-inner-topics-drill]')).toBeNull();
  });

  it('running shows 5 then 「N more running」, the rest 3 then 「Show more」; each opens to Collapse', async () => {
    state.items = [
      ...Array.from({ length: 7 }, (_, index) => item(`run-${index}`, 'p-shop', running, 100 - index)),
      ...Array.from({ length: 5 }, (_, index) => item(`idle-${index}`, 'p-shop', idle, 100 - index)),
    ];
    openProject('p-shop');
    await render();
    expect(sessionRows()).toEqual(['run-0', 'run-1', 'run-2', 'run-3', 'run-4', 'idle-0', 'idle-1', 'idle-2']);
    expect(moreRows()).toEqual(['sidebar.moreRunning:2', 'sidebar.showMore:2']);
    await act(async () => host.querySelector<HTMLElement>('[data-more-row="chat:shop-chat:running"]')!.click());
    expect(sessionRows()).toHaveLength(10);
    expect(moreRows()).toEqual(['sidebar.showLess', 'sidebar.showMore:2']);
  });

  it('a collapsed My agents keeps its pill and shows how many need me next to the title', async () => {
    state.items = [item('mine-in-group', 'p-x', waiting), item('also-mine', 'p-x', running)];
    state.agents = new Map([['mine-in-group', 'agent-a'], ['also-mine', 'agent-a']]);
    openChat('group');
    await render();
    const agents = () => host.querySelector<HTMLElement>('[data-inner-sidebar-section="agents"]')!;
    await act(async () => agents().querySelector<HTMLElement>('button[aria-label="sidebar.collapseAgents"]')!.click());
    expect(sessionRows()).toEqual([]);
    expect(agents().querySelector('[data-agents-pill]')?.getAttribute('data-agents-pill')).toBe('2|1');
    expect(agents().querySelector('[aria-label="sidebar.unreadCount:1"]')?.textContent).toBe('1');
  });

  it('the filter appears past 12 items and narrows topics and agents together; nothing matching says so', async () => {
    openChat('group');
    await render();
    expect(host.querySelector('[data-inner-sidebar-filter]')).toBeNull();
    topicsView('group', { total: 12, hidden: 7 });
    await render();
    expect(host.querySelector('[data-inner-sidebar-filter]')).not.toBeNull();

    await typeFilter('mine');
    expect(filterQuery()).toBe('mine');
    expect(host.querySelector('[data-inner-topics-drill]')).toBeNull();
    expect(moreRows()).toEqual([]);
    expect(sessionRows()).toEqual(['mine-in-group']);

    topicsView('group', { total: 12, hidden: 7, matched: 0 });
    await typeFilter('zzz');
    expect(sections()).toEqual([]);
    expect(host.querySelector('[data-inner-sidebar-empty]')?.textContent).toBe('sidebar.innerFilterEmpty:zzz');
  });

  it('opening one of its agents keeps the column; a direct message or another session closes it', async () => {
    const shell = createRoot(document.createElement('div'));
    await act(async () => shell.render(<ShellProbe />));
    openChat('group');
    await render();
    expect(shellColumnChat).toBe('group');
    openSession('mine-in-group');
    await render();
    expect(host.querySelector('[data-inner-sidebar-chat="group"]')).not.toBeNull();
    // The list keeps the group's row selected while one of its agents is open.
    expect(innerSidebarChat.get()).toEqual({ kind: 'group', chatId: 'group' });
    openSession('mine-elsewhere');
    await render();
    expect(host.querySelector('[data-region="inner-sidebar"]')).toBeNull();
    expect(innerSidebarChat.get()).toBeNull();
    expect(shellColumnChat).toBeNull();
    openChat('dm');
    await render();
    expect(host.querySelector('[data-region="inner-sidebar"]')).toBeNull();
    act(() => shell.unmount());
  });

  it('publishes my running agents per project group for the project row badge', async () => {
    openChat('dm');
    await render();
    expect([...counts()]).toEqual([['shop-chat', { total: 3, running: 2 }]]);
  });
});
