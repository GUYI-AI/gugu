import type { PersonalConversationHiding } from '../../lib/hideListedConversation'
import { memo, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatItem, NotificationLevel } from '@gugu/core/shared/types/chat'
import { chatAttention } from '@gugu/core/shared/ui/chatModels'
import { Archive, MessageSquare, Pin, PinOff } from '@/lib/icons'
import { cn } from '@/session/renderer/utils/utils'
import {
  SidebarMenuAction, SidebarMenuRow, sidebarRowActionsSlotClass, sidebarRowContentInsetX,
  sidebarRowHoverActionsClass, sidebarRowRestActionsClass,
} from '@/session/renderer/features/sidebar/sidebar-primitives'
import { SidebarRowQuickAction } from '@/session/renderer/features/sidebar/sidebar-row-quick-action'
import { clearDraggedScreenContent, startChatDrag } from '@/session/renderer/lib/drag-screen-content'
import { useChatStore, useChatStoreSelect, useStoreValueBy } from '../../store/chatContext'
import { useRowContextMenu } from '../../hooks/useRowContextMenu'
import { useStableHandler } from '../../hooks/useStableHandler'
import { publishInnerSidebarTopicsView, useInnerSidebarTopicsAll } from '../../lib/innerSidebarBridge'
import { readSessionpageViewRequestBridge } from '../../lib/sessionpageViewRequestBridge'
import { useSidebarChatView } from '../../lib/sidebarChatsBridge'
import { blockKey } from '../../lib/sidebarJoinedGroups'
import { Chip } from '../ui/Chip'
import { SearchField } from '../ui/SearchField'
import { ChatRowContextMenu } from './ChatRowContextMenu'
import { TopicCallChip } from './GroupTopicsRows'
import { innerSidebarTopicRows, topicsOfChat } from './innerSidebarTopicsModel'
import { useCloseTopic } from './useCloseTopic'
import { useGroupChatSettings } from './useGroupChatSettings'
import { useToast } from '../toastContext'
import { messageForUser } from '../../lib/userFacingError'

/**
 * #2548 内层侧栏「话题」那一格里的行(会话页留格子,ChatListSlotHost 画进来)。
 * 行尾静止时显示未读，悬停时显示与智能体行共用的快捷按钮。右键和打开沿用聊天列表话题子行的行为。
 * 露哪几条、什么次序见 innerSidebarTopicsModel;分区头的「全部 ›」在会话页那一侧。
 * 「全部 ›」= 这一格原地摊开(yangchichi 11-24 msg:a5090525):顶上一个搜索框筛名字,下面是全部话题;主区照旧是当前会话。
 */
export function InnerSidebarTopics({ chatId }: { chatId: string }) {
  const all = useInnerSidebarTopicsAll() === chatId
  // 搜索词只活在摊开的这一段里:‹ 返回 再打开 = 空框。
  return all ? <AllTopics chatId={chatId} /> : <TopicRows chatId={chatId} all={false} query="" />
}

function AllTopics({ chatId }: { chatId: string }) {
  const { t } = useTranslation('messaging')
  const [query, setQuery] = useState('')
  return (
    <>
      <div className="px-1 pb-1">
        <SearchField
          variant="nav"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={t('history.searchTopics')}
          clearLabel={t('history.searchTopics')}
          onClear={() => setQuery('')}
          autoFocus
        />
      </div>
      <TopicRows chatId={chatId} all query={query} />
    </>
  )
}

