// @vitest-environment jsdom
// GUYI-AI/gugu#2548 the top and the foot of the sidebar as one list: which controls show and which existing action each runs.
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  open: true,
  view: 'home',
  toggleLeft: vi.fn(),
  setCollapsed: vi.fn(),
  navigate: vi.fn(),
  back: vi.fn(),
  canGoBack: true,
  dispatch: vi.fn((_id: string) => true),
  request: vi.fn(),
  /** `interface.sidebarCollapseHintRetired` as read (undefined = settings not read yet). */
  retired: false as boolean | undefined,
  update: vi.fn(),
  notificationsOpen: false,
}));
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({ translate: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key) }),
}));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: (key: string) =>
    key === 'interface'
      ? { value: state.retired === undefined ? undefined : { sidebarCollapseHintRetired: state.retired }, update: state.update }
      : { value: undefined },
}));
vi.mock('@renderer/lib/hooks/useKeyboardShortcuts', () => ({ getEffectiveHotkey: (id: string) => (id === 'app.toggleLeftSidebar' ? 'Mod+Shift+S' : null) }));
vi.mock('@renderer/lib/ui/shortcut-format', () => ({ formatHotkeyText: (hotkey: string) => `[${hotkey}]` }));
vi.mock('@renderer/lib/layout/layout-provider', () => ({
  SIDEBAR_PROGRESS_VAR: '--gg-sidebar-progress',
  useWorkspaceLayoutContext: () => ({ isLeftOpen: state.open, toggleLeft: state.toggleLeft, setCollapsed: state.setCollapsed }),
}));
// The task page's own back (the back button, Mod+[, the window's ←).
vi.mock('@renderer/lib/components/nav-buttons', () => ({ navigateBack: state.back }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { history: { get canGoBack() { return state.canGoBack; } } } }));
// jsdom has no IntersectionObserver: the foot counts as on screen whenever the bubble asks.
vi.mock('@/components/chat/useConversationVisibility', async () => {
  const { useRef } = await import('react');
  return { useConversationVisibility: (requested: boolean) => ({ ref: useRef(null), shown: requested }) };
});
vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: state.navigate }),
  useWorkspaceSlots: () => ({ currentView: state.view }),
  isCurrentView: (current: string, target: string) => current === target,
}));
vi.mock('@renderer/lib/commands/registry', () => ({ commandRegistry: { dispatch: state.dispatch } }));
// The group itself (新建空白项目 / 使用现有文件夹 / 使用远程文件夹) is the old sidebar's, tested where it lives.
vi.mock('./add-project-menu-items', () => ({ AddProjectMenuItems: () => <div data-testid="add-project-menu-items" /> }));
vi.mock('@/lib/sidebarChatsBridge', () => ({ requestShellChatAction: state.request, useSidebarNotificationsOpen: () => state.notificationsOpen }));
// The tooltip's text is what matters here; Base UI draws it only on hover.
vi.mock('@/components/ui/Tooltip', () => ({ Hint: ({ label, children }: { label: string; children: ReactElement }) => <span data-hint={label}>{children}</span> }));

const { SidebarOneListFoot, SidebarOneListTop } = await import('./sidebar-one-list-chrome');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  state.open = true;
  state.view = 'home';
  state.canGoBack = true;
  state.retired = false;
  state.notificationsOpen = false;
  for (const fn of [state.toggleLeft, state.setCollapsed, state.navigate, state.back, state.dispatch, state.request, state.update]) fn.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = (node: ReactElement) => act(async () => root.render(node));
const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const click = (element: HTMLElement) => act(async () => { element.click(); await Promise.resolve(); });

