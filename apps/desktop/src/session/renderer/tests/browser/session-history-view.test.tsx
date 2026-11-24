import { useRef, type ReactNode } from 'react';
import { CommandShortcutBinder } from '@renderer/lib/commands/command-shortcut-binder';
import { useFindBar } from '@renderer/lib/ui/use-find-bar';
import { FindBar } from '@renderer/lib/ui/find-bar';
import { page, userEvent } from '@vitest/browser/context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionHistoryDirectoryPage, SessionHistoryDirectoryParams, SessionHistoryDirectoryRow, SessionHistoryPage, SessionHistoryRow } from '@shared/core/session-history/session-history';
import { SESSION_HOME_SECTION_KEY } from '@shared/core/session-history/session-history';
import { isMacHost } from '@shared/host-os';
import '@/styles/tokens.css';
import '@renderer/index.css';

vi.mock('@renderer/features/settings/use-app-settings-key', async () => { const { fakeAppSettings } = await import('../../../../../../../tests/support/appSettingsDouble'); return { useAppSettingsKey: () => fakeAppSettings({}) } });

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  listDirectories: vi.fn(),
  previewLocalSession: vi.fn(),
  importLocalSession: vi.fn(),
  navigate: vi.fn(),
  openSession: vi.fn(),
  ensureProjectLoaded: vi.fn(),
  restore: vi.fn(),
  remoteListDirectories: vi.fn(),
  remoteList: vi.fn(),
  remoteImport: vi.fn(),
  syncProjects: vi.fn(),
  openLink: vi.fn(async () => true),
}));
/** 这次进会话历史带的那一部分(useParams('session-history'));默认什么都不带。 */
const entry = vi.hoisted(() => ({ params: {} as Record<string, unknown> }));
// #6956 推到渲染层的事件:按机器分(与真 onMachineEvent 同一个判据,null = 本机),用例自己当主进程往里发。
// 离线机器的心跳摘要(remoteHostsStore.sessionsOf)、账号上的项目(accountProjectsStore,`bound` = 各台上绑着 webapp 的本地项目)与本地项目表:用例自己摆。
const world = vi.hoisted(() => ({
  digests: {} as Record<string, unknown[]>,
  bound: [] as Array<{ deviceId: string; localProjectId: string }>,
  projects: new Map<string, { id: string; name: string; data: { path: string } }>(),
  projectMachine: {} as Record<string, string>,
}));
const bus = vi.hoisted(() => ({
  listeners: new Set<{ machine: string | null; event: string; cb: (data: unknown) => void }>(),
}));
function emitFrom(machine: string | null, event: string, data: unknown): void {
  for (const l of [...bus.listeners]) if (l.machine === machine && l.event === event) l.cb(data);
}

vi.mock('@renderer/lib/ipc', () => {
  const rpc = {
    sessionHistory: { list: mocks.list, listDirectories: mocks.listDirectories },
    sessionImport: {
      previewLocalSession: mocks.previewLocalSession,
      importLocalSession: mocks.importLocalSession,
    },
  };
  return {
    rpc,
    // #6264 别的机器:那台机器上同一张路由表;这里只摆会话历史与导入两格。
    rpcOn: (machine: string | null) =>
      machine
        ? {
            sessionHistory: {
              list: (params: unknown) => mocks.remoteList(machine, params),
              listDirectories: (params: unknown) => mocks.remoteListDirectories(machine, params),
            },
            sessionImport: {
              previewLocalSession: mocks.previewLocalSession,
              importLocalSession: (params: unknown) => mocks.remoteImport(machine, params),
            },
          }
        : rpc,
    onMachineEvent: (machine: string | null, event: { name: string }, cb: (data: unknown) => void) => {
      const listener = { machine, event: event.name, cb };
      bus.listeners.add(listener);
      return () => bus.listeners.delete(listener);
    },
    events: { on: () => () => {}, emit: () => {} },
  };
});
// #6264 名下别的机器由用例自己摆(真 store 会去接 gugu 侧的设备通道):d22 用 SSH 装上、tunnel 只经远程隧道、off 离线。
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', async () => {
  const { observable } = await import('mobx');
  const device = (id: string, label: string, isOnline: boolean, directTerminal: boolean) => ({
    device: { id, label, isOnline, platform: 'linux', lastSeenAt: '2026-09-24T08:00:00Z', sessionDigest: null, directTerminal },
  });
  return {
    remoteHostsStore: {
      hosts: observable.map([
        ['dev-d22', device('dev-d22', 'd22', true, true)],
        ['dev-tunnel', device('dev-tunnel', 'tunnel', true, false)],
        ['dev-off', device('dev-off', 'off', false, true)],
      ]),
      start: () => {},
      device(id: string) {
        return (this.hosts.get(id) as { device: { directTerminal: boolean } } | undefined)?.device ?? null;
      },
      syncProjects: mocks.syncProjects,
      sessionsOf: (id: string) => ({ sessions: world.digests[id] ?? [], live: false }),
      connectionState: () => 'connected',
      // #7199 选了睡着的云电脑才会叫醒 / 读叫醒没成的原因;这几台都不是云电脑。
      wakeCloudComputer: async () => false,
      wakeFailure: () => null,
    },
  };
});
// A session opens the one way every session is opened (openLink); what it hands over is read here.
vi.mock('@/lib/guguLinks', () => ({ openLink: mocks.openLink }));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: mocks.navigate }),
  useParams: () => ({ params: entry.params, setParams: () => {} }),
}));
vi.mock('@renderer/features/sessions/open-session-in-session', () => ({
  openSessionInSessionWhenReady: mocks.openSession,
}));
vi.mock('@renderer/features/sessions/restore-session-flow', () => ({
  restoreArchivedSession: mocks.restore,
}));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({ ensureProjectLoaded: mocks.ensureProjectLoaded, projects: world.projects }),
  projectDisplayName: (store: { name: string } | undefined) => store?.name,
}));
vi.mock('@renderer/lib/stores/app-state', () => ({
  sidebarStore: {},
}));
vi.mock('@renderer/lib/machine-routing', () => ({
  machineRegistry: { machineOf: (id: string) => world.projectMachine[id] ?? null },
}));
// 节头的 agent 图标:真 AgentIcon 会把 agent store / 导航那整张图拉进来,这里只判「画了几个、id 对不对」。
vi.mock('@renderer/lib/components/agent-icon', () => ({
  AgentIcon: ({ id }: { id: string }) => <span data-testid="agent-icon" data-agent-id={id} />,
}));

