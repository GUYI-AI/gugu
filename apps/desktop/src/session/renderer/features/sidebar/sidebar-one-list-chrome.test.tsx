// @vitest-environment jsdom
// GUYI-AI/gugu#2548 the head and the top of the sidebar as one list: which controls show and which existing action each runs.
import { act, useSyncExternalStore, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_SESSION_ENGINE_LABEL } from '@shared/core/session-import/session-import';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let version = 0;
  return {
    open: true,
    view: 'home',
    locale: 'zh-CN',
    toggleLeft: (() => {}) as () => void,
    navigate: (() => {}) as (view: string) => void,
    back: (() => {}) as (canGoBack: boolean) => void,
    canGoBack: true,
    dispatch: (() => true) as (id: string) => boolean,
    request: (() => {}) as (action: string) => void,
    /** `interface.sidebarIntro` as read (undefined = settings not read yet). */
    intro: 'collapse' as string | undefined,
    update: (() => {}) as (partial: { sidebarIntro?: string }) => void,
    notificationsOpen: false,
    touring: false,
    /** What the bubble's Root was handed (the popover itself is replaced below). */
    onOpenChange: undefined as undefined | ((open: boolean, details: unknown) => void),
    /** A change to the layout, the settings or the bell, seen by the mounted head (as the real hooks would). */
    emit() {
      version += 1;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
  };
});
state.toggleLeft = vi.fn();
state.navigate = vi.fn();
state.back = vi.fn();
state.dispatch = vi.fn(() => true);
state.request = vi.fn();
// The stored value moves with the write, as the settings cache does (optimistically).
state.update = vi.fn((partial: { sidebarIntro?: string }) => {
  if (partial.sidebarIntro) state.intro = partial.sidebarIntro;
  state.emit();
});
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({
    locale: state.locale,
    translate: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  }),
}));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: (key: string) => {
    useSyncExternalStore(state.subscribe, state.version);
    return key === 'interface'
      ? { value: state.intro === undefined ? undefined : { sidebarIntro: state.intro }, update: state.update }
      : { value: undefined };
  },
}));
vi.mock('@renderer/lib/hooks/useKeyboardShortcuts', () => ({ getEffectiveHotkey: (id: string) => (id === 'app.toggleLeftSidebar' ? 'Mod+Shift+S' : null) }));
vi.mock('@renderer/lib/ui/shortcut-format', () => ({ formatHotkeyText: (hotkey: string) => `[${hotkey}]` }));
vi.mock('@renderer/lib/layout/layout-provider', () => ({
  SIDEBAR_PROGRESS_VAR: '--gg-sidebar-progress',
  useWorkspaceLayoutContext: () => {
    useSyncExternalStore(state.subscribe, state.version);
    return { isLeftOpen: state.open, toggleLeft: state.toggleLeft };
  },
}));
// The task page's own back (the back button, Mod+[, the window's ←).
vi.mock('@renderer/lib/components/nav-buttons', () => ({ navigateBack: state.back }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { history: { get canGoBack() { return state.canGoBack; } } } }));
// jsdom has no IntersectionObserver: the head counts as on screen whenever the bubble asks.
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
vi.mock('@/lib/sidebarChatsBridge', () => ({
  requestShellChatAction: state.request,
  useSidebarNotificationsOpen: () => {
    useSyncExternalStore(state.subscribe, state.version);
    return state.notificationsOpen;
  },
  useProductTourOnScreen: () => {
    useSyncExternalStore(state.subscribe, state.version);
    return state.touring;
  },
}));
// The tooltip's text and side are what matter here; Base UI draws it only on hover.
vi.mock('@/components/ui/Tooltip', () => ({
  Hint: ({ label, side, children }: { label: string; side?: string; children: ReactElement }) => <span data-hint={label} data-hint-side={side}>{children}</span>,
}));
// The search box as it is, tested where it lives (it opens the search panel).
vi.mock('./sidebar-search-trigger', () => ({ SidebarSearchTrigger: () => <button type="button" data-testid="sidebar-search-trigger" /> }));
// The intro's card is the feature tour's (TourBubble, drawn for real); its popover owns floating geometry, which jsdom
// does not lay out: the positioner says which element it is anchored on instead, and the root hands over its dismissals.
vi.mock('@/components/ui/Popover', () => {
  const resolve = (anchor: unknown) => (typeof anchor === 'function' ? (anchor as () => Element | null)() : (anchor as Element | null));
  return {
    Popover: {
      Root: ({ children, onOpenChange }: { children: ReactElement; onOpenChange?: (open: boolean, details: unknown) => void }) => {
        state.onOpenChange = onOpenChange;
        return children;
      },
      Portal: ({ children }: { children: ReactElement }) => children,
      Positioner: ({ children, anchor, side, align }: { children: ReactElement; anchor: unknown; side: string; align: string }) => (
        <div data-anchor={resolve(anchor)?.getAttribute('data-testid') ?? ''} data-side={side} data-align={align}>{children}</div>
      ),
      Popup: ({ children, ...props }: { children: ReactElement; role?: string; 'data-testid'?: string }) => (
        <section role={props.role} data-testid={props['data-testid']}>{children}</section>
      ),
      Arrow: () => <i data-testid="intro-arrow" />,
    },
  };
});

