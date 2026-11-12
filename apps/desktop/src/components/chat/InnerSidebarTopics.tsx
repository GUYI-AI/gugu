import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatItem, NotificationLevel } from '@gugu/core/shared/types/chat'
import { TopicSubRow, TopicSubRows, type ChatRowActions } from '../ChatListPanel'
import { useChatStore, useStoreValueBy } from '../../store/chatContext'
import { useStableHandler } from '../../hooks/useStableHandler'
import { publishInnerSidebarTopicsView, setInnerSidebarTopicsAll, useInnerSidebarTopicsAll } from '../../lib/innerSidebarBridge'
import { readSessionpageViewRequestBridge } from '../../lib/sessionpageViewRequestBridge'
import { requestTopicSplit } from '../../lib/topicSplitRequest'
import { UI_EVENTS } from '../../lib/uiEvents'
import { innerSidebarTopicLevels, topicIsSunkAt, topicsOfChat } from './innerSidebarTopicsModel'

/**
 * #2548 内层侧栏「话题」那一格里的行(会话页留格子,ChatListSlotHost 画进来):就是聊天列表里嵌在群下面的那几行
 * (TopicSubRow / TopicSubRows,同一份右键菜单、同一个「更多」),只是挂在内层侧栏里。点一行 = 聊天列表里点话题那一下
 * (开它的源对话,话题开成分栏);「更多」= 分区头的「全部 ›」,摊开这个对话的全部话题。
 */
export function InnerSidebarTopics({ chatId }: { chatId: string }) {
  const { t } = useTranslation('messaging')
  const { pinChat, deleteChat, setChatNotificationLevel } = useChatStore('pinChat', 'deleteChat', 'setChatNotificationLevel')
  // Only this chat's topics: a message elsewhere must not redraw these rows.
  const topics = useStoreValueBy(
    (store) => topicsOfChat(store.chats, chatId),
    (store) => [chatId, store.chats.filter((chat) => chat.source_chat_id === chatId)],
  )
  const all = useInnerSidebarTopicsAll() === chatId
  // 沉降要一个「当下」:逐渲染取(同聊天列表),❌ memo 到话题上。
  const now = Date.now()
  const hidden = innerSidebarTopicLevels(topics, now, false).hidden.length
  useEffect(() => publishInnerSidebarTopicsView({ chatId, total: topics.length, hidden }), [chatId, topics.length, hidden])

  // 分栏此刻开着哪条话题(行高亮):真值由聊天区广播,同聊天列表(UI_EVENTS.topicSplitChanged)。
  const [activeTopicId, setActiveTopicId] = useState<string | null>(null)
  useEffect(() => {
    const onChanged = (event: Event) => setActiveTopicId((event as CustomEvent<{ chatId: string | null }>).detail?.chatId ?? null)
    window.addEventListener(UI_EVENTS.topicSplitChanged, onChanged)
    return () => window.removeEventListener(UI_EVENTS.topicSplitChanged, onChanged)
  }, [])

  // 与聊天列表侧栏那一份点话题同一条路:请会话页摆出源对话那一块,话题开成分栏。
  const open = useStableHandler((topic: ChatItem, beside: boolean) => {
    const sessionPage = readSessionpageViewRequestBridge()
    if (!sessionPage) throw new Error('sessionpage view request bridge is not installed')
    sessionPage.openChat(chatId, beside)
    requestTopicSplit({ chatId: topic.id, name: topic.name ?? '', sourceChatId: chatId, focusComposer: true })
  })
  const pin = useStableHandler((topic: ChatItem) => pinChat(topic.id, !topic.is_pinned))
  const setLevel = useStableHandler((topicId: string, level: NotificationLevel) => setChatNotificationLevel(topicId, level))
  const remove = useStableHandler((topicId: string) => deleteChat(topicId, true))
  const actions = useMemo<ChatRowActions>(() => ({
    activate: open,
    openTopic: open,
    toggleTopics: () => {
      throw new Error('inner sidebar topic rows have no topics of their own to toggle')
    },
    pin,
    unpinFromSidebar: () => {
      throw new Error('inner sidebar topic rows are never pinned to the sidebar')
    },
    setNotificationLevel: setLevel,
    remove,
    // 这一格没有键盘游标(每一行都在 Tab 序里):获得焦点不用记。
    focus: () => undefined,
    keyDown: (event, topic) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      open(topic, false)
    },
  }), [open, pin, setLevel, remove])

  return (
    <div role="listbox" aria-label={t('history.tabs.topics')} data-inner-sidebar-topics={chatId}>
      <TopicSubRows topics={topics} isSunk={topicIsSunkAt(now)} expanded={all} onExpand={() => setInnerSidebarTopicsAll(chatId)}>
        {(topic) => <TopicSubRow key={topic.id} topic={topic} mobile={false} isActive={topic.id === activeTopicId} tabIndex={0} actions={actions} />}
      </TopicSubRows>
    </div>
  )
}
