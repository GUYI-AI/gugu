import { useEffect, useRef, useState, type RefObject } from 'react'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import type { GroupChatSettings, GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import { useChatStore } from '../../store/chatContext'
import { useChatFolderName } from './chatFolderName'
import { Folder, LayoutGrid, MessageSquare, MoreHorizontal, Search, UserPlus, Users } from '@/lib/icons'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { groupInviteAccess } from '../../lib/groupMemberPermissions'
import type { groupAgentStatusIndicatorProps } from '../../lib/groupAgentStatus'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Popover } from '../ui/Popover'
import { DropdownMenu, MenuItem, MenuSeparator } from '../ui/Menu'
import { OpenAppMenuItems } from './OpenAppMenuItems'
import { GroupAppsPicker } from './GroupAppsPicker'
import { AddGroupMembers } from './AddGroupMembers'
import { ChatDetailsMenuItems } from './ChatDetailsMenuItems'
import { ChatHeaderSwitches } from './ChatHeaderSwitches'
import { GroupTopicsRows, TopicCallChip, TopicUnreadChip } from './GroupTopicsRows'
import { useChatTopicPins } from './useChatTopicPins'
import { topicCallTotal, topicUnreadTotal } from './topicPinsModel'
import { useStripNarrow } from '../../session/renderer/features/tabs/tab-strip-narrow'
import type { ChatTopicState } from '../../session/renderer/features/chats/chat-tabs/chat-tab-providers'
import { useInnerSidebarChat } from '../../lib/innerSidebarBridge'

interface ChatHeaderActionsProps {
  isGroupChat: boolean
  isRoomChat: boolean
  memberTopic?: ChatTopicState | null
  memberTopicCount?: number
  infoShown: boolean
  showHeaderMenu: boolean
  mobile?: boolean
  room?: {
    snapshot: GroupCollabSnapshot
    settings: GroupChatSettings | null
    statusIndicatorProps?: ReturnType<typeof groupAgentStatusIndicatorProps>
    onReload: () => Promise<void>
  }
  moreButtonRef: RefObject<HTMLButtonElement | null>
  onSearch: () => void
  onOpenFolder: () => void
  onOpenInfo: (page?: 'main' | 'members') => void
  onCloseInfo: () => void
  onToggleHeaderMenu: () => void
  onCloseHeaderMenu: () => void
}