const { SidebarOneListHead, SidebarOneListTop } = await import('./sidebar-one-list-chrome');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  state.open = true;
  state.view = 'home';
  state.locale = 'zh-CN';
  state.canGoBack = true;
  state.intro = 'collapse';
  state.notificationsOpen = false;
  state.touring = false;
  state.onOpenChange = undefined;
  for (const fn of [state.toggleLeft, state.navigate, state.back, state.dispatch, state.request, state.update]) vi.mocked(fn).mockClear();
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
/** A change seen by the mounted head: the sidebar collapsing, the bell's panel opening. */
const change = (apply: () => void) => act(async () => { apply(); state.emit(); });

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

describe('the head: the collapse button, the bell, the search box and 会话历史', () => {
  const hiddenWithTheNames = (element: Element) => element.closest('[class~="opacity-(--gg-sidebar-text)"]') !== null;

  it('collapse: chevrons only, the tooltip says what it does with the shortcut, and it runs the collapse action', async () => {
    await render(<SidebarOneListHead />);
    const fold = q('sidebar-fold')!;
    expect(fold.textContent).toBe('');
    expect(fold.getAttribute('aria-label')).toBe('sidebar.collapseSidebar');
    const hint = fold.closest<HTMLElement>('[data-hint]')!;
    expect(hint.dataset.hint).toBe('sidebar.collapseSidebar ([Mod+Shift+S])');
    // The row is the window's top band: its tooltips open below it.
    expect(hint.dataset.hintSide).toBe('bottom');
    await click(fold);
    expect(state.toggleLeft).toHaveBeenCalledTimes(1);
  });

  it('one row on the top band: 「«」 first on the avatars\' axis, then the bell, the search box, and 会话历史 last', async () => {
    await render(<SidebarOneListHead />);
    const head = document.querySelector<HTMLElement>('[data-sidebar-head]')!;
    // The sidebar's 40px top band (the window's drag handle), 20px in: the 32px 「«」 is centred on x = 36.
    expect(head.hasAttribute('data-sidebar-space')).toBe(true);
    expect(head.className).toMatch(/\bpl-5\b/);
    expect(head.style.paddingLeft).toBe('');
    const bell = head.querySelector('[data-notification-slot="toggle"]')!;
    const order = [q('sidebar-fold')!, bell, q('sidebar-search-trigger')!, q('sidebar-session-history')!];
    const all = [...head.querySelectorAll('*')];
    const positions = order.map((control) => all.indexOf(control));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(head.firstElementChild!.contains(q('sidebar-fold'))).toBe(true);
    expect(hiddenWithTheNames(q('sidebar-fold')!)).toBe(false);
    for (const control of order.slice(1)) {
      expect(hiddenWithTheNames(control)).toBe(true);
      expect(control.closest('[inert]')).toBeNull();
    }
    expect(q('sidebar-session-history')!.closest<HTMLElement>('[data-hint]')!.dataset.hintSide).toBe('bottom');
  });

  it('collapsed (the rail): the same button in the same place expands; the bell, search and 会话历史 hide with the names', async () => {
    state.open = false;
    await render(<SidebarOneListHead />);
    const head = document.querySelector<HTMLElement>('[data-sidebar-head]')!;
    expect(head.firstElementChild!.contains(q('sidebar-fold'))).toBe(true);
    expect(q('sidebar-fold')!.closest<HTMLElement>('[data-hint]')!.dataset.hint).toBe('sidebar.expandSidebar ([Mod+Shift+S])');
    expect(q('sidebar-fold')!.closest('[inert]')).toBeNull();
    for (const control of [head.querySelector('[data-notification-slot="toggle"]')!, q('sidebar-search-trigger')!, q('sidebar-session-history')!]) {
      expect(hiddenWithTheNames(control)).toBe(true);
      expect(control.closest('[inert]')).not.toBeNull();
    }
  });

  it('会话历史 toggles: opens the existing 会话历史 page, lit while shown; clicked again it goes back to the view before', async () => {
    await render(<SidebarOneListHead />);
    const history = q('sidebar-session-history')!;
    expect(history.closest<HTMLElement>('[data-hint]')!.dataset.hint).toBe('sidebar.sessionHistory');
    expect(history.dataset.on).toBeUndefined();
    expect(history.getAttribute('aria-pressed')).toBe('false');
    await click(history);
    expect(state.navigate).toHaveBeenCalledWith('session-history');
    expect(state.back).not.toHaveBeenCalled();
    state.view = 'session-history';
    // The head is an observer (memoised); the slots hook re-renders it in the app, a new key does here.
    await render(<SidebarOneListHead key="on-history" />);
    const lit = q('sidebar-session-history')!;
    expect(lit.dataset.on).toBe('true');
    expect(lit.getAttribute('aria-pressed')).toBe('true');
    await click(lit);
    expect(state.back).toHaveBeenCalledWith(true);
    expect(state.navigate).toHaveBeenCalledTimes(1);
  });
});

