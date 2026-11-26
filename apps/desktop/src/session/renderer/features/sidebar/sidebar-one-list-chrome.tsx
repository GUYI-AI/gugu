import { Archive, Clock, FolderPlus, PanelLeft, Plus, SquarePen, UserRound, Users } from '@/lib/icons';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useConversationVisibility } from '@/components/chat/useConversationVisibility';
import { NotificationSlot } from '@/components/needsYou/NotificationSlot';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { DropdownMenu, MenuItem, MenuSubmenu } from '@/components/ui/Menu';
import { TourBubble } from '@/components/productTour/TourBubble';
import { Hint } from '@/components/ui/Tooltip';
import { MeSlot } from '@/components/me/MeSlot';
import { requestShellChatAction, useProductTourOnScreen, useSidebarNotificationsOpen } from '@/lib/sidebarChatsBridge';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { navigateBack } from '@renderer/lib/components/nav-buttons';
import { getEffectiveHotkey, useShortcutOverrides } from '@renderer/lib/hooks/useKeyboardShortcuts';
import { sidebarRailTextOpacity, useLeftRailLayout, useSidebarProgressFollow, useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
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
 * search button) running an existing action. Collapsed, the sidebar is a rail of the list's avatars (SIDEBAR_RAIL_PX wide,
 * every avatar where it was): what has text fades, as do search, 已安排 and 会话历史. The fold button (SidebarRailRow) and the
 * 「+」 sit on the avatars' axis, in that order; the bell is in the foot.
 */

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

/**
 * The top row (mock v19: 「创建智能体」收窄淡出,+ 从右边滑到这条竖线上). Its layout is the expanded one (side padding 12, gap 4)
 * or the rail's (18, 0, 创建智能体 at 0), taken where the rows take the rail's layout (@@@panel-track: one layout at each end
 * of the fold). In between the 「+」 (32) slides from the row's right end onto the avatars' axis (18 + 16 = 34 of the 68 rail)
 * by a transform, in the half of the fold where 创建智能体 has faded (followNames), so the two never cross.
 */
function followTopRow(row: HTMLElement, progress: number, railLayout: boolean) {
  row.style.paddingInline = railLayout ? '18px' : '12px';
  row.style.gap = railLayout ? '0px' : '4px';
  row.style.paddingBottom = `${railLayout ? TOP_ROW_GAP_RAIL_PX : TOP_ROW_GAP_OPEN_PX}px`;
  const plus = row.lastElementChild as HTMLElement | null;
  if (!plus) return;
  // From its expanded place (12 from the right end) to the rail's (18 from the left); a read of a clean layout. It moves in
  // the half of the fold where the text is gone (the mirror of sidebarRailTextOpacity), ❌ across 创建智能体 still fading.
  const travel = railLayout ? 0 : sidebarRailTextOpacity(1 - progress) * (row.clientWidth - 12 - plus.offsetWidth - 18);
  plus.style.transform = travel > 0 ? `translateX(${-travel}px)` : '';
}

/** What the rail hides along with the names: it takes their opacity (sidebarRailTextOpacity), on its own element. */
function followNames(element: HTMLElement, progress: number) {
  element.style.opacity = String(sidebarRailTextOpacity(progress));
}

/**
 * 创建智能体 (what 新建任务 does) and the 「+」 menu. Collapsed, the 「+」 is all the top keeps, so its menu leads with
 * 创建智能体 (the same action, the same icon).
 */
