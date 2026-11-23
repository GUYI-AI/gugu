import { useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder, LayoutGrid, MessageSquare, Search } from '@/lib/icons'
import { searchInChat } from '@renderer/features/global-search/search-session'
import { folderItem } from '../../session/renderer/features/chats/chat-tabs/chat-panel-item'
import { openPanelItem } from '../../session/renderer/features/chats/chat-tabs/chat-layouts'
import { openApp } from '../appSlot/useOpenApp'
import { DropdownMenu } from '../ui/Menu'
import { Popover } from '../ui/Popover'
import { ChatAppsPicker } from './ChatAppsPicker'
import { useChatFolderName } from './chatFolderName'
import { GroupTopicsRows } from './GroupTopicsRows'

const tileClass = 'flex h-[62px] min-w-0 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl bg-[var(--bg-elevated)] text-[12px] text-[var(--text-primary)] hover:bg-row-hover'

/**
 * The 详情 page's first row (第 16 版): what used to sit at the far end of the chat's strip — search, its Apps, a
 * group's topics, a person chat's folder. A group's members, adding members and its folder are its info rows right
 * under it (GroupInfoRows).
 */
export function ChatDetailsQuickActions({ chatId, isGroup }: { chatId: string; isGroup: boolean }) {
  const { t } = useTranslation('messaging')
  const folderName = useChatFolderName()
  const appsAnchor = useRef<HTMLButtonElement>(null)
  const [appsOpen, setAppsOpen] = useState(false)
  return (
    <div data-testid="chat-details-quick-actions" className="grid grid-cols-3 gap-2 px-3 pt-3 pb-2">
      <Tile icon={<Search size={18} />} label={t(isGroup ? 'header.searchHistory' : 'header.searchChat')} onClick={() => searchInChat(chatId)} />
      {/* A group's folder is the Files row of its info (GroupInfoRows): one entry. */}
      {isGroup ? null : <Tile icon={<Folder size={18} />} label={folderName} onClick={() => openPanelItem(chatId, folderItem())} />}
      <Popover.Root open={appsOpen} modal={false} onOpenChange={setAppsOpen}>
        <Popover.Trigger ref={appsAnchor} render={<Tile icon={<LayoutGrid size={18} />} label={t('header.apps')} />} />
        {appsOpen ? <ChatAppsPicker chatId={chatId} anchor={appsAnchor} onOpen={(app) => openApp(app.extensionId, chatId)} onClose={() => setAppsOpen(false)} /> : null}
      </Popover.Root>
      {isGroup ? <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger render={<Tile icon={<MessageSquare size={18} />} label={t('history.tabs.topics')} />} />
        <DropdownMenu.Content style={{ width: 320, maxWidth: 'min(320px, var(--available-width))' }} align="end">
          <GroupTopicsRows chatId={chatId} />
        </DropdownMenu.Content>
      </DropdownMenu.Root> : null}
    </div>
  )
}

function Tile({ icon, label, ...props }: { icon: ReactNode; label: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={tileClass} {...props}>{icon}<span className="max-w-full truncate px-1">{label}</span></button>
}