import { setLocalePreference } from '@/i18n';
import { setPortalContainer } from '@renderer/lib/portal-container';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { SessionHistoryMainPanel } from '@renderer/features/session-history/session-history-view';
import { SESSION_HISTORY_IMPORT_PART } from '@renderer/features/session-history/session-history-import-part';
import { accountProjectsStore } from '@renderer/features/projects/stores/account-projects-store';
import { runInAction } from 'mobx';
import { followRendererSession, queryClient } from '@/lib/replica';
import { thisDeviceId } from '@/store/thisDevice';

/** 账号上的项目:webapp(这台电脑上的 p1,加上用例绑在别的机器上的)。 */
function seedAccounts(): void {
  thisDeviceId.set([], 'this-computer');
  runInAction(() => {
    accountProjectsStore.list = [{ chatId: 'chat-webapp', name: 'webapp', archived: false, activeAt: '2026-01-01T00:00:00.000Z', bindings: [{ deviceId: 'this-computer', localProjectId: 'p1' }, ...world.bound] }];
    accountProjectsStore.status = 'ready';
  });
}

const NOW = Date.now();
const WEBAPP = '/Users/me/work/webapp';
const BILLING = '/Users/me/work/billing-service';
/** 主进程给的节 key:webapp 在项目群 chat-webapp 里。 */
const WEBAPP_SECTION = 'project:chat-webapp';

function gugu(overrides: Partial<SessionHistoryRow> & { key: string }): SessionHistoryRow {
  const sessionId = overrides.key.replace('gugu:', '');
  return {
    source: 'gugu',
    status: 'active',
    title: overrides.key,
    providerSessionId: null,
    providerId: 'claude',
    directory: WEBAPP,
    projectName: 'webapp',
    updatedAt: NOW - 3 * 60 * 60 * 1000,
    lastPromptAt: null,
    addedAt: NOW - 24 * 60 * 60 * 1000,
    archivedAt: null,
    childCount: 0,
    parentTitle: null,
    gugu: { projectId: 'p1', sessionId, runtime: 'acp' },
    ...overrides,
  };
}

function local(overrides: Partial<SessionHistoryRow> & { key: string; title: string }): SessionHistoryRow {
  const providerSessionId = overrides.key.replace('local:', '');
  return {
    source: 'codex',
    status: 'not-imported',
    providerSessionId,
    providerId: 'codex',
    directory: BILLING,
    projectName: null,
    updatedAt: NOW - 60 * 60 * 1000,
    lastPromptAt: null,
    addedAt: null,
    archivedAt: null,
    childCount: 0,
    parentTitle: null,
    local: {
      engine: 'codex',
      providerSessionId,
      title: overrides.title,
      cwd: BILLING,
      filePath: `/Users/me/.codex/sessions/${providerSessionId}.jsonl`,
      updatedAt: NOW - 60 * 60 * 1000,
      sizeBytes: 100,
    },
    ...overrides,
  };
}

// 顺序故意既不按时间也不按字母:渲染层若自作主张排序,DOM 顺序就会偏离主进程给的顺序。
const WEBAPP_ROWS: SessionHistoryRow[] = [
  gugu({ key: 'gugu:zebra', title: '整理 zebra 仓的发布脚本', status: 'archived', archivedAt: NOW - 1000, childCount: 2 }),
  gugu({ key: 'gugu:alpha', title: 'alpha 登录页主按钮的 hover 态', updatedAt: NOW - 10 * 60 * 60 * 1000, providerId: 'codex' }),
];
const BILLING_ROWS: SessionHistoryRow[] = [
  local({ key: 'local:codex-1', title: '给结算服务补幂等键' }),
  local({ key: 'local:codex-2', title: '把日志切成按天滚动' }),
];
const ROWS = [...WEBAPP_ROWS, ...BILLING_ROWS];

function dir(overrides: Partial<SessionHistoryDirectoryRow> & { key: string }): SessionHistoryDirectoryRow {
  return {
    directory: overrides.key || null,
    projectName: null,
    sessionCount: 2,
    countsBySource: { gugu: 0, 'claude-code': 0, codex: 2 },
    countsByStatus: { active: 0, archived: 0, 'not-imported': 2 },
    providers: ['codex'],
    updatedAt: NOW - 60 * 60 * 1000,
    lastPromptAt: null,
    addedAt: null,
    sessions: [],
    ...overrides,
  };
}

const DIRS: SessionHistoryDirectoryRow[] = [
  dir({
    key: WEBAPP_SECTION,
    projectName: 'webapp',
    countsBySource: { gugu: 2, 'claude-code': 0, codex: 0 },
    countsByStatus: { active: 1, archived: 1, 'not-imported': 0 },
    providers: ['claude', 'codex'],
    updatedAt: NOW - 3 * 60 * 60 * 1000,
    addedAt: NOW - 24 * 60 * 60 * 1000,
    sessions: WEBAPP_ROWS,
  }),
  dir({ key: BILLING, sessions: BILLING_ROWS }),
];

