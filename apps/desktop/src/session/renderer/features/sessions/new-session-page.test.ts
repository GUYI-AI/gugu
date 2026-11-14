import { motionValue } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocalePreference } from '@/i18n';
import type { SessionFailure } from '@renderer/features/sessions/stores/session-failure';
import type { AccountProject } from '@gugu/core/cloud/deviceProjects';
import { IMPLICIT_SESSION_HOME_PROJECT_ID } from './session-home-project-constants';
import { homeView } from '@renderer/app/home-view';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { ProjectHome } from '@renderer/features/projects/components/main-panel/project-home';
import { NewSessionComposer, NewSessionPage } from './new-session-page';
import { remoteInstallNote } from './remote-install-before-create';
import { MachinePicker } from '@renderer/features/remote-hosts/machine-picker';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { installRemoteHostsBridge, type RemoteHostsBridge } from '@shared/remote-hosts';
import { ComposerProjectPicker } from './composer-context-tray';
import { getSessionWorkspaceActionOrder, sessionWorkspaceActionBlocked } from './pane-empty-state';
import { registerWorkspaceBackend, type WorkspaceBackend } from './workspace-backend/workspace-backend';
import { ShellTitlebar } from '@renderer/lib/components/titlebar/shell-titlebar';
import { NEW_SESSION_DRAFT_KEY, composerDrafts, projectDraftKey } from './composer-drafts';
import { cancelComposerVerb } from './composer-verb-tag';
import { readComposerVerb, setComposerVerb, takeComposerCarry } from '@/lib/composerVerbBridge';

const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
  dismissNotice: vi.fn(),
  showAddProjectModal: vi.fn(),
  orderedProjects: [] as Array<{ id: string; state: 'mounted' }>,
  createSessionStateProjectId: undefined as string | undefined,
  createSessionStateOptions: undefined as
    | { requireGeneratedName?: boolean; runInProjectDir?: boolean }
    | undefined,
  createSessionCallbackProjectId: undefined as string | undefined,
  createSessionStateWorkspaceId: undefined as string | null | undefined,
  // 项目首页的文件夹卡读侧栏的会话分布(sidebarStore.placement)。
  placement: { entries: new Map<string, Array<{ projectId: string; sessionId: string; group: 'working' | 'needs-you' | null; time: number; title: string }>>() },
  // #7341 第二步:项目首页按侧栏那一行看这个项目在各台机器上的本地项目(这里没合并:就是它自己)。
  rowProjectIdOf: (projectId: string) => projectId,
  projectMembersOf: (projectId: string) => [projectId],
  projectType: 'local' as 'local' | 'ssh',
  projectId: 'project-1',
  setProjectView: vi.fn(),
  navigate: vi.fn(),
  currentView: 'project' as 'project' | 'task',
  sessionFieldProps: null as null | { showAutoApproveToggle?: boolean; canSubmit?: boolean; onSubmit?: () => void },
  deliveryError: null as SessionFailure | null,
  // null = 输入框里就是挂上时读到的那份(真 hook 的 useState(initialPrompt));字符串 = 用户打进去的。
  prompt: null as string | null,
  initialPrompt: undefined as string | undefined,
  onCreated: undefined as undefined | ((result: { projectId: string; sessionId: string }) => void),
  handleCreateSession: vi.fn()
}));

vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getGitRepositoryStore: vi.fn(),
  getProjectStore: (projectId: string) => {
    const data = {
      type: mocks.projectType,
      id: projectId,
      name: projectId,
      path: `/tmp/${projectId}`,
      repositoryWorkspaceId: projectId
    };
    return {
      id: projectId,
      name: projectId,
      data,
      mountedProject: {
        data,
        view: { activeView: 'tasks', setProjectView: mocks.setProjectView }
      }
    };
  },
  asMounted: (store: { mountedProject?: unknown } | undefined) => store?.mountedProject,
  mountedProjectData: (store: { mountedProject?: { data?: unknown } } | undefined) =>
    store?.mountedProject?.data ?? null,
  projectDisplayName: (store: { name?: string } | undefined) => store?.name,
  projectViewKind: () => 'ready',
  getProjectManagerStore: () => ({ projects: new Map() })
}));

vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  getSessionPageStore: vi.fn()
}));

// 提示走全 app 唯一的出口(#137);这里只看「发了什么」,不挂提示条。
vi.mock('@/lib/notices', () => ({ notify: mocks.notify, dismissNotice: mocks.dismissNotice }));

vi.mock('@renderer/features/sessions/create-session-modal/use-create-session-callback', () => ({
  useCreateSessionCallback: ({ selectedProjectId, onCreated }: {
    selectedProjectId?: string;
    onCreated?: typeof mocks.onCreated;
  }) => {
    mocks.createSessionCallbackProjectId = selectedProjectId;
    mocks.onCreated = onCreated;
    return { handleCreateSession: mocks.handleCreateSession, canCreate: true, deliveryError: mocks.deliveryError };
  }
}));

vi.mock('@renderer/features/sessions/create-session-modal/use-create-session-state', () => ({
  useCreateSessionState: (
    projectId?: string,
    ...args: unknown[]
  ) => {
    mocks.createSessionStateProjectId = projectId;
    // (projectId, defaultBranch, isUnborn, currentBranch, workspaceId, …, options)
    mocks.createSessionStateWorkspaceId = args[3] as string | null | undefined;
    mocks.createSessionStateOptions = args.at(-1) as typeof mocks.createSessionStateOptions;
    return {
      isValid: false,
      workspaceConfig: {},
      sessionName: { effectiveSessionName: '', isPending: false }
    };
  }
}));

vi.mock('@renderer/features/sessions/create-session-modal/use-project-git-context', () => ({
  useProjectGitContext: () => ({
    defaultBranch: undefined,
    isUnborn: false,
    currentBranch: null,
    repositoryWorkspaceId: null
  })
}));

