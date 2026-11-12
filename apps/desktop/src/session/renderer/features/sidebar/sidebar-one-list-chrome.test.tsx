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
  navigate: vi.fn(),
  dispatch: vi.fn((_id: string) => true),
  request: vi.fn(),
}));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: undefined }) }));
vi.mock('@renderer/lib/hooks/useKeyboardShortcuts', () => ({ getEffectiveHotkey: (id: string) => (id === 'app.toggleLeftSidebar' ? 'Mod+Shift+S' : null) }));
vi.mock('@renderer/lib/ui/shortcut-format', () => ({ formatHotkeyText: (hotkey: string) => `[${hotkey}]` }));
vi.mock('@renderer/lib/layout/layout-provider', () => ({ useWorkspaceLayoutContext: () => ({ isLeftOpen: state.open, toggleLeft: state.toggleLeft }) }));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: state.navigate }),
  useWorkspaceSlots: () => ({ currentView: state.view }),
  isCurrentView: (current: string, target: string) => current === target,
}));
vi.mock('@renderer/lib/commands/registry', () => ({ commandRegistry: { dispatch: state.dispatch } }));
vi.mock('@/lib/sidebarChatsBridge', () => ({ requestShellChatAction: state.request }));
// The tooltip's text is what matters here; Base UI draws it only on hover.
vi.mock('@/components/ui/Tooltip', () => ({ Hint: ({ label, children }: { label: string; children: ReactElement }) => <span data-hint={label}>{children}</span> }));

const { SidebarOneListFoot, SidebarOneListTop } = await import('./sidebar-one-list-chrome');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  state.open = true;
  state.view = 'home';
  for (const fn of [state.toggleLeft, state.navigate, state.dispatch, state.request]) fn.mockClear();
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
    await click(q('sidebar-create-new-project')!);
    expect(state.dispatch).toHaveBeenLastCalledWith('app.newProject');
    await click(q('sidebar-create-menu')!);
    await click(q('sidebar-create-add-contact')!);
    expect(state.request).toHaveBeenLastCalledWith('add-contact');
    expect(state.request).toHaveBeenCalledTimes(2);
  });

  it('fails loud when 新建项目 has no command to run', async () => {
    state.dispatch.mockReturnValueOnce(false);
    const { runOneListCreateAction } = await import('./sidebar-one-list-chrome');
    expect(() => runOneListCreateAction('new-project')).toThrow(/app.newProject/);
  });

  it('collapsed (the rail): the 「+」 stays, 创建智能体 is not drawn and leads the 「+」 menu instead', async () => {
    const create = vi.fn();
    await render(<SidebarOneListTop collapsed onCreateAgent={create} />);
    expect(q('sidebar-create-agent')!.className).toMatch(/\bhidden\b/);
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
    expect(fold.getAttribute('aria-label')).toBe('task.collapseSidebar');
    expect(fold.closest<HTMLElement>('[data-hint]')!.dataset.hint).toBe('task.collapseSidebar ([Mod+Shift+S])');
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
    expect(q('sidebar-fold')!.closest<HTMLElement>('[data-hint]')!.dataset.hint).toBe('task.expandSidebar ([Mod+Shift+S])');
    const railFoot = document.querySelector<HTMLElement>('[data-sidebar-foot]')!;
    expect(railFoot.className).toMatch(/\bflex-col-reverse\b/);
    expect(railFoot.className).toMatch(/\bpl-5\b/);
    expect(railFoot.firstElementChild!.contains(q('sidebar-fold'))).toBe(true);
  });

  it('会话历史 opens the existing 会话历史 page and is lit while it is shown', async () => {
    await render(<SidebarOneListFoot />);
    const history = q('sidebar-session-history')!;
    expect(history.closest<HTMLElement>('[data-hint]')!.dataset.hint).toBe('sidebar.sessionHistory');
    expect(history.dataset.on).toBeUndefined();
    await click(history);
    expect(state.navigate).toHaveBeenCalledWith('session-history');
    state.view = 'session-history';
    // The foot is an observer (memoised); the slots hook re-renders it in the app, a new key does here.
    await render(<SidebarOneListFoot key="on-history" />);
    expect(q('sidebar-session-history')!.dataset.on).toBe('true');
  });
});
