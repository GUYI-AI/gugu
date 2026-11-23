import { useTranslation } from 'react-i18next'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { isRoomChat } from '@gugu/core/shared/ui/chatModels'
import { Search } from '@/lib/icons'
import { useChatStore } from '@/store/chatContext'
import { searchInChat } from '@renderer/features/global-search/search-session'
import { getAppSettingValueSnapshot } from '@renderer/features/settings/app-settings-client'
import { getEffectiveHotkey } from '@renderer/lib/hooks/useKeyboardShortcuts'
import { formatHotkeyText } from '@renderer/lib/ui/shortcut-format'
import { openInfoTab } from '../../session/renderer/features/chats/chat-tabs/chat-layouts'
import { Avatar } from '../Avatar'
import { ConversationCard } from './ConversationCard'
import { useGroupChatSettings } from './useGroupChatSettings'

/**
 * The card of a chat (a person, a group, a topic). Mounted only while open: the group's settings are read then.
 * Its second row is 搜索聊天记录 (a chat has no restart, 第 16 版 #41); rename is the group's own rename (managers only).
 */
export function ChatConversationCard({ chat, name, avatar, isAgent, onClose }: {
  chat: ChatItem
  name: string
  avatar: string | null
  isAgent: boolean
  onClose: () => void
}) {
  const { t } = useTranslation('messaging')
  const { setChatNotificationLevel } = useChatStore('setChatNotificationLevel')
  const room = isRoomChat(chat.kind)
  const { settings, update } = useGroupChatSettings(room ? chat.id : null)
  const findHotkey = getEffectiveHotkey('app.find', getAppSettingValueSnapshot('keyboard'))
  const { identitiesById } = useChatStore('identitiesById')
  const members = chat.member_user_ids ?? []
  // 设计稿名片第二行(群 / 话题):三个叠着的头像 + 「N 名成员」。私聊没有这一行。
  const subtitle = room && members.length > 0 ? <>
    <span className="flex ps-1.5">{members.slice(0, 3).map((id) => <span key={id} className="-ms-1.5 flex rounded-full ring-[1.5px] ring-[var(--popover)]">
      <Avatar name={identitiesById[id]?.display_name ?? ''} avatarUrl={identitiesById[id]?.avatar ?? null} seed={id} size={18} />
    </span>)}</span>
    {t('group.settings.memberCount', { count: members.length })}
  </> : null
  return <ConversationCard
    avatar={<Avatar name={name} avatarUrl={avatar} seed={room ? chat.id : chat.peer_user_id ?? undefined} isAgent={isAgent} harnessBadge={false} variant={room ? 'group' : 'default'} size={44} still />}
    name={name}
    subtitle={subtitle}
    onRename={room && settings?.can_manage ? async (next) => { if (!(await update({ name: next }))) throw new Error('group rename failed') } : null}
    notify={{ on: (chat.notification_level ?? 'all') !== 'none', set: (on) => void setChatNotificationLevel(chat.id, on ? 'all' : 'none') }}
    action={{ icon: <Search size={16} />, label: t(room ? 'header.searchHistory' : 'header.searchChat'), testId: 'conversation-card-search',
      end: findHotkey ? formatHotkeyText(findHotkey) : undefined, run: () => { onClose(); searchInChat(chat.id) } }}
    onDetails={() => { onClose(); openInfoTab(chat.id, 'main') }}
  />
}