function TopicRows({ chatId, all, query }: { chatId: string; all: boolean; query: string }) {
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const closeTopic = useCloseTopic()
  const { pinChat, hideConversation, setChatNotificationLevel } = useChatStore('pinChat', 'hideConversation', 'setChatNotificationLevel')
  // Only this chat's topics: a message elsewhere must not redraw these rows.
  const topics = useStoreValueBy(
    (store) => topicsOfChat(store.chats, chatId),
    (store) => [chatId, store.chats.filter((chat) => chat.source_chat_id === chatId)],
  )
  const { focusedChatId, split = [] } = useSidebarChatView()
  const openTopicIds = topics.filter(topic => topic.id === focusedChatId || split.includes(blockKey.chat(topic.id))).map(topic => topic.id)
  const needle = query.trim().toLocaleLowerCase()
  const rows = innerSidebarTopicRows(needle ? topics.filter((topic) => (topic.name ?? '').toLocaleLowerCase().includes(needle)) : topics, { all, openTopicIds })
  const level = innerSidebarTopicRows(topics, { all: false })
  const sourceRole = useChatStoreSelect((store) => store.chats.find((chat) => chat.id === chatId)?.my_role ?? 'unknown')
  const { settings, error } = useGroupChatSettings(rows.shown.length ? chatId : null, sourceRole)
  // For group/project topics the server derives can_archive_topic from the source group's management authority.
  const canClose = !error && settings?.can_manage === true && (sourceRole === 'unknown' || settings.my_role === sourceRole)
  useEffect(
    () => publishInnerSidebarTopicsView({ chatId, total: topics.length, hidden: level.hidden, calling: level.calling }),
    [chatId, topics.length, level.hidden, level.calling],
  )

  // 与聊天列表侧栏那一份点话题同一条路:话题和群一样是一条主会话,请会话页摆出它自己那一块(#62)。
  const open = useStableHandler((topic: ChatItem, beside: boolean) => {
    const sessionPage = readSessionpageViewRequestBridge()
    if (!sessionPage) throw new Error('sessionpage view request bridge is not installed')
    sessionPage.openChat(topic.id, beside)
  })
  const pin = useStableHandler((topic: ChatItem) => {
    void pinChat(topic.id, !topic.is_pinned).catch((error: unknown) => {
      toast(t('chatArea.management.pinFailed', { reason: messageForUser(error) }), 'error')
    })
  })
  const close = useStableHandler((topic: ChatItem) => closeTopic(topic.id, topic.name ?? ''))
  const setLevel = useStableHandler((topicId: string, notificationLevel: NotificationLevel) => setChatNotificationLevel(topicId, notificationLevel))
  const remove = useStableHandler((topicId: string) => hideConversation(topicId))
  const leaveSplit = useStableHandler((topicId: string) => {
    const sessionPage = readSessionpageViewRequestBridge()
    if (!sessionPage?.leaveSplit) throw new Error('sessionpage view request bridge cannot leave a split')
    sessionPage.leaveSplit(blockKey.chat(topicId))
  })

  if (needle && rows.shown.length === 0) {
    return <p className="px-2 py-1 text-[length:var(--font-caption)] text-[var(--text-tertiary)]">{t('history.empty.searchTopics')}</p>
  }
  return (
    <div role="list" aria-label={t('history.tabs.topics')} data-inner-sidebar-topics={chatId}>
      {rows.shown.map((topic) => (
        <InnerTopicRow key={topic.id} topic={topic} active={topic.id === focusedChatId} onOpen={open} onPin={pin} onClose={canClose ? close : undefined} onSetLevel={setLevel} onRemove={remove} onLeaveSplit={split.includes(blockKey.chat(topic.id)) ? leaveSplit : undefined} />
      ))}
    </div>
  )
}

const InnerTopicRow = memo(function InnerTopicRow({ topic, active, onOpen, onPin, onClose, onSetLevel, onRemove, onLeaveSplit }: {
  topic: ChatItem
  active: boolean
  onOpen: (topic: ChatItem, beside: boolean) => void
  onPin: (topic: ChatItem) => void
  onClose?: (topic: ChatItem) => void
  onRemove: (topicId: string) => Promise<PersonalConversationHiding | undefined>
  onSetLevel: (topicId: string, level: NotificationLevel) => void
  /** Only while the topic is a block of the split screen. */
  onLeaveSplit?: (topicId: string) => void
}) {
  const { t } = useTranslation('messaging')
  const menu = useRowContextMenu()
  const calls = chatAttention(topic).callsYou
  const unread = calls > 0 ? <TopicCallChip count={calls} at />
    : topic.unread_count > 0 ? <Chip shape="dot" role="img" aria-label={t('chatList.newsNotCallingYou')} title={t('chatList.newsNotCallingYou')} /> : null
  // 拖进聊天区 = 开成一块(startChatDrag);行里那枚按钮因此放开原生拖拽。
  return (
    <>
      <SidebarMenuRow
        role="listitem"
        isActive={active || Boolean(onLeaveSplit)}
        className="group/row gap-1 pr-1"
        draggable
        onDragStart={(event) => startChatDrag(event, topic, topic.name)}
        onDragEnd={clearDraggedScreenContent}
        onClick={(event) => onOpen(topic, event.metaKey || event.ctrlKey)}
        onContextMenu={menu.onContextMenu}
      >
        <SidebarMenuAction allowNativeDrag data-topic-row={topic.id} data-pane-opener="" aria-current={active ? 'page' : undefined} aria-label={topic.name ?? ''}
          className={cn('gap-2', sidebarRowContentInsetX)}>
          <MessageSquare className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" />
          <span className="truncate">{topic.name}</span>
        </SidebarMenuAction>
        <span className={sidebarRowActionsSlotClass} data-row-hover-actions>
          <span className={sidebarRowHoverActionsClass}>
            <SidebarRowQuickAction label={t(topic.is_pinned ? 'chatList.unpin' : 'chatList.pin')} onClick={() => onPin(topic)}>
              {topic.is_pinned ? <PinOff /> : <Pin />}
            </SidebarRowQuickAction>
            {onClose && <SidebarRowQuickAction label={t('chatList.closeTopic')} onClick={() => onClose(topic)}>
              <Archive />
            </SidebarRowQuickAction>}
          </span>
          <span className={cn(sidebarRowRestActionsClass, 'mr-1')}>{unread}</span>
        </span>
      </SidebarMenuRow>
      {menu.menuPos && (
        <ChatRowContextMenu
          x={menu.menuPos.x}
          y={menu.menuPos.y}
          chat={topic}
          onClose={menu.closeMenu}
          onPin={() => onPin(topic)}
          onSetNotificationLevel={(level) => onSetLevel(topic.id, level)}
          onHide={() => onRemove(topic.id)}
          onLeaveSplit={onLeaveSplit ? () => onLeaveSplit(topic.id) : undefined}
        />
      )}
    </>
  )
})
