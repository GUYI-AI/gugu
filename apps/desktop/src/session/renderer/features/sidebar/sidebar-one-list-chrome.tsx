import { ChevronsLeft, ChevronsRight, FolderPlus, History, Plus, SquarePen, UserRound, Users } from '@/lib/icons';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { useConversationVisibility } from '@/components/chat/useConversationVisibility';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { DropdownMenu, MenuItem } from '@/components/ui/Menu';
import { Popover } from '@/components/ui/Popover';
import { Hint } from '@/components/ui/Tooltip';
import { requestShellChatAction, useSidebarNotificationsOpen } from '@/lib/sidebarChatsBridge';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { commandRegistry } from '@renderer/lib/commands/registry';
import { navigateBack } from '@renderer/lib/components/nav-buttons';
import { getEffectiveHotkey } from '@renderer/lib/hooks/useKeyboardShortcuts';
import { SIDEBAR_PROGRESS_VAR, useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import { isCurrentView, useNavigate, useWorkspaceSlots } from '@renderer/lib/layout/navigation-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { formatHotkeyText } from '@renderer/lib/ui/shortcut-format';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import {
  nextSidebarCollapseHint,
  sidebarCollapseHintShown,
  sidebarCollapseHintState,
  type SidebarCollapseHint,
  type SidebarCollapseHintEvent,
} from './sidebar-collapse-hint';

/**
 * GUYI-AI/gugu#2548 the top and the foot of the sidebar as one list (internal switch `interface.desktopSidebarV2`).
 * Composition only: every control is an existing one (Button, IconButton, DropdownMenu + MenuItem, Hint) running an
 * existing action. Collapsed, the sidebar is a rail of the list's avatars (ONE_LIST_RAIL_PX wide, every avatar where it
 * was): what has text fades, the 「+」 and the collapse button sit on the avatars' axis.
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
 * is always open, so nothing needs flipping first). 新建项目: the `app.newProject` command (its shortcut, the palette).
 */