vi.mock('@renderer/features/sessions/hooks/useSessionSettings', () => ({
  useSessionSettings: () => ({
    autoApproveByDefault: false,
    includeIssueContextByDefault: false
  })
}));

vi.mock('@renderer/features/sessions/session-config/session-field', () => ({
  SessionField: (props: { showAutoApproveToggle?: boolean; canSubmit?: boolean; onSubmit?: () => void }) => {
    mocks.sessionFieldProps = props;
    return React.createElement('div', { 'data-testid': 'active-task-composer' });
  }
}));

vi.mock('./implicit-session-home-project', () => ({
  ensureImplicitSessionHomeProjectId: vi.fn().mockResolvedValue('implicit-task-home')
}));

vi.mock('@renderer/features/sessions/session-config/initial-session-section', () => ({
  useInitialSessionState: (...args: unknown[]) => {
    const options = args[3] as { initialPrompt?: string; draft?: ReturnType<typeof composerDrafts.forKey> } | undefined;
    if (options?.draft && mocks.prompt !== null) options.draft.setPrompt(mocks.prompt);
    mocks.initialPrompt = options?.draft?.prompt ?? options?.initialPrompt;
    return {
      provider: 'codex',
      prompt: mocks.prompt ?? mocks.initialPrompt ?? '',
      issueContextEditorOpen: false,
      // 「这一轮带了内容」把待发附件一并算上,所以这份替身也必须有附件。
      attachments: [],
    };
  }
}));

vi.mock('@renderer/features/sessions/session-config/session-state-context', () => ({
  SessionStateProvider: ({ children }: { children: React.ReactNode }) => children
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: mocks.navigate }),
  useParams: () => ({ params: { projectId: mocks.projectId } }),
  // 项目级动作组要知道自己长在哪个视图上:设置齿轮只长在项目页那一排(主页/设置页),
  // 会话页只留「在哪里打开项目」。
  useWorkspaceSlots: () => ({ currentView: mocks.currentView })
}));

vi.mock('@renderer/lib/layout/layout-provider', () => ({
  // 顶栏的左侧槽位让位量读的是侧栏那条动画宽度(motion value),替身也得给一个真的 —— 给个假对象
  // 会在 useTransform 里炸,而炸出来的是「读不到 .get()」这种和布局毫不相干的报错。
  useWorkspaceLayoutContext: () => ({
    isLeftOpen: true,
    isLeftPeeking: false,
    leftAnimatedWidth: motionValue(260),
    setCollapsed: vi.fn(),
    setTriggerHovered: vi.fn()
  })
}));

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useShowModal: () => mocks.showAddProjectModal
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  sidebarStore: mocks,
  appState: {
    navigation: {
      currentViewId: 'home',
      viewParamsStore: {},
      revalidate: vi.fn()
    }
  }
}));

// 项目选择器只列账号上的项目(accountProjectsStore):每个 mocks.orderedProjects 是一个项目(名字 = id),
// 绑在它所在的机器上;`extra` 是另给的(没有文件夹的等)。
vi.mock('@renderer/features/projects/stores/account-projects-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/features/projects/stores/account-projects-store')>();
  const { machineRegistry } = await import('@renderer/lib/machine-routing');
  const { runInAction } = await import('mobx');
  class TestAccounts extends actual.AccountProjectsStore {
    extra: AccountProject[] = [];
    override get projects(): readonly AccountProject[] {
      return [
        ...mocks.orderedProjects.map((project) => ({
          chatId: `chat-${project.id}`, name: project.id, archived: false, activeAt: '2026-01-01T00:00:00.000Z',
          bindings: [{ deviceId: machineRegistry.machineOf(project.id) ?? 'this-computer', localProjectId: project.id }],
        })),
        ...this.extra,
      ];
    }
  }
  const accountProjectsStore = new TestAccounts();
  accountProjectsStore.attach({
    projects: { get: (id: string) => (mocks.orderedProjects.some((project) => project.id === id) ? { createdAt: null } : undefined) } as never,
    machineOf: (id) => machineRegistry.machineOf(id),
    connected: () => true,
  });
  runInAction(() => {
    accountProjectsStore.localDeviceId = 'this-computer';
    accountProjectsStore.status = 'ready';
  });
  return { ...actual, accountProjectsStore };
});

const runMachineCloud = vi.hoisted(() => ({ remember: vi.fn(async () => ({})) }));
vi.mock('@/lib/agentCreateDefaults', () => ({
  readAgentCreateDefaults: async () => ({ deviceId: null, projectByDevice: {}, projectByChat: {}, machineByProject: {} }),
  rememberAgentCreateRunMachine: runMachineCloud.remember,
}));
vi.mock('@renderer/lib/ui/dropdown-menu', () => ({
  DropdownMenuGroup: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuCheckboxItem: ({ children, checked, disabled, onCheckedChange }: { children: React.ReactNode; checked: boolean; disabled?: boolean; onCheckedChange: (checked: boolean) => void }) => React.createElement('button', { role: 'menuitemcheckbox', 'aria-checked': checked, disabled, onClick: () => onCheckedChange(!checked) }, children),
  DropdownMenu: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuSeparator: () => null,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuItem: ({
    children,
    disabled,
    onClick,
    ...props
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    'data-device-id'?: string;
  }) =>
    React.createElement(
      'button',
      { type: 'button', role: 'menuitem', ...props, disabled, onClick: disabled ? undefined : onClick },
      children
    ),
  DropdownMenuSub: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuSubContent: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuSubTrigger: ({ children, ...props }: { children: React.ReactNode }) =>
    React.createElement('button', { type: 'button', role: 'menuitem', ...props }, children),
  DropdownMenuTrigger: ({
    children,
    render,
    ...props
  }: {
    children?: React.ReactNode;
    render?: React.ReactNode;
  }) => render ?? React.createElement('button', props, children)
}));