export const ChatHeaderActions = observer(function ChatHeaderActions({
  isGroupChat, isRoomChat, memberTopic, memberTopicCount, infoShown, showHeaderMenu, mobile, room, moreButtonRef,
  onSearch, onOpenFolder, onOpenInfo, onCloseInfo, onToggleHeaderMenu, onCloseHeaderMenu,
}: ChatHeaderActionsProps) {
  const { t } = useTranslation('messaging')
  const { activeChatId } = useChatStore('activeChatId')
  const folderName = useChatFolderName()
  const narrow = useHeaderNarrow(moreButtonRef, Boolean(mobile))
  const groupId = isGroupChat ? activeChatId : null
  const topics = useChatTopicPins(mobile ? null : groupId)
  const invite = groupInviteAccess(activeChatId ?? '', isGroupChat ? 'group' : 'topic', room?.settings ?? null)
  const appsButton = useRef<HTMLButtonElement>(null)
  const [popup, setPopup] = useState<{ chatId: string | null; kind: 'apps' | 'invite' | null }>({ chatId: activeChatId, kind: null })
  if (popup.chatId !== activeChatId) setPopup({ chatId: activeChatId, kind: null })
  const openPopup = (kind: 'apps' | 'invite') => { onCloseHeaderMenu(); setPopup({ chatId: activeChatId, kind }) }
  const closePopup = () => setPopup({ chatId: activeChatId, kind: null })
  const memberCount = memberTopic ? memberTopicCount : room ? room.snapshot.humans.length + room.snapshot.agents.length : 0
  const wideGroup = isGroupChat && !narrow
  // #2548 桌面内层侧栏挂着这个对话时,成员、话题、邀请三枚与那一列重复(成员在它头一行的「…」里),收起来。
  const innerChat = useInnerSidebarChat()
  const innerColumn = !mobile && activeChatId !== null && innerChat === activeChatId
  return <Popover.Root open={popup.kind === 'apps' && !mobile} modal={false} onOpenChange={(open) => open ? openPopup('apps') : closePopup()}>
    {(isRoomChat || memberTopic) && !innerColumn ? <>
      <Button variant="ghost" size="md" className={mobile ? 'min-h-[var(--control-h-touch)]' : undefined} data-testid={AUTOMATION_TEST_IDS.chatHeaderMembersButton} aria-label={t('header.memberList')} title={t('header.memberList')} aria-pressed={infoShown}
        onClick={() => infoShown ? onCloseInfo() : onOpenInfo('members')}>
        <Users className="text-[var(--faint-fg)]" />{memberCount}
      </Button>
      {wideGroup && <span aria-hidden className="mx-1 h-4 border-s border-[var(--border)]" />}
    </> : null}
    {groupId && <>
      {!mobile && !innerColumn && <DropdownMenu.Root key={groupId} modal={false} onOpenChange={(open) => { if (open) { onCloseHeaderMenu(); closePopup() } }}>
        <DropdownMenu.Trigger data-testid={AUTOMATION_TEST_IDS.groupMenuTopics} aria-label={t('history.tabs.topics')}
          render={<Button variant="ghost" size="md" title={narrow ? t('history.tabs.topics') : undefined}><MessageSquare />{!narrow && t('history.tabs.topics')}{topicCallTotal(topics.topics) > 0 ? <TopicCallChip count={topicCallTotal(topics.topics)} at /> : <TopicUnreadChip count={topicUnreadTotal(topics.topics)} />}</Button>} />
        <DropdownMenu.Content data-testid={AUTOMATION_TEST_IDS.groupTopicsPopup} style={{ width: 320, maxWidth: 'min(320px, var(--available-width))' }} align="end">
          <GroupTopicsRows chatId={groupId} />
        </DropdownMenu.Content>
      </DropdownMenu.Root>}
      {/* @@@group-share 邀请(选人 + 链接 / 二维码)在每种宽度都是一步:窄了只收成图标,❌ 收进「更多」。 */}
      {invite.showInvite && !innerColumn && (narrow
        ? <IconButton data-testid={AUTOMATION_TEST_IDS.chatHeaderInviteButton} aria-label={t('header.invite')} title={t('header.invite')} onClick={() => openPopup('invite')}><UserPlus /></IconButton>
        : <Button variant="ghost" size="md" data-testid={AUTOMATION_TEST_IDS.chatHeaderInviteButton} aria-label={t('header.invite')} onClick={() => openPopup('invite')}><UserPlus />{t('header.invite')}</Button>)}
      {wideGroup && <>
        <Popover.Trigger ref={appsButton} data-testid={AUTOMATION_TEST_IDS.chatHeaderAppsButton} onClick={onCloseHeaderMenu}
          render={<Button variant="ghost" size="md" aria-label={t('header.groupApps')}><LayoutGrid />{t('header.groupApps')}</Button>} />
        <span aria-hidden className="mx-1 h-4 border-s border-[var(--border)]" />
      </>}
    </>}
    <DropdownMenu.Root open={showHeaderMenu} modal={false} onOpenChange={(open) => open ? onToggleHeaderMenu() : onCloseHeaderMenu()}>
      <DropdownMenu.Trigger ref={moreButtonRef} data-testid={AUTOMATION_TEST_IDS.chatHeaderMoreButton} title={t('header.more')} aria-pressed={showHeaderMenu}
        render={<IconButton on={showHeaderMenu || undefined} aria-label={t('header.more')}><MoreHorizontal /></IconButton>} />
      {showHeaderMenu && <DropdownMenu.Content data-testid={AUTOMATION_TEST_IDS.groupHeaderMenu} side="bottom" align="end" sideOffset={4} style={{ minWidth: 220 }}>
        {groupId && narrow && <MenuItem onClick={() => openPopup('apps')} icon={<LayoutGrid size={16} />}>{t('header.groupApps')}</MenuItem>}
        <MenuItem data-testid={AUTOMATION_TEST_IDS.chatHeaderSearchButton} onClick={onSearch} icon={<Search size={16} />} shortcut={isRoomChat ? '⌘F' : undefined}>
          {t(isRoomChat ? 'header.searchHistory' : 'header.searchChat')}
        </MenuItem>
        <MenuItem onClick={onOpenFolder} icon={<Folder size={16} />}>{folderName}</MenuItem>
        <ChatDetailsMenuItems isGroupChat={isGroupChat} onOpenInfo={() => isGroupChat ? onOpenInfo('main') : onOpenInfo()} />
        <MenuSeparator />
        <ChatHeaderSwitches />
        {activeChatId && !wideGroup && <OpenAppMenuItems chatId={activeChatId} separated />}
      </DropdownMenu.Content>}
    </DropdownMenu.Root>
    {groupId && popup.kind === 'apps' && <GroupAppsPicker chatId={groupId} mobile={mobile} anchor={narrow ? moreButtonRef : appsButton} onClose={closePopup} />}
    {groupId && popup.kind === 'invite' && room && <AddGroupMembers chatId={groupId} snapshot={room.snapshot} settings={room.settings} canInviteHumans={invite.canInviteHumans}
      humanDeniedHint={invite.projectGroup ? t('group.projectGroupNoInvite') : undefined} onReload={room.onReload} onClose={closePopup} />}
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