export function runOneListCreateAction(action: OneListCreateAction): void {
  if (action === 'new-project') {
    if (!commandRegistry.dispatch('app.newProject')) throw new Error('app.newProject is not registered');
    return;
  }
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
              return (
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
 * C9's state (sidebar-collapse-hint): comes up when a group or a project opens while expanded, retires for good on either
 * button or on any collapse. Retired is stored in the app settings (`interface.sidebarCollapseHintRetired`, the store the
 * switch itself lives in); the first-run hint system holds one line and one button and cannot say this.
 */
function useSidebarCollapseHint(openChatId: string | null, expanded: boolean) {
  const { value: interfaceSettings, update } = useAppSettingsKey('interface');
  const stored = interfaceSettings?.sidebarCollapseHintRetired;
  const [session, setSession] = useState<SidebarCollapseHint>('waiting');
  const dispatch = (event: SidebarCollapseHintEvent) => setSession((state) => nextSidebarCollapseHint(state, event));
  // A group or project opened. (This also re-runs when the sidebar expands again; harmless, the collapse retired it.)
  useEffect(() => {
    if (openChatId) setSession((state) => nextSidebarCollapseHint(state, { kind: 'opened', expanded }));
  }, [openChatId, expanded]);
  // Collapsed by any route: every one of them ends in the layout's open state going false.
  const wasExpanded = useRef(expanded);
  useEffect(() => {
    if (wasExpanded.current && !expanded) setSession((state) => nextSidebarCollapseHint(state, { kind: 'collapsed' }));
    wasExpanded.current = expanded;
  }, [expanded]);
  // Written once, and only over a settings read (the main side parses the whole `interface` group on update).
  const saved = useRef(false);
  const retired = session === 'retired';
  useEffect(() => {
    if (!retired || stored !== false || saved.current) return;
    saved.current = true;
    update({ sidebarCollapseHintRetired: true });
  }, [retired, stored, update]);

  const state = sidebarCollapseHintState(stored, session);
  // The foot can be on a hidden retained surface (another place of the shell, a page without the task list): the bubble is
  // portalled, so it asks whether the foot is on screen (@@@hint-visibility, an IntersectionObserver).
  const { ref: footRef, shown: onScreen } = useConversationVisibility(state === 'showing');
  const notificationsOpen = useSidebarNotificationsOpen();
  const shown = sidebarCollapseHintShown(state, { expanded, onScreen, notificationsOpen });
  return { footRef, shown, answer: () => dispatch({ kind: 'answered' }) };
}

/**
 * The foot: the collapse button (chevrons only; its tooltip says what it does and the shortcut, as the old header toggle's
 * did) and 会话历史 next to it. The collapse button sits on the rail's axis and never moves; collapsed, 会话历史 stacks
 * above it (the rail has room for one button per line). Above the collapse button, once: C9 (useSidebarCollapseHint).
 *
 * `openChatId`: the group or project the inner sidebar is open on (innerSidebarChat), null when none.
 */
export const SidebarOneListFoot = observer(function SidebarOneListFoot({ openChatId = null }: { openChatId?: string | null }) {
  const { translate } = useSessionMessages();
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();
  const { isLeftOpen, toggleLeft, setCollapsed } = useWorkspaceLayoutContext();
  const { value: keyboard } = useAppSettingsKey('keyboard');
  const hotkey = getEffectiveHotkey('app.toggleLeftSidebar', keyboard);
  const shortcut = hotkey ? formatHotkeyText(hotkey) : null;
  // #2548: 收起侧栏 / 展开侧栏 and the product's own shortcut (owner: not the mock's ⌘\).
  const foldLabel = translate(isLeftOpen ? 'sidebar.collapseSidebar' : 'sidebar.expandSidebar');
  const historyLabel = translate('sidebar.sessionHistory');
  const historyShown = isCurrentView(currentView, 'session-history');
  const hint = useSidebarCollapseHint(openChatId, isLeftOpen);
  return (
    // 20 + 32 / 2 = 36: the collapse button is centred on the avatars' axis, as the 「+」 is; it is first in both
    // directions, so it holds its place (the bottom-left) and only 会话历史 moves.
    <div ref={hint.footRef} className={cn('flex shrink-0 gap-2 py-2 pl-5', isLeftOpen ? 'flex-row items-center' : 'flex-col-reverse items-start')} data-sidebar-foot="">
      <Hint label={shortcut ? `${foldLabel} (${shortcut})` : foldLabel} side="top">
        <IconButton size="md" tone="strong" aria-label={foldLabel} aria-expanded={isLeftOpen} onClick={toggleLeft} data-testid="sidebar-fold">
          {isLeftOpen ? <ChevronsLeft /> : <ChevronsRight />}
        </IconButton>
      </Hint>
      <Hint label={historyLabel} side="top">
        {/* A toggle: open, 会话历史 is lit; clicked again it goes back to the view before it, by the task page's own back
            (navigateBack: the back button, Mod+[ and the window's ← take the same path), ❌ a second history here. */}
        <IconButton
          size="md"
          tone="strong"
          aria-label={historyLabel}
          aria-pressed={historyShown}
          on={historyShown}
          onClick={() => (historyShown ? navigateBack(appState.history.canGoBack) : navigate('session-history'))}
          data-testid="sidebar-session-history"
        >
          <History />
        </IconButton>
      </Hint>
      {/* C9 above the collapse button. It leaves by its buttons or by a collapse only (mock v25): a click elsewhere or an
          Escape meant for something else neither closes it nor is swallowed by it. */}
      <Popover.Root
        open={hint.shown}
        modal={false}
        onOpenChange={(open, details) => {
          if (open) return;
          details.cancel();
          details.allowPropagation();
        }}
      >
        <Popover.Portal>
          <Popover.Positioner
            anchor={() => hint.footRef.current?.querySelector('[data-testid="sidebar-fold"]') ?? null}
            side="top"
            align="start"
            sideOffset={10}
            collisionPadding={8}
          >
            <Popover.Popup
              initialFocus={false}
              finalFocus={false}
              data-testid="sidebar-collapse-hint"
              className="w-[248px] rounded-[var(--radius-surface)] bg-[var(--popover)] p-3 text-[length:var(--font-body)] leading-[var(--lh-body)] text-[var(--text-primary)] shadow-[var(--shadow-lift)]"
            >
              <Popover.Arrow className="size-3 rotate-45 bg-[var(--popover)] data-[side=top]:-bottom-1.5" />
              <Popover.Title className="m-0 text-[length:var(--font-body)] font-[var(--font-weight-semibold)]">
                {translate('sidebar.collapseHintTitle')}
              </Popover.Title>
              <Popover.Description className="mt-1 mb-0 text-[var(--text-secondary)]">
                {shortcut ? translate('sidebar.collapseHintBody', { shortcut }) : translate('sidebar.collapseHintBodyNoShortcut')}
              </Popover.Description>
              <div className="mt-3 flex justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={hint.answer} data-testid="sidebar-collapse-hint-dismiss">
                  {translate('sidebar.collapseHintDismiss')}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    hint.answer();
                    setCollapsed('left', true);
                  }}
                  data-testid="sidebar-collapse-hint-try"
                >
                  {translate('sidebar.collapseHintTry')}
                </Button>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
});
