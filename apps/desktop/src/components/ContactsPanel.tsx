import { useShownAgentName } from '@/hooks/useShownAgentName'
import { groupDisplayName } from '@gugu/core/shared/ui/chatModels'
import { AgentContactRow } from './contacts/AgentContactRow'
import { useAgentRowActions } from '@/hooks/useAgentRowActions'
import { contactAgents, peopleContacts } from './contacts/contactSelectors'
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AgentSettingsModal } from './agentsettings/AgentSettingsModal'
import { displayName, sortContactsPinnedFirst, sortGroupChatsPinnedFirst } from '../lib/contactsListSort'
import {
  agentContactRowDotClass,
  agentContactRowStatusClass
} from './contactAgentTone'
import { Collapse } from './ui/Collapse'
import { PaneEmptyState } from './ui/PaneEmptyState'
// @@@ui-ruler 通讯录只消费原语:列/列头 → Pane/PaneHeader、行 → ListRow、图标钮 → IconButton、
// 分区标签 → SectionLabel、小标签/计数 → Chip。几何一律来自 tokens.css 的那把尺子。
import { Sheet } from './ui/Sheet'
import { Pane, PaneHeader } from './ui/Pane'
import { ListRow } from './ui/ListRow'
import { SectionLabel } from './ui/SectionLabel'
import { Chip } from './ui/Chip'
import { ChevronDown, UserPlus, Users } from '@/lib/icons'
import { useContactsStore } from '../store/contactsContext'
import { useChatStore, useStoreValueBy } from '../store/chatContext'
import { useAuth } from '../store/auth'
import { NewFriendsPanel } from './NewFriendsPanel'
import { AddFriendSearch } from './AddFriendSearch'
import { ContactsHeaderActions } from './contacts/AddContactMenu'
import { Avatar } from './Avatar'
import { CreateGroupChatForm, MEMBER_PICKER_SHEET } from './CreateGroupChatModal'
import { ContactsPersonSectionState } from './contacts/ContactsSectionState'
import { ContactsDeviceSections } from './contacts/ContactsDeviceSections'
import { contactsAreEmpty } from './contacts/contactsByDevice'
import { sidebarCountClass } from '../session/renderer/features/sidebar/sidebar-primitives'
import { ContactGroupAvatar, ContactSearch, SelectionCheckbox } from './contacts/ContactSearch'
import { ContactsListDock } from './contacts/ContactsListDock'
import { Button } from './ui/Button'
import { useToast } from './toastContext'
import type { ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'
import { isCloudAgentMarked } from '@gugu/core/shared/enums/agentTypeModels'
import { chatService } from '../lib/chat'
import { closeIfMyAssistant } from '../lib/assistantClose'
import { AUTOMATION_TEST_IDS } from '../lib/automationDom'
import type { QrScanRoute } from '../lib/qrScanRoute'
import { AgentContactProfileCard, PersonContactProfileCard } from './contacts/ContactProfileCard'
import { commonGroupForAgent, requestStateForAgent } from './contacts/agentContactRequest'
import {
  ContactRowContextMenu,
  type ContactRowMenuActions
} from './contacts/ContactRowActions'
import { useRowContextMenu } from '../hooks/useRowContextMenu'
import { ShareAgentModal } from './contacts/ShareAgentModal'
import { GroupInviteJoinModal } from './contacts/GroupInvite'
import { useTranslation } from 'react-i18next'
import { messageForUser } from '../lib/userFacingError'
import { confirmOwnedAgentArchive } from '../lib/archiveOwnedAgent'
import {
  cpaneActionsClass, cpaneAvatarClass, cpaneCardClass, cpaneNameClass, cpaneStatusClass, ct,
  rowAvatarClass, rowKeyActivate, sectionChevronClass, sectionLabelClass
} from './contacts/contactsPanelStyles'
// #855 契约：GroupJoinConfirmDialog 曾从本模块导出，实现搬走后仍从这里透出，外部 import 不受影响。
export { GroupJoinConfirmDialog } from './contacts/GroupInvite'
interface ContactsPanelProps {
  externalContactId?: string
  scanSeed?: { route: QrScanRoute; token: number } | null
  onSwitchToChat?: (target: ContactUser) => void
  onOpenGroupChat?: (group: ContactGroupChat) => void
  /** 开共享 Session Composer 创建草稿(#2549/#2558);缺省 = 拿不到 composer → 入口不渲染。 */
  onOpenAgentCreateDraft?: () => void
}
type LeftSel = 'contacts' | 'new_friends' | 'add_friend' | 'group_chats' | 'agent_library'

// @@@qr-share-as-image - save a data-URL image (e.g. the exported group-invite QR) as a downloaded
// file, used as the fallback when clipboard image write is unavailable.
function PersonContactRow({
  contact,
  selected,
  multiSelected = false,
  selectionMode = false,
  pinned = false,
  onSelect,
  onToggleSelection,
  menu
}: {
  contact: ContactUser
  selected: boolean
  multiSelected?: boolean
  selectionMode?: boolean
  pinned?: boolean
  onSelect: () => void
  onToggleSelection?: () => void
  menu?: ContactRowMenuActions
}) {
  const { menuPos, onContextMenu, closeMenu } = useRowContextMenu()
  return (
    <>
      <ListRow
        role="button"
        tabIndex={0}
        data-contact-id={contact.id}
        data-contact-option={selectionMode ? contact.id : undefined}
        aria-pressed={selectionMode ? multiSelected : undefined}
        selected={selected}
        pinned={pinned}
        leading={
          <>
            {selectionMode ? <SelectionCheckbox checked={multiSelected} /> : null}
            <div className={rowAvatarClass}>
              <Avatar name={contact.display_name} avatarUrl={contact.avatar} seed={contact.id} size="sm" />
            </div>
          </>
        }
        title={displayName(contact)}
        onClick={() => (selectionMode ? onToggleSelection?.() : onSelect())}
        onKeyDown={rowKeyActivate(() => (selectionMode ? onToggleSelection?.() : onSelect()))}
        onContextMenu={menu ? onContextMenu : undefined}
      />
      {menu && menuPos ? (
        <ContactRowContextMenu x={menuPos.x} y={menuPos.y} onClose={closeMenu} {...menu} />
      ) : null}
    </>
  )
}

// ── GroupChatRow (in 3-section sidebar) ──────────────────────────────────────
function GroupSectionRow({
  group,
  selected,
  pinned = false,
  onSelect,
  menu
}: {
  group: ContactGroupChat
  selected: boolean
  pinned?: boolean
  onSelect: () => void
  menu?: ContactRowMenuActions
}) {
  const { menuPos, onContextMenu, closeMenu } = useRowContextMenu()
  return (
    <>
      <ListRow
        role="button"
        tabIndex={0}
        data-group-id={group.id}
        selected={selected}
        pinned={pinned}
        leading={<ContactGroupAvatar group={group} size="sm" />}
        title={groupDisplayName(group)}
        /* show member count like design's group row .st-dot.off — 静态灰点(非 agent 态),用 offline 档 */
        subtitle={
          <span className={agentContactRowStatusClass('offline')}>
            <span className={agentContactRowDotClass('offline')} aria-hidden="true" />
            {ct('panel.memberCount', { count: group.member_count })}
          </span>
        }
        onClick={onSelect}
        onKeyDown={rowKeyActivate(onSelect)}
        onContextMenu={menu ? onContextMenu : undefined}
      />
      {menu && menuPos ? (
        <ContactRowContextMenu x={menuPos.x} y={menuPos.y} onClose={closeMenu} {...menu} />
      ) : null}
    </>
  )
}

// The contacts sidebar. Single scrollable sidebar with
// 3 collapsible sections: Agent / 个人 / 群组.
function ContactsThreeSectionSidebar({
  currentUserId,
  agentContacts,
  humanContacts,
  groupChats,
  pendingCount,
  query,
  onQuery,
  selectedContactId,
  selectedGroupId,
  selectionMode,
  selectedContactIds,
  newFriendsActive,
  onSelectContact,
  onToggleContact,
  onEnterSelectionMode,
  onFinishSelectionMode,
  onCreateGroupFromSelection,
  onSelectGroup,
  onSelectNewFriends,
  onSelectAddFriend,
  onCreateAgent,
  onCreateGroup,
  onStartChat,
  onPin,
  onMarkUnread,
  onToggleNotif,
  onRemove,
  contactPinned,
  contactNotifMuted,
  getContactRemoveLabel,
  onGroupPin,
  onGroupToggleNotif,
  onGroupLeaveOrDissolve,
  groupPinned,
  groupNotifMuted
}: {
  currentUserId?: string | null
  agentContacts: ContactUser[]
  humanContacts: ContactUser[]
  groupChats: ContactGroupChat[]
  pendingCount: number
  query: string
  onQuery: (v: string) => void
  selectedContactId: string | null
  selectedGroupId: string | null
  selectionMode: boolean
  selectedContactIds: Set<string>
  newFriendsActive?: boolean
  onSelectContact: (c: ContactUser) => void
  onToggleContact: (c: ContactUser) => void
  onEnterSelectionMode: () => void
  onFinishSelectionMode: () => void
  onCreateGroupFromSelection: () => void
  onSelectGroup: (g: ContactGroupChat) => void
  onSelectNewFriends: () => void
  onSelectAddFriend: (mode: 'contact' | 'group', seed?: string) => void
  onCreateAgent?: () => void
  onCreateGroup: () => void
  // #886 — 右键菜单同款 chat-scoped 动作（与移动端 ContactRow / 聊天列表行为同步统一）
  onStartChat?: (contact: ContactUser) => void
  onPin?: (contact: ContactUser) => void
  onMarkUnread?: (contact: ContactUser) => void
  onToggleNotif?: (contact: ContactUser) => void
  onRemove?: (contact: ContactUser) => void
  contactPinned?: Map<string, boolean>
  contactNotifMuted?: Map<string, boolean>
  getContactRemoveLabel: (contact: ContactUser) => string
  // #1694 — 群行右键菜单动作（chat-scoped；群本身即 chat，无需 resolveDmId）
  onGroupPin?: (g: ContactGroupChat) => void
  onGroupToggleNotif?: (g: ContactGroupChat) => void
  onGroupLeaveOrDissolve?: (g: ContactGroupChat) => void
  groupPinned?: Map<string, boolean>
  groupNotifMuted?: Map<string, boolean>
}) {
  // #886 — resolve the per-contact right-click menu action set (undefined ⇒ no menu, e.g. new-friends).
  const buildRowMenu = useCallback(
    (c: ContactUser): ContactRowMenuActions | undefined => {
      if (!onPin || !onMarkUnread || !onToggleNotif || !onRemove) return undefined
      return {
        removeLabel: getContactRemoveLabel(c), contact: c, // #5645 → 「设置备注」
        onStartChat: onStartChat ? () => onStartChat(c) : undefined,
        isPinned: contactPinned?.get(c.id) ?? false,
        notifMuted: contactNotifMuted?.get(c.id) ?? false,
        onPin: () => onPin(c),
        onMarkUnread: () => onMarkUnread(c),
        onToggleNotif: () => onToggleNotif(c),
        onRemove: () => onRemove(c)
      }
    },
    [onPin, onMarkUnread, onToggleNotif, onRemove, onStartChat, contactPinned, contactNotifMuted, getContactRemoveLabel]
  )
  // #1694 — 群行右键菜单：复用 ContactRowContextMenu，仅给 置顶 / 通知 / 退出·解散（不传 onStartChat/onMarkUnread）。
  // 角色化：owner → 「解散群聊」，member → 「退出群聊」；确认弹窗 + 真正动作在父层 onGroupLeaveOrDissolve。
  const buildGroupRowMenu = useCallback(
    (g: ContactGroupChat): ContactRowMenuActions | undefined => {
      if (!onGroupPin || !onGroupToggleNotif || !onGroupLeaveOrDissolve) return undefined
      return {
        removeLabel: g.my_role === 'owner' ? ct('contextMenu.dissolveGroup') : ct('contextMenu.leaveGroup'),
        isPinned: groupPinned?.get(g.id) ?? false,
        notifMuted: groupNotifMuted?.get(g.id) ?? g.is_muted,
        onPin: () => onGroupPin(g),
        onToggleNotif: () => onGroupToggleNotif(g),
        onRemove: () => onGroupLeaveOrDissolve(g)
      }
    },
    [onGroupPin, onGroupToggleNotif, onGroupLeaveOrDissolve, groupPinned, groupNotifMuted]
  )
  const [personCollapsed, setPersonCollapsed] = useState(false)
  const agentRowActions = useAgentRowActions({ onSelect: onSelectContact, onToggleSelection: onToggleContact, onStartChat, onPin, onMarkUnread, onToggleNotif, onRemove })

  // #2598 三分区此前完全无排序(置顶点了位置不动 = 假开关)。置顶前置走 contactsListSort,与移动端同一条链路。
  const isContactPinned = useCallback((c: ContactUser) => contactPinned?.get(c.id) ?? false, [contactPinned])
  const isGroupPinned = useCallback((g: ContactGroupChat) => groupPinned?.get(g.id) ?? false, [groupPinned])
  const sortedAgents = sortContactsPinnedFirst(agentContacts, isContactPinned)
  const sortedHumans = sortContactsPinnedFirst(humanContacts, isContactPinned)

  return (
    // @@@ui-ruler 导航列 = Pane nav:列宽 --nav-col-w、底色 --sidebar、右分隔线全由原语给,
    // 与会话列表同宽同色 —— 切 tab 时分隔线不再左右跳。
    <Pane paneRole="nav">
      {/* @@@4322-selection-dock 标题不再在多选态换成计数 —— 计数与批量动作一起收在底部坞里
          （见 contacts/ContactsListDock.tsx）；头部只留稳定标题与模式进出，切模式时不再抖一下。
          添加联系人走独立的 add_friend 路由（@@@add-friend-unify），不是「新的请求」。 */}
      <PaneHeader
        title={ct('panel.title')}
        actions={
          <ContactsHeaderActions
            selectionMode={selectionMode}
            labels={{ selectModeDone: ct('panel.selectModeDone'), selectMode: ct('panel.selectMode') }}
            onFinishSelectionMode={onFinishSelectionMode}
            onEnterSelectionMode={onEnterSelectionMode}
            onSelectAddFriend={onSelectAddFriend}
          />
        }
      />
      <ContactSearch query={query} onQuery={onQuery} people={humanContacts} agents={agentContacts} groups={groupChats} onOpenContact={onSelectContact} onOpenGroup={onSelectGroup}
        pick={selectionMode ? { ids: selectedContactIds, canPick: (c) => c.type !== 'agent' || c.owner_user_id === currentUserId, onToggle: onToggleContact } : undefined}
        onLookupNumber={(number) => onSelectAddFriend('contact', number)}>
      <div className="flex-1 overflow-y-auto !px-2 !pb-3">
        {/* 新的请求 row — @@@1944 目的地统一走 onSelectNewFriends（selectedNav 单一真相源），
            与「添加联系人」+ 同一入口，请求视图只在详情列渲一次（不再有 sidebar 私有 overlay）。 */}
        <ListRow
          role="button"
          tabIndex={0}
          selected={newFriendsActive}
          data-testid={AUTOMATION_TEST_IDS.contactsNewFriendsNav}
          leading={
            <div className="grid h-[var(--avatar-sm)] w-[var(--avatar-sm)] shrink-0 place-items-center rounded-full bg-[var(--warn)] text-[var(--color-white)]">
              <UserPlus size={16} />
            </div>
          }
          title={ct('panel.newRequests')}
          accessory={pendingCount > 0 ? <Chip tone="accent" shape="count">{pendingCount}</Chip> : null}
          onClick={onSelectNewFriends}
          onKeyDown={rowKeyActivate(onSelectNewFriends)}
        />

        <ContactsDeviceSections
          agents={sortedAgents} people={sortedHumans}
          groups={sortGroupChatsPinnedFirst(groupChats, isGroupPinned)}
          currentUserId={currentUserId}
          onCreateAgent={onCreateAgent}
          onCreateGroup={onCreateGroup}
          renderAgent={(c) => (
            <AgentContactRow
              key={c.id} contact={c}
              selected={c.id === selectedContactId}
              multiSelected={selectedContactIds.has(c.id)}
              selectionMode={selectionMode && c.owner_user_id === currentUserId}
              pinned={isContactPinned(c)}
              notifMuted={contactNotifMuted?.get(c.id) ?? false} actions={agentRowActions}
              removeLabel={c.owner_user_id === currentUserId && onPin && onMarkUnread && onToggleNotif && onRemove ? getContactRemoveLabel(c) : undefined}
            />
          )}
          renderGroup={(g) => (
            <GroupSectionRow
              key={g.id}
              group={g}
              selected={g.id === selectedGroupId}
              pinned={isGroupPinned(g)}
              onSelect={() => onSelectGroup(g)}
              menu={buildGroupRowMenu(g)}
            />
          )}
          personSection={
            <>
              <SectionLabel
                interactive
                className={sectionLabelClass}
                leading={<span className={sectionChevronClass(personCollapsed)}><ChevronDown size={16} /></span>}
                trailing={personCollapsed ? <span className={sidebarCountClass}>{sortedHumans.length}</span> : undefined}
                onClick={() => setPersonCollapsed((v) => !v)}
              >
                {ct('panel.contactSectionTitle')}
              </SectionLabel>
              <Collapse open={!personCollapsed} className="gg-c-sec-body">
                {sortedHumans.map((c) => (
                  <PersonContactRow
                    key={c.id}
                    contact={c}
                    selected={c.id === selectedContactId}
                    multiSelected={selectedContactIds.has(c.id)}
                    selectionMode={selectionMode}
                    pinned={isContactPinned(c)}
                    onSelect={() => onSelectContact(c)}
                    onToggleSelection={() => onToggleContact(c)}
                    menu={buildRowMenu(c)}
                  />
                ))}
                <ContactsPersonSectionState isEmpty={contactsAreEmpty(sortedHumans, sortedAgents, groupChats)} onAddContact={() => onSelectAddFriend('contact')} />
              </Collapse>
            </>
          }
        />
      </div>
      </ContactSearch>
      <ContactsListDock
        selectionMode={selectionMode}
        selectedCount={selectedContactIds.size}
        onCreateGroupFromSelection={onCreateGroupFromSelection}
      />
    </Pane>
  )
}

/**
 * 桌面详情列的外壳。原来四个分支各写一遍 `<main style>` + 一条 50px 空 header 条
 * （截图里 y≈77 那条只有线、上面什么都没有的横杠）。现在统一成 Pane detail + PaneHeader：
 * 列头有内容（当前联系人/群名），与会话头同高同线，切 tab 时标题基线不跳。
 */
function CpaneShell({ title, overlay, children }: { title?: string; overlay?: ReactNode; children: ReactNode }) {
  return (
    <Pane paneRole="detail">
      <PaneHeader divider title={title} />
      <div className="flex flex-1 items-start justify-center overflow-y-auto !px-6 !pb-6 !pt-[calc(var(--spacing-2xl)*2)]">
        <div className="w-full max-w-[480px]">{children}</div>
      </div>
      {overlay}
    </Pane>
  )
}

function CpaneGroupHeader({
  group,
  onOpenGroupChat
}: {
  group: ContactGroupChat
  onOpenGroupChat?: (g: ContactGroupChat) => void
}) {
  return (
    <div className={cpaneCardClass}>
      <div className={cpaneAvatarClass}>
        <ContactGroupAvatar group={group} size={96} />
      </div>
      <div className={cpaneNameClass}>{groupDisplayName(group)}</div>
      {/* group status: member count, no dot per design noStatus class */}
      <div className={cpaneStatusClass}>{ct('panel.memberCount', { count: group.member_count })}</div>
      <div className={cpaneActionsClass}>
        <Button variant="primary" size="lg" onClick={() => onOpenGroupChat?.(group)}>
          {ct('panel.enterGroup')}
        </Button>
      </div>
    </div>
  )
}

export const ContactsPanel = memo(function ContactsPanel({
  externalContactId,
  scanSeed,
  onSwitchToChat,
  onOpenGroupChat,
  onOpenAgentCreateDraft
}: ContactsPanelProps) {
  useTranslation('contacts')
  const {
    contacts,
    sharedGroupAgents,
    groupChats,
    pendingRequestCount,
    sentRequests,
    sendRequest,
    removeOwnedAgent,
    removeContact,
  } = useContactsStore()
  const { user } = useAuth()
  const { toast } = useToast()
  const { pinChat, markUnread, setChatNotificationLevel, leaveGroup, deleteChat, refreshChats } = useChatStore('pinChat', 'markUnread', 'setChatNotificationLevel', 'leaveGroup', 'deleteChat', 'refreshChats')
  const chats = useStoreValueBy((store) => store.chats, (store) => store.chats.map((c) => [c.id, c.kind, c.peer_user_id, c.is_pinned, c.notification_level]))
  const [selectedNav, setSelectedNav] = useState<LeftSel>('contacts')
  const [query, setQuery] = useState('')
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null)
  const [contactSelectionMode, setContactSelectionMode] = useState(false)
  const [selectedContactIds, setSelectedContactIds] = useState<Set<string>>(new Set())
  const [requestingAgentId, setRequestingAgentId] = useState<string | null>(null)
  const [showGroupModal, setShowGroupModal] = useState(false) // #2118 — 空群组分区「创建群聊」CTA 开建群弹窗
  // @@@scan-seed (#537-A) - a contact scan routes the 咕咕号 into NewFriendsPanel's search; the token
  // forces a re-search even when the same code is scanned twice. Group scans use `query` directly.
  const [addFriendSeed, setAddFriendSeed] = useState<{ query: string; token: number } | null>(null)
  // #1169 (b): a scanned/pasted group invite QR opens this token-gated join-confirm modal.
  const [groupInviteJoin, setGroupInviteJoin] = useState<{ publicId: number; joinToken?: string; token: number } | null>(null)
  // @@@contacts-sidebar - selected group in the 3-section sidebar (cpane design)
  const [selectedSidebarGroupId, setSelectedSidebarGroupId] = useState<string | null>(null)

  const humanContacts = useMemo(() => peopleContacts(contacts), [contacts])
  const agentContacts = useMemo(() => contactAgents(contacts, sharedGroupAgents), [contacts, sharedGroupAgents])
  const sentRequestIds = useMemo(
    () => new Set(sentRequests.map((request) => request.receiver_id)),
    [sentRequests]
  )
  const requestAgent = useCallback(async (agent: ContactUser) => {
    if (requestingAgentId) return
    setRequestingAgentId(agent.id)
    try {
      await sendRequest(agent.id)
    } finally {
      setRequestingAgentId(null)
    }
  }, [requestingAgentId, sendRequest])
  const getContactRemoveLabel = (contact: ContactUser) =>
    contact.type === 'agent' && contact.owner_user_id === user?.id
      ? ct('contextMenu.deleteAgent')
      : ct('contextMenu.deleteContact')

  // #886 — per-contact DM lookup helpers for pin/notif toggle labels.
  // Returns the existing DM chat for a contact from the loaded chats list, if any.
  const findDm = useCallback(
    (contactId: string) =>
      chats.find(
        (c) => (c.kind === 'dm' || c.kind === 'ai') && c.peer_user_id === contactId
      ),
    [chats]
  )

  // Resolves (or lazily creates) the DM chat ID for a contact.
  const resolveDmId = useCallback(
    async (contact: ContactUser): Promise<string> => {
      const existing = findDm(contact.id)
      if (existing) return existing.id
      return chatService.getOrCreateDM(user!.id, contact.id)
    },
    [findDm, user]
  )

  // Maps each contact id → isPinned / notifMuted derived from the loaded chats list.
  const contactPinned = useMemo(
    () => new Map(contacts.map((c) => [c.id, findDm(c.id)?.is_pinned ?? false])),
    [contacts, findDm]
  )
  const contactNotifMuted = useMemo(
    () => new Map(contacts.map((c) => [c.id, (findDm(c.id)?.notification_level ?? 'all') === 'none'])),
    [contacts, findDm]
  )

  const handleContactPin = useCallback(
    async (contact: ContactUser) => {
      const chatId = await resolveDmId(contact)
      const currentlyPinned = findDm(contact.id)?.is_pinned ?? false
      await pinChat(chatId, !currentlyPinned)
    },
    [resolveDmId, findDm, pinChat]
  )

  const handleContactMarkUnread = useCallback(
    async (contact: ContactUser) => {
      const chatId = await resolveDmId(contact)
      await markUnread(chatId)
    },
    [resolveDmId, markUnread]
  )

  const handleContactToggleNotif = useCallback(
    async (contact: ContactUser) => {
      const chatId = await resolveDmId(contact)
      const currentlyMuted = (findDm(contact.id)?.notification_level ?? 'all') === 'none'
      await setChatNotificationLevel(chatId, currentlyMuted ? 'all' : 'none')
    },
    [resolveDmId, findDm, setChatNotificationLevel]
  )

  // #1694 — 群行右键菜单状态/动作（群本身即 chat，g.id 即 chatId，无需 resolveDmId）。
  const groupPinned = useMemo(
    () => new Map(groupChats.map((g) => [g.id, chats.find((c) => c.id === g.id)?.is_pinned ?? false])),
    [groupChats, chats]
  )
  // #1694-followup — notif 状态与 pin 同源:从 chats(chat store，setChatNotificationLevel 即时更新)读，
  // 不用 g.is_muted(groupChats contacts-store 快照，mute 后不刷新 → label stale + toggle 方向反)。
  const groupNotifMuted = useMemo(
    () => new Map(groupChats.map((g) => [g.id, (chats.find((c) => c.id === g.id)?.notification_level ?? 'all') === 'none'])),
    [groupChats, chats]
  )
  const handleGroupPin = useCallback(
    async (g: ContactGroupChat) => {
      const currentlyPinned = chats.find((c) => c.id === g.id)?.is_pinned ?? false
      await pinChat(g.id, !currentlyPinned)
    },
    [chats, pinChat]
  )
  const handleGroupToggleNotif = useCallback(
    async (g: ContactGroupChat) => {
      // 从 chats live 读当前静音态(对齐 handleContactToggleNotif)，g.is_muted 是快照会 stale。
      const currentlyMuted = (chats.find((c) => c.id === g.id)?.notification_level ?? 'all') === 'none'
      await setChatNotificationLevel(g.id, currentlyMuted ? 'all' : 'none')
    },
    [chats, setChatNotificationLevel]
  )
  // 角色化：owner → 解散群聊（deleteChat persist → chats.status='archived'，全员退出）；
  // member → 退出群聊（leaveGroup 删自己 chat_members 行）。确认弹窗复用 ChatManagementActions 文案。
  const handleGroupLeaveOrDissolve = useCallback(
    async (g: ContactGroupChat) => {
      const isOwner = g.my_role === 'owner'
      const ok = window.confirm(isOwner ? ct('confirmations.dissolveGroup') : ct('confirmations.leaveGroup'))
      if (!ok) return
      // #1694-followup — 对齐 handleRemoveContact:成功/失败都 toast，别静默吞(fail-loud)。
      try {
        if (isOwner) await deleteChat(g.id, true)
        else await leaveGroup(g.id)
        toast(isOwner ? ct('toast.dissolvedGroup') : ct('toast.leftGroup'), 'success')
      } catch (error) {
        toast(isOwner ? ct('toast.dissolveFailed') : ct('toast.leaveFailed'), 'error', messageForUser(error))
      }
    },
    [deleteChat, leaveGroup, toast]
  )

  const scopedContacts = useMemo(() => {
    if (selectedNav === 'agent_library') return agentContacts
    // @@@1944 new_friends 不再是联系人列表的一种 scope——它的请求列表（含已发出）由 NewFriendsPanel
    // 自渲染，桌面/移动都只在一个渲染点出现，无中间联系人行列表。
    if (selectedNav === 'group_chats' || selectedNav === 'new_friends') return []
    return humanContacts
  }, [agentContacts, humanContacts, selectedNav])

  useEffect(() => {
    if (!externalContactId) return
    const contact = contacts.find((item) => item.id === externalContactId)
      ?? sharedGroupAgents.find((item) => item.id === externalContactId)
    if (!contact) return
    setSelectedNav(contact.type === 'agent' ? 'agent_library' : 'contacts')
    setSelectedContactId(contact.id)
  }, [contacts, externalContactId, sharedGroupAgents])

  useEffect(() => {
    if (selectedNav === 'group_chats') return
    if (selectedContactId && scopedContacts.some((contact) => contact.id === selectedContactId))
      return
    setSelectedContactId(scopedContacts[0]?.id ?? null)
  }, [selectedContactId, selectedNav, scopedContacts])

  useEffect(() => {
    if (selectedContactIds.size === 0) return
    const liveIds = new Set(contacts.map((contact) => contact.id))
    setSelectedContactIds((current) => {
      const next = new Set([...current].filter((id) => liveIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [contacts, selectedContactIds.size])

  // @@@scan-seed (#537) - a QR decoded by the chat-list "+" scan (MainLayout owns the camera + tab
  useEffect(() => {
    if (!scanSeed) return
    const { route } = scanSeed
    setSelectedContactId(null)
    // @@@1944 nav 高亮同源清理：new_friends 行按 selectedNav 高亮，群行按 selectedSidebarGroupId
    // 高亮——扫码路由切到 new_friends 时必须一并清群选中，否则双高亮。
    setSelectedSidebarGroupId(null)
    if (route.nav === 'group_join') {
      // #1169 (b): a scanned/pasted group invite QR → token-gated join-confirm modal (bypasses the
      // removed 群号 search box). The route carries the unguessable join_token from the QR payload.
      setGroupInviteJoin({ publicId: route.publicId, joinToken: route.joinToken, token: Date.now() })
    } else {
      // @@@add-friend-unify 扫码得到一个人的咕咕号 = 加人意图 → 直达 add_friend 搜索面板并 seed 查询，
      // 而非「新的请求」收件箱（后者是收发申请，与扫码加人不同意图）。
      setSelectedNav('add_friend')
      setAddFriendSeed({ query: route.query, token: Date.now() })
    }
  }, [scanSeed])

  // ── three-section sidebar derived state ────────────────────────────────────
  const selectedSidebarContact = useMemo(
    () => contacts.find((c) => c.id === selectedContactId)
      ?? sharedGroupAgents.find((c) => c.id === selectedContactId)
      ?? null,
    [contacts, selectedContactId, sharedGroupAgents]
  )
  const selectedShownName = useShownAgentName({ name: selectedSidebarContact ? displayName(selectedSidebarContact) : '', agentType: selectedSidebarContact?.agent_type, createdAt: selectedSidebarContact?.type === 'agent' ? selectedSidebarContact.created_at ?? undefined : undefined })
  const selectedSidebarGroup = useMemo(
    () => groupChats.find((g) => g.id === selectedSidebarGroupId) ?? null,
    [groupChats, selectedSidebarGroupId]
  )

  // @@@cpane-modals — modal state for the desktop cpane action buttons
  const [cpaneSettingsContact, setCpaneSettingsContact] = useState<ContactUser | null>(null)
  const [cpaneShareContact, setCpaneShareContact] = useState<ContactUser | null>(null)
  const [addFriendMode, setAddFriendMode] = useState<'contact' | 'group'>('contact')

  const toggleContactSelection = (contact: ContactUser) => {
    if (contact.type === 'agent' && isCloudAgentMarked(contact)) return
    setSelectedContactIds((current) => {
      const next = new Set(current)
      if (next.has(contact.id)) next.delete(contact.id)
      else next.add(contact.id)
      return next
    })
  }

  const enterContactSelectionMode = () => {
    setSelectedNav('contacts')
    setSelectedContactId(null)
    setSelectedSidebarGroupId(null)
    setContactSelectionMode(true)
    setSelectedContactIds(new Set())
  }

  const finishContactSelectionMode = () => {
    setContactSelectionMode(false)
    setSelectedContactIds(new Set())
  }

  const handleRemoveContact = async (contact: ContactUser) => {
    const name = displayName(contact)
    const isOwnedAgent = contact.type === 'agent' && contact.owner_user_id === user?.id
    if (isOwnedAgent && closeIfMyAssistant(user?.id, contact.id)) return // #7350 删的是咕咕:换成关闭咕咕那份确认
    if (!isOwnedAgent && !window.confirm(ct('confirmations.deleteContact', { name }))) return
    try {
      if (isOwnedAgent) { if (!(await confirmOwnedAgentArchive(contact.id, name, removeOwnedAgent))) return }
      else await removeContact(contact.id)
      toast(ct(isOwnedAgent ? 'toast.deletedAgent' : 'toast.deletedContact'), 'success')
    } catch (error) {
      toast(
        isOwnedAgent ? ct('toast.deleteAgentFailed') : ct('toast.deleteContactFailed'),
        'error', messageForUser(error)
      )
    }
  }

  const groupModal = <Sheet open={showGroupModal} onClose={() => setShowGroupModal(false)} {...MEMBER_PICKER_SHEET} testId="create-group-modal" ariaLabel={ct('createGroup.title')}>
    {showGroupModal ? <CreateGroupChatForm initialSelectedIds={[...selectedContactIds]} onClose={() => setShowGroupModal(false)} onCreated={() => { setShowGroupModal(false); finishContactSelectionMode(); void refreshChats() }} /> : null}
  </Sheet>
  const groupInviteJoinModal = groupInviteJoin ? (
    <GroupInviteJoinModal key={groupInviteJoin.token} publicId={groupInviteJoin.publicId}
      joinToken={groupInviteJoin.joinToken} onClose={() => setGroupInviteJoin(null)} />
  ) : null

  // Desktop layout: three-section sidebar + centered cpane
  // @@@1944 桌面详情列唯一路由：selectedNav（+ 选中实体）→ 详情视图的单一真相源。
  // 每个 nav 目的地在双栏里只渲染一次——列表列恒为联系人导航，详情列由这里决定。
  const cpaneRight = (() => {
    if (selectedNav === 'add_friend') {
      return <AddFriendSearch seed={addFriendSeed} autoFocus showHeader mode={addFriendMode} />
    }
    if (selectedNav === 'new_friends') {
      return <NewFriendsPanel onOpenGroupChat={onOpenGroupChat} />
    }
    if (selectedSidebarGroup) {
      return (
        <CpaneShell title={selectedSidebarGroup.name}>
          <CpaneGroupHeader
            group={selectedSidebarGroup}
            onOpenGroupChat={onOpenGroupChat}
          />
        </CpaneShell>
      )
    }
    if (selectedSidebarContact) {
      const isOwnedAgent =
        selectedSidebarContact.type === 'agent' &&
        selectedSidebarContact.owner_user_id === user?.id
      if (selectedSidebarContact.type === 'agent') {
        const commonGroup = commonGroupForAgent(selectedSidebarContact.id, groupChats)
        const requestState = requestStateForAgent({
          agent: selectedSidebarContact,
          currentUserId: user?.id,
          commonGroup,
          sentRequestIds,
          requestingAgentId,
        })
        return (
          <CpaneShell
            title={selectedShownName}
            overlay={
              <>
                {cpaneSettingsContact?.id === selectedSidebarContact.id ? (
                  <AgentSettingsModal
                    agent={cpaneSettingsContact}
                    onClose={() => setCpaneSettingsContact(null)}
                  />
                ) : null}
                {/* 分享 modal — opens ShareAgentModal (invites friends via shareAgentWithFriends) */}
                {cpaneShareContact?.id === selectedSidebarContact.id ? (
                  <ShareAgentModal
                    agent={cpaneShareContact}
                    contacts={humanContacts}
                    onClose={() => setCpaneShareContact(null)}
                    onOpenGroupChat={onOpenGroupChat}
                  />
                ) : null}
              </>
            }
          >
            {/* 设计稿 cpane = 仅头像/名称/状态 + 动作卡片；旧 AgentDetail 的可见性/运行/共同群等
                不在设计稿 cpane 中（移到 Agent 设置 modal）→ 不再 stack。 */}
            <AgentContactProfileCard
              contact={selectedSidebarContact}
              onSwitchToChat={isOwnedAgent && onSwitchToChat ? () => onSwitchToChat(selectedSidebarContact) : undefined}
              onShare={isOwnedAgent ? () => setCpaneShareContact(selectedSidebarContact) : undefined}
              onSettings={isOwnedAgent ? () => setCpaneSettingsContact(selectedSidebarContact) : undefined}
              onDelete={isOwnedAgent ? () => handleRemoveContact(selectedSidebarContact) : undefined}
              requestState={requestState}
              onRequest={() => requestAgent(selectedSidebarContact)}
              onOpenGroup={commonGroup && onOpenGroupChat ? () => onOpenGroupChat(commonGroup) : undefined}
            />
          </CpaneShell>
        )
      }
      // human contact — 设计稿人物 cpane = 仅头像/名称 + 发消息卡片；旧 HumanDetail 不在设计稿 → 不 stack。
      return (
        <CpaneShell title={selectedShownName}>
          <PersonContactProfileCard
            contact={selectedSidebarContact}
            onSwitchToChat={onSwitchToChat ? () => onSwitchToChat(selectedSidebarContact) : undefined}
          />
        </CpaneShell>
      )
    }
    // empty state
    return (
      <Pane paneRole="detail">
        <PaneHeader divider />
        <div className="gg-c-cpane-empty flex flex-1 items-center justify-center">
          <PaneEmptyState icon={<Users size={26} color="var(--text-tertiary)" />} caption={ct('panel.selectContact')} />
        </div>
      </Pane>
    )
  })()

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-hidden">
      <ContactsThreeSectionSidebar
        currentUserId={user?.id}
        agentContacts={agentContacts}
        humanContacts={humanContacts}
        groupChats={groupChats}
        pendingCount={pendingRequestCount}
        query={query}
        onQuery={setQuery}
        selectedContactId={selectedContactId}
        selectedGroupId={selectedSidebarGroupId}
        selectionMode={contactSelectionMode}
        selectedContactIds={selectedContactIds}
        newFriendsActive={selectedNav === 'new_friends'}
        onSelectContact={(c) => {
          if (contactSelectionMode && c.owner_user_id === user?.id) {
            toggleContactSelection(c)
            return
          }
          setSelectedContactId(c.id)
          setSelectedSidebarGroupId(null)
          setSelectedNav(c.type === 'agent' ? 'agent_library' : 'contacts')
        }}
        onToggleContact={toggleContactSelection}
        onEnterSelectionMode={enterContactSelectionMode}
        onFinishSelectionMode={finishContactSelectionMode}
        onCreateGroupFromSelection={() => setShowGroupModal(true)}
        onSelectGroup={(g) => {
          setContactSelectionMode(false)
          setSelectedContactIds(new Set())
          setSelectedSidebarGroupId(g.id)
          setSelectedContactId(null)
          setSelectedNav('group_chats')
        }}
        onSelectNewFriends={() => {
          setContactSelectionMode(false)
          setSelectedContactIds(new Set())
          setSelectedNav('new_friends')
          setSelectedContactId(null)
          setSelectedSidebarGroupId(null)
        }}
        onSelectAddFriend={(mode, seed) => {
          setAddFriendMode(mode)
          setContactSelectionMode(false)
          setSelectedContactIds(new Set())
          setSelectedNav('add_friend')
          setSelectedContactId(null)
          setSelectedSidebarGroupId(null)
          // @@@add-friend-unify 点按钮进加人搜索必须开在空态：清掉上一次扫码残留的 seed，
          // 否则会用旧扫码号预填搜索（seed effect 按 token 只触发一次，但新挂载会重读旧 token）。
          setAddFriendSeed(seed ? { query: seed, token: Date.now() } : null)
        }}
        onCreateAgent={onOpenAgentCreateDraft}
        onCreateGroup={() => setShowGroupModal(true)}
        onStartChat={onSwitchToChat}
        onPin={handleContactPin}
        onMarkUnread={handleContactMarkUnread}
        onToggleNotif={handleContactToggleNotif}
        onRemove={handleRemoveContact}
        contactPinned={contactPinned}
        contactNotifMuted={contactNotifMuted}
        getContactRemoveLabel={getContactRemoveLabel}
        onGroupPin={handleGroupPin}
        onGroupToggleNotif={handleGroupToggleNotif}
        onGroupLeaveOrDissolve={handleGroupLeaveOrDissolve}
        groupPinned={groupPinned}
        groupNotifMuted={groupNotifMuted}
      />
      {cpaneRight}
      {groupModal}
      {groupInviteJoinModal}
    </div>
  )

})