export function SidebarOneListTop({ collapsed, onCreateAgent }: { collapsed: boolean; onCreateAgent: () => void }) {
  const { translate } = useSessionMessages();
  const [menuOpen, setMenuOpen] = useState(false);
  const rowRef = useSidebarProgressFollow<HTMLDivElement>(followTopRow);
  const createRef = useSidebarProgressFollow<HTMLButtonElement>(followNames);
  const menuLabel = [...(collapsed ? [translate('sidebar.createAgent')] : []), ...ONE_LIST_CREATE_MENU.map((action) => translate(CREATE_MENU_LABEL[action]))].join(' / ');
  return (
    <div ref={rowRef} className="flex shrink-0 items-center" data-sidebar-one-list-top="">
      {/* Fades with the sidebar's text (followNames) and narrows to nothing: no side padding or border
          of its own (its label is centred, so expanded it looks the same), and its overflow is clipped on the way. Collapsed
          it is inert: out of the tab order and the pointer's way. */}
      <Button
        ref={createRef}
        variant="primary"
        className="h-[34px] min-w-0 flex-1 overflow-hidden rounded-[10px]"
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
        {/* A constant label: an empty one renders the bare button (Hint), so blanking it while open remounted the 「+」 and Esc
            had no trigger to give focus back to. The tooltip closes on the press by itself. */}
        <Hint label={menuLabel} side={collapsed ? 'right' : 'bottom'}>
          <DropdownMenu.Trigger
            // Design v16: 28 (radius 8) on the rail, 34 (radius 10) beside 创建智能体.
            className={cn('gg-icon-btn gg-ghost window-no-drag-region', collapsed ? '!size-7 !rounded-lg' : '!size-[34px] !rounded-[10px]')}
            data-size="md"
            data-on={menuOpen || undefined}
            aria-label={menuLabel}
            data-testid="sidebar-create-menu"
          >
            <Plus />
          </DropdownMenu.Trigger>
        </Hint>
        {menuOpen ? (
          <DropdownMenu.Content aria-label={menuLabel} side={collapsed ? 'right' : 'bottom'} align={collapsed ? 'start' : 'end'} sideOffset={collapsed ? 8 : 4}>
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
 * The rows' geometry at either end of the fold (@@@panel-track: each is taken where the rows take the rail's layout). What
 * is under them is moved by the difference times the progress (followBelowRailRow, followListOffset), so between the two
 * ends the rows move with the fold and land where the rail draws them, ❌ jump when the layout flips.
 */
/** The fold row: 12 + the 32px search field + 12 expanded; the fold button's 36 on the rail. */
const RAIL_ROW_OPEN_PX = 56;
const RAIL_ROW_RAIL_PX = 36;
/** Under 创建智能体 and its 「+」 (followTopRow). */
const TOP_ROW_GAP_OPEN_PX = 17;
const TOP_ROW_GAP_RAIL_PX = 8;
/** The list's gutter (left-sidebar: 14 open, 8 on the rail). */
const LIST_GUTTER_OPEN_PX = 14;
const LIST_GUTTER_RAIL_PX = 8;

/** The fold row's height, written in the same frame as what is under it (followBelowRailRow), ❌ a render later. */
function followRailRowHeight(row: HTMLElement, _progress: number, railLayout: boolean) {
  row.style.height = `${railLayout ? RAIL_ROW_RAIL_PX : RAIL_ROW_OPEN_PX}px`;
}

/** What sits under the fold row, moved up as far as the row would have shrunk at this progress (0 at either end). */
export function followBelowRailRow(element: HTMLElement, progress: number, railLayout: boolean) {
  const shift = railLayout ? 0 : (RAIL_ROW_OPEN_PX - RAIL_ROW_RAIL_PX) * (1 - progress);
  element.style.transform = shift > 0 ? `translateY(${-shift}px)` : '';
}

/**
 * How far the list's rows are moved left and up at this progress: what the gutter and the top row's gap would have shrunk
 * (0 at either end). The names' mask moves its edge with them (left-sidebar's followNamesMask).
 */
export function listFoldShift(progress: number, railLayout: boolean): { x: number; y: number } {
  const rest = railLayout ? 0 : 1 - progress;
  return { x: (LIST_GUTTER_OPEN_PX - LIST_GUTTER_RAIL_PX) * rest, y: (TOP_ROW_GAP_OPEN_PX - TOP_ROW_GAP_RAIL_PX) * rest };
}

/** The list's rows, moved left by listFoldShift (inside the gutter). Their rise is the scroll box's (left-sidebar's
 *  followNamesMask), so they never cross its top edge, which clips. */
export function followListOffset(element: HTMLElement, progress: number, railLayout: boolean) {
  const shift = listFoldShift(progress, railLayout);
  element.style.transform = shift.x > 0 ? `translateX(${-shift.x}px)` : '';
}

/**
 * The fold row, under the head: the fold button at the end of the search field expanded (界面减法 #46: search is at the top only
 * while the sidebar is open), on the avatars' axis on the rail — the fold button is in this row in both states, ❌ a row of
 * its own. Each changes where the rows take the rail's layout (@@@panel-track); the field and the button fade with the names
 * before that.
 */
function SidebarRailRow({ visibilityRef }: { visibilityRef: RefObject<HTMLDivElement | null> }) {
  const railLayout = useLeftRailLayout();
  const fieldRef = useSidebarProgressFollow<HTMLDivElement>(followNames);
  const rowRef = useSidebarProgressFollow<HTMLDivElement>(followRailRowHeight);
  return (
    // Design v16: on the rail the fold button is centred on the avatars' axis (34 of 68), right under the head band (on macOS
    // just under the traffic lights). Open, the search field keeps its side inset (12) above and below it too (yangchichi
    // 11-24: the gaps were too wide).
    <div
      ref={(row) => {
        rowRef.current = row;
        visibilityRef.current = row;
      }}
      className={cn('flex shrink-0', railLayout ? 'items-start justify-center' : 'items-center gap-1 p-3')}
      data-sidebar-rail-row=""
    >
      {/* Keyed: the two are different elements. Unkeyed, React kept the field's div for the rail's, and with it the inline
          opacity the fold had faded the field to (followNames writes it): the rail's fold button was there but invisible. */}
      {railLayout ? <div key="rail" className="flex"><SidebarFoldButton /></div> : (
        <div key="field" ref={fieldRef} className="flex min-w-0 flex-1 items-center gap-1">
          <div className="min-w-0 flex-1"><SidebarSearchTrigger /></div>
          <SidebarFoldButton />
        </div>
      )}
    </div>
  );
}

/** Folds / unfolds the sidebar: the fold button in the fold row (SidebarRailRow), both states. */
function SidebarFoldButton() {
  const { translate } = useSessionMessages();
  const { isLeftOpen, toggleLeft } = useWorkspaceLayoutContext();
  const hotkey = getEffectiveHotkey('app.toggleLeftSidebar', useShortcutOverrides());
  const shortcut = hotkey ? formatHotkeyText(hotkey) : null;
  // #2548: 收起侧栏 / 展开侧栏 and the product's own shortcut (owner: not the mock's ⌘\).
  const foldLabel = translate(isLeftOpen ? 'sidebar.collapseSidebar' : 'sidebar.expandSidebar');
  return (
    <Hint label={shortcut ? `${foldLabel} (${shortcut})` : foldLabel} side={isLeftOpen ? 'bottom' : 'right'}>
      <IconButton size="md" tone="strong" className="window-no-drag-region !h-[26px] !w-[30px] !rounded-[7px]" aria-label={foldLabel} aria-expanded={isLeftOpen} onClick={toggleLeft} data-testid="sidebar-fold">
        <PanelLeft />
      </IconButton>
    </Hint>
  );
}

/**
 * C9, the two-step intro (sidebar-intro). Where it is (`step`) is stored in the app settings (`interface.sidebarIntro`, the
 * store the switch itself lives in) and read from there, written only over a read (the main side parses the whole
 * `interface` group on update); coming up (`up`) is this run's. The first-run hint system holds one line and one button
 * and cannot say this.
 */
function useSidebarIntro(innerShownFor: string | null, expanded: boolean) {
  const { settings: interfaceSettingsReading, update } = useAppSettingsKey('interface');
  const interfaceSettings = interfaceSettingsReading.state === 'value' ? interfaceSettingsReading.value.value : undefined;
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

/**
 * The head: the window's drag band, as tall as the window's own controls need it at the sidebar's top (the traffic lights',
 * `--sidebar-head-height`; 0 where they are elsewhere, as Windows' title bar row), then the fold row (SidebarRailRow). Over
 * the head, once: C9 (useSidebarIntro), drawn next to the step's button so it never covers it.
 *
 * `innerShownFor`: what the inner sidebar is drawn for (innerSidebarShownFor: a chat, or the sample), null when none.
 */
export const SidebarOneListHead = observer(function SidebarOneListHead({ innerShownFor = null }: { innerShownFor?: string | null }) {
  const { translate, locale } = useSessionMessages();
  const { navigate } = useNavigate();
  const { pageView: currentView } = useWorkspaceSlots();
  const { isLeftOpen } = useWorkspaceLayoutContext();
  const keyboard = useShortcutOverrides();
  const hotkey = getEffectiveHotkey('app.toggleLeftSidebar', keyboard);
  const shortcut = hotkey ? formatHotkeyText(hotkey) : null;
  const historyShown = isCurrentView(currentView, 'session-history');
  const intro = useSidebarIntro(innerShownFor, isLeftOpen);
  const step = intro.step;
  const end = () => intro.move({ kind: 'end' });
  // 打开看看: the foot button's navigation, then the intro is over. Already on 会话历史 there is nothing to open (❌ the
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
    <>
    <SidebarSpace controls={0} className="mt-(--desktop-surface-inset) !h-(--sidebar-head-height)" data-sidebar-head="" />
    <SidebarRailRow visibilityRef={intro.headRef} />
      {/* C9 beside the step's button, in the feature tour's card without its shade: it is contextual and blocks nothing,
          so it takes no focus, and a click elsewhere neither closes it nor is swallowed by it. Escape ends it and still
          reaches whatever it was meant for. 会话历史 is in the foot, so its step opens upwards. */}
      {step && card && (
        <TourBubble
          key={step}
          anchor={() => document.querySelector(`[data-region="left-sidebar"] [data-testid="${SIDEBAR_INTRO_ANCHOR[step]}"]`)}
          side={step === 'history' ? 'top' : 'bottom'}
          align={step === 'history' ? 'start' : 'end'}
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
    </>
  );
});

/**
 * The foot (界面减法 #46 #51): expanded, one row — my own avatar and name (the shell draws it, with its menu, into
 * MeSlot), then 已安排, 会话历史 and the bell; on the rail the bell above my avatar, on the avatars' axis. 已安排 and
 * 会话历史 are not on the rail. The layout changes where the rows take the rail's (@@@panel-track).
 */
export const SidebarOneListFoot = observer(function SidebarOneListFoot() {
  const { translate } = useSessionMessages();
  const { navigate } = useNavigate();
  const { pageView: currentView } = useWorkspaceSlots();
  const railLayout = useLeftRailLayout();
  const controlsRef = useSidebarProgressFollow<HTMLDivElement>(followNames);
  const scheduledLabel = translate('sidebar.scheduled');
  const scheduledShown = isCurrentView(currentView, 'automations');
  const historyLabel = translate('sidebar.sessionHistory');
  const historyShown = isCurrentView(currentView, 'session-history');
  return (
    <div
      className={cn('flex shrink-0 px-3 pb-3 pt-2', railLayout ? 'flex-col-reverse items-center gap-2' : 'items-center gap-1')}
      data-sidebar-foot=""
    >
      <MeSlot rail={railLayout} />
      {!railLayout && (
        <div ref={controlsRef} className="flex shrink-0 items-center gap-1">
          <Hint label={scheduledLabel} side="top">
            <IconButton
              size="md"
              tone="strong"
              className="!size-7"
              aria-label={scheduledLabel}
              aria-current={scheduledShown ? 'page' : undefined}
              on={scheduledShown}
              onClick={() => navigate('automations')}
              data-testid="sidebar-scheduled"
            >
              <Clock />
            </IconButton>
          </Hint>
          <Hint label={historyLabel} side="top">
            {/* The button toggles back through the same navigation as the shell's back button and Mod+[. */}
            <IconButton
              size="md"
              tone="strong"
              className="!size-7"
              aria-label={historyLabel}
              aria-pressed={historyShown}
              on={historyShown}
              onClick={() => (historyShown ? navigateBack(appState.history.canGoBack) : navigate('session-history'))}
              data-testid="sidebar-session-history"
            >
              <Archive />
            </IconButton>
          </Hint>
        </div>
      )}
      <NotificationSlot part="toggle" tone="strong" />
    </div>
  );
});

/** Each step's button: the fold button in the head, 会话历史 in the foot. */
const SIDEBAR_INTRO_ANCHOR = { collapse: 'sidebar-fold', history: 'sidebar-session-history' } as const;