describe('NewSessionPage', () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    mocks.showAddProjectModal.mockReset();
    mocks.notify.mockReset();
    mocks.dismissNotice.mockReset();
    mocks.orderedProjects = [];
    mocks.createSessionStateProjectId = undefined;
    mocks.createSessionStateOptions = undefined;
    mocks.createSessionCallbackProjectId = undefined;
    mocks.projectType = 'local';
    mocks.projectId = 'project-1';
    mocks.setProjectView.mockReset();
    mocks.navigate.mockReset();
    mocks.currentView = 'project';
    mocks.sessionFieldProps = null;
    mocks.prompt = null;
    mocks.initialPrompt = undefined;
    mocks.onCreated = undefined;
    mocks.handleCreateSession.mockReset();
    composerDrafts.set(NEW_SESSION_DRAFT_KEY, '');
    composerDrafts.set(projectDraftKey('project-1'), '');
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost'
    });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    // 项目级动作(「在哪里打开项目」)里的 Select/Tooltip 会做 instanceof Element / Node 判断。
    vi.stubGlobal('Element', dom.window.Element);
    vi.stubGlobal('Node', dom.window.Node);
    vi.stubGlobal('Event', dom.window.Event);
    // setLocalePreference 会往 window 派发 CustomEvent；用 Node 全局那个会被 jsdom 的 EventTarget 拒收。
    vi.stubGlobal('CustomEvent', dom.window.CustomEvent);
    // 新建会话页的分栏:量分栏区宽度要 `ResizeObserver`、
    // 存宽度要 `localStorage`、弹簧要 rAF;面板里的文件树分栏(react-resizable-panels)还要
    // `DOMRect`。少一个不是断言失败,
    // 是渲染期抛异常、整棵树起不来(实撞:14 条一起红在 `localStorage is not defined`,
    // 修掉又露出 `ResizeObserver is not defined`、库内 `new DOMRect` 的 `n is not a constructor`)。
    // jsdom 除 ResizeObserver 外都有,那一个自己搭。
    vi.stubGlobal('DOMRect', dom.window.DOMRect);
    // 分栏收起/展开走 framer-motion 的弹簧,它在起动画时判 `instanceof SVGElement`。
    vi.stubGlobal('SVGElement', dom.window.SVGElement);
    vi.stubGlobal('localStorage', dom.window.localStorage);
    // jsdom 默认不给 rAF(要开 pretendToBeVisual,那会常驻一条 16ms 定时器循环)。这里只要一个
    // 确定性的 shim:合帧那段逻辑本身不是判据,别为它引进真定时器。
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(Date.now()), 0) as unknown as number
    );
    vi.stubGlobal('cancelAnimationFrame', (handle: number) =>
      clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
    );
    // ⚠️ 装两处。react-resizable-panels 是从**元素所属的 window** 上取这个构造器的
    // (`mountGroup.ts:38`: `group.element.ownerDocument.defaultView.ResizeObserver`),
    // 只 `stubGlobal` 它够不着 —— 报出来是库内一句 `n is not a constructor`,与 ResizeObserver
    // 三个字毫无关系,查了好一会儿。产品自己的代码读的是裸全局,所以两处都要。
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    (dom.window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
    container = dom.window.document.querySelector('#root') as HTMLDivElement;
    root = createRoot(container);
    // 语言必须显式钉住：默认偏好是 `system`，会随宿主的 navigator 语言解析，
    // 下面那些中文断言就会随运行环境时红时绿。
    setLocalePreference('zh-CN');
    mocks.deliveryError = null;
  });

  /** 产品里会话页始终活在 task locale provider 下面，测试也走同一条渲染路径。 */
  // 与生产一样使用共享查询上下文;这个壳只渲染局部子树。
  function localized(...children: React.ReactNode[]) {
    return React.createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      React.createElement(
        SessionLocalizationProvider,
        null,
        ...children
      )
    );
  }

  async function renderPage() {
    await act(async () => {
      root.render(localized(React.createElement(ShellTitlebar), React.createElement(NewSessionPage)));
    });
  }

  // 项目块画的窗口 chrome 与项目首页(app/project-block.tsx)。
  async function renderProjectHome() {
    const projectId = mocks.projectId;
    await act(async () => {
      root.render(
        localized(
          React.createElement(ShellTitlebar),
          React.createElement(
            React.Fragment,
            null,
            React.createElement(ProjectHome, { projectId })
          )
        )
      );
    });
  }

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    dom.window.close();
  });

  it('uses the task composer as the Home view', () => {
    expect(homeView.MainPanel).toBe(NewSessionPage);
    expect(homeView.TitlebarSlot).toBe(ShellTitlebar);
  });

  it('cancelling the task verb carries text back and discards attachments and the old task retry', () => {
    const key = 'cancel-task-draft';
    const draft = composerDrafts.forKey(key);
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    draft.setPrompt('carry these words');
    draft.setPending([{ chip: { id: 'image', name: 'image.png', kind: 'image', previewUrl: 'blob:cancel-task' }, file: new File(['image'], 'image.png') }]);
    draft.setPendingMessage({ projectId: 'project-1', sessionId: 'old-task', clientMessageId: 'old-message', prompt: 'old words', text: 'old words' });
    draft.setDeliveryError({ kind: 'raw', detail: 'old failure' });
    setComposerVerb('chat-cancel', 'task');

    cancelComposerVerb('chat-cancel', key);

    expect(readComposerVerb('chat-cancel')).toBeNull();
    expect(takeComposerCarry('chat-cancel')).toBe('carry these words');
    const reopened = composerDrafts.forKey(key);
    expect(reopened).not.toBe(draft);
    expect(reopened.prompt).toBe('');
    expect(reopened.pending).toEqual([]);
    expect(reopened.pendingMessage).toBeNull();
    expect(reopened.deliveryError).toBeNull();
    expect(revoke.mock.calls.filter(([url]) => url === 'blob:cancel-task')).toHaveLength(1);
    revoke.mockRestore();
  });

  it('keeps the full zero-height shell titlebar available for moving the window', async () => {
    await renderPage();

    const dragRegion = container.querySelector('[data-session-titlebar-drag-region]');
    expect(dragRegion).not.toBeNull();
    expect(dragRegion?.className).toContain('h-10');
    expect(dragRegion?.className).toContain('[-webkit-app-region:drag]');
    expect(dragRegion?.parentElement?.className).toContain('h-0');

    expect(container.querySelector('[data-titlebar-actions]')).toBeNull();
  });

  it.each(['mac', 'win', 'linux'])('keeps new-task tools in the task itself on %s', async (platform) => {
    dom.window.document.documentElement.dataset.platform = platform;
    await renderPage();
    expect(container.querySelector('[data-titlebar-actions]')).toBeNull();
    expect(container.querySelector('[data-testid="new-session-right-panel"]')).toBeNull();
    expect(container.querySelector('[data-panel-resize-handle]')).toBeNull();
  });

  it('uses the shared pre-session shell on the project home', async () => {
    await renderProjectHome();

    // #7341 首页上面是这个项目的文件夹卡(项目名在卡面上);那句「我们应该在…」挪进了输入框当提示。
    const card = container.querySelector('[data-testid="project-folder-card"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('project-1');
    expect(container.querySelector('h1.gg-type-page-title')).toBeNull();
    // 这里没有宿主通道:读不到文件夹就照实说读不到,❌ 拿根目录冒充、❌ 整页崩掉。
    expect(card?.textContent).toContain('读不到这个项目的文件夹');
    expect(mocks.createSessionStateOptions).toEqual({
      requireGeneratedName: true,
      runInProjectDir: true
    });
    // 项目是一块之后(gugu-dev#181):项目级动作在项目块的页签条上,首页自己不再浮一排顶栏;
    // 「+」只列群文件夹和 App,终端、浏览器归会话 ⇒ 首页没有发第一句之前的草稿工作区。
    expect(container.querySelector('[data-page-title-actions]')).toBeNull();
    expect(container.querySelector('[data-testid="new-session-right-panel"]')).toBeNull();
  });

  const deliveryFailure: SessionFailure = { kind: 'provision-timeout', timeoutMs: 30000 };

  it('reports a delivery failure through the shared notice outlet on the session composer', async () => {
    mocks.deliveryError = deliveryFailure;
    await renderPage();
    expect(container.querySelector('[data-testid="create-delivery-error"]')).toBeNull();
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      key: expect.stringMatching(/^session-create:/), tier: 'error', ongoing: true,
      title: expect.not.stringContaining('taskError.'),
    }));
  });

  it('uses the original failed Codex target to share its catalog notice key', async () => {
    mocks.deliveryError = { kind: 'raw', detail: 'local Codex app-server exited (code=1 signal=null)', target: { machineId: 'original-machine', leg: 'acp' } };
    await renderPage();
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ key: 'session-catalog:original-machine:codex:acp' }));
    expect(JSON.stringify(mocks.notify.mock.calls)).not.toMatch(/app-server|code=1|signal=null/);
  });

  it('reports a delivery failure through the same outlet on the project composer', async () => {
    mocks.deliveryError = deliveryFailure;
    await renderProjectHome();
    expect(container.querySelector('[data-testid="create-delivery-error"]')).toBeNull();
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      key: expect.stringMatching(/^session-create:/), tier: 'error', ongoing: true,
      title: expect.not.stringContaining('taskError.'),
    }));
  });

  it('stays silent while nothing has failed', async () => {
    await renderProjectHome();

    expect(container.querySelector('[data-testid="create-delivery-error"]')).toBeNull();
  });

  it('keeps the window drag region for a session with no user project', async () => {
    mocks.projectId = IMPLICIT_SESSION_HOME_PROJECT_ID;
    await renderProjectHome();

    expect(container.querySelector('button[aria-label="项目设置"]')).toBeNull();
    // The shared window drag region remains available without project actions.
    expect(container.querySelector('[data-session-titlebar-drag-region]')).not.toBeNull();
  });

  it('keeps concrete-session empty states and tab menus on the same contextual order', () => {
    // owner 2026-08-21:未绑项目(隐式 task-home)不再削清单 —— 两种上下文给同一张单子。
    expect(getSessionWorkspaceActionOrder()).toEqual([
      'side-session',
      'review',
      'terminal',
      'browser'
    ]);
  });

  it('别的机器上的会话:清单与本机同序同项(外加端口);远程隧道的机器终端 / 浏览器 / 端口灰着,❌ 从清单里删', () => {
    // owner 2026-09-25:「完整能力披露懂不懂」。
    const remote = (direct: boolean) =>
      ({
        machine: { kind: 'remote', deviceId: direct ? 'ssh-box' : 'tunnel-box', label: () => 'box' },
        terminal: { available: direct },
        browser: { available: direct }
      }) as unknown as WorkspaceBackend;
    const off = registerWorkspaceBackend((projectId) =>
      projectId === 'on-tunnel' ? remote(false) : projectId === 'on-ssh' ? remote(true) : null
    );
    try {
      const full = ['side-session', 'review', 'terminal', 'browser', 'ports'];
      expect(getSessionWorkspaceActionOrder('on-tunnel')).toEqual(full);
      expect(getSessionWorkspaceActionOrder('on-ssh')).toEqual(full);
      expect(full.filter((id) => sessionWorkspaceActionBlocked('on-tunnel', id as never))).toEqual([
        'terminal',
        'browser',
        'ports'
      ]);
      expect(full.filter((id) => sessionWorkspaceActionBlocked('on-ssh', id as never))).toEqual([]);
      expect(sessionWorkspaceActionBlocked(undefined, 'terminal')).toBeNull();
    } finally {
      off();
    }
  });

  // #2569 the sample's first message, handed to the project it became: the person already pressed send in the sample.
  it('sends a handed-over draft once, as soon as the box can; not again, and not after the person edits it', async () => {
    const key = projectDraftKey('project-1');
    const draft = composerDrafts.forKey(key);
    const handoff = {
      hiddenContext: 'the sample context',
      picked: { provider: 'codex' as const, model: null, platformModel: null, effort: null, permissionMode: 'full-access' as const, sessionView: 'general' as const },
      sendWhenReady: true,
    };
    try {
      draft.setPrompt('周六下雨怎么办');
      draft.setHandoff(handoff);
      await act(async () => root.render(localized(React.createElement(NewSessionComposer, { projectId: 'project-1', draftKey: key }))));
      expect(mocks.handleCreateSession).toHaveBeenCalledOnce();
      expect(draft.handoff).toMatchObject({ hiddenContext: 'the sample context', sendWhenReady: false });
      await act(async () => root.render(localized(React.createElement(NewSessionComposer, { projectId: 'project-1', draftKey: key, placeholder: 'again' }))));
      expect(mocks.handleCreateSession).toHaveBeenCalledOnce();

      draft.setHandoff({ ...handoff, sendWhenReady: true });
      draft.setPrompt('周日下雨怎么办');
      expect(draft.handoff?.sendWhenReady, 'the person took it over').toBe(false);
    } finally { composerDrafts.discard(key); }
  });

  // #2589 review 3: the sample's box can still be mounted for a render after its draft moved to the project; it must not take
  // the hand-off (it has no project to create the task in) — the project's box sends it.
  it('a box with no project never auto-sends a handed-over draft: the project box it was handed to does', async () => {
    const send = vi.fn();
    const draft = composerDrafts.forKey('sample-test');
    try {
      draft.setPrompt('周六下雨怎么办');
      draft.setHandoff({
        hiddenContext: 'the sample context',
        picked: { provider: 'codex', model: null, platformModel: null, effort: null, permissionMode: 'full-access', sessionView: 'general' },
        sendWhenReady: true,
      });
      await act(async () => root.render(localized(React.createElement(NewSessionComposer, { projectId: undefined, draftKey: 'sample-test', sendWithoutProject: send }))));
      expect(mocks.sessionFieldProps?.canSubmit).toBe(true);
      expect(mocks.handleCreateSession).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(draft.handoff?.sendWhenReady, 'left for the project box').toBe(true);
    } finally { composerDrafts.discard('sample-test'); }
  });

  it('with no project yet, sending goes to sendWithoutProject (an agent picked, words written); blocked holds it', async () => {
    const send = vi.fn();
    mocks.prompt = '周六下雨怎么办';
    try {
      await act(async () => root.render(localized(React.createElement(NewSessionComposer, { projectId: undefined, draftKey: 'sample-test', sendWithoutProject: send }))));
      expect(mocks.sessionFieldProps?.canSubmit).toBe(true);
      act(() => mocks.sessionFieldProps?.onSubmit?.());
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ provider: 'codex', prompt: '周六下雨怎么办' }));
      expect(mocks.handleCreateSession).not.toHaveBeenCalled();
      await act(async () => root.render(localized(React.createElement(NewSessionComposer, { projectId: undefined, draftKey: 'sample-test', sendWithoutProject: send, blocked: true }))));
      expect(mocks.sessionFieldProps?.canSubmit).toBe(false);
    } finally { composerDrafts.discard('sample-test'); }
  });

  it('keeps an editable, projectless composer when no project exists', async () => {
    await renderPage();

    // Owner-approved task naming (#563), already synchronized by #573.
    expect(container.textContent).toContain('新建任务');
    expect(container.textContent).not.toContain('新建会话');
    expect(container.textContent).toContain('未选择项目');
    expect(container.querySelector('[data-testid="active-task-composer"]')).not.toBeNull();
    expect(mocks.createSessionStateProjectId).toBe('implicit-task-home');
    expect(mocks.createSessionCallbackProjectId).toBe('implicit-task-home');
    expect(container.textContent).not.toContain('Open project');
    expect(container.textContent).not.toContain('Create repository');
    expect(container.textContent).toContain('不使用项目');
    expect(container.textContent).toContain('新建项目');
    expect(container.textContent).toContain('新建空白项目');
    expect(container.textContent).toContain('使用现有文件夹');
  });

  // #7341 项目首页点中的文件夹 = 新会话从哪开工:它的 workspaceId 必须交到建会话那一步,缺省才落回项目根目录。
  it('starts the new session in the folder the project home picked', async () => {
    await act(async () => {
      root.render(localized(React.createElement(NewSessionComposer, { projectId: 'project-1', workspaceId: 'ws-attached' })));
    });
    expect(mocks.createSessionStateWorkspaceId).toBe('ws-attached');

    await act(async () => {
      root.render(localized(React.createElement(NewSessionComposer, { projectId: 'project-1' })));
    });
    // 没选 = 项目根目录(这里的 git 上下文桩给的根目录是 null)。
    expect(mocks.createSessionStateWorkspaceId).toBeNull();
  });

  it('draws the shared machine picker (compact size) in the composer tray', async () => {
    await renderPage();
    const picker = container.querySelector('[data-testid="composer-device-picker"]');
    expect(picker).not.toBeNull();
    expect(picker?.getAttribute('data-size')).toBe('compact');
    // 默认这台电脑:电脑图标 + 名字「这台电脑」(托盘里各处同一个叫法)。
    expect(picker?.getAttribute('data-selected-id')).toBe('local');
    expect(picker?.textContent).toContain('这台电脑');
    expect(picker?.querySelector('[data-kind="computer"]')).not.toBeNull();
  });

  it('keeps offline task composer device rows visible but disabled', async () => {
    const onSelect = vi.fn();
    await act(async () => {
      root.render(localized(React.createElement(MachinePicker, {
        size: 'compact',
        machines: [
          { id: 'device-online', label: 'Mac Studio', isLocal: false, isOnline: true },
          { id: 'device-offline', label: 'MacBook', isLocal: false, isOnline: false },
        ],
        selectedId: 'device-online',
        onSelect,
      })));
    });

    const online = container.querySelector('[data-device-id="device-online"]') as HTMLButtonElement;
    const offline = container.querySelector('[data-device-id="device-offline"]') as HTMLButtonElement;
    expect(online).not.toBeNull();
    expect(offline).not.toBeNull();
    expect(offline.disabled).toBe(true);
    await act(async () => offline.click());
    expect(onSelect).not.toHaveBeenCalled();
    await act(async () => online.click());
    expect(onSelect).toHaveBeenCalledWith('device-online');
  });

  it('新建页写了一半:切去某条会话(整页卸载)再点新建,写好的话还在;发送成功后不留', async () => {
    mocks.prompt = '写了一半的首句';
    await renderPage();
    await act(async () => root.render(localized()));

    mocks.prompt = null;
    await renderPage();
    expect(mocks.initialPrompt).toBe('写了一半的首句');

    await act(async () => composerDrafts.forKey(NEW_SESSION_DRAFT_KEY).take());
    await act(async () => mocks.onCreated?.({ projectId: 'implicit-task-home', sessionId: 'session-1' }));
    await act(async () => root.render(localized()));
    await renderPage();
    expect(mocks.initialPrompt).toBe('');
  });

  it('新建页与项目页各暂存各的:新建页的草稿不出现在项目页', async () => {
    mocks.prompt = '新建页的草稿';
    await renderPage();
    await act(async () => root.render(localized()));

    mocks.prompt = null;
    await renderProjectHome();
    expect(mocks.initialPrompt).toBe('');
    await act(async () => root.render(localized()));
    await renderPage();
    expect(mocks.initialPrompt).toBe('新建页的草稿');
  });

  it('keeps project selection optional when a project is mounted', async () => {
    mocks.orderedProjects = [{ id: 'project-1', state: 'mounted' }];

    await renderPage();

    expect(container.textContent).toContain('未选择项目');
    expect(container.querySelector('[data-testid="active-task-composer"]')).not.toBeNull();
    expect(mocks.createSessionStateProjectId).toBe('implicit-task-home');
    expect(mocks.createSessionCallbackProjectId).toBe('implicit-task-home');
    expect(container.textContent).toContain('project-1');
  });

  it('classifies a selected project task under that project instead of the standalone section', async () => {
    mocks.orderedProjects = [{ id: 'project-1', state: 'mounted' }];
    await renderPage();

    const projectItem = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'project-1'
    );
    await act(async () => projectItem?.click());

    expect(mocks.createSessionStateProjectId).toBe('project-1');
    expect(mocks.createSessionCallbackProjectId).toBe('project-1');
    expect(mocks.navigate).toHaveBeenCalledWith('project', { projectId: 'project-1' });
  });

  it('选择项目进入项目首页,带上已输入的首句', async () => {
    mocks.orderedProjects = [{ id: 'project-1', state: 'mounted' }];
    mocks.prompt = '继续实现这一段';
    await renderPage();
    const projectItem = Array.from(container.querySelectorAll('[role="menuitem"]')).find(
      (item) => item.textContent?.trim() === 'project-1'
    ) as HTMLButtonElement;
    expect(projectItem).toBeDefined();
    await act(async () => projectItem.click());
    expect(mocks.navigate).toHaveBeenCalledWith('project', { projectId: 'project-1' });
    await act(async () => root.render(localized()));
    mocks.prompt = null;
    await renderProjectHome();
    expect(mocks.initialPrompt).toBe('继续实现这一段');
    expect(container.querySelector('[data-testid="project-folder-card"]')).not.toBeNull();
  });

  // #2412 review ①: picking a folder on a machine without one selects that machine only once the folder is attached.
  it('keeps the current machine when attaching a folder on another machine fails', async () => {
    const pickable = vi.spyOn(remoteHostsStore, 'pickableMachineIds').mockReturnValue(['device-9']);
    const pickFolder = vi.spyOn(remoteHostsStore, 'pickFolder').mockResolvedValue('/srv/someone-elses-project');
    const device = vi.spyOn(remoteHostsStore, 'device').mockImplementation((id) => (id === 'device-9' ? { id, label: 'd9', hostKind: 'server', isOnline: true, lastSeenAt: null } as never : null));
    const connection = vi.spyOn(remoteHostsStore, 'connectionState').mockImplementation((id) => (id === 'device-9' ? 'connected' : 'offline') as never);
    mocks.orderedProjects = [{ id: 'project-1', state: 'mounted' }];
    try {
      runMachineCloud.remember.mockClear();
      await renderProjectHome();
      const picker = () => container.querySelector('[data-testid="composer-device-picker"]');
      expect(picker()?.getAttribute('data-selected-id')).toBe('local');
      const elsewhere = container.querySelector('[data-testid="composer-device-picker-elsewhere"] [data-device-id="device-9"]') as HTMLButtonElement;
      expect(elsewhere).not.toBeNull();
      // That machine cannot say what the folder is (no connection here): the attach plan fails, nothing is attached.
      await act(async () => { elsewhere.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(pickFolder).toHaveBeenCalledWith('device-9', '~');
      expect(picker()?.getAttribute('data-selected-id')).toBe('local');
      expect(runMachineCloud.remember).not.toHaveBeenCalled();
    } finally {
      pickable.mockRestore();
      pickFolder.mockRestore();
      device.mockRestore();
      connection.mockRestore();
    }
  });

  // #2412 review ②: a machine picked on New task goes with the project only when it holds that project's folder.
  // Architecture review ④: it is handed to the project block that opens next, not written to the account settings —
  // those are written when a task is actually created on it.
  it('hands the machine picked first to the project block only for a project that has a folder there, remembering nothing', async () => {
    machineRegistry.register('device-9', ['project-remote']);
    mocks.orderedProjects = [{ id: 'project-1', state: 'mounted' }, { id: 'project-remote', state: 'mounted' }];
    remoteHostsStore.requestNewSession('device-9');
    const { resetRunMachineMemoryForTest, useProjectRunMachine } = await import('@renderer/features/projects/components/main-panel/project-run-machine');
    const runMachineOf = async (projectId: string) => {
      let machine: string | null | undefined;
      const Probe = () => {
        machine = useProjectRunMachine(projectId, [{ key: 'local', online: true }, { key: 'device-9', online: true }], `chat-${projectId}`).machine;
        return null;
      };
      await act(async () => root.render(React.createElement(Probe)));
      return machine;
    };
    try {
      runMachineCloud.remember.mockClear();
      await renderPage();
      const pick = (name: string) => Array.from(container.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent?.trim() === name) as HTMLButtonElement;
      await act(async () => pick('project-1').click());
      expect(await runMachineOf('project-1')).toBeNull();
      // The probe replaced the page in this root; the page opens again with the machine picked first.
      remoteHostsStore.requestNewSession('device-9');
      await renderPage();
      await act(async () => pick('project-remote').click());
      expect(await runMachineOf('project-remote')).toBe('device-9');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(runMachineCloud.remember).not.toHaveBeenCalled();
    } finally {
      resetRunMachineMemoryForTest();
      machineRegistry.forgetMachine('device-9');
    }
  });

  // 项目与机器解耦:账号上一个文件夹都没有的项目也列出来(identity.list_my_projects),› 里是给它挂第一个文件夹的机器。
  it('lists an account project that has no folder on any machine, with machines to give it one', async () => {
    const { accountProjectsStore } = await import('@renderer/features/projects/stores/account-projects-store');
    (accountProjectsStore as unknown as { extra: AccountProject[] }).extra = ([
      { chatId: 'chat-empty', name: 'paper', archived: false, activeAt: '2026-01-01T00:00:00.000Z', bindings: [] },
      { chatId: 'chat-old', name: 'retired', archived: true, activeAt: '2026-01-01T00:00:00.000Z', bindings: [] },
      { chatId: 'chat-bound', name: 'bound', archived: false, activeAt: '2026-01-01T00:00:00.000Z', bindings: [{ deviceId: 'd', localProjectId: 'p' }] },
    ]);
    try {
      mocks.orderedProjects = [{ id: 'project-1', state: 'mounted' }];
      await renderPage();
      const folderless = Array.from(container.querySelectorAll('[data-testid="folderless-project"]'));
      // No folder anywhere, or a folder only on a machine that is not loaded here: both bind a first folder (›); archived ones are not listed.
      expect(folderless.map((item) => item.textContent?.trim())).toEqual(['paper', 'bound']);
      expect(folderless[0]?.getAttribute('data-chat-id')).toBe('chat-empty');
    } finally {
      (accountProjectsStore as unknown as { extra: AccountProject[] }).extra = [];
    }
  });

  it('项目已有草稿时保留它,全局首句也仍在', async () => {
    composerDrafts.set(projectDraftKey('project-1'), '项目原来的草稿');
    mocks.orderedProjects = [{ id: 'project-1', state: 'mounted' }];
    mocks.prompt = '全局草稿';
    await renderPage();
    const projectItem = Array.from(container.querySelectorAll('[role="menuitem"]')).find(
      (item) => item.textContent?.trim() === 'project-1'
    ) as HTMLButtonElement;
    await act(async () => projectItem.click());
    expect(composerDrafts.get(projectDraftKey('project-1'))).toBe('项目原来的草稿');
    expect(composerDrafts.get(NEW_SESSION_DRAFT_KEY)).toBe('全局草稿');
  });

  it('从项目页切回不使用项目,带上该项目首句', async () => {
    mocks.prompt = '暂时脱离项目处理';
    await renderProjectHome();
    const skip = Array.from(container.querySelectorAll('[role="menuitem"]')).find(
      (item) => item.textContent?.trim() === '不使用项目'
    ) as HTMLButtonElement;
    expect(skip).toBeDefined();
    await act(async () => skip.click());
    expect(mocks.navigate).toHaveBeenCalledWith('new-session');
    await act(async () => root.render(localized()));
    mocks.prompt = null;
    await renderPage();
    expect(mocks.initialPrompt).toBe('暂时脱离项目处理');
    expect(mocks.createSessionCallbackProjectId).toBe('implicit-task-home');
  });

  // owner 2026-10-19:项目跨设备,设备选择圈定范围;具体执行设备跟随所选文件夹。
  it('项目页共用新建托盘,机器是「在哪台跑」的单选,默认本机(有文件夹)', async () => {
    mocks.orderedProjects = [
      { id: 'project-1', state: 'mounted' },
      { id: 'project-2', state: 'mounted' }
    ];
    await renderProjectHome();
    expect(container.querySelector('[data-testid="composer-device-picker"]')?.getAttribute('data-selected-id')).toBe('local');
    expect(container.querySelector('[data-testid="composer-device-picker"]')?.textContent).toContain('这台电脑');
    // 项目预选这一个;这一页就是它的,没有「未选择项目」。
    expect(container.textContent).not.toContain('未选择项目');
    expect(mocks.createSessionCallbackProjectId).toBe('project-1');
    expect(container.querySelector('[data-testid="active-task-composer"]')).not.toBeNull();

    // 换一个项目 = 去那个项目的页面。
    const other = Array.from(container.querySelectorAll('[role="menuitem"]')).find(
      (item) => item.textContent?.trim() === 'project-2'
    ) as HTMLButtonElement;
    await act(async () => other.click());
    expect(mocks.navigate).toHaveBeenCalledWith('project', { projectId: 'project-2' });
  });

  it('项目页可切换只有远端文件夹的项目,在哪台跑如实标离线', async () => {
    // 产品里别的机器的项目只经远程主机那座桥登记进来;桥在、那台机器连不上(开线一直不回)= 离线。
    const removeBridge = installRemoteHostsBridge({
      openSessionHost: () => () => new Promise(() => {}),
      listDevices: () => [],
      subscribeDevices: () => () => {},
    } as unknown as RemoteHostsBridge);
    machineRegistry.register('device-9', ['project-remote']);
    mocks.projectId = 'project-remote';
    mocks.orderedProjects = [{ id: 'project-remote', state: 'mounted' }, { id: 'project-1', state: 'mounted' }];
    try {
      await renderProjectHome();
      // 项目与机器解耦:托盘上是「在哪台跑」的选择器,默认选有这个项目文件夹的那台(只有 device-9 有)。
      expect(container.querySelector('[data-testid="composer-device-picker"]')?.getAttribute('data-selected-id')).toBe('device-9');
      expect(container.textContent).toContain('离线');
      // 那台机器用不了:输入框下面没有行内字(它一变输入框就动),原因在统一提示条里说,发送照样挡住。
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ key: 'machine:device-9', tier: 'error', ongoing: true }));
      expect(mocks.sessionFieldProps?.canSubmit).toBe(false);
      const projects = Array.from(container.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent?.trim());
      expect(projects).toContain('project-remote');
      expect(projects).toContain('project-1');
    } finally {
      machineRegistry.forgetMachine('device-9');
      removeBridge();
    }
  });

  it('本机的「新建空白项目」照旧建在本机', async () => {
    await act(async () => {
      root.render(localized(React.createElement(ComposerProjectPicker, { selectedId: undefined, onSelect: vi.fn() })));
    });
    await act(async () =>
      (container.querySelector('[data-testid="project-create-blank"]') as HTMLButtonElement).click()
    );
    expect(mocks.showAddProjectModal).toHaveBeenCalledWith(expect.objectContaining({ machine: null }));
  });

  // 项目与机器解耦:选择器只列 accountProjectsStore 里的项目 —— 本机有文件夹的、哪台上都没有文件夹的、文件夹只在一台离线机器上的。
  it('lists exactly the account projects: a folder here, no folder anywhere, a folder only on an offline machine', async () => {
    const { accountProjectsStore } = await import('@renderer/features/projects/stores/account-projects-store');
    const onSelect = vi.fn();
    machineRegistry.register('device-off', ['project-offline']);
    mocks.orderedProjects = [{ id: 'project-1', state: 'mounted' }, { id: 'project-offline', state: 'mounted' }];
    (accountProjectsStore as unknown as { extra: AccountProject[] }).extra = [{ chatId: 'chat-empty', name: 'paper', archived: false, activeAt: '2026-01-01T00:00:00.000Z', bindings: [] }];
    try {
      await act(async () => {
        root.render(localized(React.createElement(ComposerProjectPicker, { selectedId: undefined, onSelect })));
      });
      const listed = Array.from(container.querySelectorAll('[data-chat-id]'));
      expect(listed.map((item) => [item.getAttribute('data-chat-id'), item.textContent?.trim()])).toEqual([
        ['chat-project-1', 'project-1'],
        ['chat-project-offline', 'project-offline'],
        ['chat-empty', 'paper'],
      ]);
      expect(listed[2]?.getAttribute('data-testid')).toBe('folderless-project');
      await act(async () => (listed[1] as HTMLButtonElement).click());
      expect(onSelect).toHaveBeenCalledWith('project-offline');
    } finally {
      act(() => {
        machineRegistry.forgetMachine('device-off');
        (accountProjectsStore as unknown as { extra: AccountProject[] }).extra = [];
      });
    }
  });

  it('shows the read error with a retry above the last list when the account projects cannot be read', async () => {
    const { accountProjectsStore } = await import('@renderer/features/projects/stores/account-projects-store');
    mocks.orderedProjects = [{ id: 'project-1', state: 'mounted' }];
    const { runInAction } = await import('mobx');
    runInAction(() => { accountProjectsStore.status = 'error'; });
    try {
      await act(async () => {
        root.render(localized(React.createElement(ComposerProjectPicker, { selectedId: undefined, onSelect: vi.fn() })));
      });
      expect(container.querySelector('[data-testid="account-projects-error"]')).not.toBeNull();
      // The list is the same source's last read (as in the sidebar), not a local stitch: it stays under the error line.
      expect([...container.querySelectorAll('[data-chat-id]')].map((row) => row.getAttribute('data-chat-id'))).toEqual(['chat-project-1']);
    } finally {
      act(() => runInAction(() => { accountProjectsStore.status = 'ready'; }));
    }
  });


});

