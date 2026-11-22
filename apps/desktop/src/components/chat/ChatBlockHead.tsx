import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { isRoomChat } from '@gugu/core/shared/ui/chatModels'
import { Avatar } from '../Avatar'
import { OwnedAgentNameEditor } from '../contacts/OwnedAgentNameEditor'

/**
 * gugu-dev#181 聊天画在会话页一块里(项目块的项目群、对话块,见 ChatSlotHost)时的头:块顶上那条页签条就是头,
 * 头栏右边那排图标画进块顶的 `actions` 那一格,对话的头像和名字画进第一枚页签(`title`)。格子还没挂上 = 不画。
 */
export function ChatBlockHead({ host, actions, chat, name, avatar, isAgent, agentIdentity }: {
  host: { actions: HTMLElement | null; title: HTMLElement | null }
  actions: ReactNode
  chat: ChatItem
  name: string
  avatar: string | null
  isAgent: boolean
  agentIdentity?: { id: string; display_name: string; owner_user_id?: string | null; removed_at?: string | null }
}) {
  const room = isRoomChat(chat.kind)
  const title = (
    <span className="flex min-w-0 items-center gap-1" data-chat-block-title="">
      <Avatar
        name={name}
        avatarUrl={avatar}
        seed={room ? chat.id : chat.peer_user_id ?? undefined}
        isAgent={isAgent}
        variant={room ? 'group' : 'default'}
        size={16}
        still
      />
      <span className="min-w-0 truncate">{name}</span>
    </span>
  )
  return (
    <>
      {host.actions ? createPortal(actions, host.actions) : null}
      {host.title ? createPortal(
        !room && isAgent && agentIdentity && !agentIdentity.removed_at ? (
          <OwnedAgentNameEditor key={agentIdentity.id} agentId={agentIdentity.id} name={agentIdentity.display_name}
            ownerUserId={agentIdentity.owner_user_id} clickName>{title}</OwnedAgentNameEditor>
        ) : title,
        host.title,
      ) : null}
    </>
  )
}
