// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation';
import { observable, runInAction } from 'mobx';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const running = presentAgentStatus({ reading: { status: 'working', detail: null } });
const idle = presentAgentStatus({ reading: { status: 'idle', detail: null } });
type Item = { id: string; projectId: string; parentSessionId?: string | null; isPinned: boolean; time: number; presentation: typeof running | null };
const item = (id: string, projectId: string, presentation: Item['presentation'] = idle): Item => ({ id, projectId, isPinned: false, time: 0, presentation });

// The column is an observer: what it reads must be observable for a change to redraw it (as in the app).
type Live = { on: boolean; currentViewId: string; viewParamsStore: Record<string, unknown> };
const state = vi.hoisted(() => ({
  live: null as unknown as Live,
  items: [] as { id: string; projectId: string }[],
  agents: new Map<string, string>(),
  projectChats: new Map<string, string>(),
}));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: { desktopSidebarV2: state.live.on } }) }));
vi.mock('@renderer/lib/layout/layout-provider', () => ({ SIDEBAR_DEFAULT_WIDTH_PX: 260 }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
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
    idleExpandedProjectIds: new Set<string>(),
    toggleSessionExpanded: vi.fn(),
    toggleIdleExpanded: vi.fn(),
  },
}));
vi.mock('./sidebar-session-item', () => ({ SidebarSessionItem: ({ sessionId }: { sessionId: string }) => <div data-session-row={sessionId} /> }));
vi.mock('./sidebar-session-branch-view', () => ({
  SidebarSessionBranchCount: ({ summary, label }: { summary: { total: number; active: { count: number }[] }; label: string }) => (
    <span data-agents-pill={`${summary.total}|${summary.active[0]?.count ?? 0}`} aria-label={label} />
  ),
}));

state.live = observable({ on: true, currentViewId: 'chat', viewParamsStore: {} });
const { publishChatSummaries } = await import('@/lib/chatSummariesBridge');
const { setInnerSidebarTopicsAll, publishInnerSidebarTopicsView } = await import('@/lib/innerSidebarBridge');
const { installShellSlots, readShellSlots } = await import('@/lib/shellSlots');
const { InnerSidebar, innerSidebarChat } = await import('./inner-sidebar');

let host: HTMLDivElement;
let root: Root;
const counts = () => (window as unknown as Record<string, unknown>).__GUGU_MY_CHAT_AGENT_COUNTS__ as ReadonlyMap<string, unknown>;
const sections = () => [...host.querySelectorAll<HTMLElement>('[data-inner-sidebar-section]')].map((section) => section.dataset.innerSidebarSection);
const sessionRows = () => [...host.querySelectorAll<HTMLElement>('[data-session-row]')].map((row) => row.dataset.sessionRow);
const render = () => act(async () => root.render(<InnerSidebar />));

beforeEach(() => {
  installShellSlots();
  runInAction(() => { state.live.on = true; });
  state.items = [item('mine-in-group', 'p-x', running), item('mine-elsewhere', 'p-y'), item('shop-task', 'p-shop', running), item('shop-idle', 'p-shop')];
  state.agents = new Map([['mine-in-group', 'agent-a'], ['mine-elsewhere', 'agent-b']]);
  state.projectChats = new Map([['p-shop', 'shop-chat']]);
  publishChatSummaries([
    { id: 'group', kind: 'group', unread_count: 0, member_user_ids: ['agent-a', 'human', 'someone-elses-agent'] },
    { id: 'shop-chat', kind: 'group', unread_count: 0, member_user_ids: ['agent-a'] },
    { id: 'dm', kind: 'dm', unread_count: 0 },
  ]);
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  act(() => setInnerSidebarTopicsAll(null));
});

const go = (currentViewId: string, viewParamsStore: Record<string, unknown>) => runInAction(() => Object.assign(state.live, { currentViewId, viewParamsStore }));
const openChat = (chatId: string) => go('chat', { chat: { chatId } });
const openProject = (projectId: string) => go('project', { project: { projectId } });
const openSession = (sessionId: string) => go('session', { session: { sessionId } });

describe('inner sidebar', () => {
  it('a group: Topics, then My agents with only my agents that are members, and the total | running pill', async () => {
    openChat('group');
    await render();
    const column = host.querySelector<HTMLElement>('[data-region="inner-sidebar"]')!;
    expect(column.dataset.innerSidebarKind).toBe('group');
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

  it('All › keeps what sits above Topics and hides what sits below; ‹ Back brings it back', async () => {
    publishInnerSidebarTopicsView({ chatId: 'group', total: 9, hidden: 6 });
    openChat('group');
    await render();
    const drill = () => host.querySelector<HTMLElement>('[data-inner-topics-drill]')!;
    expect(drill().dataset.innerTopicsDrill).toBe('all');
    await act(async () => drill().click());
    expect(sections()).toEqual(['topics']);
    expect(drill().dataset.innerTopicsDrill).toBe('back');
    await act(async () => drill().click());
    expect(sections()).toEqual(['topics', 'agents']);

    publishInnerSidebarTopicsView({ chatId: 'shop-chat', total: 9, hidden: 6 });
    openProject('p-shop');
    await render();
    await act(async () => drill().click());
    expect(sections()).toEqual(['agents', 'topics']);
  });

  it('no All › when level one already shows every topic', async () => {
    publishInnerSidebarTopicsView({ chatId: 'group', total: 2, hidden: 0 });
    openChat('group');
    await render();
    expect(host.querySelector('[data-inner-topics-drill]')).toBeNull();
  });

  it('opening one of its agents keeps the column; a direct message or another session closes it', async () => {
    openChat('group');
    await render();
    openSession('mine-in-group');
    await render();
    expect(host.querySelector('[data-inner-sidebar-chat="group"]')).not.toBeNull();
    // The list keeps the group's row selected while one of its agents is open.
    expect(innerSidebarChat.get()).toEqual({ kind: 'group', chatId: 'group' });
    openSession('mine-elsewhere');
    await render();
    expect(host.querySelector('[data-region="inner-sidebar"]')).toBeNull();
    expect(innerSidebarChat.get()).toBeNull();
    openChat('dm');
    await render();
    expect(host.querySelector('[data-region="inner-sidebar"]')).toBeNull();
  });

  it('publishes my running agents per project group for the project row badge', async () => {
    openChat('dm');
    await render();
    expect([...counts()]).toEqual([['shop-chat', { total: 3, running: 2 }]]);
  });

  it('switch off: nothing is drawn and no counts are published', async () => {
    openChat('group');
    await render();
    expect(host.querySelector('[data-region="inner-sidebar"]')).not.toBeNull();
    await act(async () => runInAction(() => { state.live.on = false; }));
    expect(host.innerHTML).toBe('');
    expect(counts().size).toBe(0);
  });
});
