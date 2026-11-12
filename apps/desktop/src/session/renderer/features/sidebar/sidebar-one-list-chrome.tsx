import { ChevronsLeft, ChevronsRight, FolderPlus, History, Plus, SquarePen, UserRound, Users } from '@/lib/icons';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { DropdownMenu, MenuItem } from '@/components/ui/Menu';
import { Hint } from '@/components/ui/Tooltip';
import { requestShellChatAction } from '@/lib/sidebarChatsBridge';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { commandRegistry } from '@renderer/lib/commands/registry';
import { getEffectiveHotkey } from '@renderer/lib/hooks/useKeyboardShortcuts';
import { useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import { isCurrentView, useNavigate, useWorkspaceSlots } from '@renderer/lib/layout/navigation-provider';
import { formatHotkeyText } from '@renderer/lib/ui/shortcut-format';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';

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

/**
 * 创建智能体 (what 新建任务 does) and the 「+」 menu. Collapsed, the 「+」 is all the top keeps, so its menu leads with
 * 创建智能体 (the same action, the same icon).
 */
export function SidebarOneListTop({ collapsed, onCreateAgent }: { collapsed: boolean; onCreateAgent: () => void }) {
  const { translate } = useSessionMessages();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuLabel = [...(collapsed ? [translate('sidebar.createAgent')] : []), ...ONE_LIST_CREATE_MENU.map((action) => translate(CREATE_MENU_LABEL[action]))].join(' / ');
  return (
    // Expanded: the list's 12px gutter. Collapsed: the 「+」 (32) centred on the rail's axis (20 + 16 = 36).
    <div className={cn('flex shrink-0 items-center gap-1 pb-2', collapsed ? 'pl-5' : 'px-3')} data-sidebar-one-list-top="">
      {/* Fades with the sidebar's text (--gg-sidebar-text, left-sidebar). */}
      <Button variant="primary" className={cn('min-w-0 flex-1 opacity-(--gg-sidebar-text)', collapsed && 'hidden')} onClick={onCreateAgent} data-testid="sidebar-create-agent">
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
 * The foot: the collapse button (chevrons only; its tooltip says what it does and the shortcut, as the old header toggle's
 * did) and 会话历史 next to it. The collapse button sits on the rail's axis and never moves; collapsed, 会话历史 stacks
 * above it (the rail has room for one button per line).
 */
export const SidebarOneListFoot = observer(function SidebarOneListFoot() {
  const { translate } = useSessionMessages();
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();
  const { isLeftOpen, toggleLeft } = useWorkspaceLayoutContext();
  const { value: keyboard } = useAppSettingsKey('keyboard');
  const hotkey = getEffectiveHotkey('app.toggleLeftSidebar', keyboard);
  const foldLabel = translate(isLeftOpen ? 'task.collapseSidebar' : 'task.expandSidebar');
  const historyLabel = translate('sidebar.sessionHistory');
  return (
    // 20 + 32 / 2 = 36: the collapse button is centred on the avatars' axis, as the 「+」 is; it is first in both
    // directions, so it holds its place (the bottom-left) and only 会话历史 moves.
    <div className={cn('flex shrink-0 gap-2 py-2 pl-5', isLeftOpen ? 'flex-row items-center' : 'flex-col-reverse items-start')} data-sidebar-foot="">
      <Hint label={hotkey ? `${foldLabel} (${formatHotkeyText(hotkey)})` : foldLabel} side="top">
        <IconButton size="md" tone="strong" aria-label={foldLabel} aria-expanded={isLeftOpen} onClick={toggleLeft} data-testid="sidebar-fold">
          {isLeftOpen ? <ChevronsLeft /> : <ChevronsRight />}
        </IconButton>
      </Hint>
      <Hint label={historyLabel} side="top">
        <IconButton
          size="md"
          tone="strong"
          aria-label={historyLabel}
          on={isCurrentView(currentView, 'session-history')}
          onClick={() => navigate('session-history')}
          data-testid="sidebar-session-history"
        >
          <History />
        </IconButton>
      </Hint>
    </div>
  );
});