describe('remoteInstallNote(#6264 别的机器上没装的家:建会话时那边当场装)', () => {
  const translate = ((key: string, values?: Record<string, unknown>) => {
    const table: Record<string, string> = {
      'remoteHost.installOnCreate': '{agent} 还没装在 {device} 上 —— 发送后会先在那台机器上装好,再开会话。',
      'remoteHost.installing': '正在 {device} 上安装 {agent}…',
      'remoteHost.installingDetail': '正在 {device} 上安装 {agent} · {progress}',
      'agentsPage.phaseDownloading': '下载中',
    };
    return (table[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? ''));
  }) as never;
  const gemini = { id: 'gemini', name: 'Gemini CLI', reading: 'not-detected' };

  it('选了那边没装的:说发送后会先在那台机器上装', () => {
    expect(remoteInstallNote(gemini, 'd22', null, translate)?.text).toBe('Gemini CLI 还没装在 d22 上 —— 发送后会先在那台机器上装好,再开会话。');
  });

  it('那边装着的:什么都不说', () => {
    expect(remoteInstallNote({ ...gemini, reading: 'installed' }, 'd22', null, translate)).toBeNull();
  });

  it('发送后在装:先说在装,有读数就接上真实进度与比例', () => {
    expect(remoteInstallNote(gemini, 'd22', { harness: 'gemini', progress: null }, translate)).toEqual({
      text: '正在 d22 上安装 Gemini CLI…',
      ratio: null,
    });
    const note = remoteInstallNote(
      gemini,
      'd22',
      { harness: 'gemini', progress: { providerId: 'gemini', phase: 'downloading', bytesDone: 1024 * 1024, bytesTotal: 4 * 1024 * 1024, elapsedMs: 800 } },
      translate
    );
    expect(note?.text).toContain('正在 d22 上安装 Gemini CLI · 下载中');
    expect(note?.ratio).toBeCloseTo(0.25);
  });
});
