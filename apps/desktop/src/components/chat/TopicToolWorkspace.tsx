import { useRef, useState, type ReactNode } from 'react'
import { observer } from 'mobx-react-lite'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { searchInChat } from '@renderer/features/global-search/search-session'
import { closeInfoTab, infoTabOf, openInfoTab, openPanelItem } from '@renderer/features/chats/chat-tabs/chat-layouts'
import { folderItem } from '@renderer/features/chats/chat-tabs/chat-panel-item'
import { TopicChatPanes } from '@renderer/features/chats/chat-tabs/chat-panes'
import { ChatTabPortals } from '../appSlot/ChatTabHosts'
import { GroupTabContent } from '../appSlot/GroupTabContent'
import { useChatStore } from '../../store/chatContext'
import { ChatHeaderActions } from './ChatHeaderActions'
import { TopicMembers } from './ChatSettingsPanel'
import { useChatOpener } from '../appSlot/useChatOpener'

export const TopicToolWorkspace = observer(function TopicToolWorkspace({ chatId, name, memberCount, visible, onForward, children }: {
  chatId: string
  name: string
  memberCount?: number
  visible: boolean
  onForward?: (message: MessageItem) => void
  children: ReactNode
}) {
  const { chats } = useChatStore('chats')
  const sourceChatId = chats.find((chat) => chat.id === chatId)?.source_chat_id
  const opener = useChatOpener(chatId, undefined, undefined, sourceChatId ?? chatId)
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState(false)
  const topic = { topicChatId: chatId, name }
  const openMembers = () => openInfoTab(chatId, 'members', topic)
  const closeMembers = () => closeInfoTab(chatId)
  const actions = <ChatHeaderActions chatId={chatId} isGroupChat={false} isRoomChat={false}
    memberTopic={topic} memberTopicCount={memberCount} infoShown={!!infoTabOf(chatId)?.shown}
    showHeaderMenu={menu} moreButtonRef={moreButtonRef} onSearch={() => searchInChat(chatId)}
    onOpenFolder={() => openPanelItem(chatId, folderItem())} onOpenInfo={openMembers} onCloseInfo={closeMembers}
    onToggleHeaderMenu={() => setMenu(true)} onCloseHeaderMenu={() => setMenu(false)} />
  return (
    <div className="relative h-full min-h-0 min-w-0" data-topic-tool-workspace={chatId}>
      <TopicChatPanes chatId={chatId} name={name} actions={actions} body={children} />
      <ChatTabPortals
        chatId={chatId}
        panel={(tab) => <GroupTabContent chatId={chatId} tabId={tab.tabId} item={tab.item} tabbed inWindow={tab.inWindow} mobile={false} visible={visible && tab.shown} onForward={onForward} onOpenWith={opener.openWith} />}
        topic={() => null}
        info={() => sourceChatId ? <TopicMembers topic={topic} sourceChatId={sourceChatId} onClose={closeMembers} mobile={false} /> : null}
      />
      {opener.overlay}
    </div>
  )
})