const DIRECTORIES = [
  { directory: WEBAPP_SECTION, projectName: 'webapp', count: 2 },
  { directory: BILLING, projectName: null, count: 2 },
];

function pageOf(rows: SessionHistoryRow[], overrides: Partial<SessionHistoryPage> = {}): SessionHistoryPage {
  return {
    rows,
    matched: rows.length,
    countsBySource: { gugu: 2, 'claude-code': 0, codex: 2 },
    countsByStatus: { active: 1, archived: 1, 'not-imported': 2 },
    directories: DIRECTORIES,
    local: { discovered: 2, indexed: 2, pending: 0, stale: false },
    ...overrides,
  };
}

function directoryPageOf(
  rows: SessionHistoryDirectoryRow[],
  overrides: Partial<SessionHistoryDirectoryPage> = {}
): SessionHistoryDirectoryPage {
  return {
    rows,
    matched: rows.length,
    countsBySource: { gugu: 2, 'claude-code': 0, codex: 2 },
    countsByStatus: { active: 1, archived: 1, 'not-imported': 2 },
    directories: DIRECTORIES,
    local: { discovered: 2, indexed: 2, pending: 0, stale: false },
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(extra?: ReactNode): void {
  container = document.createElement('div');
  container.className = 'emlight gugu-skin bg-background';
  container.style.height = '800px';
  document.body.appendChild(container);
  setPortalContainer(container);
  root = createRoot(container);
  root.render(
    <SessionLocalizationProvider>
      <QueryClientProvider client={new QueryClient()}>
        <SessionHistoryMainPanel />
        {extra}
      </QueryClientProvider>
    </SessionLocalizationProvider>
  );
}

const screen = page;
const directoryParams = () =>
  mocks.listDirectories.mock.calls.map(([params]) => params as SessionHistoryDirectoryParams);
const click = (testId: string) => (screen.getByTestId(testId).element() as HTMLElement).click();
/** 下拉 / 菜单是 Base UI:先点触发器,选项才渲染到 portal 里。 */
async function pick(triggerId: string, optionId: string): Promise<void> {
  click(triggerId);
  await expect.element(screen.getByTestId(optionId)).toBeVisible();
  click(optionId);
}
const keydown = (el: HTMLElement, key: string) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
const rowKeys = () =>
  screen.getByTestId('session-history-row').all().map((row) => row.element().getAttribute('data-row-key'));

const transcriptBackend = { find: () => ({ currentIndex: 0, total: 0 }), step: () => ({ currentIndex: 0, total: 0 }), clear: () => {} };
function TranscriptFindControl() {
  const rootRef = useRef<HTMLDivElement>(null);
  const find = useFindBar({ rootRef, backend: transcriptBackend });
  return <div ref={rootRef} className="relative"><button data-testid="transcript-find-focus">Loaded transcript</button><FindBar {...find} /></div>;
}

describe('会话历史(按目录分节)核心合同', () => {
  afterEach(() => {
    setPortalContainer(null);
    root?.unmount();
    container?.remove();
    root = null;
    container = null;
    queryClient.clear();
    followRendererSession('SIGNED_OUT', null);
  });

  beforeEach(async () => {
    // The preview is an account replica: it reads for whoever is signed in.
    followRendererSession('SIGNED_IN', 'reader');
    await page.viewport(1280, 860);
    setLocalePreference('zh-CN');
    entry.params = {};
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.list.mockResolvedValue(pageOf(ROWS));
    mocks.listDirectories.mockResolvedValue(directoryPageOf(DIRS));
    mocks.ensureProjectLoaded.mockResolvedValue(undefined);
    mocks.restore.mockResolvedValue(undefined);
    mocks.syncProjects.mockResolvedValue(undefined);
    // 别的机器默认什么都没有(它们一直和本机一起被问);要它们有行的用例自己摆。
    mocks.remoteListDirectories.mockResolvedValue(directoryPageOf([], { directories: [] }));
    world.digests = {};
    world.bound = [];
    seedAccounts();
    world.projects = new Map();
    world.projectMachine = {};
    mocks.remoteImport.mockImplementation((_machine: string, _params: { providerSessionId: string }) =>
      Promise.resolve({ projectId: 'rp', sessionId: 'rc', workingDirectory: '/home/alice/api', alreadyImported: false })
    );
    mocks.previewLocalSession.mockResolvedValue({
      sessionId: 'codex-1',
      title: BILLING_ROWS[0].title,
      cwd: BILLING,
      turnCount: 4,
      head: [],
      tail: [],
    });
  });

  it('k4/k5 routes find by focus while the real history SearchInput stays mounted', async () => {
    const findShortcut = isMacHost() ? '{Meta>}f{/Meta}' : '{Control>}f{/Control}';
    render(<><CommandShortcutBinder /><TranscriptFindControl /></>);
    await expect.element(screen.getByTestId('session-history-search')).toBeVisible();
    const history = screen.getByTestId('session-history-search').element();
    const filter = screen.getByTestId('session-history-filter').element() as HTMLElement;
    await screen.getByTestId('session-history-search').click();
    await userEvent.keyboard('{Tab}');
    expect(document.activeElement).toBe(filter);
    await userEvent.keyboard(findShortcut);
    await vi.waitFor(() => expect(document.activeElement).toBe(history));
    const transcript = screen.getByTestId('transcript-find-focus').element() as HTMLElement;
    await screen.getByTestId('transcript-find-focus').click();
    expect(document.activeElement).toBe(transcript);
    await userEvent.keyboard(findShortcut);
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('placeholder')).toMatch(/Find|查找/));
    expect(document.activeElement).not.toBe(history);
    expect(screen.getByTestId('session-history-search').all()).toHaveLength(1);
  });

  it('默认一目录一节、全展开:节头有名字 / agent 图标 / 条数,节内按主进程给的顺序两行一条,动作按状态', async () => {
    render();
    const list = screen.getByTestId('session-history-list');
    await vi.waitFor(() => expect(list.getByTestId('session-history-section').all()).toHaveLength(2));
    const sections = list.getByTestId('session-history-section').all();
    // 咕咕行的一节 = 它的项目(侧栏那一行);对不上项目的原件按「机器 · 目录」一节。
    expect(sections.map((s) => s.element().getAttribute('data-section-key'))).toEqual(['project:chat-webapp', `dir:local:${BILLING}`]);
    await expect.element(list.getByText('webapp', { exact: true })).toBeVisible();
    // 目录一节的名字 = 目录末级名(参照页就是一个词);完整路径在 title 上。项目一节不挂路径(几台机器上路径各不同)。
    await expect.element(list.getByText('billing-service', { exact: true })).toBeVisible();
    expect(
      list.getByTestId('session-history-section-name').all().map((el) => el.element().getAttribute('title'))
    ).toEqual([null, BILLING]);
    // 只有一台机器的行:行上不标机器。
    expect(list.getByTestId('session-history-row-machine').all()).toHaveLength(0);
    // 节头的 agent 图标:webapp 那节两个 provider。
    expect(sections[0].getByTestId('session-history-section-agents').getByTestId('agent-icon').all().map((el) => el.element().getAttribute('data-agent-id'))).toEqual(['claude', 'codex']);
    await expect.element(sections[0].getByText('2 个会话', { exact: true })).toBeVisible();
    // 一次 RPC 把每节的会话一起带回(模板一节全列,上限 100),❌ 每节各拉一次;默认只看咕咕会话。
    // 每节随目录页只带回露出来的那几条(❌ 每节先拉上百条进内存)。
    expect(directoryParams()[0]).toMatchObject({ limit: 50, sessionsPerDirectory: 5, source: 'gugu' });
    expect(mocks.list).not.toHaveBeenCalled();

    // 节内的行:顺序照主进程给的,两行 = 标题 / 时间(模板),动作按状态;session id、父子范围只在详情里。
    expect(rowKeys()).toEqual(ROWS.map((row) => row.key));
    expect(screen.getByTestId('session-history-row').all().map((row) => row.element().getAttribute('data-status'))).toEqual([
      'archived', 'active', 'not-imported', 'not-imported',
    ]);
    expect(list.getByText('派出 2 个子任务', { exact: false }).all()).toHaveLength(0);
    // 第二行是绝对时间,年份总写(「2026年8月20日 19:46」,与界面其它日期同一种写法)。
    expect(screen.getByTestId('session-history-row').first().element().querySelector('time')?.textContent).toMatch(
      /^\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/
    );
    // 状态不另贴标签(动作钮就是状态),行上也没有勾选框。
    expect(list.getByText('已归档', { exact: true }).all()).toHaveLength(0);
    expect(screen.getByTestId('session-history-checkbox').all()).toHaveLength(0);
    const actions = list.getByTestId('session-history-action').all();
    expect(actions.map((action) => action.element().textContent)).toEqual(['恢复', '打开', '导入', '导入']);
    await expect.element(screen.getByTestId('session-history-total')).toHaveTextContent('共 2 个目录');
  });

  it('「咕咕独立会话」那一节:节名是「咕咕独立会话」,不把内部 key 当路径露出来', async () => {
    const home = dir({ key: SESSION_HOME_SECTION_KEY, sessionCount: 1, sessions: [local({ key: 'local:th-1', title: '独立任务里跑的', directory: '/Users/me/gugu-a-profile/task-home' })] });
    mocks.listDirectories.mockResolvedValue(
      directoryPageOf([home, DIRS[1]], { directories: [...DIRECTORIES, { directory: SESSION_HOME_SECTION_KEY, projectName: null, count: 1 }] })
    );
    render();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-section').all()).toHaveLength(2));
    const name = screen.getByTestId('session-history-section-name').first();
    await expect.element(name).toHaveTextContent('咕咕独立会话');
    expect(name.element().getAttribute('title')).toBeNull();
  });

  it('筛选菜单(来源 / 状态 / 排序)与搜索都传给主进程,渲染层自己不排;触发钮写着生效的筛选', async () => {
    render();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-section').all()).toHaveLength(2));
    await expect.element(screen.getByTestId('session-history-filter')).toHaveTextContent('咕咕会话');
    await pick('session-history-filter', 'session-history-filter-source-codex');
    await vi.waitFor(() => expect(directoryParams().some((p) => p.source === 'codex')).toBe(true));
    await pick('session-history-filter', 'session-history-filter-status-archived');
    await vi.waitFor(() => expect(directoryParams().some((p) => p.status === 'archived')).toBe(true));
    await expect.element(screen.getByTestId('session-history-filter')).toHaveTextContent('Codex 会话，尚未导入，已归档');
    await pick('session-history-filter', 'session-history-filter-source-all');
    await vi.waitFor(() => expect(directoryParams().at(-1)?.source).toBeUndefined());
    await pick('session-history-filter', 'session-history-filter-sort-title');
    await vi.waitFor(() => expect(directoryParams().some((p) => p.sort === 'title')).toBe(true));
    await screen.getByTestId('session-history-search').fill('幂等');
    await vi.waitFor(() => expect(directoryParams().some((p) => p.query === '幂等')).toBe(true));
    // 排序键换了,DOM 顺序仍是主进程返回的顺序(mock 一直返回同一页)——渲染层没有自己排。
    expect(rowKeys()).toEqual(ROWS.map((row) => row.key));
  });

  it('#2548 带着导入那一部分进来(侧栏「导入以前的会话」):第一次就问全部来源里未导入的,触发钮照实写着', async () => {
    entry.params = { ...SESSION_HISTORY_IMPORT_PART };
    render();
    await vi.waitFor(() => expect(directoryParams().length).toBeGreaterThan(0));
    expect(directoryParams().every((p) => p.source === undefined && p.status === 'not-imported')).toBe(true);
    await expect.element(screen.getByTestId('session-history-filter')).toHaveTextContent('全部来源，未导入');
  });

  const scrollToListEnd = () => (screen.getByTestId('session-history-total').element().parentElement as HTMLElement).scrollIntoView();

  it('滚动加载:目录多于已带回的,滚到底把 limit 放大交给主进程(❌ 翻页、❌ offset)', async () => {
    const many = Array.from({ length: 50 }, (_, i) => dir({ key: `/d/${i}`, sessionCount: 1, sessions: [gugu({ key: `gugu:c${i}`, title: `c${i}`, directory: `/d/${i}`, gugu: { projectId: `p-${i}`, sessionId: `c${i}`, runtime: 'acp' } })] }));
    mocks.listDirectories.mockResolvedValue(directoryPageOf(many, { matched: 250 }));
    render();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-section').all()).toHaveLength(50));
    expect(directoryParams().every((p) => p.limit === 50 && p.offset === undefined)).toBe(true);
    // Scroll on every check: once rendered, the list puts its cursor row (the first one) into view, and when that lands
    // after our scroll it takes the list back to the top before the end-of-list marker is seen (#2578).
    await vi.waitFor(() => {
      scrollToListEnd();
      expect(directoryParams().some((p) => p.limit === 100 && p.offset === undefined)).toBe(true);
    });
    expect(screen.getByTestId('session-history-page').all()).toHaveLength(0);
  });

  // A slow machine must not hold back scrolling through what the others brought back (it gated on "any machine reading").
  it('滚动加载:另一台机器的第一页还没回来,滚到底照样把 limit 放大', async () => {
    const many = Array.from({ length: 50 }, (_, i) => dir({ key: `/d/${i}`, sessionCount: 1, sessions: [gugu({ key: `gugu:c${i}`, title: `c${i}`, directory: `/d/${i}`, gugu: { projectId: `p-${i}`, sessionId: `c${i}`, runtime: 'acp' } })] }));
    mocks.listDirectories.mockResolvedValue(directoryPageOf(many, { matched: 250 }));
    // The other machines answer only when the test lets them: the order of events is asserted, never a time.
    const held: Array<() => void> = [];
    mocks.remoteListDirectories.mockImplementation(() => new Promise((resolve) => { held.push(() => resolve(directoryPageOf([], { directories: [] }))); }));
    try {
      render();
      await vi.waitFor(() => expect(screen.getByTestId('session-history-section').all()).toHaveLength(50));
      // Another machine was asked and has not answered.
      expect(held.length).toBeGreaterThan(0);
      await vi.waitFor(() => {
        scrollToListEnd();
        expect(directoryParams().some((p) => p.limit === 100)).toBe(true);
      }, { timeout: 10_000 }); // a ceiling on waiting, not a speed claim: the remote stays unanswered until the finally
    } finally {
      for (const answer of held) answer();
    }
  });

  it.each([
    ['zh-CN', '读取失败：imp-8.jsonl 不存在或无法读取'],
    ['en-US', 'Failed to read: imp-8.jsonl is missing or cannot be read'],
  ] as const)('预览读不到文件(%s):按界面语言说人话,只带文件名,❌ 硬编码中文或完整路径(#3447)', async (locale, sentence) => {
    setLocalePreference(locale);
    // 主进程只递原因码 + 文件名(完整路径只进它的日志);本机 IPC 再套外壳和类名(真 Electron 45 实测的整句)。
    mocks.previewLocalSession.mockRejectedValue(
      new Error("Error invoking remote method 'sessionImport.previewLocalSession': TranscriptAccessError: transcript-unreadable:imp-8.jsonl")
    );
    render();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-row').all()).toHaveLength(4));
    // 第三行是 not-imported:点开就读预览。
    (screen.getByTestId('session-history-row').all()[2].element() as HTMLElement).click();
    const detail = screen.getByTestId('session-history-detail');
    await expect.element(detail.getByText(sentence)).toBeVisible();
    const error = detail.getByText(sentence).element().textContent ?? '';
    expect(error).not.toContain('/');
    if (locale === 'en-US') expect(error).not.toMatch(/[㐀-鿿]/u);
  });

  it.each([
    ['zh-CN', '导入失败：无法把文件夹 webapp 作为项目打开：咕咕没有读取它的权限'],
    ['en-US', 'Import failed: The folder webapp could not be opened as a project: Gugu does not have permission to read it'],
  ] as const)('导入时文件夹读不了(%s):界面说「文件夹 X 无法作为项目打开：<本地化原因>」,❌ 完整路径或原始报错(#3447)', async (locale, sentence) => {
    setLocalePreference(locale);
    // 主进程抛 `<码>:<文件夹名>`,本机 IPC 再套外壳(完整目录与原始 EACCES 只进它的日志)。
    mocks.importLocalSession.mockRejectedValue(
      new Error("Error invoking remote method 'sessionImport.importLocalSession': Error: project-permission-denied:webapp")
    );
    render();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-row').all()).toHaveLength(4));
    // 第三行是 not-imported:它的动作是「导入」。
    (screen.getByTestId('session-history-action').all()[2].element() as HTMLElement).click();
    await expect.element(screen.getByText(sentence)).toBeVisible();
    expect(screen.getByText(sentence).element().textContent).not.toMatch(/EACCES|\/work|\/Users/);
  });

  it('点一行展开详情(咕咕行含 session id),再点收起;已归档的行:恢复走唯一路径并刷新', async () => {
    // 主进程的 restoreSession 每放回一条都发一次 archivedAt: null 的 session:changed;面板靠它刷新(#6956)。
    mocks.restore.mockImplementation(async (ref: { projectId: string; sessionId: string }) => {
      emitFrom(null, 'session:changed', { ...ref, changes: { archivedAt: null } });
    });
    mocks.listDirectories.mockResolvedValue(
      directoryPageOf([{ ...DIRS[0], sessions: [{ ...WEBAPP_ROWS[0], providerSessionId: 'sess-zebra-42' }, WEBAPP_ROWS[1]] }, DIRS[1]])
    );
    render();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-row').all()).toHaveLength(4));
    const first = screen.getByTestId('session-history-row').first();
    (first.element() as HTMLElement).click();
    await expect.element(screen.getByTestId('session-history-detail')).toBeVisible();
    await expect.element(screen.getByTestId('session-history-detail').getByText('sess-zebra-42')).toBeVisible();
    (first.element() as HTMLElement).click();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-detail').all()).toHaveLength(0));

    const callsBefore = mocks.listDirectories.mock.calls.length;
    (screen.getByTestId('session-history-action').first().element() as HTMLElement).click();
    await vi.waitFor(() =>
      expect(mocks.restore).toHaveBeenCalledWith({ projectId: 'p1', sessionId: 'zebra' })
    );
    await vi.waitFor(() => expect(mocks.listDirectories.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('#6956 面板开着时在别处归档(手机、侧栏、agent):跟着问得到的每台机器的 session:changed 重拉;别的字段、离线的机器不重拉', async () => {
    render();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-row').all()).toHaveLength(4));
    const calls = () => mocks.listDirectories.mock.calls.length;
    const before = calls();
    // 只改了标题;离线的那台(没有订它):都不重拉。
    emitFrom(null, 'session:changed', { sessionId: 'alpha', projectId: 'p1', changes: { title: '改了个名' } });
    emitFrom('dev-off', 'session:changed', { sessionId: 'r1', projectId: 'rp', changes: { archivedAt: '2026-10-06 15:10:05' } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls()).toBe(before);

    // 手机把 alpha 归档了:主进程发 archivedAt ⇒ 面板重拉,那一行的动作从「打开」换成「恢复」(❌ 还写着打开,点下去等满超时)。
    mocks.listDirectories.mockResolvedValue(
      directoryPageOf([
        { ...DIRS[0], sessions: [WEBAPP_ROWS[0], { ...WEBAPP_ROWS[1], status: 'archived', archivedAt: NOW }] },
        DIRS[1],
      ])
    );
    emitFrom(null, 'session:changed', { sessionId: 'alpha', projectId: 'p1', changes: { archivedAt: '2026-10-06 15:10:05' } });
    await vi.waitFor(() => expect(calls()).toBeGreaterThan(before));
    await vi.waitFor(() =>
      expect(screen.getByTestId('session-history-action').all().map((a) => a.element().textContent)).toEqual([
        '恢复', '恢复', '导入', '导入',
      ])
    );
    // 别的机器上归档的:那台问得到,它的那一路也重拉。
    const d22Calls = () => mocks.remoteListDirectories.mock.calls.filter(([machine]) => machine === 'dev-d22').length;
    const d22Before = d22Calls();
    emitFrom('dev-d22', 'session:changed', { sessionId: 'r1', projectId: 'rp', changes: { archivedAt: '2026-10-06 15:10:05' } });
    await vi.waitFor(() => expect(d22Calls()).toBeGreaterThan(d22Before));
  });

  it('活跃的行:打开 = 进这条会话并打开它', async () => {
    render();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-action').all()).toHaveLength(4));
    (screen.getByTestId('session-history-action').nth(1).element() as HTMLElement).click();
    await vi.waitFor(() =>
      expect(mocks.openLink).toHaveBeenCalledWith({ kind: 'session', sessionId: 'alpha', projectId: 'p1' })
    );
  });

  it('未导入的行:方向键 + 回车导入光标那条', async () => {
    render();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-row').all()).toHaveLength(4));
    mocks.importLocalSession.mockImplementation((_params: { providerSessionId: string }) =>
      Promise.resolve({
        projectId: 'p1', sessionId: 'c1', workingDirectory: '/w', alreadyImported: false,
      })
    );
    const searchEl = screen.getByTestId('session-history-search').element() as HTMLInputElement;
    searchEl.focus();
    // 光标从第一行(zebra)起:两下到 codex-1,两下之间等一帧 —— 同一帧里第二下读到的还是旧光标。
    keydown(searchEl, 'ArrowDown');
    await vi.waitFor(() => expect(searchEl.getAttribute('aria-activedescendant')).toContain('gugu:alpha'));
    keydown(searchEl, 'ArrowDown');
    await vi.waitFor(() => expect(searchEl.getAttribute('aria-activedescendant')).toContain('local:codex-1'));
    keydown(searchEl, 'Enter');
    await vi.waitFor(() =>
      expect(mocks.importLocalSession).toHaveBeenCalledWith(expect.objectContaining({ providerSessionId: 'codex-1', engine: 'codex' }))
    );
    await vi.waitFor(() => expect(mocks.openLink).toHaveBeenCalledWith({ kind: 'session', sessionId: 'c1', projectId: 'p1' }));

  });

  it('搜索词是某条的 session id 前缀:光标直接落在那条并上色', async () => {
    render();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-row').all()).toHaveLength(4));
    const searchEl = screen.getByTestId('session-history-search').element() as HTMLInputElement;
    await screen.getByTestId('session-history-search').fill('codex-2');
    await vi.waitFor(() => expect(directoryParams().some((p) => p.query === 'codex-2')).toBe(true));
    await vi.waitFor(() => expect(searchEl.getAttribute('aria-activedescendant')).toContain('local:codex-2'));
    const hit = screen.getByTestId('session-history-row').nth(3).element();
    expect(hit.getAttribute('data-row-key')).toBe('local:codex-2');
    expect(hit.className).toContain('bg-row-selected');
    // 短词只是普通关键词,不抢光标。
    await screen.getByTestId('session-history-search').fill('cod');
    await vi.waitFor(() => expect(directoryParams().some((p) => p.query === 'cod')).toBe(true));
    await vi.waitFor(() => expect(searchEl.getAttribute('aria-activedescendant')).toContain('gugu:zebra'));
  });

  it('全部机器一起读:同一个项目在本机与 d22 上的任务进同一节,行上标机器;离线那台不去问', async () => {
    // d22 上的 webapp 是另一台上的本地项目 rp1,与本机 p1 绑在同一个项目群上 ⇒ d22 的主进程也给 project:chat-webapp 这一节。
    world.bound = [{ deviceId: 'dev-d22', localProjectId: 'rp1' }];
    seedAccounts();
    const remoteRow = gugu({ key: 'gugu:remote-w', title: 'd22 上的 webapp 任务', directory: '/home/alice/webapp', updatedAt: NOW - 5 * 60 * 60 * 1000, gugu: { projectId: 'rp1', sessionId: 'remote-w', runtime: 'acp' } });
    mocks.remoteListDirectories.mockImplementation((machine: string) =>
      Promise.resolve(
        machine === 'dev-d22'
          ? directoryPageOf([dir({ key: WEBAPP_SECTION, projectName: 'webapp', sessionCount: 1, providers: ['claude'], updatedAt: remoteRow.updatedAt, sessions: [remoteRow] })])
          : directoryPageOf([], { directories: [] })
      )
    );
    render();
    const list = screen.getByTestId('session-history-list');
    await vi.waitFor(() => expect(rowKeys()).toContain('dev-d22/gugu:remote-w'));
    const sections = list.getByTestId('session-history-section').all();
    expect(sections.map((s) => s.element().getAttribute('data-section-key'))).toEqual(['project:chat-webapp', `dir:local:${BILLING}`]);
    // 一节三条:按更新时间跨机器归并(zebra 3h 前 → d22 那条 5h 前 → alpha 10h 前)。
    expect(sections[0].getByTestId('session-history-row').all().map((row) => row.element().getAttribute('data-row-key'))).toEqual([
      'gugu:zebra', 'dev-d22/gugu:remote-w', 'gugu:alpha',
    ]);
    await expect.element(sections[0].getByText('3 个会话', { exact: true })).toBeVisible();
    expect(sections[0].getByTestId('session-history-row-machine').all().map((el) => el.element().textContent)).toEqual(['本机', 'd22', '本机']);
    // 每台问得到的都问了;离线的 off ❌ 去问(只会挂满超时)。
    expect(mocks.remoteListDirectories).toHaveBeenCalledWith('dev-d22', expect.objectContaining({ sessionsPerDirectory: 5, source: 'gugu' }));
    expect(mocks.remoteListDirectories).toHaveBeenCalledWith('dev-tunnel', expect.anything());
    expect(mocks.remoteListDirectories.mock.calls.some(([machine]) => machine === 'dev-off')).toBe(false);

    // 打开 d22 那条:带着它的机器。
    (sections[0].getByTestId('session-history-action').nth(1).element() as HTMLElement).click();
    await vi.waitFor(() =>
      expect(mocks.openLink).toHaveBeenCalledWith({ kind: 'session', sessionId: 'remote-w', projectId: 'rp1', deviceId: 'dev-d22' })
    );

    // 机器筛选:只看 d22 ⇒ 只剩它的行,本机不再问。
    const localCalls = mocks.listDirectories.mock.calls.length;
    await pick('session-history-machine', 'session-history-machine-dev-d22');
    await vi.waitFor(() => expect(rowKeys()).toEqual(['dev-d22/gugu:remote-w']));
    await expect.element(screen.getByTestId('session-history-machine')).toHaveTextContent('d22');
    expect(mocks.listDirectories.mock.calls.length).toBe(localCalls);
    // 一台机器的行:不再标机器。
    expect(screen.getByTestId('session-history-row-machine').all()).toHaveLength(0);
    await pick('session-history-machine', 'session-history-machine-all');
    await vi.waitFor(() => expect(rowKeys()).toHaveLength(5));
  });

  it('离线的机器:心跳摘要里的任务按项目归节、行标离线,节尾写哪台离线;点得开的照侧栏的判据打开', async () => {
    world.bound = [{ deviceId: 'dev-off', localProjectId: 'offp' }];
    seedAccounts();
    const summary = (conversationId: string, title: string, at: string, supported: boolean) => ({
      conversationId, projectId: 'offp', title, harness: 'codex', runtime: 'acp', agentStatus: null,
      lastInteractedAt: at, supported,
    });
    world.digests = {
      'dev-off': [
        summary('off-1', 'off 上能打开的', new Date(NOW - 2 * 60 * 60 * 1000).toISOString(), true),
        summary('off-2', 'off 上打不开的', new Date(NOW - 20 * 60 * 60 * 1000).toISOString(), false),
      ],
    };
    render();
    // 离线那台的行当场就有(心跳摘要),本机的行要等主进程回来:等整节到齐再比次序。
    const webapp = screen.getByTestId('session-history-section').first();
    await vi.waitFor(() =>
      expect(webapp.getByTestId('session-history-row').all().map((row) => row.element().getAttribute('data-row-key'))).toEqual([
        'dev-off/gugu:off-1', 'gugu:zebra', 'gugu:alpha', 'dev-off/gugu:off-2',
      ])
    );
    expect(webapp.element().getAttribute('data-section-key')).toBe('project:chat-webapp');
    expect(webapp.getByTestId('session-history-row-offline').all()).toHaveLength(2);
    await expect.element(webapp.getByTestId('session-history-section-offline')).toHaveTextContent('off 离线');
    // 别的节里没有离线的行:没有这一句。
    expect(screen.getByTestId('session-history-section').nth(1).getByTestId('session-history-section-offline').all()).toHaveLength(0);
    expect(mocks.remoteListDirectories.mock.calls.some(([machine]) => machine === 'dev-off')).toBe(false);

    const actions = webapp.getByTestId('session-history-action').all();
    expect((actions[3].element() as HTMLButtonElement).disabled).toBe(true);
    (actions[0].element() as HTMLElement).click();
    await vi.waitFor(() =>
      expect(mocks.openLink).toHaveBeenCalledWith({ kind: 'session', sessionId: 'off-1', projectId: 'offp', deviceId: 'dev-off' })
    );

    // 摘要行也过同一套筛选:只看已归档 ⇒ 它们(都是活跃的)不在了。
    await pick('session-history-filter', 'session-history-filter-status-archived');
    await vi.waitFor(() => expect(rowKeys().some((key) => key?.startsWith('dev-off/'))).toBe(false));
  });

  it('恢复 / 导入作用在行所在的机器上:d22 的已归档行先挂上 d22 再恢复,本机的不挂;d22 的原件导入建在 d22', async () => {
    const archived = gugu({ key: 'gugu:remote-z', title: 'd22 上归档的', status: 'archived', archivedAt: NOW, directory: '/home/alice/api', projectName: 'api', updatedAt: NOW - 60 * 1000, gugu: { projectId: 'rp2', sessionId: 'remote-z', runtime: 'acp' } });
    const original = local({ key: 'local:remote-1', title: 'd22 上聊过的一条', directory: '/home/alice/scratch' });
    mocks.remoteListDirectories.mockImplementation((machine: string) =>
      Promise.resolve(
        machine === 'dev-d22'
          ? directoryPageOf([
              dir({ key: '/home/alice/api', projectName: 'api', sessionCount: 1, updatedAt: archived.updatedAt, sessions: [archived] }),
              dir({ key: '/home/alice/scratch', sessionCount: 1, sessions: [original] }),
            ])
          : directoryPageOf([], { directories: [] })
      )
    );
    render();
    await vi.waitFor(() => expect(rowKeys()).toContain('dev-d22/gugu:remote-z'));
    const rowAction = (key: string) =>
      screen.getByTestId('session-history-row').all().find((row) => row.element().getAttribute('data-row-key') === key)!
        .getByTestId('session-history-action').element() as HTMLElement;
    // 对不上项目的原件一节:节头标着它的机器。
    await expect.element(screen.getByTestId('session-history-section-machine').first()).toHaveTextContent('d22');

    rowAction('dev-d22/gugu:remote-z').click();
    await vi.waitFor(() => expect(mocks.restore).toHaveBeenCalledWith({ projectId: 'rp2', sessionId: 'remote-z' }));
    expect(mocks.syncProjects).toHaveBeenCalledWith('dev-d22');

    mocks.syncProjects.mockClear();
    rowAction('gugu:zebra').click();
    await vi.waitFor(() => expect(mocks.restore).toHaveBeenCalledWith({ projectId: 'p1', sessionId: 'zebra' }));
    expect(mocks.syncProjects).not.toHaveBeenCalled();

    rowAction('dev-d22/local:remote-1').click();
    await vi.waitFor(() =>
      expect(mocks.remoteImport).toHaveBeenCalledWith('dev-d22', expect.objectContaining({ providerSessionId: 'remote-1' }))
    );
    expect(mocks.importLocalSession).not.toHaveBeenCalled();
    // With its machine: the one way mounts d22's projects before the task opens (remote-hosts-store.reachProject).
    await vi.waitFor(() => expect(mocks.openLink).toHaveBeenCalledWith({ kind: 'session', sessionId: 'rc', projectId: 'rp', deviceId: 'dev-d22' }));
  });

  it('#6264 只经远程隧道连着的机器:导入的会话进「通用」(那种机器没有终端)', async () => {
    mocks.remoteListDirectories.mockImplementation((machine: string) =>
      Promise.resolve(
        machine === 'dev-tunnel'
          ? directoryPageOf([dir({ key: '/home/alice/api', sessions: [local({ key: 'local:remote-1', title: 'tunnel 上聊过的一条' })] })])
          : directoryPageOf([], { directories: [] })
      )
    );
    render();
    await vi.waitFor(() => expect(rowKeys()).toContain('dev-tunnel/local:remote-1'));
    await pick('session-history-machine', 'session-history-machine-dev-tunnel');
    await vi.waitFor(() => expect(rowKeys()).toEqual(['dev-tunnel/local:remote-1']));
    click('session-history-action');
    await vi.waitFor(() =>
      expect(mocks.remoteImport).toHaveBeenCalledWith('dev-tunnel', expect.objectContaining({ sessionView: 'general' }))
    );
  });
});
