import { IconButton } from '@/components/ui/IconButton';
import { Hint } from '@/components/ui/Tooltip';
import { SearchIcon } from '@renderer/features/global-search/search-icon';
import { openGlobalSearch } from '@renderer/features/global-search/search-session';
import { getEffectiveHotkey, useShortcutOverrides } from '@renderer/lib/hooks/useKeyboardShortcuts';
import { formatHotkeyText } from '@renderer/lib/ui/shortcut-format';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

export function SidebarSearchTrigger() {
  const { translate } = useSessionMessages();
  const hotkey = getEffectiveHotkey('app.quickSwitcher', useShortcutOverrides());
  const label = translate('common.search');
  return (
    <Hint label={hotkey ? `${label} ${formatHotkeyText(hotkey)}` : label} side="bottom">
      <IconButton
        size="md"
        className="window-no-drag-region !size-[34px] !rounded-[10px]"
        aria-label={translate('sidebar.searchConversations')}
        data-testid="sidebar-search-trigger"
        onClick={() => openGlobalSearch()}
      >
        <SearchIcon />
      </IconButton>
    </Hint>
  );
}