describe('the top: 创建智能体 and the 「+」 menu', () => {
  it('创建智能体 runs what 新建任务 runs (the caller hands it handleNewSession)', async () => {
    const create = vi.fn();
    await render(<SidebarOneListTop collapsed={false} onCreateAgent={create} />);
    const button = q('sidebar-create-agent')!;
    expect(button.textContent).toBe('sidebar.createAgent');
    expect(button.dataset.variant).toBe('primary');
    await click(button);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('the 「+」 menu holds 新建群聊, 新建项目, 添加联系人, in that order, each the existing action', async () => {
    await render(<SidebarOneListTop collapsed={false} onCreateAgent={vi.fn()} />);
    await click(q('sidebar-create-menu')!);
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual(['sidebar.newGroupChat', 'task.projectNew', 'sidebar.addContact']);

    await click(q('sidebar-create-create-group')!);
    expect(state.request).toHaveBeenLastCalledWith('create-group');
    await click(q('sidebar-create-menu')!);
    await click(q('sidebar-create-add-contact')!);
    expect(state.request).toHaveBeenLastCalledWith('add-contact');
    expect(state.request).toHaveBeenCalledTimes(2);
  });

  it('新建项目 opens the old sidebar\'s 「添加项目」 group beside it, ❌ straight into a blank project', async () => {
    await render(<SidebarOneListTop collapsed={false} onCreateAgent={vi.fn()} />);
    await click(q('sidebar-create-menu')!);
    const row = q('sidebar-create-new-project')!;
    expect(row.getAttribute('aria-haspopup')).toBe('menu');
    expect(q('add-project-menu-items')).toBeNull();
    await click(row);
    expect(q('add-project-menu-items')).not.toBeNull();
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.request).not.toHaveBeenCalled();
  });

  it('collapsing moves the 「+」 and narrows 创建智能体 with the open/close progress, ❌ a jump at the start', async () => {
    await render(<SidebarOneListTop collapsed={false} onCreateAgent={vi.fn()} />);
    const top = document.querySelector<HTMLElement>('[data-sidebar-one-list-top]')!;
    // 12px gutter and a 4px gap expanded (progress 1), 20px and no gap on the rail (progress 0): the 「+」 lands on x = 36.
    expect(top.style.paddingInline).toBe('calc(20px - 8px * var(--gg-sidebar-progress, 1))');
    expect(top.style.gap).toBe('calc(4px * var(--gg-sidebar-progress, 1))');
    expect(top.className).not.toMatch(/\b(px-3|pl-5|gap-1)\b/);
    const button = q('sidebar-create-agent')!;
    expect(button.className).toMatch(/\bflex-1\b/);
    expect(button.classList.contains('hidden')).toBe(false);
    expect(button.style.paddingInline).toBe('0px');
    expect(button.hasAttribute('inert')).toBe(false);
  });

  it('collapsed (the rail): the 「+」 stays, 创建智能体 is inert (its width already 0) and leads the 「+」 menu instead', async () => {
    const create = vi.fn();
    await render(<SidebarOneListTop collapsed onCreateAgent={create} />);
    expect(q('sidebar-create-agent')!.hasAttribute('inert')).toBe(true);
    await click(q('sidebar-create-menu')!);
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual(['sidebar.createAgent', 'sidebar.newGroupChat', 'task.projectNew', 'sidebar.addContact']);
    await click(q('sidebar-create-create-agent')!);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('expanded, the 「+」 menu does not repeat 创建智能体 (the button is right there)', async () => {
    await render(<SidebarOneListTop collapsed={false} onCreateAgent={vi.fn()} />);
    await click(q('sidebar-create-menu')!);
    expect(q('sidebar-create-create-agent')).toBeNull();
  });
});

describe('the foot: the collapse button and 会话历史', () => {
  it('collapse: chevrons only, the tooltip says what it does with the shortcut, and it runs the collapse action', async () => {
    await render(<SidebarOneListFoot />);
    const fold = q('sidebar-fold')!;
    expect(fold.textContent).toBe('');
    expect(fold.getAttribute('aria-label')).toBe('sidebar.collapseSidebar');
    expect(fold.closest<HTMLElement>('[data-hint]')!.dataset.hint).toBe('sidebar.collapseSidebar ([Mod+Shift+S])');
    await click(fold);
    expect(state.toggleLeft).toHaveBeenCalledTimes(1);
  });

  it('collapsed, the same button expands; 会话历史 stacks above it, the collapse button stays first (bottom-left)', async () => {
    await render(<SidebarOneListFoot />);
    const foot = document.querySelector<HTMLElement>('[data-sidebar-foot]')!;
    expect(foot.className).toMatch(/\bflex-row\b/);
    expect(foot.firstElementChild!.contains(q('sidebar-fold'))).toBe(true);
    state.open = false;
    await render(<SidebarOneListFoot key="collapsed" />);
    expect(q('sidebar-fold')!.closest<HTMLElement>('[data-hint]')!.dataset.hint).toBe('sidebar.expandSidebar ([Mod+Shift+S])');
    const railFoot = document.querySelector<HTMLElement>('[data-sidebar-foot]')!;
    expect(railFoot.className).toMatch(/\bflex-col-reverse\b/);
    expect(railFoot.className).toMatch(/\bpl-5\b/);
    expect(railFoot.firstElementChild!.contains(q('sidebar-fold'))).toBe(true);
  });

  it('会话历史 toggles: opens the existing 会话历史 page, lit while shown; clicked again it goes back to the view before', async () => {
    await render(<SidebarOneListFoot />);
    const history = q('sidebar-session-history')!;
    expect(history.closest<HTMLElement>('[data-hint]')!.dataset.hint).toBe('sidebar.sessionHistory');
    expect(history.dataset.on).toBeUndefined();
    expect(history.getAttribute('aria-pressed')).toBe('false');
    await click(history);
    expect(state.navigate).toHaveBeenCalledWith('session-history');
    expect(state.back).not.toHaveBeenCalled();
    state.view = 'session-history';
    // The foot is an observer (memoised); the slots hook re-renders it in the app, a new key does here.
    await render(<SidebarOneListFoot key="on-history" />);
    const lit = q('sidebar-session-history')!;
    expect(lit.dataset.on).toBe('true');
    expect(lit.getAttribute('aria-pressed')).toBe('true');
    await click(lit);
    expect(state.back).toHaveBeenCalledWith(true);
    expect(state.navigate).toHaveBeenCalledTimes(1);
  });

  it('the 会话历史 toggle is the same on the rail', async () => {
    state.open = false;
    state.view = 'session-history';
    await render(<SidebarOneListFoot />);
    const history = q('sidebar-session-history')!;
    expect(history.dataset.on).toBe('true');
    await click(history);
    expect(state.back).toHaveBeenCalledTimes(1);
    expect(state.navigate).not.toHaveBeenCalled();
  });
});

describe('C9: the one-time 「侧栏可以收起来」 bubble over the collapse button', () => {
  const bubble = () => q('sidebar-collapse-hint');

  it('does not show before a group or a project is opened', async () => {
    await render(<SidebarOneListFoot />);
    expect(bubble()).toBeNull();
  });

  it('opening one while expanded brings it up: title, body with the product\'s shortcut, 知道了 (secondary) and 收起试试 (primary)', async () => {
    await render(<SidebarOneListFoot openChatId="g1" />);
    const hint = bubble()!;
    expect(hint.textContent).toContain('sidebar.collapseHintTitle');
    expect(hint.textContent).toContain('sidebar.collapseHintBody {"shortcut":"[Mod+Shift+S]"}');
    expect(q('sidebar-collapse-hint-dismiss')!.dataset.variant).toBe('secondary');
    expect(q('sidebar-collapse-hint-try')!.dataset.variant).toBe('primary');
  });

  it('知道了 retires it and stores that', async () => {
    await render(<SidebarOneListFoot openChatId="g1" />);
    await click(q('sidebar-collapse-hint-dismiss')!);
    expect(bubble()).toBeNull();
    expect(state.update).toHaveBeenCalledWith({ sidebarCollapseHintRetired: true });
    expect(state.setCollapsed).not.toHaveBeenCalled();
  });

  it('收起试试 collapses the sidebar and retires it', async () => {
    await render(<SidebarOneListFoot openChatId="g1" />);
    await click(q('sidebar-collapse-hint-try')!);
    expect(state.setCollapsed).toHaveBeenCalledWith('left', true);
    expect(state.update).toHaveBeenCalledWith({ sidebarCollapseHintRetired: true });
  });

  it('a collapse by any other route retires it too, before it ever came up', async () => {
    await render(<SidebarOneListFoot />);
    state.open = false;
    await render(<SidebarOneListFoot openChatId="g1" />);
    expect(state.update).toHaveBeenCalledWith({ sidebarCollapseHintRetired: true });
    state.open = true;
    await render(<SidebarOneListFoot openChatId="g2" />);
    expect(bubble()).toBeNull();
  });

  it('never shows once stored as retired, nor before the settings are read', async () => {
    state.retired = true;
    await render(<SidebarOneListFoot openChatId="g1" />);
    expect(bubble()).toBeNull();
    state.retired = undefined;
    await render(<SidebarOneListFoot key="unread" openChatId="g1" />);
    expect(bubble()).toBeNull();
    expect(state.update).not.toHaveBeenCalled();
  });

  it('a click elsewhere does not close it', async () => {
    await render(<SidebarOneListFoot openChatId="g1" />);
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      document.body.click();
    });
    expect(bubble()).not.toBeNull();
    expect(state.update).not.toHaveBeenCalled();
  });

  it('steps aside while the bell\'s panel replaces the list', async () => {
    state.notificationsOpen = true;
    await render(<SidebarOneListFoot openChatId="g1" />);
    expect(bubble()).toBeNull();
  });
});
