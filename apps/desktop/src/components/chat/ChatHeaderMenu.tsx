import type { ReactNode, RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder, LayoutGrid, MoreHorizontal, Search, UserPlus } from '@/lib/icons'
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom'
import { groupInviteAccess } from '@/lib/groupMemberPermissions'
import { useReplica } from '@/lib/replica'
import { openGroupMemberPicker } from '@/lib/uiEvents'
import { IconButton } from '../ui/IconButton'
import { DropdownMenu, MenuItem } from '../ui/Menu'
import { ChatDetailsMenuItems } from './ChatDetailsMenuItems'
import { useChatFolderName } from './chatFolderName'
import { groupSettings } from './useGroupChatSettings'
import { getAppSettingValueSnapshot } from '@renderer/features/settings/app-settings-client'
import { getEffectiveHotkey } from '@renderer/lib/hooks/useKeyboardShortcuts'
import { formatHotkeyText } from '@renderer/lib/ui/shortcut-format'

/** The same conversation menu in the chat header and the desktop group sidebar. */
export function ChatHeaderMenu({
  chatId, isGroupChat, isRoomChat, open, onOpenChange, onSearch, onOpenFolder, onOpenInfo, onOpenApps,
  buttonRef, mobile, sidebar, compactButton, children,
}: {
  chatId: string | null
  isGroupChat: boolean
  isRoomChat: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onSearch: () => void
  onOpenFolder: () => void
  onOpenInfo: () => void
  onOpenApps?: () => void
  buttonRef?: RefObject<HTMLButtonElement | null>
  mobile?: boolean
  sidebar?: boolean
  compactButton?: boolean
  children?: ReactNode
}) {
  const { t } = useTranslation('messaging')
  const folderName = useChatFolderName()
  // #2609 The search item names the shortcut that runs it (app.find with the user's binding) in this platform's keys:
  // ⌘F on macOS, Ctrl+F elsewhere. Read when the menu renders; ❌ a literal.
  const findHotkey = getEffectiveHotkey('app.find', getAppSettingValueSnapshot('keyboard'))
  const settings = useReplica(groupSettings, open && isGroupChat && chatId ? [chatId] : null)
  const canAddMembers = chatId && settings.state === 'value' && groupInviteAccess('group', settings.value).showInvite

  return <DropdownMenu.Root open={open} modal={false} onOpenChange={onOpenChange}>
    <DropdownMenu.Trigger ref={buttonRef} data-testid={sidebar ? 'inner-head-more' : AUTOMATION_TEST_IDS.chatHeaderMoreButton}
      title={t('header.more')} aria-pressed={open}
      render={<IconButton size={sidebar || compactButton ? 'sm' : undefined} tone={sidebar ? 'strong' : undefined} on={open || undefined} aria-label={t('header.more')}><MoreHorizontal /></IconButton>} />
    {open && <DropdownMenu.Content data-testid={AUTOMATION_TEST_IDS.groupHeaderMenu} side="bottom" align="end" sideOffset={4} style={{ minWidth: 220 }}>
      {children}
      {onOpenApps && <MenuItem onClick={onOpenApps} icon={<LayoutGrid size={16} />}>{t('header.apps')}</MenuItem>}
      <MenuItem data-testid={AUTOMATION_TEST_IDS.chatHeaderSearchButton} onClick={onSearch} icon={<Search size={16} />} shortcut={isRoomChat && !mobile && findHotkey ? formatHotkeyText(findHotkey) : undefined}>
        {t(isRoomChat ? 'header.searchHistory' : 'header.searchChat')}
      </MenuItem>
      <MenuItem data-pane-opener="" onClick={onOpenFolder} icon={<Folder size={16} />}>{folderName}</MenuItem>
      <ChatDetailsMenuItems isGroupChat={isGroupChat} onOpenInfo={onOpenInfo} />
      {canAddMembers && <MenuItem icon={<UserPlus size={16} />} data-testid="group-add-members" onClick={() => openGroupMemberPicker(chatId)}>
        {t('group.memberList.addMembers')}
      </MenuItem>}
    </DropdownMenu.Content>}
  </DropdownMenu.Root>
}
