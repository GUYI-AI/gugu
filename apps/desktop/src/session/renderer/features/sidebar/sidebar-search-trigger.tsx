import { Search } from '@/lib/icons'
import { BoundShortcut } from '@renderer/lib/ui/shortcut';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { openGlobalSearch } from '@renderer/features/global-search/search-session';
import { innerSidebarChat } from './inner-sidebar-anchor';
import { sidebarRowContentInsetX, sidebarRowShortcutClass } from './sidebar-primitives';

/**
 * 侧栏顶上的「搜索…」:打开搜索面板(搜聊天和任务里说过的话,Mod+Shift+F 同一个)。按名字跳转是 Mod+O,
 * 它的最后一行把打的字交给这里 —— 两个入口,各管一件事。
 * #2548 ⑦ 开着一个群(内层栏挂在群上,连同从它里面点开的智能体)时先搜这个群:带一枚可删的 in: 条件(同群里 ⌘F 那一条),
 * 面板自己会说别处还有几条。项目 ❌:in: 条件会把任务里说过的话一起关掉,而项目里找的多半正是那些。
 */
function searchScope(): { chips: [{ kind: 'in'; chatId: string }] } | undefined {
  const anchor = innerSidebarChat.get();
  return anchor?.kind === 'group' ? { chips: [{ kind: 'in', chatId: anchor.chatId }] } : undefined;
}

export function SidebarSearchTrigger() {
  const { translate } = useSessionMessages();
  return (
    // Keep one visible line. The full label wraps out of view when its natural width does not fit beside the icon.
    // The icon centres on its own line, and the shortcut still follows the search field's width.
    <button
      type="button"
      onClick={() => openGlobalSearch(searchScope())}
      aria-label={translate('sidebar.searchConversations')}
      data-testid="sidebar-search-trigger"
      className="group/row @container flex h-8 min-w-0 w-full flex-wrap content-start items-center justify-center overflow-hidden rounded-full bg-[var(--em-surface-input)] text-sm text-foreground-tertiary-muted [-webkit-app-region:no-drag]"
    >
      <span className={cn('flex h-8 shrink-0 items-center pr-2 @max-[2rem]:px-0', sidebarRowContentInsetX)}>
        <Search className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" />
      </span>
      <span aria-hidden="true" className="flex h-8 min-w-max flex-1 items-center whitespace-nowrap">{translate('sidebar.searchPlaceholder')}</span>
      <BoundShortcut commandId="app.globalSearch" variant="keycaps" className={cn(sidebarRowShortcutClass, 'ml-2 @max-[11.5rem]:hidden')} />
    </button>
  );
}
