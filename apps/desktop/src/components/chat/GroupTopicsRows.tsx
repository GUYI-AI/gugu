import { useTranslation } from 'react-i18next'
import { chatAttention } from '@gugu/core/shared/ui/chatModels'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { Chip } from '../ui/Chip'
import { MenuItem } from '../ui/Menu'
import { ListRowContent } from '../ui/ListRow'
import { openTopicChat } from '@/hooks/useTopicSurface'
import { useGroupTopics } from './useGroupTopics'
import { ConversationRowContextMenu } from './ConversationRowContextMenu'
import { useRowContextMenu } from '../../hooks/useRowContextMenu'
import { useMarkChatsRead } from '../../hooks/useMarkChatsRead'
import { hasUnreadInRows } from '../../session/shared/conversation-row-menu'
import './group-topics.css'

/** 行几何是 ListRow 的(会话列表同一把尺),这里只把菜单行的上下内距换成列表行的。 */
const topicRowStyle = { padding: 'var(--row-pad) 10px' }

export function TopicUnreadChip({ count, muted = false }: { count: number; muted?: boolean }) {
  return count > 0 ? <Chip tone={muted ? 'default' : 'accent'} shape="count">{count > 99 ? '99+' : count}</Chip> : null
}

/** 叫到你的条数:红底,和项目行上的数同一个来源。 */
export function TopicCallChip({ count, at = false }: { count: number; at?: boolean }) {
  return <Chip tone="danger" shape="count">{at ? '@' : ''}{count > 99 ? '99+' : count}</Chip>
}

export function GroupTopicsRows({ chatId }: { chatId: string }) {
  const { t } = useTranslation('messaging')
  const topics = useGroupTopics(chatId)
  return <div className="gg-topic-list">
    {topics.map(topic => <TopicMenuRow key={topic.id} topic={topic} topics={topics} />)}
    {topics.length === 0 && <MenuItem disabled><span className="gg-topic-empty">{t('history.empty.topics')}<small>{t('topic.menu.emptyHint')}</small></span></MenuItem>}
  </div>
}

function TopicMenuRow({ topic, topics }: { topic: ChatItem; topics: ChatItem[] }) {
  const menu = useRowContextMenu()
  const markRead = useMarkChatsRead()
  const calls = chatAttention(topic).askingYou
  return <div className="gg-topic-menu-row" data-topic-id={topic.id} onContextMenu={menu.onContextMenu}>
    {menu.menuPos && <ConversationRowContextMenu {...menu.menuPos} onClose={menu.closeMenu} entry="topic-popup"
      state={{ kind: 'topic', hasUnread: hasUnreadInRows([topic]), hasTopicsUnread: hasUnreadInRows(topics) }}
      run={{ 'mark-read': () => markRead(topic.id), 'mark-topics-read': () => markRead(topics.map((row) => row.id)) }} />}
    <MenuItem data-testid="group-menu-topic" data-pane-opener="" className="gg-topic-menu-open" style={topicRowStyle} render={<div data-emphasis={topic.unread_count > 0 || undefined} />} onClick={() => openTopicChat(topic.id)}>
      <ListRowContent title={topic.name}
        meta={topic.unread_count > 0 ? (calls > 0 ? <TopicCallChip count={calls} at /> : <TopicUnreadChip count={topic.unread_count} muted={topic.is_muted} />) : undefined} />
    </MenuItem>
  </div>
}
