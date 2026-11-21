import { useEffect, useRef, useState, type RefObject } from 'react'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import type { GroupChatSettings, GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import { useChatStore } from '../../store/chatContext'
import { LayoutGrid, MessageSquare, SquarePen, Users } from '@/lib/icons'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Popover } from '../ui/Popover'
import { DropdownMenu, MenuItem, MenuSeparator, MenuSubmenu } from '../ui/Menu'
import { ChatHeaderMenu } from './ChatHeaderMenu'
import { AppsButton, ChatAppsPicker } from './ChatAppsPicker'
import { openApp } from '../appSlot/useOpenApp'
import { GroupTopicsRows, TopicCallChip, TopicUnreadChip } from './GroupTopicsRows'
import { useChatTopicPins } from './useChatTopicPins'
import { topicCallTotal, topicUnreadTotal } from './topicPinsModel'
import { useChatWorkspaceHeaderDensity } from '@renderer/features/tabs/use-chat-workspace-header-density'
import { useStripNarrow } from '../../session/renderer/features/tabs/tab-strip-narrow'
import type { ChatTopicState } from '../../session/renderer/features/chats/chat-tabs/chat-tab-providers'
import { useInnerSidebarChat } from '../../lib/innerSidebarBridge'
import { Unknown } from '../ui/Unknown'

interface ChatHeaderActionsProps {
  chatId?: string
  isGroupChat: boolean
  isRoomChat: boolean
  memberTopic?: ChatTopicState | null
  memberTopicCount?: number
  infoShown: boolean
  showHeaderMenu: boolean
  mobile?: boolean
  membersInMenu?: boolean
  room?: {
    /** null until the roster is read: the count is a placeholder, ❌ 0. */
    snapshot: GroupCollabSnapshot | null
    settings: GroupChatSettings | null
    onReload: () => Promise<void>
  }
  moreButtonRef: RefObject<HTMLButtonElement | null>
  onSearch: () => void
  onCreateAgent?: () => void
  onOpenFolder: () => void
  onOpenInfo: (page?: 'main' | 'members') => void
  onCloseInfo: () => void
  onToggleHeaderMenu: () => void
  onCloseHeaderMenu: () => void
}

