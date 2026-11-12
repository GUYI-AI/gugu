import { memo, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatItem, NotificationLevel } from '@gugu/core/shared/types/chat'
import { chatAttention } from '@gugu/core/shared/ui/chatModels'
import { MessageSquare } from '@/lib/icons'
import { cn } from '@/session/renderer/utils/utils'
import { SidebarMenuButton, sidebarRowContentInsetX } from '@/session/renderer/features/sidebar/sidebar-primitives'
import { clearDraggedScreenContent, startChatDrag } from '@/session/renderer/lib/drag-screen-content'
import { useChatStore, useStoreValueBy } from '../../store/chatContext'
import { useRowContextMenu } from '../../hooks/useRowContextMenu'
import { useStableHandler } from '../../hooks/useStableHandler'
import { publishInnerSidebarTopicsView, useInnerSidebarTopicsAll } from '../../lib/innerSidebarBridge'
import { readSessionpageViewRequestBridge } from '../../lib/sessionpageViewRequestBridge'
import { requestTopicSplit } from '../../lib/topicSplitRequest'
import { UI_EVENTS } from '../../lib/uiEvents'
import { Chip } from '../ui/Chip'
import { ChatRowContextMenu } from './ChatRowContextMenu'
import { TopicCallChip } from './GroupTopicsRows'
import { innerSidebarTopicRows, topicsOfChat } from './innerSidebarTopicsModel'

/**
 * #2548 内层侧栏「话题」那一格里的行(会话页留格子,ChatListSlotHost 画进来)。行是侧栏顶上那几行动作行的样子
 * (SidebarMenuButton,对齐分区的内容列,❌ 竖轨与缩进):话题图标 + 名字 + 行尾:叫到你的「@N」(红),其余新消息一个小灰点;
 * 右键是聊天列表话题子行那一份菜单(置顶 / 免打扰 / 删除)。点一行 = 聊天列表里点话题那一下(开源对话,话题开成分栏)。
 * 露哪几条、什么次序见 innerSidebarTopicsModel;分区头的「全部 ›」在会话页那一侧。
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
  const rows = innerSidebarTopicRows(topics, { all })
  const level = innerSidebarTopicRows(topics, { all: false })
  useEffect(
    () => publishInnerSidebarTopicsView({ chatId, total: topics.length, hidden: level.hidden, calling: level.calling }),
    [chatId, topics.length, level.hidden, level.calling],
  )

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
  const setLevel = useStableHandler((topicId: string, notificationLevel: NotificationLevel) => setChatNotificationLevel(topicId, notificationLevel))
  const remove = useStableHandler((topicId: string) => deleteChat(topicId, true))

  return (
    <div role="list" aria-label={t('history.tabs.topics')} data-inner-sidebar-topics={chatId}>
      {rows.shown.map((topic) => (
        <InnerTopicRow key={topic.id} topic={topic} active={topic.id === activeTopicId} onOpen={open} onPin={pin} onSetLevel={setLevel} onRemove={remove} />
      ))}
    </div>
  )
}

const InnerTopicRow = memo(function InnerTopicRow({ topic, active, onOpen, onPin, onSetLevel, onRemove }: {
  topic: ChatItem
  active: boolean
  onOpen: (topic: ChatItem, beside: boolean) => void
  onPin: (topic: ChatItem) => void
  onSetLevel: (topicId: string, level: NotificationLevel) => void
  onRemove: (topicId: string) => void
}) {
  const { t } = useTranslation('messaging')
  const menu = useRowContextMenu()
  const calls = chatAttention(topic).callsYou
  // 拖进聊天区 = 开成分栏:与聊天列表话题子行(TopicSubRow)同一个拖拽源;行里那枚按钮因此放开原生拖拽。
  return (
    <div role="listitem" draggable onDragStart={(event) => startChatDrag(event, topic, topic.name)} onDragEnd={clearDraggedScreenContent}>
      <SidebarMenuButton
        isActive={active}
        allowNativeDrag
        data-topic-row={topic.id}
        aria-label={topic.name ?? ''}
        className="w-full justify-between pr-2"
        onClick={(event) => onOpen(topic, event.metaKey || event.ctrlKey)}
        onContextMenu={menu.onContextMenu}
      >
        <span className={cn('flex min-w-0 items-center gap-2', sidebarRowContentInsetX)}>
          <MessageSquare className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" />
          <span className="truncate">{topic.name}</span>
        </span>
        {/* #2548 叫到你的(点名你、@所有人、回复你说的)是「@N」,同群里话题菜单那一枚;其余新消息只挂小灰点,同一个列表的行。 */}
        {calls > 0 ? <TopicCallChip count={calls} at />
          : topic.unread_count > 0 ? <Chip shape="dot" role="img" aria-label={t('chatList.newsNotCallingYou')} title={t('chatList.newsNotCallingYou')} /> : null}
      </SidebarMenuButton>
      {menu.menuPos && (
        <ChatRowContextMenu
          x={menu.menuPos.x}
          y={menu.menuPos.y}
          chat={topic}
          onClose={menu.closeMenu}
          onPin={() => onPin(topic)}
          onSetNotificationLevel={(level) => onSetLevel(topic.id, level)}
          onDelete={() => onRemove(topic.id)}
        />
      )}
    </div>
  )
})
