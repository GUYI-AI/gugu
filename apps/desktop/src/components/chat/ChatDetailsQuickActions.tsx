import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Folder, Hash, LayoutGrid, Search } from '@/lib/icons'
import { openLinkTarget } from '@/lib/guguLinks'
import { rendererLogger } from '@/lib/log'
import { searchInChat } from '@renderer/features/global-search/search-session'
import { folderItem } from '../../session/renderer/features/chats/chat-tabs/chat-panel-item'
import { openPanelItem } from '../../session/renderer/features/chats/chat-tabs/chat-layouts'
import { openApp } from '../appSlot/useOpenApp'
import { DetailsTile, DetailsTiles } from '../details/DetailsParts'
import { DropdownMenu } from '../ui/Menu'
import { Popover } from '../ui/Popover'
import { ChatAppsPicker } from './ChatAppsPicker'
import { useChatFolderName } from './chatFolderName'
import { GroupTopicsRows } from './GroupTopicsRows'

/**
 * The 详情 page's four tiles (第 16 版设计稿 .qa): what used to sit at the far end of the chat's strip — search, its
 * folder, its Apps, a group's topics (a topic's: back to its group). On the desktop 详情 page they are the only entry for each (the group's Files row is
 * the phone's).
 */
export function ChatDetailsQuickActions({ chatId, isGroup, sourceChatId }: {
  chatId: string
  isGroup: boolean
  /** A topic's group: its fourth tile is 回到群 (opens the group, the same way as clicking its row). */
  sourceChatId?: string
}) {
  const { t } = useTranslation('messaging')
  const folderName = useChatFolderName()
  const appsAnchor = useRef<HTMLButtonElement>(null)
  const [appsOpen, setAppsOpen] = useState(false)
  return (
    <DetailsTiles>
      <DetailsTile icon={<Search />} label={t(isGroup ? 'groupDetails.searchHistory' : 'groupDetails.searchChat')} testId="chat-details-search" onClick={() => searchInChat(chatId)} />
      <DetailsTile icon={<Folder />} label={folderName} testId="chat-details-folder" onClick={() => openPanelItem(chatId, folderItem())} />
      <Popover.Root open={appsOpen} modal={false} onOpenChange={setAppsOpen}>
        <Popover.Trigger ref={appsAnchor} render={<DetailsTile icon={<LayoutGrid />} label={t('header.apps')} testId="chat-details-apps" />} />
        {appsOpen ? <ChatAppsPicker chatId={chatId} anchor={appsAnchor} onOpen={(app) => openApp(app.extensionId, chatId)} onClose={() => setAppsOpen(false)} /> : null}
      </Popover.Root>
      {isGroup ? <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger render={<DetailsTile icon={<Hash />} label={t('history.tabs.topics')} testId="chat-details-topics" />} />
        <DropdownMenu.Content className="w-[320px] max-w-[min(320px,var(--available-width))]" align="end">
          <GroupTopicsRows chatId={chatId} />
        </DropdownMenu.Content>
      </DropdownMenu.Root> : null}
      {sourceChatId ? <DetailsTile icon={<ArrowLeft />} label={t('groupDetails.backToGroup')} testId="chat-details-back-to-group"
        onClick={() => { openLinkTarget({ kind: 'chat', chatId: sourceChatId }).catch((error: unknown) => rendererLogger('chat/details').error({ error, chatId: sourceChatId }, 'open the topic\'s group failed')) }} /> : null}
    </DetailsTiles>
  )
}
