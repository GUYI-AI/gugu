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
    // The header owns placement; reuse the existing search surface and content inset.
    // 底色和别处的搜索框同一个输入面(--em-surface-input,#132):它长得就是一个搜索框。
    // #2548 it shares the head row with 「«」, the bell and 会话历史, so it can be narrower than its text plus the hover
    // keycaps: those take their width even while invisible, so below 11rem they are left out (@container) and 「搜索…」
    // keeps its room (the shortcut itself still works).
    <button
      type="button"
      onClick={() => openGlobalSearch(searchScope())}
      aria-label={translate('sidebar.searchConversations')}
      data-testid="sidebar-search-trigger"
      className={cn(
        'group/row @container flex h-8 min-w-0 w-full items-center gap-2 rounded-full bg-[var(--em-surface-input)] text-sm text-foreground-tertiary-muted [-webkit-app-region:no-drag]',
        sidebarRowContentInsetX
      )}
    >
      <Search className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" />
      <span className="min-w-0 flex-1 truncate text-left">{translate('sidebar.searchPlaceholder')}</span>
      <BoundShortcut commandId="app.globalSearch" variant="keycaps" className={cn(sidebarRowShortcutClass, '@max-[11rem]:hidden')} />
    </button>
  );
}