export const ChatHeaderActions = observer(function ChatHeaderActions({
  chatId, isGroupChat, isRoomChat, memberTopic, memberTopicCount, infoShown, showHeaderMenu, mobile, membersInMenu, room, moreButtonRef,
  onSearch, onCreateAgent, onOpenFolder, onOpenInfo, onCloseInfo, onToggleHeaderMenu, onCloseHeaderMenu,
}: ChatHeaderActionsProps) {
  const { t } = useTranslation('messaging')
  const { activeChatId: currentChatId } = useChatStore('activeChatId')
  const activeChatId = chatId ?? currentChatId
  const narrow = useHeaderNarrow(moreButtonRef, Boolean(mobile))
  const density = useChatWorkspaceHeaderDensity(moreButtonRef)
  const groupId = isGroupChat ? activeChatId : null
  const topics = useChatTopicPins(mobile ? null : groupId)
  const appsButton = useRef<HTMLButtonElement>(null)
  const [popup, setPopup] = useState<{ chatId: string | null; kind: 'apps' | null }>({ chatId: activeChatId, kind: null })
  if (popup.chatId !== activeChatId) setPopup({ chatId: activeChatId, kind: null })
  const openPopup = (kind: 'apps') => { onCloseHeaderMenu(); setPopup({ chatId: activeChatId, kind }) }
  const closePopup = () => setPopup({ chatId: activeChatId, kind: null })
  const memberCount = memberTopic ? memberTopicCount : room?.snapshot ? room.snapshot.humans.length + room.snapshot.agents.length : null
  const hasMembers = isRoomChat || Boolean(memberTopic)
  const toggleMembers = () => infoShown ? onCloseInfo() : onOpenInfo('members')
  const folded = density === 'menu'
  const labeled = density === 'labeled' || (density === undefined && !narrow)
  const showApps = !!activeChatId && !folded && (density !== undefined || !narrow)
  // #2548 桌面内层侧栏挂着这个对话时，隐藏重复的话题按钮。手机居中页头把成员入口收进更多。
  const innerChat = useInnerSidebarChat()
  const innerColumn = !mobile && activeChatId !== null && innerChat === activeChatId
  const showTopics = !mobile && !innerColumn && !!groupId
  const membersInMore = hasMembers && (folded || membersInMenu)
  const topicsInMore = folded && showTopics
  const appsInMore = folded && !!activeChatId
  const hasFoldedItems = folded && (membersInMore || topicsInMore || appsInMore)
  const actionSize = density ? 'sm' : 'md'
  return <Popover.Root open={popup.kind === 'apps' && !mobile} modal={false} onOpenChange={(open) => open ? openPopup('apps') : closePopup()}>
    {onCreateAgent ? (
      <IconButton aria-label={t('chatList.createAgent')} title={t('chatList.createAgent')} onClick={onCreateAgent}>
        <SquarePen />
      </IconButton>
    ) : null}
    {hasMembers && !membersInMore ? <>
      <Button variant="ghost" size={actionSize} className={mobile ? 'min-h-[var(--control-h-touch)]' : undefined} data-pane-opener="" data-testid={AUTOMATION_TEST_IDS.chatHeaderMembersButton} aria-label={t('header.memberList')} title={t('header.memberList')} aria-pressed={infoShown}
        onClick={toggleMembers}>
        <Users className="text-[var(--faint-fg)]" />{memberCount ?? <Unknown className="w-[1.5ch]" />}
      </Button>
      {isGroupChat && labeled && <span aria-hidden className="mx-1 h-4 border-s border-[var(--border)]" />}
    </> : null}
    {groupId && <>
      {showTopics && !folded && <DropdownMenu.Root key={groupId} modal={false} onOpenChange={(open) => { if (open) { onCloseHeaderMenu(); closePopup() } }}>
        <DropdownMenu.Trigger data-testid={AUTOMATION_TEST_IDS.groupMenuTopics} aria-label={t('history.tabs.topics')}
          render={<Button variant="ghost" size={actionSize} title={t('history.tabs.topics')}><MessageSquare />{labeled && t('history.tabs.topics')}{topicCallTotal(topics.topics) > 0 ? <TopicCallChip count={topicCallTotal(topics.topics)} at /> : <TopicUnreadChip count={topicUnreadTotal(topics.topics)} />}</Button>} />
        <DropdownMenu.Content data-testid={AUTOMATION_TEST_IDS.groupTopicsPopup} style={{ width: 320, maxWidth: 'min(320px, var(--available-width))' }} align="end">
          <GroupTopicsRows chatId={groupId} />
        </DropdownMenu.Content>
      </DropdownMenu.Root>}
    </>}
    {showApps && <>
      <Popover.Trigger ref={appsButton} onClick={onCloseHeaderMenu} render={<AppsButton size={actionSize} labeled={labeled} />} />
      {labeled && <span aria-hidden className="mx-1 h-4 border-s border-[var(--border)]" />}
    </>}
    <ChatHeaderMenu
      chatId={activeChatId} isGroupChat={isGroupChat} isRoomChat={isRoomChat} mobile={mobile} compactButton={density !== undefined} buttonRef={moreButtonRef}
      open={showHeaderMenu} onOpenChange={(open) => open ? onToggleHeaderMenu() : onCloseHeaderMenu()}
      onSearch={onSearch} onOpenFolder={onOpenFolder} onOpenInfo={() => isGroupChat ? onOpenInfo('main') : onOpenInfo()}
      onOpenApps={activeChatId && density === undefined && narrow ? () => openPopup('apps') : undefined}
    >
      {membersInMore ? <MenuItem data-pane-opener="" icon={<Users size={16} />} onClick={toggleMembers}>
        {t('header.memberList')}{memberCount == null ? '' : ` (${memberCount})`}
      </MenuItem> : null}
      {topicsInMore && groupId && <MenuSubmenu icon={<MessageSquare size={16} />} label={t('history.tabs.topics')}>
        <GroupTopicsRows chatId={groupId} />
      </MenuSubmenu>}
      {appsInMore && <MenuItem icon={<LayoutGrid size={16} />} onClick={() => openPopup('apps')}>{t('header.apps')}</MenuItem>}
      {hasFoldedItems && <MenuSeparator />}
    </ChatHeaderMenu>
    {activeChatId && popup.kind === 'apps' && <ChatAppsPicker chatId={activeChatId} onOpen={(app) => openApp(app.extensionId, activeChatId)} mobile={mobile} anchor={showApps ? appsButton : moreButtonRef} onClose={closePopup} />}
  </Popover.Root>
})

/** Tab strips already measure their block. Ordinary page headers measure only their own width. */
function useHeaderNarrow(ref: RefObject<HTMLElement | null>, mobile: boolean) {
  const stripNarrow = useStripNarrow(ref)
  const [pageNarrow, setPageNarrow] = useState(false)
  useEffect(() => {
    if (ref.current?.closest('.session-tab-bar')) return
    const header = ref.current?.closest<HTMLElement>('[data-chat-area-header]')
    if (!header) return
    const measure = () => setPageNarrow(header.getBoundingClientRect().width <= 560)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(header)
    return () => observer.disconnect()
  }, [ref])
  return mobile || stripNarrow || pageNarrow
}
