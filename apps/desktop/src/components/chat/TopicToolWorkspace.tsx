import type { ReactNode } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { TopicChatPanes } from '@renderer/features/chats/chat-tabs/chat-panes'
import { ChatTabPortals } from '../appSlot/ChatTabHosts'
import { GroupTabContent } from '../appSlot/GroupTabContent'
import { useChatStore } from '../../store/chatContext'
import { useChatOpener } from '../appSlot/useChatOpener'

export function TopicToolWorkspace({ chatId, title, visible, onForward, children }: {
  chatId: string
  title: ReactNode
  visible: boolean
  onForward?: (message: MessageItem) => void
  children: ReactNode
}) {
  const { chats } = useChatStore('chats')
  const sourceChatId = chats.find((chat) => chat.id === chatId)?.source_chat_id
  const opener = useChatOpener(chatId, undefined, undefined, sourceChatId ?? chatId)
  return (
    <div className="relative h-full min-h-0 min-w-0" data-topic-tool-workspace={chatId}>
      <TopicChatPanes chatId={chatId} title={title} body={children} />
      <ChatTabPortals
        chatId={chatId}
        panel={(tab) => <GroupTabContent chatId={chatId} tabId={tab.tabId} item={tab.item} tabbed inWindow={tab.inWindow} mobile={false} visible={visible && tab.shown} onForward={onForward} onOpenWith={opener.openWith} />}
        topic={() => null}
        info={() => null}
      />
      {opener.overlay}
    </div>
  )
}
