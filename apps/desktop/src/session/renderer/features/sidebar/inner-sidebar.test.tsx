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
const item = (id: string, projectId: string, presentation: Item['presentation'] = idle, time = 0, parentSessionId: string | null = null): Item => ({
  id,
  projectId,
  parentSessionId,
  isPinned: false,
  time,
  presentation,
  unseen: false,
  title: id,
});

// The column is an observer: what it reads must be observable for a change to redraw it (as in the app).
type Live = {
  currentViewId: string;
  viewParamsStore: Record<string, unknown>;
  shownMore: Set<string>;
  navigate: (view: string, params: Record<string, unknown>) => void;
};
const state = vi.hoisted(() => ({
  live: null as unknown as Live,
  items: [] as Item[],
  agents: new Map<string, string>(),
  projectChats: new Map<string, string>(),
  placementReads: 0,
  openChatOnScreen: vi.fn(),
  openSessionWhenReady: vi.fn(),
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
// The account project list: each project here has one local project (its row id) and its group (projectChats).
const localOfChat = (chatId: string) => [...state.projectChats].find(([, chat]) => chat === chatId)?.[0];
vi.mock('@renderer/features/projects/stores/account-projects-store', () => ({
  accountProjectsStore: {
    projectOfLocal: (projectId: string) => (state.projectChats.has(projectId) ? { chatId: state.projectChats.get(projectId) } : undefined),
    membersOf: (chatId: string) => { const local = localOfChat(chatId); return local ? [local] : []; },
    representativeOf: (chatId: string) => localOfChat(chatId),
  },
}));
vi.mock('@renderer/features/chats/open-chat', () => ({ openChatOnScreen: (...args: unknown[]) => state.openChatOnScreen(...args) }));
vi.mock('@renderer/features/sessions/open-session-in-session', () => ({
  openSessionInSessionWhenReady: (...args: unknown[]) => state.openSessionWhenReady(...args),
}));
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
      state.placementReads += 1;
      return { nodeById: new Map(state.items.map((entry) => [entry.id, { item: entry, children: [] }])) };
    },
    get sidebarProjects() {
      return [...state.projectChats].map(([id, chatId]) => ({ kind: 'local', id, chatId }));
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

state.live = observable({
  currentViewId: 'chat',
  viewParamsStore: {} as Record<string, unknown>,
  shownMore: new Set<string>(),
  navigate(view: string, params: Record<string, unknown>) {
    this.currentViewId = view;
    this.viewParamsStore = { [view]: params };
  },
});
// The sessions and their agents are observable too (the sidebar store and the bindings are mobx).
const sessions = observable({ items: [] as Item[], agents: observable.map<string, string>() }, { items: observable.ref });
Object.defineProperty(state, 'items', {
  get: () => sessions.items,
  set: (items: Item[]) => runInAction(() => { sessions.items = items; }),
});
Object.defineProperty(state, 'agents', {
  get: () => sessions.agents,
  set: (agents: Map<string, string>) => runInAction(() => { sessions.agents.replace(agents); }),
});
state.toggleIdleExpanded.mockImplementation((key: string) => runInAction(() => {
  if (state.live.shownMore.has(key)) state.live.shownMore.delete(key);
  else state.live.shownMore.add(key);
}));
const { publishChatSummaries } = await import('@/lib/chatSummariesBridge');
const { readComposerVerb, setComposerVerb } = await import('@/lib/composerVerbBridge');
const { setInnerSidebarTopicsAll, publishInnerSidebarTopicsView, publishOneListAgentRows, useInnerSidebarChat } = await import('@/lib/innerSidebarBridge');
const { installShellSlots, readShellSlots } = await import('@/lib/shellSlots');
const { InnerSidebar, InnerSidebarRestore, innerSidebarChat, innerSidebarShownFor } = await import('./inner-sidebar');
const { innerSidebarFolded, innerSidebarFoldedAway, setInnerSidebarFolded, shellRestoreLaneTaken } = await import('./inner-sidebar-fold');
const { readPanelToggle } = await import('@/lib/panelToggles');

let host: HTMLDivElement;
let root: Root;
const counts = () => (window as unknown as Record<string, unknown>).__GUGU_MY_CHAT_AGENT_COUNTS__ as ReadonlyMap<string, unknown>;
const sections = () => [...host.querySelectorAll<HTMLElement>('[data-inner-sidebar-section]')].map((section) => section.dataset.innerSidebarSection);
const sessionRows = () => [...host.querySelectorAll<HTMLElement>('[data-session-row]')].map((row) => row.dataset.sessionRow);
const moreRows = () => [...host.querySelectorAll<HTMLElement>('[data-more-row]')].map((row) => row.textContent);
const render = () => act(async () => root.render(<InnerSidebar />));
const agentsCount = () => host.querySelector('[data-inner-sidebar-section="agents"] [data-inner-agents-count]')?.textContent;
const topicsView = (chatId: string, fields: { total: number; hidden: number; calling?: number }) =>
  act(() => publishInnerSidebarTopicsView({ chatId, calling: 0, ...fields }));
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
  setInnerSidebarFolded(false);
});

const go = (currentViewId: string, viewParamsStore: Record<string, unknown>) =>
  act(() => runInAction(() => Object.assign(state.live, { currentViewId, viewParamsStore })));
const openChat = (chatId: string) => go('chat', { chat: { chatId } });
const openProject = (projectId: string) => go('project', { project: { projectId } });
const openSession = (sessionId: string) => go('session', { session: { sessionId } });

describe('inner sidebar', () => {
  it('a group: its own head row on top (no spacer above it), then Topics, then Agents with only my agents that are members and a plain count', async () => {
    openChat('group');
    await render();
    const column = host.querySelector<HTMLElement>('[data-region="inner-sidebar"]')!;
    expect(column.dataset.innerSidebarKind).toBe('group');
    expect(host.querySelector('[data-inner-head="group"]')?.textContent).toContain('Planning');
    expect(column.querySelector('[data-sidebar-space]'), 'the head row is the column’s top band (proposal v1)').toBeNull();
    expect(sections()).toEqual(['topics', 'agents']);
    // Only my agents are listed in a group too, but the title reads 「智能体」 (owner 11-12).
    expect(host.querySelector('[data-inner-sidebar-section="agents"]')?.textContent).toContain('sidebar.agents');
    expect(sessionRows()).toEqual(['mine-in-group']);
    expect(agentsCount()).toBe('1');
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

  it('the head row is the chat itself: current (never a selected fill) while its chat is open, a click goes back to it, the pen starts a new agent there', async () => {
    publishChatSummaries([{ id: 'group', kind: 'group', name: 'Planning', unread_count: 5, member_user_ids: ['agent-a'] }, { id: 'shop-chat', kind: 'group', name: 'Shop', unread_count: 0, member_user_ids: ['agent-a'] }]);
    openChat('group');
    await render();
    const head = () => host.querySelector<HTMLElement>('[data-inner-head="group"] [data-slot="button"]')!;
    // The column's title (proposal v1 .ihead): it marks where you are without the list rows' selected fill.
    expect(head().getAttribute('aria-current')).toBe('page');
    expect(head().dataset.active).toBeUndefined();
    // No unread number on the head row: the group's row in the list carries it (proposal v1 state0).
    expect(host.querySelector('[data-inner-head="group"] [aria-label^="sidebar.unreadCount"]')).toBeNull();
    openSession('mine-in-group');
    await render();
    expect(head().getAttribute('aria-current')).toBeNull();
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

  it('All › (the only way to every topic: no 「All N topics」 row under them) keeps what sits above Topics and hides what sits below; ‹ Back brings it back', async () => {
    topicsView('group', { total: 9, hidden: 6 });
    openChat('group');
    await render();
    const drill = () => host.querySelector<HTMLElement>('[data-inner-topics-drill]')!;
    expect(drill().dataset.innerTopicsDrill).toBe('all');
    expect(moreRows()).toEqual([]);
    await act(async () => drill().click());
    expect(sections()).toEqual(['topics']);
    expect(drill().dataset.innerTopicsDrill).toBe('back');
    await act(async () => drill().click());
    expect(sections()).toEqual(['topics', 'agents']);

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

  it('one flat list, no 「needs you」 / 「running」 headers: needs you, then running, then the rest; past 10 one 「Show more」 opens to Collapse', async () => {
    state.items = [
      ...Array.from({ length: 7 }, (_, index) => item(`run-${index}`, 'p-shop', running, 100 - index)),
      ...Array.from({ length: 5 }, (_, index) => item(`idle-${index}`, 'p-shop', idle, 100 - index)),
      item('asks', 'p-shop', waiting, 0),
    ];
    openProject('p-shop');
    await render();
    expect(host.querySelector('[data-agent-group]'), 'no group headers').toBeNull();
    expect(host.querySelector('[data-inner-sidebar-section="agents"]')?.textContent).not.toContain('sidebar.needsYou');
    expect(agentsCount()).toBe('13');
    expect(sessionRows()).toEqual(['asks', ...Array.from({ length: 7 }, (_, index) => `run-${index}`), 'idle-0', 'idle-1']);
    expect(moreRows()).toEqual(['sidebar.showMore:3']);
    await act(async () => host.querySelector<HTMLElement>('[data-more-row="chat:shop-chat"]')!.click());
    expect(sessionRows()).toHaveLength(13);
    expect(moreRows()).toEqual(['sidebar.showLess']);
  });

  it('a collapsed Agents keeps its count and shows how many need me next to the title', async () => {
    state.items = [item('mine-in-group', 'p-x', waiting), item('also-mine', 'p-x', running)];
    state.agents = new Map([['mine-in-group', 'agent-a'], ['also-mine', 'agent-a']]);
    openChat('group');
    await render();
    const agents = () => host.querySelector<HTMLElement>('[data-inner-sidebar-section="agents"]')!;
    await act(async () => agents().querySelector<HTMLElement>('button[aria-label="sidebar.collapseAgents"]')!.click());
    expect(sessionRows()).toEqual([]);
    expect(agentsCount()).toBe('2');
    expect(agents().querySelector('[aria-label="sidebar.unreadCount:1"]')?.textContent).toBe('1');
  });

  it('no find box in the column, however much is in it (the top search takes over)', async () => {
    topicsView('group', { total: 40, hidden: 35 });
    openChat('group');
    await render();
    expect(host.querySelector('[data-region="inner-sidebar"] input')).toBeNull();
  });

  it('folds from its head row, for every group alike, until expanded from the restore lane', async () => {
    const restore = document.body.appendChild(document.createElement('div'));
    const restoreRoot = createRoot(restore);
    await act(async () => restoreRoot.render(<InnerSidebarRestore />));
    openChat('group');
    await render();
    expect(shellRestoreLaneTaken(true, 72)).toBe(false);
    expect(restore.querySelector('button')).toBeNull();
    const fold = host.querySelector<HTMLElement>('[data-inner-head="group"] [data-inner-head-fold]')!;
    expect(fold.getAttribute('aria-label')).toBe('sidebar.collapseInner');
    // The fold button sits at the row's far end, right of the new-agent pen (proposal v1).
    const ends = [...fold.parentElement!.children];
    expect(ends.at(-1)).toBe(fold);
    expect(ends.at(-2)?.matches('[data-inner-head-new-agent]')).toBe(true);

    await act(async () => fold.click());
    expect(host.querySelector('[data-region="inner-sidebar"]'), 'folded: the column is gone, the content is the card alone').toBeNull();
    expect(innerSidebarFolded.get()).toBe(true);
    expect(innerSidebarFoldedAway.get()).toBe(true);
    expect(innerSidebarShownFor.get()).toBeNull();
    // Still attached: the list keeps the group lit.
    expect(innerSidebarChat.get()).toEqual({ kind: 'group', chatId: 'group' });
    // The leftmost strip leaves the expand button its lane even with the list open beside it.
    expect(shellRestoreLaneTaken(true, 72)).toBe(true);
    const expand = restore.querySelector<HTMLElement>('button[aria-label="sidebar.expandInner"]')!;
    expect(expand, 'the list column toggle, in the restore lane').not.toBeNull();
    expect(expand.closest('[data-shell-restore-lane]')).not.toBeNull();
    expect(expand.textContent, 'no number on it').toBe('');

    // Remembered globally: another group (and a project) opens folded too.
    openProject('p-shop');
    await render();
    expect(host.querySelector('[data-region="inner-sidebar"]')).toBeNull();
    expect(restore.querySelector('button')).not.toBeNull();
    // Nothing to fold over (a direct message): no expand button, no lane.
    openChat('dm');
    await render();
    expect(innerSidebarFoldedAway.get()).toBe(false);
    expect(restore.querySelector('button')).toBeNull();
    expect(shellRestoreLaneTaken(true, 72)).toBe(false);

    openChat('group');
    await render();
    expect(readPanelToggle('column:inner')).toMatchObject({ open: false, label: 'sidebar.expandInner' });
    await act(async () => restore.querySelector<HTMLElement>('button')!.click());
    expect(host.querySelector('[data-inner-sidebar-chat="group"]')).not.toBeNull();
    expect(restore.querySelector('button')).toBeNull();
    expect(innerSidebarShownFor.get()).toBe('group');
    act(() => restoreRoot.unmount());
    restore.remove();
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

// #2574 my standalone agent (its own row in the list: a DM, in no group or project) spawned sub-agents: opening it opens
// the inner column, the head row is the agent, 智能体 lists its sub-agents.
describe('a standalone agent with sub-agents', () => {
  const solo = { kind: 'agent', chatId: 'dm-solo', agentUserId: 'agent-solo' };
  // What the one list draws as my agents' own rows: it alone decides (lib/sidebarOneList oneListAgentRows).
  const soloRow = { chatId: 'dm-solo', name: 'Solo', avatar: null, createdAt: null };
  const beeRow = { chatId: 'dm-b', name: 'Bee', avatar: null, createdAt: null };
  const listRows = (rows: Record<string, typeof soloRow>) => act(() => publishOneListAgentRows(new Map(Object.entries(rows))));
  afterEach(() => act(() => publishOneListAgentRows(null)));
  beforeEach(() => {
    listRows({ 'agent-solo': soloRow, 'agent-b': beeRow });
    state.items = [
      ...state.items,
      item('solo-task', 'p-y', idle, 9),
      item('sub-quiet', 'p-y', idle, 8, 'solo-task'),
      item('sub-busy', 'p-y', running, 1, 'solo-task'),
      item('sub-asks', 'p-y', waiting, 0, 'solo-task'),
      item('grandchild', 'p-y', waiting, 0, 'sub-quiet'),
    ];
    for (const [session, agent] of [['solo-task', 'agent-solo'], ['sub-quiet', 'agent-s1'], ['sub-busy', 'agent-s2'], ['sub-asks', 'agent-s3'], ['grandchild', 'agent-s4']]) {
      state.agents.set(session!, agent!);
    }
    publishChatSummaries([
      { id: 'group', kind: 'group', name: 'Planning', unread_count: 0, member_user_ids: ['agent-a', 'human'] },
      { id: 'shop-chat', kind: 'group', name: 'Shop', unread_count: 0, member_user_ids: ['agent-a'] },
      { id: 'dm-solo', kind: 'dm', name: 'Solo', peer_user_id: 'agent-solo', unread_count: 0 },
      // A sub-agent can have a DM with me too (it wrote to me); that does not make it a row of the list.
      { id: 'dm-s1', kind: 'dm', name: 'Sub one', peer_user_id: 'agent-s1', unread_count: 0 },
      { id: 'dm-b', kind: 'dm', name: 'Bee', peer_user_id: 'agent-b', unread_count: 0 },
      { id: 'dm-a', kind: 'ai', name: 'Ace', peer_user_id: 'agent-a', unread_count: 0 },
    ]);
  });
  const head = () => host.querySelector<HTMLElement>('[data-inner-head="dm-solo"] [data-slot="button"]');

  it('opening it shows the column: the agent as its head row (fold only), then just 智能体 with its sub-agents, needs you → running → rest', async () => {
    const shell = createRoot(document.createElement('div'));
    await act(async () => shell.render(<ShellProbe />));
    openSession('solo-task');
    await render();
    const column = host.querySelector<HTMLElement>('[data-region="inner-sidebar"]')!;
    expect(column.dataset.innerSidebarKind).toBe('agent');
    expect(column.dataset.innerSidebarChat).toBe('dm-solo');
    expect(host.querySelector('[data-inner-head="dm-solo"]')?.textContent).toContain('Solo');
    expect(head()!.getAttribute('aria-current'), 'its own conversation is open').toBe('page');
    // No pen (its sub-agents are its own to spawn) and no 「…」 (its header gives nothing up to the column).
    expect(host.querySelector('[data-inner-head-new-agent]')).toBeNull();
    expect(host.querySelector('[data-inner-head-actions]')).toBeNull();
    const fold = host.querySelector<HTMLElement>('[data-inner-head="dm-solo"] [data-inner-head-fold]')!;
    expect([...fold.parentElement!.children].at(-1)).toBe(fold);
    // No 话题: the agent's conversation is its session.
    expect(sections()).toEqual(['agents']);
    expect(readShellSlots()!.getSlots().has('inner-topics:dm-solo')).toBe(false);
    // The grandchild stays folded under its parent; the count is every sub-agent.
    expect(sessionRows()).toEqual(['sub-asks', 'sub-busy', 'sub-quiet']);
    expect(agentsCount()).toBe('4');
    expect(innerSidebarChat.get()).toEqual(solo);
    expect(shellColumnChat).toBe('dm-solo');
    act(() => shell.unmount());
  });

  it('a sub-agent opened from it keeps the column and the agent lit in the list; the head goes back to the agent; anything else closes it', async () => {
    openSession('solo-task');
    await render();
    openSession('sub-busy');
    await render();
    expect(host.querySelector('[data-inner-sidebar-chat="dm-solo"]')).not.toBeNull();
    expect(innerSidebarChat.get()).toEqual(solo);
    expect(head()!.getAttribute('aria-current')).toBeNull();
    openSession('grandchild');
    await render();
    expect(host.querySelector('[data-inner-sidebar-chat="dm-solo"]')).not.toBeNull();
    await act(async () => head()!.click());
    expect(state.openSessionWhenReady).toHaveBeenLastCalledWith({ projectId: 'p-y', sessionId: 'solo-task' });
    expect(head()!.getAttribute('aria-current')).toBe('page');
    openSession('mine-elsewhere');
    await render();
    expect(host.querySelector('[data-region="inner-sidebar"]')).toBeNull();
    expect(innerSidebarChat.get()).toBeNull();
  });

  it('no sub-agents, no column: the conversation opens as today', async () => {
    openSession('mine-elsewhere');
    await render();
    expect(host.querySelector('[data-region="inner-sidebar"]')).toBeNull();
    expect(innerSidebarChat.get()).toBeNull();
    // Its sub-agents gone, the agent opens without one too.
    state.items = state.items.filter((entry) => !entry.parentSessionId);
    openSession('solo-task');
    await render();
    expect(host.querySelector('[data-region="inner-sidebar"]')).toBeNull();
  });

  it('a sub-agent opened on its own opens nothing, even one with sub-agents of its own: it has no row of its own', async () => {
    openSession('sub-busy');
    await render();
    expect(host.querySelector('[data-region="inner-sidebar"]')).toBeNull();
    openSession('sub-quiet');
    await render();
    expect(host.querySelector('[data-region="inner-sidebar"]')).toBeNull();
  });

  it('opens only on a row the one list draws for the agent: none (its folder still counted as a project, its group not read yet) → no column, whatever the summaries say', async () => {
    // The summaries say it lives nowhere; the list, which decides, draws no row for it.
    listRows({ 'agent-b': beeRow });
    openSession('solo-task');
    await render();
    expect(host.querySelector('[data-region="inner-sidebar"]')).toBeNull();
    // The list has said nothing yet (still reading): unknown, so no column either.
    act(() => publishOneListAgentRows(null));
    await render();
    expect(host.querySelector('[data-region="inner-sidebar"]')).toBeNull();
    // Its row drawn: the column opens; the row gone: it closes, a sub-agent open or not.
    listRows({ 'agent-solo': soloRow });
    await render();
    expect(host.querySelector('[data-inner-sidebar-chat="dm-solo"]')).not.toBeNull();
    openSession('sub-busy');
    await render();
    listRows({});
    await render();
    expect(host.querySelector('[data-region="inner-sidebar"]')).toBeNull();
  });

  it('the head row is the list row: its name comes from that row, not the chat summary', async () => {
    listRows({ 'agent-solo': { ...soloRow, name: 'Solo as the list names it' } });
    publishChatSummaries([{ id: 'dm-solo', kind: 'dm', name: null, peer_user_id: 'agent-solo', unread_count: 0 }]);
    openSession('solo-task');
    await render();
    expect(host.querySelector('[data-inner-head="dm-solo"]')?.textContent).toContain('Solo as the list names it');
  });

  it("the head goes straight back to the agent's own session: the column stays even where opening its chat lands on a chat view", async () => {
    // Opening the DM can fall back to the chat view (its conversation not in the directory): that closes the column.
    state.openChatOnScreen.mockImplementation((chatId: string) => runInAction(() => state.live.navigate('chat', { chatId })));
    openSession('solo-task');
    await render();
    openSession('sub-busy');
    await render();
    await act(async () => head()!.click());
    await render();
    expect(state.openSessionWhenReady).toHaveBeenCalledWith({ projectId: 'p-y', sessionId: 'solo-task' });
    expect(host.querySelector('[data-inner-sidebar-chat="dm-solo"]')).not.toBeNull();
    expect(head()!.getAttribute('aria-current')).toBe('page');
    state.openChatOnScreen.mockReset();
  });

  it("a fork of the agent under another agent's tree is not its conversation: it opens nothing, and its children are not the agent's", async () => {
    state.items = [...state.items, item('solo-fork', 'p-y', running, 0, 'mine-elsewhere'), item('fork-kid', 'p-y', running, 0, 'solo-fork')];
    state.agents.set('solo-fork', 'agent-solo');
    state.agents.set('fork-kid', 'agent-fk');
    openSession('solo-fork');
    await render();
    expect(host.querySelector('[data-region="inner-sidebar"]')).toBeNull();
    openSession('solo-task');
    await render();
    expect(sessionRows()).toEqual(['sub-asks', 'sub-busy', 'sub-quiet']);
    expect(agentsCount()).toBe('4');
  });

  it('derives the sessions once per change, not once per render', async () => {
    openSession('solo-task');
    await render();
    const reads = state.placementReads;
    for (const session of ['sub-busy', 'grandchild', 'sub-asks', 'solo-task']) {
      openSession(session);
      await render();
    }
    expect(state.placementReads).toBe(reads);
    state.items = state.items.filter((entry) => entry.id !== 'sub-asks');
    await render();
    expect(state.placementReads).toBeGreaterThan(reads);
    expect(sessionRows()).toEqual(['sub-busy', 'sub-quiet']);
  });

  it('an agent living in a group or a project is no standalone agent: no column of its own, sub-agents or not', async () => {
    state.items = [...state.items, item('group-sub', 'p-x', running, 0, 'mine-in-group'), item('shop-sub', 'p-z', running, 0, 'shop-idle')];
    state.agents.set('group-sub', 'agent-gs');
    state.agents.set('shop-idle', 'agent-shop');
    state.agents.set('shop-sub', 'agent-ss');
    publishChatSummaries([
      { id: 'group', kind: 'group', name: 'Planning', unread_count: 0, member_user_ids: ['agent-a', 'human'] },
      { id: 'shop-chat', kind: 'group', name: 'Shop', unread_count: 0, member_user_ids: [] },
      { id: 'dm-a', kind: 'ai', name: 'Ace', peer_user_id: 'agent-a', unread_count: 0 },
      { id: 'dm-shop', kind: 'dm', name: 'Shopper', peer_user_id: 'agent-shop', unread_count: 0 },
    ]);
    openSession('mine-in-group');
    await render();
    expect(host.querySelector('[data-region="inner-sidebar"]')).toBeNull();
    openSession('shop-idle');
    await render();
    expect(host.querySelector('[data-region="inner-sidebar"]')).toBeNull();
  });

  it('folds with every other column (one global fold) and comes back from the restore lane', async () => {
    const restore = document.body.appendChild(document.createElement('div'));
    const restoreRoot = createRoot(restore);
    await act(async () => restoreRoot.render(<InnerSidebarRestore />));
    openChat('group');
    await render();
    await act(async () => host.querySelector<HTMLElement>('[data-inner-head="group"] [data-inner-head-fold]')!.click());
    openSession('solo-task');
    await render();
    expect(host.querySelector('[data-region="inner-sidebar"]')).toBeNull();
    expect(innerSidebarFoldedAway.get()).toBe(true);
    expect(innerSidebarChat.get(), 'still attached: the list keeps the agent lit').toEqual(solo);
    await act(async () => restore.querySelector<HTMLElement>('button[aria-label="sidebar.expandInner"]')!.click());
    expect(host.querySelector('[data-inner-sidebar-chat="dm-solo"]')).not.toBeNull();
    expect(innerSidebarShownFor.get()).toBe('dm-solo');
    act(() => restoreRoot.unmount());
    restore.remove();
  });
});