describe('C9: the two-step intro, 侧栏可以收起来 → 会话历史, in the feature tour\'s card', () => {
  const bubble = () => document.querySelector<HTMLElement>('[data-testid^="sidebar-intro-"][role="dialog"]');
  const anchorOf = (card: HTMLElement) => card.closest<HTMLElement>('[data-anchor]')!.dataset.anchor;
  const placementOf = (card: HTMLElement) => {
    const { side, align } = card.closest<HTMLElement>('[data-anchor]')!.dataset;
    return { side, align };
  };
  const tools = (locale: string) =>
    locale === 'zh-CN'
      ? Object.values(LOCAL_SESSION_ENGINE_LABEL).join('、')
      : new Intl.ListFormat(locale, { type: 'disjunction' }).format(Object.values(LOCAL_SESSION_ENGINE_LABEL));
  const details = (reason: string) => ({ reason, cancel: vi.fn(), allowPropagation: vi.fn() });

  it('does not show before a group or a project is opened', async () => {
    await render(<SidebarOneListHead />);
    expect(bubble()).toBeNull();
  });

  it('opening one while expanded brings up step 1 on the collapse button: 1 / 2, the shortcut, 跳过 and 下一步, no 上一步', async () => {
    await render(<SidebarOneListHead innerShownFor="g1" />);
    const card = bubble()!;
    expect(card.dataset.testid).toBe('sidebar-intro-collapse');
    expect(anchorOf(card)).toBe('sidebar-fold');
    // Under the top row (❌ over the buttons it explains), running on from 「«」 at the row's start.
    expect(placementOf(card)).toEqual({ side: 'bottom', align: 'start' });
    expect(card.querySelector('.product-tour-kicker')!.textContent).toBe('1 / 2');
    expect(card.querySelector('h2')!.textContent).toBe('sidebar.introCollapseTitle');
    expect(card.querySelector('p')!.textContent).toBe('sidebar.introCollapseBody {"shortcut":"[Mod+Shift+S]"}');
    expect(q('sidebar-intro-skip')!.dataset.variant).toBe('ghost');
    expect(q('sidebar-intro-next')!.dataset.variant).toBe('primary');
    expect(q('sidebar-intro-previous')).toBeNull();
    expect(q('sidebar-intro-open-history')).toBeNull();
    expect(state.update).not.toHaveBeenCalled();
  });

  it('下一步 moves to step 2 on the 会话历史 button and stores it: 2 / 2, the tools named, 上一步 · 打开看看 · 完成', async () => {
    await render(<SidebarOneListHead innerShownFor="g1" />);
    await click(q('sidebar-intro-next')!);
    expect(state.update).toHaveBeenLastCalledWith({ sidebarIntro: 'history' });
    const card = bubble()!;
    expect(card.dataset.testid).toBe('sidebar-intro-history');
    expect(anchorOf(card)).toBe('sidebar-session-history');
    // Under the row too, running on from 会话历史.
    expect(placementOf(card)).toEqual({ side: 'bottom', align: 'start' });
    expect(card.querySelector('.product-tour-kicker')!.textContent).toBe('2 / 2');
    expect(card.querySelector('h2')!.textContent).toBe('sidebar.introHistoryTitle');
    expect(card.querySelector('p')!.textContent).toBe(`sidebar.introHistoryBody ${JSON.stringify({ tools: tools('zh-CN') })}`);
    expect(q('sidebar-intro-skip')).toBeNull();
    const buttons = [...card.querySelectorAll<HTMLElement>('footer button')].map((button) => button.dataset.testid);
    expect(buttons).toEqual(['sidebar-intro-previous', 'sidebar-intro-open-history', 'sidebar-intro-next']);
    expect(q('sidebar-intro-next')!.dataset.variant).toBe('primary');
  });

  it('the tools are the import list\'s engines, as an English list in English', async () => {
    state.locale = 'en-US';
    state.intro = 'history';
    await render(<SidebarOneListHead innerShownFor="g1" />);
    expect(bubble()!.querySelector('p')!.textContent).toBe(`sidebar.introHistoryBody ${JSON.stringify({ tools: tools('en-US') })}`);
    expect(bubble()!.querySelector('p')!.textContent).not.toContain('、');
  });

  it('上一步 goes back to step 1 and stores that', async () => {
    state.intro = 'history';
    await render(<SidebarOneListHead innerShownFor="g1" />);
    await click(q('sidebar-intro-previous')!);
    expect(state.update).toHaveBeenLastCalledWith({ sidebarIntro: 'collapse' });
    expect(anchorOf(bubble()!)).toBe('sidebar-fold');
  });

  it('跳过 ends it for good and stores that; it does not come up again', async () => {
    await render(<SidebarOneListHead innerShownFor="g1" />);
    await click(q('sidebar-intro-skip')!);
    expect(state.update).toHaveBeenLastCalledWith({ sidebarIntro: 'ended' });
    expect(bubble()).toBeNull();
    await render(<SidebarOneListHead innerShownFor="g2" />);
    expect(bubble()).toBeNull();
    expect(state.toggleLeft).not.toHaveBeenCalled();
  });

  it('完成 ends it', async () => {
    state.intro = 'history';
    await render(<SidebarOneListHead innerShownFor="g1" />);
    await click(q('sidebar-intro-next')!);
    expect(state.update).toHaveBeenLastCalledWith({ sidebarIntro: 'ended' });
    expect(bubble()).toBeNull();
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it('打开看看 opens 会话历史 the way the head button does, then ends it', async () => {
    state.intro = 'history';
    await render(<SidebarOneListHead innerShownFor="g1" />);
    await click(q('sidebar-intro-open-history')!);
    expect(state.navigate).toHaveBeenCalledWith('session-history');
    expect(state.update).toHaveBeenLastCalledWith({ sidebarIntro: 'ended' });
    expect(bubble()).toBeNull();
  });

  it('打开看看 on 会话历史 already: nothing to open (❌ the button\'s toggle back), it ends', async () => {
    state.intro = 'history';
    state.view = 'session-history';
    await render(<SidebarOneListHead innerShownFor="g1" />);
    await click(q('sidebar-intro-open-history')!);
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.back).not.toHaveBeenCalled();
    expect(state.update).toHaveBeenLastCalledWith({ sidebarIntro: 'ended' });
  });

  it('Escape ends it, and still reaches what it was meant for', async () => {
    await render(<SidebarOneListHead innerShownFor="g1" />);
    const escape = details('escape-key');
    await act(async () => state.onOpenChange!(false, escape));
    expect(state.update).toHaveBeenLastCalledWith({ sidebarIntro: 'ended' });
    expect(escape.allowPropagation).toHaveBeenCalled();
    expect(bubble()).toBeNull();
  });

  it('a click elsewhere neither closes it nor is swallowed by it', async () => {
    await render(<SidebarOneListHead innerShownFor="g1" />);
    for (const reason of ['outside-press', 'focus-out']) {
      const dismissal = details(reason);
      await act(async () => state.onOpenChange!(false, dismissal));
      expect(dismissal.cancel).toHaveBeenCalled();
      expect(dismissal.allowPropagation).toHaveBeenCalled();
    }
    expect(bubble()).not.toBeNull();
    expect(state.update).not.toHaveBeenCalled();
  });

  it('collapsing while step 1 shows is step 1 learned: the rail hides 会话历史, so step 2 waits for the sidebar to expand', async () => {
    await render(<SidebarOneListHead innerShownFor="g1" />);
    await change(() => (state.open = false));
    expect(state.update).toHaveBeenLastCalledWith({ sidebarIntro: 'history' });
    expect(bubble()).toBeNull();
    // Expanded again: step 2 on 会话历史, with 上一步 (step 2 is only ever drawn expanded).
    await change(() => (state.open = true));
    const card = bubble()!;
    expect(card.dataset.testid).toBe('sidebar-intro-history');
    expect(anchorOf(card)).toBe('sidebar-session-history');
    expect(q('sidebar-intro-previous')).not.toBeNull();
    expect(state.update).toHaveBeenCalledTimes(1);
  });

  it('collapsing on step 2 hides it (not ended), and it comes back on 会话历史 once expanded', async () => {
    state.intro = 'history';
    await render(<SidebarOneListHead innerShownFor="g1" />);
    expect(bubble()!.dataset.testid).toBe('sidebar-intro-history');
    await change(() => (state.open = false));
    expect(bubble()).toBeNull();
    await change(() => (state.open = true));
    expect(bubble()!.dataset.testid).toBe('sidebar-intro-history');
    expect(state.update).not.toHaveBeenCalled();
  });

  it('a collapse before it ever came up: it comes up at step 2', async () => {
    await render(<SidebarOneListHead />);
    await change(() => (state.open = false));
    expect(state.update).toHaveBeenLastCalledWith({ sidebarIntro: 'history' });
    expect(bubble()).toBeNull();
    await change(() => (state.open = true));
    await render(<SidebarOneListHead innerShownFor="g1" />);
    expect(bubble()!.dataset.testid).toBe('sidebar-intro-history');
  });

  it('opened while collapsed it waits, and comes up once the sidebar expands', async () => {
    state.open = false;
    await render(<SidebarOneListHead innerShownFor="g1" />);
    expect(bubble()).toBeNull();
    await change(() => (state.open = true));
    expect(bubble()!.dataset.testid).toBe('sidebar-intro-collapse');
  });

  it('never shows once stored as ended, nor before the settings are read (and writes nothing then)', async () => {
    state.intro = 'ended';
    await render(<SidebarOneListHead innerShownFor="g1" />);
    expect(bubble()).toBeNull();
    state.intro = undefined;
    await render(<SidebarOneListHead key="unread" innerShownFor="g1" />);
    expect(bubble()).toBeNull();
    await change(() => (state.open = false));
    expect(state.update).not.toHaveBeenCalled();
  });

  it('steps aside while the bell\'s panel replaces the list, and comes back where it was (hidden, not ended)', async () => {
    await render(<SidebarOneListHead innerShownFor="g1" />);
    await change(() => (state.notificationsOpen = true));
    expect(bubble()).toBeNull();
    await change(() => (state.notificationsOpen = false));
    expect(bubble()!.dataset.testid).toBe('sidebar-intro-collapse');
    expect(state.update).not.toHaveBeenCalled();
  });

  it('steps aside while the feature tour is on screen (❌ two bubbles at once), and comes back where it was', async () => {
    state.touring = true;
    await render(<SidebarOneListHead innerShownFor="g1" />);
    expect(bubble()).toBeNull();
    await change(() => (state.touring = false));
    expect(bubble()!.dataset.testid).toBe('sidebar-intro-collapse');
    await change(() => (state.touring = true));
    expect(bubble()).toBeNull();
    expect(state.update).not.toHaveBeenCalled();
  });
});
