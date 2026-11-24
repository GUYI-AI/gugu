import { Search } from '@/lib/icons';
import { openGlobalSearch } from '@renderer/features/global-search/search-session';
import { getEffectiveHotkey, useShortcutOverrides } from '@renderer/lib/hooks/useKeyboardShortcuts';
import { formatHotkeyText } from '@renderer/lib/ui/shortcut-format';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { innerSidebarChat } from './inner-sidebar-anchor';

/**
 * 侧栏顶上的搜索按钮打开搜索面板(搜聊天和任务里说过的话,Mod+Shift+F 同一个)。按名字跳转是 Mod+O,
 * 它的最后一行把打的字交给这里 —— 两个入口,各管一件事。
 * #2548 ⑦ 开着一个群(内层栏挂在群上,连同从它里面点开的智能体)时先搜这个群:带一枚可删的 in: 条件(同群里 ⌘F 那一条),
 * 面板自己会说别处还有几条。项目 ❌:in: 条件会把任务里说过的话一起关掉,而项目里找的多半正是那些。
 */
function searchScope(): { chips: [{ kind: 'in'; chatId: string }] } | undefined {
  const anchor = innerSidebarChat.get();
  return anchor?.kind === 'group' ? { chips: [{ kind: 'in', chatId: anchor.chatId }] } : undefined;
}

/** The search field at the top of the open sidebar (界面减法 #46): 搜索 and its shortcut in a box. */
export function SidebarSearchTrigger() {
  const { translate } = useSessionMessages();
  const hotkey = getEffectiveHotkey('app.globalSearch', useShortcutOverrides());
  const label = translate('common.search');
  const shortcut = hotkey ? formatHotkeyText(hotkey) : null;
  return (
    <button
      type="button"
      className="window-no-drag-region flex h-8 w-full items-center gap-2 rounded-[9px] bg-background/55 px-[10px] text-sm text-foreground-tertiary-muted shadow-[inset_0_0_0_0.5px_var(--border)] hover:bg-background/80"
      aria-label={translate('sidebar.searchConversations')}
      data-testid="sidebar-search-trigger"
      onClick={() => openGlobalSearch(searchScope())}
    >
      <Search className="size-[15px] shrink-0" />
      <span className="truncate">{label}</span>
      {shortcut && <span className="ml-auto shrink-0 text-xs opacity-80">{shortcut}</span>}
    </button>
  );
}
