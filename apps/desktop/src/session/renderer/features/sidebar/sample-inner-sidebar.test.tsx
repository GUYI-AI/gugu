// @vitest-environment jsdom
// #2548 the sample project (#709) open: the inner column draws the sample itself from its bundled content. Head row =
// cover, name, 「示例」, no new-agent pen (read-only), 「…」 holding only the row menu's remove; 智能体 lists exactly the
// content's agent (clicking it = clicking the task card); 话题 is empty. Removing the sample takes the column with it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observable, runInAction } from 'mobx';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const io = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>(), failWrite: false, toast: vi.fn() }));
// Observable like the app's stores, so the observers redraw when they change.
type Live = {
  navigation: { currentViewId: string; viewParamsStore: Record<string, unknown> };
  screen: { focusedBlockId: string | null; blocks: Map<string, { kind: string; chatId?: string }> };
};
const state = vi.hoisted(() => ({ live: null as unknown as Live }));

vi.mock('@/lib/supabase', async () => {
  const { versionedSettingsClient } = await import('../../../../../../../tests/support/versionedSettingsTestDouble');
  return { identityDb: versionedSettingsClient(io) };
});
vi.mock('@renderer/features/assistant/assistant-shell', () => ({ useAssistantShell: () => ({ ownerId: 'u', ownerName: 'Ana', ownerAvatar: null }) }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: io.toast }));
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({
    locale: 'zh-CN',
    translate: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${Object.values(params).join(',')}` : key),
  }),
}));
vi.mock('@renderer/lib/layout/layout-provider', () => ({
  SIDEBAR_DEFAULT_WIDTH_PX: 260,
  useWorkspaceLayoutContext: () => ({ isLeftOpen: true, leftRail: 0 }),
}));
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { get navigation() { return state.live.navigation; } },
  sidebarStore: {
    placement: { nodeById: new Map() },
    sidebarProjects: [],
    projectMembersOf: (row: string) => [row],
    rowProjectIdOf: (id: string) => id,
    remoteSession: () => null,
    expandedSessionIds: new Set<string>(),
    idleExpandedProjectIds: new Set<string>(),
  },
}));
vi.mock('@renderer/app/screen-layout', () => ({
  screenLayout: {
    get focusedBlockId() { return state.live.screen.focusedBlockId; },
    get blocks() { return state.live.screen.blocks; },
    corners: () => ({ topLeft: false, topRight: false }),
  },
}));
vi.mock('@renderer/app/screen-layout-actions', () => ({ forgetSampleProjectOnScreen: vi.fn() }));
// The chat column's own wiring (inner-sidebar.test.tsx covers it).
vi.mock('@renderer/features/sessions/stores/session-agent-bindings', () => ({ sessionAgentBindings: { bindingFor: () => undefined } }));
vi.mock('@renderer/features/projects/stores/account-projects-store', () => ({
  accountProjectsStore: { projectOfLocal: () => undefined, membersOf: () => [], representativeOf: () => undefined },
}));
vi.mock('@renderer/features/chats/open-chat', () => ({ openChatOnScreen: vi.fn() }));
vi.mock('@renderer/features/chats/chat-tabs/chat-layouts', () => ({ openInfoTab: vi.fn() }));
vi.mock('@renderer/features/projects/project-task-entry', () => ({ prepareProjectTask: vi.fn() }));
vi.mock('@renderer/features/projects/components/project-menu', () => ({ ProjectMenuItems: () => null }));
vi.mock('./sidebar-session-title', () => ({ SidebarSessionTitle: ({ title }: { title: string }) => <span data-row-title="">{title}</span> }));
// The sample block around the pane, without its tab strip, transcript and file preview (unchanged, drawn elsewhere).
vi.mock('@renderer/features/tabs/tab-bar', () => ({ TabStripShell: () => null }));
vi.mock('@renderer/features/tabs/tab-bar/tab-chip', () => ({ TabChip: () => null, TabSlot: () => null }));
vi.mock('@renderer/features/sessions/titlebar-actions', () => ({ TabBarActionRow: () => null }));
vi.mock('@/components/chat/MessageFilePreviewPanel', () => ({ MessageFilePreviewPanel: () => <aside data-file-pane="" /> }));
vi.mock('@renderer/features/sample-project/sample-new-project-button', () => ({ SampleNewProjectButton: () => null }));
vi.mock('@renderer/features/sample-project/sample-project-transcript', async (original) => ({
  ...(await original<object>()),
  SampleProjectTranscript: ({ onOpenTask }: { onOpenTask: () => void }) => <button type="button" data-task-card="" onClick={onOpenTask} />,
}));
vi.mock('@renderer/features/sample-project/sample-task-pane', () => ({
  SampleTaskPane: ({ onClose }: { onClose: () => void }) => <aside data-sample-task-pane=""><button type="button" data-close-pane="" onClick={onClose} /></aside>,
}));

state.live = observable(
  {
    navigation: { currentViewId: 'screen', viewParamsStore: {} as Record<string, unknown> },
    screen: { focusedBlockId: 'sample-block' as string | null, blocks: new Map<string, { kind: string; chatId?: string }>() },
  },
  undefined,
  { deep: true }
);
const { publishChatSummaries } = await import('@/lib/chatSummariesBridge');
const { InnerSidebar, InnerSidebarRestore, innerSidebarChat, innerSidebarShownFor } = await import('./inner-sidebar');
const { innerSidebarFoldedAway, setInnerSidebarFolded } = await import('./inner-sidebar-fold');
const { SampleProjectBlock } = await import('@renderer/features/sample-project/sample-project-block');
const { openSamplePane } = await import('@renderer/features/sample-project/sample-project-view');
const { SAMPLE_AGENT_SEED } = await import('@renderer/features/sample-project/sample-project-transcript');
const { zhCNSampleProject } = await import('@renderer/features/sample-project/content/zh-CN');

let host: HTMLDivElement;
let root: Root;
const column = () => host.querySelector<HTMLElement>('[data-region="inner-sidebar"]');
const sections = () => [...host.querySelectorAll<HTMLElement>('[data-inner-sidebar-section]')].map((section) => section.dataset.innerSidebarSection);
const agentRows = () => [...host.querySelectorAll<HTMLElement>('[data-inner-sidebar-section="agents"] [role="treeitem"]')];
const head = () => host.querySelector<HTMLElement>('[data-inner-head="sample-project"] [data-slot="button"]')!;
const taskPane = () => host.querySelector('[data-sample-task-pane]');
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const until = async (condition: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !condition(); i++) await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(condition(), what).toBe(true);
};
const look = (blocks: [string, { kind: string; chatId?: string }][], focused: string | null, currentViewId: string, viewParamsStore: Record<string, unknown> = {}) =>
  act(() => runInAction(() => {
    state.live.screen.blocks = new Map(blocks);
    state.live.screen.focusedBlockId = focused;
    state.live.navigation.currentViewId = currentViewId;
    state.live.navigation.viewParamsStore = viewParamsStore;
  }));
const lookAtSample = () => look([['sample-block', { kind: 'sample-project' }]], 'sample-block', 'screen');
// The workspace: the inner column beside the sample's block, both live.
const render = async () => {
  await act(async () => root.render(<><InnerSidebar /><SampleProjectBlock blockId="sample-block" /></>));
  await until(() => column() !== null, 'the account key was read and the sample column drawn');
};

beforeEach(async () => {
  io.rows.clear();
  io.failWrite = false;
  io.toast.mockReset();
  io.rows.set('u/user', { user_id: 'u', scope: 'user', config: { sampleProject: { version: 1, dismissed: false } }, updated_at: '2026-11-12T00:00:00.000Z' });
  publishChatSummaries([{ id: 'group', kind: 'group', name: 'Planning', unread_count: 0, member_user_ids: ['human'] }]);
  await lookAtSample();
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  openSamplePane(null);
  setInnerSidebarFolded(false);
});

describe('the inner column for the sample project', () => {
  it('draws the sample: head row with its cover, name and 「示例」 (no pen), then 智能体 with exactly the content agent, then an empty 话题', async () => {
    await render();
    expect(column()!.dataset.innerSidebarKind).toBe('sample');
    expect(column()!.style.width).toBe('260px');
    expect(innerSidebarChat.get(), 'the sample is no chat: the list keeps lighting the sample row by itself').toBeNull();

    const headRow = host.querySelector<HTMLElement>('[data-inner-head="sample-project"]')!;
    expect(headRow.querySelector('svg.gg-project-avatar')).not.toBeNull();
    expect(headRow.textContent).toContain('projects.sample.name');
    expect(headRow.querySelector('[data-slot="chip"]')?.textContent).toBe('projects.sample.tag');
    expect(headRow.querySelector('[data-inner-head-actions]')?.getAttribute('aria-label')).toBe('projects.sample.actions');
    expect(host.querySelector('[data-inner-head-new-agent]'), 'read-only: nobody to send a new agent to').toBeNull();
    expect(head().getAttribute('aria-current')).toBe('page');
    expect(head().dataset.active, 'the head row is a title, never a selected row').toBeUndefined();

    expect(sections()).toEqual(['agents', 'topics']);
    const rows = agentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('[data-row-title]')?.textContent).toBe(zhCNSampleProject.agent.name);
    expect(rows[0].querySelector(`[data-row-agent-avatar="${SAMPLE_AGENT_SEED}"]`), 'the face it has in the conversation').not.toBeNull();
    expect(rows[0].dataset.agentTone, 'nothing runs in a frozen sample').toBeUndefined();
    // A plain count beside the title, as the group / project column (#2548 ⑥): no pill, nothing running.
    expect(host.querySelector('[data-inner-sidebar-section="agents"] [data-session-branch-count]')).toBeNull();
    expect(host.querySelector('[data-inner-sidebar-section="agents"] [data-inner-agents-count]')?.textContent).toBe('1');

    const topics = host.querySelector<HTMLElement>('[data-inner-sidebar-section="topics"]')!;
    expect(topics.textContent).toContain('sidebar.topics');
    expect(topics.textContent).toContain('sidebar.noTopics');
  });

  it('clicking the agent opens the task pane the task card opens; the head row goes back to the conversation', async () => {
    await render();
    expect(taskPane()).toBeNull();
    const conversation = host.querySelector<HTMLElement>('[data-sample-conversation]')!;
    expect(conversation.style.contentVisibility).toBe('');
    await act(async () => agentRows()[0].click());
    expect(taskPane()).not.toBeNull();
    // The task takes the whole block, as an agent opened from a project's column takes the main area (mock v33), ❌ a side
    // pane that leaves the conversation a sliver beside the inner column. The conversation is kept, only hidden.
    expect(conversation.style.contentVisibility).toBe('hidden');
    expect(agentRows()[0].dataset.active).toBe('true');
    expect(head().getAttribute('aria-current')).toBeNull();

    await act(async () => head().click());
    expect(taskPane()).toBeNull();
    expect(host.querySelector('[data-sample-conversation]'), 'the same conversation, not a rebuilt one').toBe(conversation);
    expect(conversation.style.contentVisibility).toBe('');
    expect(head().getAttribute('aria-current')).toBe('page');
    expect(head().dataset.active, 'the head row is a title, never a selected row').toBeUndefined();
    expect(agentRows()[0].dataset.active).toBeUndefined();

    // The task card in the conversation and the agent row are one pane: closing it from the pane deselects the row.
    await act(async () => host.querySelector<HTMLElement>('[data-task-card]')!.click());
    expect(agentRows()[0].dataset.active).toBe('true');
    await act(async () => host.querySelector<HTMLElement>('[data-close-pane]')!.click());
    expect(taskPane()).toBeNull();
    expect(agentRows()[0].dataset.active).toBeUndefined();
  });

  it('removing the sample from the head row 「…」 saves the account key and takes the column away', async () => {
    await render();
    await act(async () => host.querySelector<HTMLElement>('[data-inner-head-actions]')!.click());
    const remove = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === 'projects.sample.remove');
    await until(() => !!remove(), 'the head menu opened');
    expect(document.querySelectorAll('[role="menuitem"]'), 'only what the sample row menu offers').toHaveLength(1);
    await act(async () => remove()!.click());
    await until(() => column() === null, 'the column left with the sample');
    expect(io.rows.get('u/user')?.config).toEqual({ sampleProject: { version: 1, dismissed: true } });
    expect(io.toast).not.toHaveBeenCalled();
    await flush();
    expect(host.querySelector('[data-inner-sidebar-section]')).toBeNull();
  });

  it('only while its block is the one looked at: a group swaps it out, closing the sample or leaving the screen removes it', async () => {
    await render();
    await look([['sample-block', { kind: 'sample-project' }], ['chat-block', { kind: 'chat', chatId: 'group' }]], 'chat-block', 'chat', { chat: { chatId: 'group' } });
    expect(column()!.dataset.innerSidebarKind).toBe('group');
    expect(column()!.dataset.innerSidebarChat).toBe('group');
    expect(innerSidebarShownFor.get()).toBe('group');

    await lookAtSample();
    expect(column()!.dataset.innerSidebarKind).toBe('sample');
    // The foot's intro comes up on the sample's column too (it crowds the page all the same).
    expect(innerSidebarShownFor.get()).toBe('sample');

    await look([['sample-block', { kind: 'sample-project' }]], 'sample-block', 'library');
    expect(column()).toBeNull();
    expect(innerSidebarShownFor.get()).toBeNull();

    await look([], null, 'home');
    expect(column()).toBeNull();
  });

  it('folds like the group column: the head row’s far-end button, then the expand button in the restore lane brings it back', async () => {
    await act(async () => root.render(<><InnerSidebar /><SampleProjectBlock blockId="sample-block" /><InnerSidebarRestore /></>));
    await until(() => column() !== null, 'the sample column drawn');
    const fold = host.querySelector<HTMLElement>('[data-inner-head="sample-project"] [data-inner-head-fold]')!;
    expect([...fold.parentElement!.children].at(-1)).toBe(fold);
    await act(async () => fold.click());
    expect(column()).toBeNull();
    expect(innerSidebarFoldedAway.get()).toBe(true);
    expect(innerSidebarShownFor.get()).toBeNull();
    const expand = host.querySelector<HTMLElement>('[data-shell-restore-lane] button[aria-label="sidebar.expandInner"]')!;
    await act(async () => expand.click());
    expect(column()!.dataset.innerSidebarKind).toBe('sample');
    expect(host.querySelector('[data-shell-restore-lane]')).toBeNull();
  });

  it('draws nothing while the account has no sample', async () => {
    io.rows.set('u/user', { user_id: 'u', scope: 'user', config: { sampleProject: { version: 1, dismissed: true } }, updated_at: '2026-11-12T00:00:00.000Z' });
    await act(async () => root.render(<InnerSidebar />));
    await flush();
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(column()).toBeNull();
  });
});
