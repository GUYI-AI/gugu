import { ChevronsLeft, ChevronsRight, FolderPlus, History, Plus, SquarePen, UserRound, Users } from '@/lib/icons';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConversationVisibility } from '@/components/chat/useConversationVisibility';
import { NotificationSlot } from '@/components/needsYou/NotificationSlot';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { DropdownMenu, MenuItem, MenuSubmenu } from '@/components/ui/Menu';
import { TourBubble } from '@/components/productTour/TourBubble';
import { Hint } from '@/components/ui/Tooltip';
import { requestShellChatAction, useProductTourOnScreen, useSidebarNotificationsOpen } from '@/lib/sidebarChatsBridge';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { navigateBack } from '@renderer/lib/components/nav-buttons';
import { getEffectiveHotkey } from '@renderer/lib/hooks/useKeyboardShortcuts';
import { SIDEBAR_PROGRESS_VAR, useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import { isCurrentView, useNavigate, useWorkspaceSlots } from '@renderer/lib/layout/navigation-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { formatHotkeyText } from '@renderer/lib/ui/shortcut-format';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { LOCAL_SESSION_ENGINE_LABEL } from '@shared/core/session-import/session-import';
import { AddProjectMenuItems } from './add-project-menu-items';
import { nextSidebarIntro, SIDEBAR_INTRO_STEPS, sidebarIntroShown, type SidebarIntroEvent } from './sidebar-intro';
import { SidebarSearchTrigger } from './sidebar-search-trigger';
import { SidebarSpace } from './sidebar-space';

/**
 * GUYI-AI/gugu#2548 the head and the top of the sidebar as one list.
 * Composition only: every control is an existing one (Button, IconButton, DropdownMenu + MenuItem, Hint, the bell's slot, the
 * search box) running an existing action. Collapsed, the sidebar is a rail of the list's avatars (ONE_LIST_RAIL_PX wide,
 * every avatar where it was): what has text fades, and so do the bell, the search box and 会话历史; the collapse button and
 * the 「+」 sit on the avatars' axis.
 */

/**
 * The rail's width: the list's gutter (12) + row padding (8) + avatar (32) + the same 8 + 12 on the other side, so every
 * avatar of the list sits on its middle (x = 36) without moving.
 */
export const ONE_LIST_RAIL_PX = 72;

/** The 「+」 menu, in order. Each runs the action of the same name that exists today. */
export const ONE_LIST_CREATE_MENU = ['create-group', 'new-project', 'add-contact'] as const;
export type OneListCreateAction = (typeof ONE_LIST_CREATE_MENU)[number];

/**
 * 新建群聊 / 添加联系人: the chat list's own dialogs (the same request as the old Chats-tab rows; the one list's chat list
 * is always open, so nothing needs flipping first). 新建项目 is no action of its own but a submenu: the old sidebar's
 * 「添加项目」 group (新建空白项目 / 使用现有文件夹 / 使用远程文件夹 ›, AddProjectMenuItems), ❌ straight into a blank project.
 */
export function runOneListCreateAction(action: Exclude<OneListCreateAction, 'new-project'>): void {
  requestShellChatAction(action);
}

const CREATE_MENU_ICON = { 'create-group': Users, 'new-project': FolderPlus, 'add-contact': UserRound } as const;
const CREATE_MENU_LABEL = { 'create-group': 'sidebar.newGroupChat', 'new-project': 'task.projectNew', 'add-contact': 'sidebar.addContact' } as const;

/** The open/close progress on the content layer (workspace-layout); 1 where there is none (expanded). */
const PROGRESS = `var(${SIDEBAR_PROGRESS_VAR}, 1)`;

/**
 * The top row's geometry as a function of the open/close progress p (mock v19: 「创建智能体」收窄淡出,+ 从右边滑到这条竖线上):
 * side padding 12 → 20 and the gap 4 → 0 as p goes 1 → 0, 创建智能体 takes what is left (0 on the rail), so the 「+」 (32)
 * slides from the right end onto the avatars' axis (20 + 16 = 36) with the same progress as everything else.
 */
const ONE_LIST_TOP_STYLE = {
  paddingInline: `calc(20px - 8px * ${PROGRESS})`,
  gap: `calc(4px * ${PROGRESS})`,
} as const;

/**
 * 创建智能体 (what 新建任务 does) and the 「+」 menu. Collapsed, the 「+」 is all the top keeps, so its menu leads with
 * 创建智能体 (the same action, the same icon).
 */
export function SidebarOneListTop({ collapsed, onCreateAgent }: { collapsed: boolean; onCreateAgent: () => void }) {
  const { translate } = useSessionMessages();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuLabel = [...(collapsed ? [translate('sidebar.createAgent')] : []), ...ONE_LIST_CREATE_MENU.map((action) => translate(CREATE_MENU_LABEL[action]))].join(' / ');
  return (
    <div className="flex shrink-0 items-center pb-2" style={ONE_LIST_TOP_STYLE} data-sidebar-one-list-top="">
      {/* Fades with the sidebar's text (--gg-sidebar-text, left-sidebar) and narrows to nothing: no side padding or border
          of its own (its label is centred, so expanded it looks the same), and its overflow is clipped on the way. Collapsed
          it is inert: out of the tab order and the pointer's way. */}
      <Button
        variant="primary"
        className="min-w-0 flex-1 overflow-hidden opacity-(--gg-sidebar-text)"
        style={{ paddingInline: 0, borderInlineWidth: 0 }}
        inert={collapsed}
        onClick={onCreateAgent}
        data-testid="sidebar-create-agent"
      >
        <SquarePen className="size-4 shrink-0" />
        <span className="truncate">{translate('sidebar.createAgent')}</span>
      </Button>
      <DropdownMenu.Root open={menuOpen} modal={false} onOpenChange={setMenuOpen}>
        {/* The chat list header's 「+」 (ChatListPanel): the same trigger on the same icon-button skin. */}
        <DropdownMenu.Trigger
          className="gg-icon-btn gg-ghost window-no-drag-region"
          data-size="md"
          data-on={menuOpen || undefined}
          aria-label={menuLabel}
          title={menuLabel}
          data-testid="sidebar-create-menu"
        >
          <Plus />
        </DropdownMenu.Trigger>
        {menuOpen ? (
          <DropdownMenu.Content aria-label={menuLabel} side="bottom" align={collapsed ? 'start' : 'end'} sideOffset={4}>
            {collapsed && (
              <MenuItem icon={<SquarePen size={15} />} data-testid="sidebar-create-create-agent" onClick={onCreateAgent}>
                {translate('sidebar.createAgent')}
              </MenuItem>
            )}
            {ONE_LIST_CREATE_MENU.map((action) => {
              const Icon = CREATE_MENU_ICON[action];
              return action === 'new-project' ? (
                <MenuSubmenu key={action} icon={<Icon size={15} />} label={translate(CREATE_MENU_LABEL[action])} data-testid={`sidebar-create-${action}`}>
                  <AddProjectMenuItems />
                </MenuSubmenu>
              ) : (
                <MenuItem key={action} icon={<Icon size={15} />} data-testid={`sidebar-create-${action}`} onClick={() => runOneListCreateAction(action)}>
                  {translate(CREATE_MENU_LABEL[action])}
                </MenuItem>
              );
            })}
          </DropdownMenu.Content>
        ) : null}
      </DropdownMenu.Root>
    </div>
  );
}

/**
 * C9, the two-step intro (sidebar-intro). Where it is (`step`) is stored in the app settings (`interface.sidebarIntro`, the
 * store the switch itself lives in) and read from there, written only over a read (the main side parses the whole
 * `interface` group on update); coming up (`up`) is this run's. The first-run hint system holds one line and one button
 * and cannot say this.
 */
function useSidebarIntro(innerShownFor: string | null, expanded: boolean) {
  const { value: interfaceSettings, update } = useAppSettingsKey('interface');
  const stored = interfaceSettings?.sidebarIntro;
  const [up, setUp] = useState(false);
  const move = useCallback(
    (event: SidebarIntroEvent) => {
      if (stored === undefined) return;
      const next = nextSidebarIntro({ step: stored, up }, event);
      if (next.up !== up) setUp(next.up);
      if (next.step !== stored) update({ sidebarIntro: next.step });
    },
    [stored, up, update]
  );
  // The inner sidebar came up (re-run when the settings are read, and when the sidebar expands again over it).
  useEffect(() => {
    if (innerShownFor) move({ kind: 'opened', expanded });
  }, [innerShownFor, expanded, move]);
  // Collapsed by any route: every one of them ends in the layout's open state going false. (One before the settings are
  // read is not counted; nothing can be written over an unread group.)
  const wasExpanded = useRef(expanded);
  useEffect(() => {
    if (wasExpanded.current && !expanded) move({ kind: 'collapsed' });
    wasExpanded.current = expanded;
  }, [expanded, move]);

  // The head can be on a hidden retained surface (another place of the shell, a page without the task list): the bubble is
  // portalled, so it asks whether the head is on screen (@@@hint-visibility, an IntersectionObserver).
  const live = up && (stored === 'collapse' || stored === 'history');
  const { ref: headRef, shown: onScreen } = useConversationVisibility(live);
  const notificationsOpen = useSidebarNotificationsOpen();
  const touring = useProductTourOnScreen();
  const step = sidebarIntroShown(stored, up, { expanded, onScreen, notificationsOpen, touring });
  return { headRef, step, move };
}

/** 会话历史's importable tools, named as the import list names them (❌ another copy of the list). */
function importableTools(locale: string): string {
  const labels = Object.values(LOCAL_SESSION_ENGINE_LABEL);
  return locale.startsWith('zh') ? labels.join('、') : new Intl.ListFormat(locale, { type: 'disjunction' }).format(labels);
}

/** What the rail hides along with the names: faded with them, and inert there (out of the pointer's way and the tab order). */
const HIDDEN_ON_RAIL = 'opacity-(--gg-sidebar-text)';

/**
 * The head, the window's top band over the list (proposal v1 ①, owner-approved): the collapse button, the bell, the search
 * box and 会话历史, in that order. The collapse button (chevrons only; its tooltip says what it does and the shortcut, as
 * the old header toggle's did) is first, centred on the avatars' axis (20 + 32 / 2 = 36), and never moves: collapsed it is
 * 「»」 in the same place. Everything after it hides with the names on the rail (proposal v1, extra 1), so the rail keeps only
 * 「»」 and the 「+」 under it. There is no foot: the list runs to the window's bottom edge. Over the head, once: C9
 * (useSidebarIntro), drawn below the row so it never covers the buttons it explains.
 *
 * `innerShownFor`: what the inner sidebar is drawn for (innerSidebarShownFor: a chat, or the sample), null when none.
 */
export const SidebarOneListHead = observer(function SidebarOneListHead({ innerShownFor = null }: { innerShownFor?: string | null }) {
  const { translate, locale } = useSessionMessages();
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();
  const { isLeftOpen, toggleLeft } = useWorkspaceLayoutContext();
  const { value: keyboard } = useAppSettingsKey('keyboard');
  const hotkey = getEffectiveHotkey('app.toggleLeftSidebar', keyboard);
  const shortcut = hotkey ? formatHotkeyText(hotkey) : null;
  // #2548: 收起侧栏 / 展开侧栏 and the product's own shortcut (owner: not the mock's ⌘\).
  const foldLabel = translate(isLeftOpen ? 'sidebar.collapseSidebar' : 'sidebar.expandSidebar');
  const historyLabel = translate('sidebar.sessionHistory');
  const historyShown = isCurrentView(currentView, 'session-history');
  const railed = !isLeftOpen;
  const intro = useSidebarIntro(innerShownFor, isLeftOpen);
  const step = intro.step;
  const end = () => intro.move({ kind: 'end' });
  // 打开看看: the head button's navigation, then the intro is over. Already on 会话历史 there is nothing to open (❌ the
  // button's toggle back).
  const openHistory = () => {
    if (!historyShown) navigate('session-history');
    end();
  };
  const card =
    step === 'collapse'
      ? {
          title: translate('sidebar.introCollapseTitle'),
          body: shortcut ? translate('sidebar.introCollapseBody', { shortcut }) : translate('sidebar.introCollapseBodyNoShortcut'),
          onNext: () => intro.move({ kind: 'next' }),
        }
      : step === 'history'
        ? {
            title: translate('sidebar.introHistoryTitle'),
            body: translate('sidebar.introHistoryBody', { tools: importableTools(locale) }),
            onPrevious: () => intro.move({ kind: 'previous' }),
            onNext: end,
            extra: (
              <Button variant="secondary" size="sm" onClick={openHistory} data-testid="sidebar-intro-open-history">
                {translate('sidebar.introOpenHistory')}
              </Button>
            ),
          }
        : null;
  return (
    // On one line with the inner column's head and the content's tabs (刘威提议稿 v1: .ltop / .ihead / .mhead share a line):
    // those sit in the card stacked on this list, which starts one surface inset lower, so this band starts there too.
    <SidebarSpace ref={intro.headRef} controls={0} className="mt-(--desktop-surface-inset) gap-1 pl-5" data-sidebar-head="">
      <Hint label={shortcut ? `${foldLabel} (${shortcut})` : foldLabel} side="bottom">
        <IconButton size="md" tone="strong" aria-label={foldLabel} aria-expanded={isLeftOpen} onClick={toggleLeft} data-testid="sidebar-fold">
          {isLeftOpen ? <ChevronsLeft /> : <ChevronsRight />}
        </IconButton>
      </Hint>
      {/* The bell (NeedsYouHost draws it into this slot) and the search box, as they are. */}
      <div className={cn('flex shrink-0', HIDDEN_ON_RAIL)} inert={railed}>
        <NotificationSlot part="toggle" tone="strong" />
      </div>
      <div className={cn('flex min-w-0 flex-1', HIDDEN_ON_RAIL)} inert={railed}>
        <SidebarSearchTrigger />
      </div>
      <Hint label={historyLabel} side="bottom">
        {/* A toggle: open, 会话历史 is lit; clicked again it goes back to the view before it, by the task page's own back
            (navigateBack: the back button, Mod+[ and the window's ← take the same path), ❌ a second history here. */}
        <IconButton
          size="md"
          tone="strong"
          className={HIDDEN_ON_RAIL}
          inert={railed}
          aria-label={historyLabel}
          aria-pressed={historyShown}
          on={historyShown}
          onClick={() => (historyShown ? navigateBack(appState.history.canGoBack) : navigate('session-history'))}
          data-testid="sidebar-session-history"
        >
          <History />
        </IconButton>
      </Hint>
      {/* C9 under the step's button, in the feature tour's card without its shade: it is contextual and blocks nothing,
          so it takes no focus, and a click elsewhere neither closes it nor is swallowed by it. Escape ends it and still
          reaches whatever it was meant for. Below the row, so the row's buttons stay in sight, and running on from the
          step's button (❌ back from 会话历史: at the default width the card does not fit there and would flip anyway). */}
      {step && card && (
        <TourBubble
          key={step}
          anchor={() => intro.headRef.current?.querySelector(`[data-testid="${SIDEBAR_INTRO_ANCHOR[step]}"]`) ?? null}
          side="bottom"
          align="start"
          sideOffset={10}
          collisionPadding={8}
          initialFocus={false}
          finalFocus={false}
          onOpenChange={(open, details) => {
            if (open) return;
            if (details.reason === 'escape-key') end();
            details.cancel();
            details.allowPropagation();
          }}
          testId={`sidebar-intro-${step}`}
          buttonTestIdPrefix="sidebar-intro"
          current={SIDEBAR_INTRO_STEPS.indexOf(step) + 1}
          total={SIDEBAR_INTRO_STEPS.length}
          onSkip={end}
          {...card}
        />
      )}
    </SidebarSpace>
  );
});

/** Each step's button in the head. */
const SIDEBAR_INTRO_ANCHOR = { collapse: 'sidebar-fold', history: 'sidebar-session-history' } as const;
