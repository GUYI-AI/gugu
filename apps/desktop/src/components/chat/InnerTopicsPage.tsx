import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft } from '@/lib/icons'
import { useStoreValueBy } from '../../store/chatContext'
import { setInnerSidebarTopicsAll } from '../../lib/innerSidebarBridge'
import { IconButton } from '../ui/IconButton'
import { SearchField } from '../ui/SearchField'
import { InnerSidebarTopics } from './InnerSidebarTopics'
import { topicsOfChat } from './innerSidebarTopicsModel'

/**
 * 「全部 ›」打开的话题页(yangchichi msg:616413ff、e19b6836):开在这个群 / 项目那一块里(主区,❌ 右侧栏)。
 * 顶上是分区头「话题 N」,下面一个搜索框筛名字,再下面是全部话题 —— 和一级侧边栏同一套行(置顶、归档、未读、打开)。
 * 点开一条话题 = 换主会话(#62),这一页随那一块一起走;‹ 回到群本身。
 */
export function InnerTopicsPage({ chatId }: { chatId: string }) {
  const { t } = useTranslation('messaging')
  const [query, setQuery] = useState('')
  const topics = useStoreValueBy(
    (store) => topicsOfChat(store.chats, chatId),
    (store) => [chatId, store.chats.filter((chat) => chat.source_chat_id === chatId)],
  )
  const needle = query.trim().toLocaleLowerCase()
  const matches = needle ? topics.filter((topic) => (topic.name ?? '').toLocaleLowerCase().includes(needle)).length : topics.length
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-topics-page={chatId}>
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-3 px-6 pt-6 pb-10">
        <div className="flex items-center gap-1">
          <IconButton size="sm" aria-label={t('common.back')} onClick={() => setInnerSidebarTopicsAll(null)}>
            <ChevronLeft />
          </IconButton>
          <span className="flex items-center gap-3 text-[13px] text-[var(--text-tertiary)]" data-topics-page-head="">
            <span>{t('history.tabs.topics')}</span>
            <span className="tabular-nums">{topics.length}</span>
          </span>
        </div>
        <SearchField
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={t('history.searchTopics')}
          clearLabel={t('history.searchTopics')}
          onClear={() => setQuery('')}
          autoFocus
        />
        {matches === 0 ? (
          <p className="px-2 py-1 text-[12.5px] text-[var(--text-tertiary)]">{t(needle ? 'history.empty.searchTopics' : 'history.empty.topics')}</p>
        ) : (
          <InnerSidebarTopics chatId={chatId} page query={query} />
        )}
      </div>
    </div>
  )
}
