import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { isRoomChat } from '@gugu/core/shared/ui/chatModels'
import { Avatar } from '../Avatar'
import { Popover } from '../ui/Popover'
import { ChatConversationCard } from './ChatConversationCard'

/**
 * gugu-dev#181 聊天画在会话页一块里(项目块的项目群、对话块,见 ChatSlotHost)时的头:对话的头像和名字画进第一枚页签
 * (`title`)。格子还没挂上 = 不画。
 * 第 16 版:顶上只留对话的名字这一颗(#8),点它出名片(#37),名片里「详情 ›」进右边的详情页签;原来页签条右端那排
 * (成员、话题、应用、⋯)都搬进了详情页(ChatSettingsPanel 的 ChatDetailsQuickActions),这里不再画。
 */
export function ChatBlockHead({ host, chat, name, avatar, isAgent }: {
  host: { title: HTMLElement | null }
  chat: ChatItem
  name: string
  avatar: string | null
  isAgent: boolean
}) {
  const room = isRoomChat(chat.kind)
  const [open, setOpen] = useState(false)
  return host.title ? createPortal(
    <Popover.Root open={open} modal={false} onOpenChange={setOpen}>
      <Popover.Trigger nativeButton={false} data-testid="conversation-capsule" render={<span className="flex h-full min-w-0 items-center gap-1" data-chat-block-title="" />}>
        <span className="flex" data-chat-block-avatar=""><Avatar
          name={name}
          avatarUrl={avatar}
          seed={room ? chat.id : chat.peer_user_id ?? undefined}
          isAgent={isAgent}
          variant={room ? 'group' : 'default'}
          size={16}
          still
        /></span>
        <span className="min-w-0 truncate">{name}</span>
      </Popover.Trigger>
      {open ? <Popover.Portal><Popover.Positioner side="bottom" align="center" sideOffset={14} collisionPadding={8}>
        <Popover.Popup aria-label={name}>
          <ChatConversationCard chat={chat} name={name} avatar={avatar} isAgent={isAgent} onClose={() => setOpen(false)} />
        </Popover.Popup>
      </Popover.Positioner></Popover.Portal> : null}
    </Popover.Root>,
    host.title,
  ) : null
}
