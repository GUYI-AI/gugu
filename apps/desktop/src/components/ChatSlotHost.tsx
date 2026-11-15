import { useSidebarChatView } from '../lib/sidebarChatsBridge'
import { memo, useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { CHAT_SLOT_PREFIX, InChatSlot, chatPartSlotKey, installShellSlots, readShellSlots } from '../lib/shellSlots'
import { ChatAreaPanel } from './ChatAreaPanel'
import { TaskChatScope } from './assistant/TaskChatScope'
import type { AssistantChatHandlers } from './assistant/AssistantChatSlot'
import { useProjectGroupChats } from '../lib/projectGroupChatsBridge'
import { useChatStore, useStoreValueBy } from '../store/chatContext'
import { useTheme } from '../store/theme'
import { SessionUiTheme } from './sessionpage/SessionUiTheme'

import { isOwnedAgentPeer, openOwnedAgentEntry, useOwnedAgentEntries } from '../lib/ownedAgentConversation'

installShellSlots()

const EMPTY: ReadonlyMap<string, HTMLElement> = new Map()

/**
 * 把对话画进会话页留的格子(gugu-dev#181:项目块的第一枚页签是项目群,对话也是一块)。和对话页同一个群聊组件,
 * 话题、置顶、悄悄话、回应都是现成的;每个格子各是一条活的线(TaskChatScope),和对话页正开着的那条互不挤占。
 * 块里没有群聊头:头上那排图标、对话的头像和名字、开着的话题画进这一块页签条上留的几格(chatPartSlotKey)。
 */
// memo: the shell re-renders on every tab switch; the chat blocks it portals must not (@@@shell-tab-store).
export const ChatSlotHost = memo(function ChatSlotHost(handlers: AssistantChatHandlers) {
  const entryReady = useOwnedAgentEntries()
  const { identitiesById, chatsRead, chatsLoadFailed } = useChatStore('identitiesById', 'chatsRead', 'chatsLoadFailed')
  // 会话页据此决定项目块正中摆文件夹卡(群里还没有消息)还是消息流,会话里「来自 X」写群名。列表读成之前那份空列表是
  // 「还不知道」:不发,❌ 发一份空的让每个项目块先画首页。
  // 名字与对话列表那一行同一个函数(chatDisplayName):私聊没有自己的名字,写对方(备注优先)——列表、⌘K 面板、
  // 「来自 X」三处叫法一样。
  const projectGroupChats = useProjectGroupChats()
  const { theme } = useTheme()
  const sidebarView = useSidebarChatView()
  const slots = readShellSlots()
  const entries = useSyncExternalStore(
    (listener) => slots?.subscribeSlots(listener) ?? (() => undefined),
    () => slots?.getSlots() ?? EMPTY,
  )
  // Only what the slots below read: each re-render here redraws the whole chat block.
  const slotChatIds = [...entries.keys()].filter(key => key.startsWith(CHAT_SLOT_PREFIX)).map(key => key.slice(CHAT_SLOT_PREFIX.length))
  const chats = useStoreValueBy(store => store.chats, store => slotChatIds.map(id => {
    const chat = store.chats.find(chat => chat.id === id)
    return chat ? [id, chat.kind, chat.peer_user_id, chat.name] : null
  }))
  return (
    <>
      {[...entries].flatMap(([key, element]) => {
        if (!key.startsWith(CHAT_SLOT_PREFIX)) return []
        const chatId = key.slice(CHAT_SLOT_PREFIX.length)
        const chat = chats.find(chat => chat.id === chatId)
        if (!chat) return []
        const privateChat = chat.kind === 'dm' || chat.kind === 'ai'
        if (privateChat && !entryReady) return []
        if ((chat?.kind === 'dm' || chat?.kind === 'ai') && isOwnedAgentPeer(chat.peer_user_id)) {
          return [createPortal(<OwnedAgentRedirect chatId={chatId} />, element, key)]
        }
        // Wait only while the initial directory read is unfinished. Missing identities can be permanent for human DMs.
        if (privateChat && !chatsRead && !chatsLoadFailed && (!chat.peer_user_id || !identitiesById[chat.peer_user_id])) return []
        return [createPortal(
          // A block is session-page content the shell draws, in this React tree: its popups portal out of the mount, so they need
          // the session page's theme layer (the +, a file's ⋯, an App's menus).
          <SessionUiTheme theme={theme}>
            <InChatSlot.Provider value={{ projectName: projectGroupChats.has(chatId) ? chats.find((chat) => chat.id === chatId)?.name ?? null : null }}>
              <TaskChatScope chatId={chatId}>
                <ChatAreaPanel
                  viewportKey={key}
                  navigationTarget={sidebarView.focusedChatId === chatId}
                  blockHost={{
                    actions: entries.get(chatPartSlotKey('actions', chatId)) ?? null,
                    title: entries.get(chatPartSlotKey('title', chatId)) ?? null,
                    tabs: entries.get(chatPartSlotKey('tabs', chatId)) ?? null,
                  }}
                  {...handlers}
                />
              </TaskChatScope>
            </InChatSlot.Provider>
          </SessionUiTheme>,
          element,
          key,
        )]
      })}
    </>
  )
})

/** Old restored chat blocks cannot mount an owned agent's IM transcript. */
function OwnedAgentRedirect({ chatId }: { chatId: string }) {
  useEffect(() => { openOwnedAgentEntry(chatId) }, [chatId])
  return null
}
