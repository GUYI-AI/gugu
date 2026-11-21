import { useShownAgentName } from '@/hooks/useShownAgentName'
import { myAgents, peopleContacts } from './contacts/contactSelectors'
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AgentSettingsModal } from './agentsettings/AgentSettingsModal'
import { displayName, sortContactsPinnedFirst, sortGroupChatsPinnedFirst } from '../lib/contactsListSort'
// @@@ui-ruler 通讯录只消费原语:列/列头 → Pane/PaneHeader、行 → ListRow、图标钮 → IconButton、
// 分区标签 → SectionLabel、小标签/计数 → Chip。几何一律来自 tokens.css 的那把尺子。
import { Sheet } from './ui/Sheet'
import { Pane, PaneHeader } from './ui/Pane'
import { navigateMobile } from '@/mobile/navigateMobile'
import { SectionLabel } from './ui/SectionLabel'
import { Chip } from './ui/Chip'
import {
  ChevronRight,
  Check,
  MessageCircle,
  Pencil,
  Plus,
  Tag,
  Trash2,
  UserPlus,
  Users,
  X
} from '@/lib/icons'
import { OnContactsHidden } from './contacts/OnContactsHidden'
import { useContactsStore } from '../store/contactsContext'
import { useChatStore, useStoreValueBy } from '../store/chatContext'
import { useAuth } from '../store/auth'
import { NewFriendsPanel } from './NewFriendsPanel'
import { AddFriendSearch } from './AddFriendSearch'
import { ContactsHeaderActions } from './contacts/AddContactMenu'
import { IconButton } from './contactsDetailControls'
import { CreateGroupChatForm, MEMBER_PICKER_SHEET } from './CreateGroupChatModal'
import { ContactsGroupSectionState } from './contacts/ContactsSectionState'
import { ContactsSectionNav } from './contacts/ContactsDeviceSections'
import { useContactsSections, type ContactsSection } from './contacts/contactsSections'
import { ContactsSectionPane } from './contacts/ContactsSectionPane'
import { useDesktopContactSearch } from './contacts/ContactsSearchPane'
import type { ContactsRowHandlers } from './contacts/ContactRows'
import { ContactSearch } from './contacts/ContactSearch'
import { ContactsListDock } from './contacts/ContactsListDock'
import { GroupChatDetailPane } from './contacts/GroupChatDetailPane'
import { sortGroupsByActivity } from './contacts/groupRowFacts'
import { useToast } from './toastContext'
import type { ContactGroup, ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'
import { isCloudAgentMarked } from '@gugu/core/shared/enums/agentTypeModels'
import { chatService } from '../lib/chat'
import { closeIfMyAssistant } from '../lib/assistantClose'
import { AUTOMATION_TEST_IDS } from '../lib/automationDom'
import type { QrScanRoute } from '../lib/qrScanRoute'
import { AgentContactProfileCard, PersonContactProfileCard } from './contacts/ContactProfileCard'
import { commonGroupForAgent, requestStateForAgent } from './contacts/agentContactRequest'
import type { ContactRowMenuActions } from './contacts/ContactRowActions'
import { ShareAgentModal } from './contacts/ShareAgentModal'
import { GroupInviteJoinModal } from './contacts/GroupInvite'
import { ContactsIndex } from './contacts/ContactsIndex'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { messageForUser } from '../lib/userFacingError'
import { confirmOwnedAgentArchive } from '../lib/archiveOwnedAgent'
import { confirmConversationAction } from '../lib/confirmDanger'
import { ContactDetail, GroupChatRow, PaneBackButton } from './contacts/ContactDetail'
import { ct, groupChatListCountLabel, groupChatListTitle, groupChatSummaryLabel, inlineInputClass } from './contacts/contactsPanelStyles'
// #855 契约：GroupJoinConfirmDialog 曾从本模块导出，实现搬走后仍从这里透出，外部 import 不受影响。
export { GroupJoinConfirmDialog } from './contacts/GroupInvite'
interface ContactsPanelProps {
  externalContactId?: string
  mobile?: boolean
  scanSeed?: { route: QrScanRoute; token: number } | null
  onSwitchToChat?: (target: ContactUser) => void
  onOpenGroupChat?: (group: ContactGroupChat) => void
  /** 开共享 Session Composer 创建草稿(#2549/#2558);缺省 = 拿不到 composer → 入口不渲染。 */
  onOpenAgentCreateDraft?: () => void
}
type LeftSel = 'contacts' | 'new_friends' | 'add_friend' | 'group_chats' | 'agent_library' | `group:${string}`
type MobileContactsPane = 'nav' | 'index' | 'detail'

// @@@qr-share-as-image - save a data-URL image (e.g. the exported group-invite QR) as a downloaded
// file, used as the fallback when clipboard image write is unavailable.
function NavButton({
  icon,
  label,
  active,
  count,
  badge,
  testId,
  mobile = false,
  onClick
}: {
  icon?: React.ReactNode
  label: string
  active: boolean
  count?: number
  badge?: number
  testId?: string
  mobile?: boolean
  onClick: () => void
}) { // 手机入口页整屏换页,回来时不该有哪行亮着 ⇒ 手机不画选中(同 SettingsNav 的 isActive)
  return (
    <button
      type="button"
      data-testid={testId}
      data-selected={(active && !mobile) || undefined}
      className={cn(
        'gg-row flex w-full cursor-pointer select-none items-center rounded-[var(--radius-control)] border-0 text-left text-[var(--fg)]',
        mobile ? 'min-h-[var(--control-h-touch)] gap-3 !px-3' : 'min-h-[var(--control-h-lg)] gap-2 !px-2',
      )}
      onClick={onClick}
    >
      <span className={cn('flex shrink-0', mobile ? 'w-5' : 'w-[15px]', active && !mobile ? 'text-[var(--primary)]' : 'text-[var(--muted-fg)]')}>{icon}</span>
      {/* @@@ui-ruler 字阶取 token(mobile 15 / desktop 13);inline 只为在同一行里二选一,❌ 裸像素。 */}
      <span
        className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
        style={{ fontSize: mobile ? 'var(--font-title)' : 'var(--font-body)' }}
      >
        {label}
      </span>
      {badge !== undefined && badge > 0 ? (
        <Chip tone="danger" shape="count">{badge > 99 ? '99+' : badge}</Chip>
      ) : count !== undefined ? (
        <span className="text-xs text-[var(--muted-fg)]">{count}</span>
      ) : null}{mobile && <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-[var(--faint-fg)]" />}
    </button>
  )
}

function GroupNameEditor({
  value,
  placeholder,
  onSave,
  onCancel
}: {
  value: string
  placeholder: string
  onSave: (name: string) => Promise<void> | void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    const name = draft.trim()
    if (!name || saving) return
    setSaving(true)
    try {
      await onSave(name)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-center gap-1">
      <input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') save()
          if (event.key === 'Escape') onCancel()
        }}
        placeholder={placeholder}
        className={inlineInputClass}
      />
      <IconButton title={ct('profile.saveAlias')} onClick={save}>
        <Check size={14} />
      </IconButton>
      <IconButton title={ct('common.cancel')} onClick={onCancel}>
        <X size={14} />
      </IconButton>
    </div>
  )
}


// 桌面左栏:新的请求 + 分组(一行一个,❌ 折叠展开)。点分组 → 右边大区域铺开这一组(ContactsSectionPane)。
function ContactsThreeSectionSidebar({
  mobile, searchField, pendingCount, sections, selectedSectionKey, onSelectSection, selectionMode, selectedContactIds, newFriendsActive,
  onEnterSelectionMode, onFinishSelectionMode, onCreateGroupFromSelection, onSelectNewFriends, onSelectAddFriend,
}: {
  mobile?: boolean
  /** 搜索框(结果铺在右边大区域,见 ContactsSearchPane)。 */
  searchField: ReactNode
  pendingCount: number
  sections: ContactsSection[]
  selectedSectionKey: string | null
  onSelectSection: (key: string) => void
  selectionMode: boolean
  selectedContactIds: Set<string>
  newFriendsActive?: boolean
  onEnterSelectionMode: () => void
  onFinishSelectionMode: () => void
  onCreateGroupFromSelection: () => void
  onSelectNewFriends: () => void
  onSelectAddFriend: (mode: 'contact' | 'group', seed?: string) => void
}) {
  return (
    // @@@ui-ruler 导航列 = Pane nav:列宽 --nav-col-w、底色 --sidebar、右分隔线全由原语给,
    // 与会话列表同宽同色 —— 切 tab 时分隔线不再左右跳。
    <Pane paneRole="nav" mobile={mobile}>
      {/* @@@4322-selection-dock 标题不再在多选态换成计数 —— 计数与批量动作一起收在底部坞里
          （见 contacts/ContactsListDock.tsx）；头部只留稳定标题与模式进出，切模式时不再抖一下。
          添加联系人走独立的 add_friend 路由（@@@add-friend-unify），不是「新的请求」。 */}
      <PaneHeader
        mobile={mobile}
        title={ct('panel.title')}
        actions={
          <ContactsHeaderActions
            mobile={mobile}
            selectionMode={selectionMode}
            labels={{ selectModeDone: ct('panel.selectModeDone'), selectMode: ct('panel.selectMode') }}
            onFinishSelectionMode={onFinishSelectionMode}
            onEnterSelectionMode={onEnterSelectionMode}
            onSelectAddFriend={onSelectAddFriend}
          />
        }
      />
      {searchField}
      <div className="flex-1 overflow-y-auto !px-2 !pb-3">
        {/* 新的请求 — @@@1944 目的地统一走 onSelectNewFriends（selectedNav 单一真相源）;请求视图只在详情列渲一次。 */}
        <ContactsSectionNav sections={sections} selectedKey={selectedSectionKey} onSelect={onSelectSection}
          requests={{ count: pendingCount, active: !!newFriendsActive, disabled: selectionMode, onSelect: onSelectNewFriends }} />
      </div>
      <ContactsListDock
        mobile={mobile}
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

function ContactsNav({
  selected,
  mobile = false,
  people,
  agents,
  groupChats,
  pendingCount,
  groups,
  query,
  onQuery,
  onSelect,
  onOpenContact,
  onOpenGroupChat,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup
}: {
  selected: LeftSel
  mobile?: boolean
  /** 联系人 tab 此刻在屏上(别的 tab 时它仍挂着)。 */
  people: ContactUser[]
  agents: ContactUser[]
  groupChats: ContactGroupChat[]
  pendingCount: number
  groups: ContactGroup[]
  query: string
  onQuery: (value: string) => void
  onSelect: (value: LeftSel, seed?: string) => void
  onOpenContact: (contact: ContactUser) => void
  onOpenGroupChat?: (group: ContactGroupChat) => void
  onCreateGroup: (name: string) => Promise<string | null>
  onRenameGroup: (groupId: string, name: string) => Promise<void>
  onDeleteGroup: (groupId: string) => Promise<void>
}) {
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)

  return (
    <Pane paneRole="nav" mobile={mobile}>
      <ContactSearch mobile={mobile} query={query} onQuery={onQuery} people={people} agents={agents} groups={groupChats} onOpenContact={onOpenContact}
        head={(searchButton) => <PaneHeader mobile={mobile} title={ct('common.contacts')} actions={searchButton} />}
        onOpenGroup={(group) => onOpenGroupChat?.(group)} onLookupNumber={(number) => onSelect('add_friend', number)}>
      <div className="flex-1 overflow-y-auto !px-2 !pb-3">
        <NavButton
          mobile={mobile}
          icon={<Users size={mobile ? 20 : 15} />}
          label={ct('common.person')}
          count={people.length}
          active={selected === 'contacts'}
          onClick={() => onSelect('contacts')}
        />
        {/* @@@add-friend-unify 移动端 Contacts tab 的搜索加人入口——桌面在头部有「添加联系人」按钮，
            移动端必须在此 nav 里同样可达，否则拆掉 NewFriendsPanel 搜索后移动端只能靠聊天页「+」加人。 */}
        <NavButton
          mobile={mobile}
          icon={
            <svg width={mobile ? 20 : 15} height={mobile ? 20 : 15} viewBox="0 0 24 24">
              <g fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="6" r="4" />
                <circle cx="17" cy="18" r="4" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 16.667v2.666M15.667 18h2.666" />
                <path d="M14 20.834c-.634.108-1.305.166-2 .166c-3.866 0-7-1.79-7-4s3.134-4 7-4c1.713 0 3.283.352 4.5.936" />
              </g>
            </svg>
          }
          label={ct('panel.addContact')}
          active={selected === 'add_friend'}
          onClick={() => onSelect('add_friend')}
        />
        <NavButton
          mobile={mobile}
          icon={<UserPlus size={mobile ? 20 : 15} />}
          label={ct('panel.newRequests')}
          badge={pendingCount}
          active={selected === 'new_friends'}
          testId={AUTOMATION_TEST_IDS.contactsNewFriendsNav}
          onClick={() => onSelect('new_friends')}
        />
        <NavButton
          mobile={mobile}
          icon={<MessageCircle size={mobile ? 20 : 15} />}
          label={ct('common.groups')}
          count={groupChats.length}
          active={selected === 'group_chats'}
          onClick={() => onSelect('group_chats')}
        />
        <NavButton
          mobile={mobile}
          label={ct('common.agent')}
          count={agents.length}
          active={selected === 'agent_library'}
          testId={AUTOMATION_TEST_IDS.contactsAgentNav}
          onClick={() => onSelect('agent_library')}
        />

        {/* 标签分区标签 —— 与三分区同一档(11/16 semibold muted)。新建入口在移动壳要 44 命中框(#4292)。 */}
        <SectionLabel
          className="!mt-3"
          trailing={
            <IconButton title={ct('tags.create')} touchTarget={mobile} onClick={() => setCreatingGroup(true)}>
              <Plus size={mobile ? 16 : 14} />
            </IconButton>
          }
        >
          {ct('tags.title')}
        </SectionLabel>

        {creatingGroup ? (
          <GroupNameEditor
            value=""
            placeholder={ct('tags.namePlaceholder')}
            onCancel={() => setCreatingGroup(false)}
            onSave={async (name) => {
              const id = await onCreateGroup(name)
              setCreatingGroup(false)
              if (id) onSelect(`group:${id}`)
            }}
          />
        ) : null}

        {groups.map((group) =>
          editingGroupId === group.id ? (
            <GroupNameEditor
              key={group.id}
              value={group.name}
              placeholder={ct('tags.namePlaceholder')}
              onCancel={() => setEditingGroupId(null)}
              onSave={async (name) => {
                await onRenameGroup(group.id, name)
                setEditingGroupId(null)
              }}
            />
          ) : (
            <div key={group.id} className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <NavButton
                  mobile={mobile}
                  icon={<Tag size={mobile ? 18 : 14} />}
                  label={group.name}
                  count={group.contactIds.length}
                  active={selected === `group:${group.id}`}
                  onClick={() => onSelect(`group:${group.id}`)}
                />
              </div>
              <IconButton title={ct('tags.rename', { name: group.name })} onClick={() => setEditingGroupId(group.id)}>
                <Pencil size={13} />
              </IconButton>
              <IconButton
                title={ct('tags.delete', { name: group.name })}
                onClick={() => {
                  if (window.confirm(ct('tags.deleteConfirm', { name: group.name }))) onDeleteGroup(group.id)
                }}
              >
                <Trash2 size={13} />
              </IconButton>
            </div>
          )
        )}
      </div>
      </ContactSearch>
    </Pane>
  )
}

function GroupChatsDetail({
  groups,
  mobile = false,
  onBack,
  onOpenGroupChat,
  onCreateGroup, onGroupPin, onGroupToggleNotif, onGroupLeave,
  groupPinned,
  groupNotifMuted,
}: {
  groups: ContactGroupChat[]
  mobile?: boolean
  onBack?: () => void
  onOpenGroupChat?: (group: ContactGroupChat) => void
  onCreateGroup?: () => void // #2118 — 空群组分区「创建群聊」CTA
  onGroupPin?: (group: ContactGroupChat) => void
  onGroupToggleNotif?: (group: ContactGroupChat) => void
  onGroupLeave?: (group: ContactGroupChat) => void
  groupPinned?: Map<string, boolean>
  groupNotifMuted?: Map<string, boolean>
}) {
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  // #1169 (b): the bare-数字群号 SEARCH/lookup (gugu-specific #653 enumeration surface) is removed —
  // typing a number no longer previews a foreign group. Token-gated JOINING moved to GroupInviteJoinModal,
  // driven by a scanned/pasted invite QR (which carries the unguessable token), bypassing this box
  // (a /join/:inviteCode route). This pane only lists the groups you're already in; search lives on the contacts home.
  const visibleGroups = useMemo(
    () => sortGroupChatsPinnedFirst(groups, (g) => groupPinned?.get(g.id) ?? false),
    [groups, groupPinned],
  )

  const menuForGroup = (group: ContactGroupChat): ContactRowMenuActions | undefined => {
    if (!onGroupPin || !onGroupToggleNotif || !onGroupLeave) return undefined
    return {
      removeLabel: ct('contextMenu.leaveGroup'), group: { chatId: group.id, role: group.my_role, name: group.name },
      isPinned: groupPinned?.get(group.id) ?? false,
      notifMuted: groupNotifMuted?.get(group.id) ?? group.is_muted,
      onPin: () => onGroupPin(group),
      onToggleNotif: () => onGroupToggleNotif(group),
      onRemove: () => onGroupLeave(group),
    }
  }

  useEffect(() => {
    if (visibleGroups.length === 0) {
      setSelectedGroupId(null)
      return
    }
    if (mobile && !selectedGroupId) return
    if (!selectedGroupId || !visibleGroups.some((group) => group.id === selectedGroupId)) {
      setSelectedGroupId(visibleGroups[0].id)
    }
  }, [mobile, selectedGroupId, visibleGroups])

  const selectedGroup =
    visibleGroups.find((group) => group.id === selectedGroupId) ??
    (mobile ? null : (visibleGroups[0] ?? null))
  const title = groupChatListTitle()

  if (mobile && selectedGroupId) {
    return (
      <GroupChatDetailPane
        group={selectedGroup}
        mobile
        onBack={() => setSelectedGroupId(null)}
        onOpenGroupChat={onOpenGroupChat}
      />
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-hidden">
      <Pane
        paneRole="nav"
        mobile={mobile}
        data-three-col-list
        className={mobile ? undefined : '!w-[360px] !min-w-[300px] max-w-[420px]'}
      >
        {/* @@@1238-top 群列表列头与其余列头同高同线;副行(计数)跟在标题下,仍在同一条基线上。 */}
        <PaneHeader
          divider
          mobile={mobile}
          leading={mobile && onBack ? <PaneBackButton label={ct('panel.backToContacts')} onBack={onBack} /> : undefined}
          title={
            <div className="min-w-0 flex-1">
              <div className={cn('overflow-hidden text-ellipsis whitespace-nowrap font-semibold text-[var(--fg)]', mobile ? 'text-xl' : 'text-base')}>
                {title}
              </div>
              <div className="text-xs text-[var(--muted-fg)]">{groupChatListCountLabel(visibleGroups.length)}</div>
            </div>
          }
        />
        <div className="flex-1 overflow-y-auto">
          {visibleGroups.length === 0 ? (
            <div className="flex min-h-full items-center justify-center">
              <ContactsGroupSectionState isEmpty onCreateGroup={onCreateGroup} align="center" />
            </div>
          ) : (
            visibleGroups.map((group) => (
              <GroupChatRow
                key={group.id}
                group={group}
                selected={group.id === selectedGroup?.id}
                pinned={groupPinned?.get(group.id) ?? false}
                onSelect={() => {
                  setSelectedGroupId(group.id)
                }}
                cardId={group.id}
                menu={menuForGroup(group)}
              />
            ))
          )}
        </div>
        <div className="flex h-8 shrink-0 items-center justify-center border-t border-[var(--border)] text-[length:var(--font-body)] text-[var(--muted-fg)]">
          {groupChatSummaryLabel(groups.length)}
        </div>
      </Pane>

      {/* @@@three-col-shrink (#390) - The detail pane shrinks first (high flex-shrink +
          real basis) down to minWidth; only then does the list-section shrink to its
          own minWidth; the nav is pinned by its minWidth. Plain flex:1 gave the detail
          basis 0 (shrink-weight 0), so the list shrank instead of the detail. */}
      {!mobile && (
        <div data-three-col-detail className="flex min-h-0 min-w-[380px] flex-[1_1000_480px] overflow-hidden">
          <GroupChatDetailPane group={selectedGroup} onOpenGroupChat={onOpenGroupChat} />
        </div>
      )}
    </div>
  )
}

// memo: the panel stays mounted behind the other tabs; a tab switch must not re-render it (@@@shell-tab-store).
export const ContactsPanel = memo(function ContactsPanel({
  externalContactId,
  mobile = false,
  scanSeed,
  onSwitchToChat,
  onOpenGroupChat,
  onOpenAgentCreateDraft
}: ContactsPanelProps) {
  useTranslation('contacts')
  const {
    contacts,
    sharedGroupAgents,
    groups,
    groupChats,
    pendingRequestCount,
    sentRequests,
    loadingContacts,
    loadingGroups,
    sendRequest,
    createGroup,
    renameGroup,
    deleteGroup,
    setAgentPublic,
    setAgentDesiredStatus,
    removeOwnedAgent,
    removeContact,
  } = useContactsStore()
  const { user } = useAuth()
  const { toast } = useToast()
  const { pinChat, markUnread, setChatNotificationLevel, leaveGroup, refreshChats } = useChatStore('pinChat', 'markUnread', 'setChatNotificationLevel', 'leaveGroup', 'refreshChats')
  const chats = useStoreValueBy((store) => store.chats, (store) => store.chats.map((c) => [c.id, c.kind, c.peer_user_id, c.is_pinned, c.notification_level]))
  const [selectedNav, setSelectedNav] = useState<LeftSel>('contacts')
  const [mobilePane, setMobilePane] = useState<MobileContactsPane>('nav')
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
  const agentContacts = useMemo(() => myAgents(contacts, user?.id), [contacts, user?.id])
  // 桌面左栏点中的分组(设备 / 个人 / 群组);null = 第一组。
  const [selectedSectionKey, setSelectedSectionKey] = useState<string | null>(null)
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
  // #2598 置顶前置走 contactsListSort(与移动端同一条链路),在分组之前排一次:分组页、导图、搜索读同一个次序。
  const sections = useContactsSections(
    useMemo(() => sortContactsPinnedFirst(agentContacts, (c) => contactPinned.get(c.id) ?? false), [agentContacts, contactPinned]),
    useMemo(() => sortContactsPinnedFirst(humanContacts, (c) => contactPinned.get(c.id) ?? false), [humanContacts, contactPinned]),
    useMemo(() => sortGroupsByActivity(groupChats, chats, groupPinned), [groupChats, chats, groupPinned]),
    user?.id,
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
  // 成员退出群聊（leaveGroup 删自己 chat_members 行）;群主没有这一项,解散只在群设置页。确认走对话动作表那一份
  // (confirmConversationAction),与聊天列表同一个确认框。#1694-followup:成功/失败都 toast,别静默吞(fail-loud)。
  const handleGroupLeave = useCallback(
    async (g: ContactGroupChat) => {
      if (!(await confirmConversationAction('leave-group', 'group', g.name ?? ''))) return
      try {
        await leaveGroup(g.id)
        toast(ct('toast.leftGroup'), 'success')
      } catch (error) {
        toast(ct('toast.leaveFailed'), 'error', messageForUser(error))
      }
    },
    [leaveGroup, toast]
  )

  const selectedGroup = selectedNav.startsWith('group:')
    ? groups.find((group) => selectedNav === `group:${group.id}`)
    : undefined

  const scopedContacts = useMemo(() => {
    if (selectedNav === 'agent_library') return agentContacts
    // @@@tag-metadata-filter - UI tags are a metadata view over all communication objects, not a human-only folder.
    if (selectedGroup)
      return contacts.filter((contact) => selectedGroup.contactIds.includes(contact.id))
    // @@@1944 new_friends 不再是联系人列表的一种 scope——它的请求列表（含已发出）由 NewFriendsPanel
    // 自渲染，桌面/移动都只在一个渲染点出现，无中间联系人行列表。
    if (selectedNav === 'group_chats' || selectedNav === 'new_friends') return []
    return humanContacts
  }, [agentContacts, contacts, humanContacts, selectedGroup, selectedNav])

  const selectedContact = useMemo(
    () =>
      scopedContacts.find((contact) => contact.id === selectedContactId) ??
      scopedContacts[0] ??
      null,
    [selectedContactId, scopedContacts]
  )

  useEffect(() => {
    if (!externalContactId) return
    const contact = contacts.find((item) => item.id === externalContactId)
      ?? sharedGroupAgents.find((item) => item.id === externalContactId)
    if (!contact) return
    setSelectedNav(contact.type === 'agent' ? 'agent_library' : 'contacts')
    setSelectedContactId(contact.id)
    // 桌面:左栏切到它所在的分组(右边铺开那一组,资料在抽屉里)。
    setSelectedSectionKey(sections.find((s) => s.agents.some((c) => c.id === contact.id) || s.people.some((c) => c.id === contact.id))?.key ?? null)
    if (mobile) setMobilePane('detail')
  }, [contacts, externalContactId, mobile, sharedGroupAgents, sections])

  useEffect(() => {
    // 桌面:点中分组只是铺开名录,❌ 替用户选第一个人(详情列给空态)。
    if (!mobile || selectedNav === 'group_chats') return
    if (selectedContactId && scopedContacts.some((contact) => contact.id === selectedContactId))
      return
    setSelectedContactId(scopedContacts[0]?.id ?? null)
  }, [mobile, selectedContactId, selectedNav, scopedContacts])

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
      // @@@1944 移动端 add_friend 直达 AddFriendSearch（住在 index pane，无中间列表）
      if (mobile) setMobilePane('index')
    }
  }, [scanSeed, mobile])

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

  // 手机壳里这张页常驻在横滑分页器里,切走 tab 时也挂着 ⇒ 切走即回到根(#6730)。
  const backToNav = useCallback(() => setMobilePane('nav'), [])

  const listTitle =
    selectedNav === 'agent_library'
      ? ct('common.agent')
      : selectedNav === 'group_chats'
        ? ct('common.groups')
        : (selectedGroup?.name ?? ct('panel.allContacts'))

  const selectNav = (next: LeftSel, seed?: string) => navigateMobile(() => {
    setSelectedNav(next)
    setSelectedContactId(null)
    setContactSelectionMode(false)
    setSelectedContactIds(new Set())
    // @@@add-friend-unify 从 nav 点进 add_friend = 空态搜索；清掉扫码残留 seed（同 onSelectAddFriend）。
    if (next === 'add_friend') setAddFriendSeed(seed ? { query: seed, token: Date.now() } : null)
    if (mobile) setMobilePane('index')
  }, 'push')

  const selectContact = (contact: ContactUser) => navigateMobile(() => {
    setSelectedContactId(contact.id)
    if (mobile) setMobilePane('detail')
  }, 'push')

  const toggleContactSelection = (contact: ContactUser) => {
    if (contact.type === 'agent' && isCloudAgentMarked(contact)) return
    setSelectedContactIds((current) => {
      const next = new Set(current)
      if (next.has(contact.id)) next.delete(contact.id)
      else next.add(contact.id)
      return next
    })
  }

  // 进多选留在原处:开着的详情、选中的分组都不动;只有从「新的请求」/ 加人页进来时回到分组(那两页没有可勾的人)。
  const enterContactSelectionMode = () => {
    setSelectedNav('contacts')
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
    if (!isOwnedAgent && !(await confirmConversationAction('remove-contact', 'dm', name))) return
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

  // 桌面搜索:框在左栏,结果铺在右边;点开一条 = 切到它所在的分组、选中它(开抽屉)。多选建群时点人 = 勾选。
  const search = useDesktopContactSearch({
    enabled: !mobile, query, onQuery: setQuery, sections, people: humanContacts, agents: agentContacts, groups: groupChats,
    pick: contactSelectionMode ? { ids: selectedContactIds, can: (c) => c.type !== 'agent' || c.owner_user_id === user?.id, onToggle: toggleContactSelection } : undefined,
    onOpenContact: (c, key) => {
      setSelectedSectionKey(key); setSelectedContactId(c.id); setSelectedSidebarGroupId(null)
      setSelectedNav(c.type === 'agent' ? 'agent_library' : 'contacts')
    },
    onOpenGroup: (g, key) => { setSelectedSectionKey(key); setSelectedContactId(null); setSelectedSidebarGroupId(g.id); setSelectedNav('group_chats') },
    onLookupNumber: (number) => { setQuery(''); setAddFriendMode('contact'); setSelectedNav('add_friend'); setAddFriendSeed({ query: number, token: Date.now() }) },
  })

  // Desktop layout: section nav + the selected section spread over the right area
  if (!mobile) {
    const rowHandlers: ContactsRowHandlers = {
      currentUserId: user?.id, selectedContactId, selectedGroupId: selectedSidebarGroupId,
      selectionMode: contactSelectionMode, selectedContactIds,
      onSelectContact: (c) => {
        if (contactSelectionMode && c.owner_user_id === user?.id) return toggleContactSelection(c)
        setSelectedContactId(c.id)
        setSelectedSidebarGroupId(null)
        setSelectedNav(c.type === 'agent' ? 'agent_library' : 'contacts')
      },
      onToggleContact: toggleContactSelection,
      onSelectGroup: (g) => {
        setContactSelectionMode(false)
        setSelectedContactIds(new Set())
        setSelectedSidebarGroupId(g.id)
        setSelectedContactId(null)
        setSelectedNav('group_chats')
      },
      onStartChat: onSwitchToChat, onPin: handleContactPin, onMarkUnread: handleContactMarkUnread,
      onToggleNotif: handleContactToggleNotif, onRemove: handleRemoveContact,
      contactPinned, contactNotifMuted, getContactRemoveLabel,
      onGroupPin: handleGroupPin, onGroupToggleNotif: handleGroupToggleNotif, onGroupLeave: handleGroupLeave,
      groupPinned, groupNotifMuted,
    }
    const selectAddFriendDesktop = (mode: 'contact' | 'group', seed?: string) => {
      setAddFriendMode(mode)
      setContactSelectionMode(false)
      setSelectedContactIds(new Set())
      setSelectedNav('add_friend')
      setSelectedContactId(null)
      setSelectedSidebarGroupId(null)
      // @@@add-friend-unify 点按钮进加人搜索必须开在空态：清掉上一次扫码残留的 seed，
      // 否则会用旧扫码号预填搜索（seed effect 按 token 只触发一次，但新挂载会重读旧 token）。
      setAddFriendSeed(seed ? { query: seed, token: Date.now() } : null)
    }
    // @@@1944 桌面详情列唯一路由：selectedNav（+ 选中实体）→ 详情视图的单一真相源。
    // 每个 nav 目的地在双栏里只渲染一次——列表列恒为联系人导航，详情列由这里决定。
    const contactDetail = (() => {
      if (selectedSidebarGroup) {
        return (
          <GroupChatDetailPane group={selectedSidebarGroup} onOpenGroupChat={onOpenGroupChat} />
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
      return null
    })()
    const section = sections.find((s) => s.key === selectedSectionKey) ?? sections[0]!
    const closeDetail = () => { setSelectedContactId(null); setSelectedSidebarGroupId(null) }
    const cpaneRight = search.pane ? search.pane
      : selectedNav === 'add_friend' ? <AddFriendSearch seed={addFriendSeed} autoFocus showHeader mode={addFriendMode} />
      : selectedNav === 'new_friends' ? <NewFriendsPanel onOpenGroupChat={onOpenGroupChat} />
        : <ContactsSectionPane section={section} rows={rowHandlers} detail={contactDetail} onCloseDetail={closeDetail} onCreateAgent={onOpenAgentCreateDraft} onCreateGroup={() => setShowGroupModal(true)} onAddContact={() => selectAddFriendDesktop('contact')} />

    return (
      <div className="flex h-full min-w-0 flex-1 overflow-hidden">
        <ContactsThreeSectionSidebar
          mobile={false}
          searchField={search.field}
          pendingCount={pendingRequestCount}
          sections={sections}
          selectedSectionKey={search.pane ? null : section.key}
          onSelectSection={(key) => { setQuery(''); setSelectedNav('contacts'); setSelectedSectionKey(key); closeDetail() }}
          selectionMode={contactSelectionMode}
          selectedContactIds={selectedContactIds}
          newFriendsActive={!search.pane && selectedNav === 'new_friends'}
          onEnterSelectionMode={enterContactSelectionMode}
          onFinishSelectionMode={finishContactSelectionMode}
          onCreateGroupFromSelection={() => setShowGroupModal(true)}
          onSelectNewFriends={() => {
            setQuery('')
            setContactSelectionMode(false)
            setSelectedContactIds(new Set())
            setSelectedNav('new_friends')
            closeDetail()
          }}
          onSelectAddFriend={selectAddFriendDesktop}
        />
        {cpaneRight}
        {groupModal}
        {groupInviteJoinModal}
      </div>
    )
  }

  // ── Mobile layout: nav / index / detail pane flow ────────────────────────────
  // @@@1944 只有移动端走到这里（桌面已在上方 return）——mobilePane 是这套 pane 流的单一真相源。
  const showNav = mobilePane === 'nav'
  const showIndex = mobilePane === 'index'
  const showDetail = mobilePane === 'detail'

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-hidden">
      <OnContactsHidden run={backToNav} />
      {showNav && (
        <ContactsNav
          selected={selectedNav}
          mobile={mobile}
          people={humanContacts}
          agents={agentContacts}
          groupChats={groupChats}
          pendingCount={pendingRequestCount}
          groups={groups}
          query={query}
          onQuery={setQuery}
          onSelect={selectNav}
          onOpenContact={(c) => { setSelectedNav(c.type === 'agent' ? 'agent_library' : 'contacts'); selectContact(c) }}
          onOpenGroupChat={onOpenGroupChat}
          onCreateGroup={createGroup}
          onRenameGroup={renameGroup}
          onDeleteGroup={async (groupId) => {
            await deleteGroup(groupId)
            if (selectedNav === `group:${groupId}`) setSelectedNav('contacts')
          }}
        />
      )}

      {selectedNav === 'group_chats' ? (
        showIndex ? (
          <GroupChatsDetail
            groups={groupChats}
            mobile={mobile}
            onBack={() => navigateMobile(() => setMobilePane('nav'), 'pop')}
            onOpenGroupChat={onOpenGroupChat}
            onCreateGroup={() => setShowGroupModal(true)}
            onGroupPin={handleGroupPin}
            onGroupToggleNotif={handleGroupToggleNotif}
            onGroupLeave={handleGroupLeave}
            groupPinned={groupPinned} groupNotifMuted={groupNotifMuted}
          />
        ) : null
      ) : selectedNav === 'add_friend' ? (
        // @@@add-friend-unify add_friend 直达搜索加人面板（AddFriendSearch）——与「新的请求」分成
        // 两条链路：扫码/点加人图标进这里搜索加人，此面板不含请求收件箱。
        showIndex ? (
          <AddFriendSearch
            seed={addFriendSeed}
            autoFocus
            showHeader
            mode={addFriendMode}
            onBack={() => navigateMobile(() => setMobilePane('nav'), 'pop')}
          />
        ) : null
      ) : selectedNav === 'new_friends' ? (
        // @@@1944 new_friends 直达请求面板（对齐 group_chats 分支形状）——不再经过一层把请求
        // 发起/接收人伪装成联系人行的 ContactsIndex；「返回」由 NewFriendsPanel 按 onBack 真渲染。
        showIndex ? (
          <NewFriendsPanel
            onOpenGroupChat={onOpenGroupChat}
            onBack={() => navigateMobile(() => setMobilePane('nav'), 'pop')}
          />
        ) : null
      ) : (
        <>
          {showIndex && (
            <ContactsIndex
              title={listTitle}
              mobile={mobile}
              contacts={scopedContacts}
              currentUserId={user?.id}
              sectionBy={selectedNav === 'agent_library' ? 'device' : undefined}
              loading={loadingContacts || loadingGroups}
              selectedContactId={selectedContact?.id}
              selectionMode={contactSelectionMode}
              selectedContactIds={selectedContactIds}
              onEnterSelectionMode={enterContactSelectionMode}
              onFinishSelectionMode={finishContactSelectionMode}
              onToggleContact={toggleContactSelection}
              onCreateGroupFromSelection={() => setShowGroupModal(true)}
              onBack={() => navigateMobile(() => setMobilePane('nav'), 'pop')}
              onAddContact={selectedGroup ? undefined : () => selectNav('add_friend')}
              onCreateAgent={onOpenAgentCreateDraft}
              onSelect={selectContact}
              onRemoveContact={handleRemoveContact}
              onStartChat={onSwitchToChat}
              onPin={handleContactPin}
              onMarkUnread={handleContactMarkUnread}
              onToggleNotif={handleContactToggleNotif}
              contactPinned={contactPinned}
              contactNotifMuted={contactNotifMuted}
              getContactRemoveLabel={getContactRemoveLabel}
              subtitle={selectedGroup ? ct('tags.titleWithCount', { count: scopedContacts.length }) : undefined}
              summaryLabel={selectedGroup ? ct('tags.countSummary', { count: scopedContacts.length }) : undefined}
            />
          )}

          {showDetail && selectedGroup ? (
            selectedContact ? (
              <ContactDetail
                contact={selectedContact}
                humanContacts={humanContacts}
                sentRequestIds={sentRequestIds}
                requestingAgentId={requestingAgentId}
                groupChats={groupChats}
                mobile={mobile}
                onBack={() => navigateMobile(() => setMobilePane('index'), 'pop')}
                onSwitchToChat={onSwitchToChat}
                onOpenGroupChat={onOpenGroupChat}
                onRequestAgent={requestAgent}
                onSetAgentPublic={setAgentPublic}
                onSetAgentDesiredStatus={setAgentDesiredStatus}
              />
            ) : null
          ) : showDetail ? (
            <ContactDetail
              contact={selectedContact}
              humanContacts={humanContacts}
              sentRequestIds={sentRequestIds}
              requestingAgentId={requestingAgentId}
              groupChats={groupChats}
              mobile={mobile}
              onBack={() => navigateMobile(() => setMobilePane(query.trim() ? 'nav' : 'index'), 'pop')}
              onSwitchToChat={onSwitchToChat}
              onOpenGroupChat={onOpenGroupChat}
              onRequestAgent={requestAgent}
              onSetAgentPublic={setAgentPublic}
              onSetAgentDesiredStatus={setAgentDesiredStatus}
            />
          ) : null}
        </>
      )}
      {groupModal}
      {groupInviteJoinModal}
    </div>
  )
})
