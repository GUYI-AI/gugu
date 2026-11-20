import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'
import { AddFriendSearch } from '@/components/AddFriendSearch'
import { Avatar } from '@/components/Avatar'
import { NewFriendsPanel } from '@/components/NewFriendsPanel'
import { ContactDetail } from '@/components/contacts/ContactDetail'
import { AgentContactRow } from '@/components/contacts/AgentContactRow'
import { useAgentRowActions } from '@/hooks/useAgentRowActions'
import { peopleContacts } from '@/components/contacts/contactSelectors'
import { GroupInviteJoinModal } from '@/components/contacts/GroupInvite'
import { rowKeyActivate } from '@/components/contacts/contactsPanelStyles'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Chip'
import { ListRow } from '@/components/ui/ListRow'
import { Pane, PaneHeader } from '@/components/ui/Pane'
import { SectionLabel } from '@/components/ui/SectionLabel'
import { displayName } from '@/lib/contactsListSort'
import { ChevronRight, Search, UserPlus } from '@/lib/icons'
import type { QrScanRoute } from '@/lib/qrScanRoute'
import { RETAINED_SURFACE_HIDDEN_STYLE } from '@/lib/retainedSurface'
import { navigateMobile } from '@/mobile/navigateMobile'
import { PhoneMeButton } from '@/mobile/PhoneMeButton'
import type { AuthUser } from '@/store/auth'
import { useContactsStore } from '@/store/contactsContext'
import { partnerFriends, partnerGroupAgents } from './partnersModel'
import './partners.css'

/** 推在「伙伴」首页上的一页:整屏、没有底栏,返回一步回到下面那一页。 */
type PartnersPage =
  | { kind: 'requests' }
  | { kind: 'add'; seed: { query: string; token: number } | null }
  | { kind: 'friend'; contactId: string }

/** 入口行:ContactsPanel NavButton 的手机几何(44 高、20 图标、16 字、计数、尾部 ›)。 */
function NavRow({ icon, label, badge, testId, onClick }: { icon: ReactNode; label: string; badge?: number; testId?: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="option" className="gg-partners-navrow" data-testid={testId} onClick={onClick}>
      <span className="gg-partners-navrow-icon">{icon}</span>
      <span className="gg-partners-navrow-label">{label}</span>
      {badge ? <Chip tone="danger" shape="count">{badge > 99 ? '99+' : badge}</Chip> : null}
      <ChevronRight size={16} aria-hidden className="gg-partners-navrow-chevron" />
    </Button>
  )
}

/**
 * 手机「伙伴」一格(OpenDCAI/gugu#446,v7.12 稿;桌面仍是 ContactsPanel):新的请求、添加联系人两行入口,下面是朋友(只列人),
 * 群里遇到的别人的 Agent 单独列,复用桌面 Agent 库的行。朋友没有状态、没有提醒(那归「消息」),群也不在这里(群一律在「消息」)。
 * 点进去的几页整屏推进来(没有底栏),由 onPushedChange 告诉外壳收起底栏。
 */
export function PhonePartnersPage({
  user,
  active,
  externalContactId,
  scanSeed,
  onOpenMe,
  onPushedChange,
  onLeave,
  onSwitchToChat,
  onOpenGroupChat,
}: {
  user: AuthUser
  /** 「伙伴」这一格此刻在屏上(切走 = 回到首页)。 */
  active: boolean
  externalContactId?: string
  scanSeed?: { route: QrScanRoute; token: number } | null
  onOpenMe: () => void
  onPushedChange: (pushed: boolean) => void
  /** 从「消息」进来的新项目页退回去:回到「消息」。 */
  onLeave: () => void
  onSwitchToChat?: (target: ContactUser) => void
  onOpenGroupChat?: (group: ContactGroupChat) => void
}) {
  const { t } = useTranslation('main')
  const { t: ct } = useTranslation('contacts')
  const { contacts, sharedGroupAgents, groupChats, pendingRequestCount, sentRequests, sendRequest, setAgentPublic, setAgentDesiredStatus } = useContactsStore()
  const [stack, setStack] = useState<PartnersPage[]>([])
  const [requestingAgentId, setRequestingAgentId] = useState<string | null>(null)
  const [groupInviteJoin, setGroupInviteJoin] = useState<{ publicId: number; joinToken?: string; token: number } | null>(null)
  const top = stack.at(-1) ?? null

  const push = useCallback((page: PartnersPage) => navigateMobile(() => setStack((current) => [...current, page]), 'push'), [])
  const pop = useCallback(() => navigateMobile(() => setStack((current) => current.slice(0, -1)), 'pop'), [])

  useEffect(() => { onPushedChange(stack.length > 0) }, [stack.length, onPushedChange])
  // 常驻在横滑分页器里:切走这一格就回到首页(同 ContactsPanel #6730)。
  useEffect(() => { if (!active) setStack([]) }, [active])
  useEffect(() => {
    if (!externalContactId) return
    setStack([{ kind: 'friend', contactId: externalContactId }])
  }, [externalContactId])
  // 扫码:一个人的咕咕号 → 添加联系人并带上它;群邀请 → 入群确认(同 ContactsPanel @@@scan-seed)。
  useEffect(() => {
    if (!scanSeed) return
    const { route } = scanSeed
    if (route.nav === 'group_join') setGroupInviteJoin({ publicId: route.publicId, joinToken: route.joinToken, token: Date.now() })
    else setStack([{ kind: 'add', seed: { query: route.query, token: Date.now() } }])
  }, [scanSeed])

  const friends = useMemo(() => partnerFriends(contacts), [contacts])
  const groupAgents = useMemo(() => partnerGroupAgents(contacts, sharedGroupAgents, user.id), [contacts, sharedGroupAgents, user.id])
  const sentRequestIds = useMemo(() => new Set(sentRequests.map((request) => request.receiver_id)), [sentRequests])
  const humanContacts = useMemo(() => peopleContacts(contacts), [contacts])
  const requestAgent = useCallback(async (agent: ContactUser) => {
    if (requestingAgentId) return
    setRequestingAgentId(agent.id)
    try {
      await sendRequest(agent.id)
    } finally {
      setRequestingAgentId(null)
    }
  }, [requestingAgentId, sendRequest])

  const groupAgentActions = useAgentRowActions({ onSelect: (agent) => push({ kind: 'friend', contactId: agent.id }) })

  const pushed = (() => {
    if (!top) return null
    switch (top.kind) {
      case 'requests':
        return <NewFriendsPanel onOpenGroupChat={onOpenGroupChat} onBack={pop} />
      case 'add':
        return <AddFriendSearch seed={top.seed} autoFocus showHeader onBack={pop} />
      case 'friend': {
        const contact = contacts.find((item) => item.id === top.contactId) ?? sharedGroupAgents.find((item) => item.id === top.contactId) ?? null
        return (
          <ContactDetail
            contact={contact}
            humanContacts={humanContacts}
            sentRequestIds={sentRequestIds}
            requestingAgentId={requestingAgentId}
            groupChats={groupChats}
            mobile
            onBack={pop}
            onSwitchToChat={onSwitchToChat}
            onOpenGroupChat={onOpenGroupChat}
            onRequestAgent={requestAgent}
            onSetAgentPublic={setAgentPublic}
            onSetAgentDesiredStatus={setAgentDesiredStatus}
          />
        )
      }
    }
  })()

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden" data-testid="phone-partners">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" style={top ? RETAINED_SURFACE_HIDDEN_STYLE : undefined}>
        <Pane paneRole="nav" mobile className="gg-partners" data-phone-root-list="contacts">
          <PaneHeader mobile titleLevel="page" title={t('shell.partnersMobile')} leading={<PhoneMeButton user={user} onOpen={onOpenMe} />} />
          <div className="gg-partners-scroll">
            <div className="gg-partners-navrows">
              <NavRow icon={<UserPlus size={20} />} label={ct('panel.newRequests')} badge={pendingRequestCount} testId="phone-partners-requests" onClick={() => push({ kind: 'requests' })} />
              <NavRow icon={<Search size={20} />} label={ct('panel.addContact')} testId="phone-partners-add" onClick={() => push({ kind: 'add', seed: null })} />
            </div>
            <div className="gg-partners-list">
              {friends.length ? <SectionLabel>{t('partners.friends', { count: friends.length })}</SectionLabel> : null}
              {friends.map((friend) => {
                const open = () => push({ kind: 'friend', contactId: friend.id })
                return (
                  <ListRow key={friend.id} mobile role="button" tabIndex={0} data-testid="phone-partners-friend"
                    leading={<Avatar name={displayName(friend)} avatarUrl={friend.avatar} seed={friend.id} size="md" harnessBadge={false} />}
                    title={displayName(friend)} onClick={open} onKeyDown={rowKeyActivate(open)} />
                )
              })}
              {groupAgents.length ? <SectionLabel>{t('partners.groupAgents', { count: groupAgents.length })}</SectionLabel> : null}
              {groupAgents.map(agent => (
                <AgentContactRow key={agent.id} contact={agent} mobile selected={false} testId="phone-partners-group-agent" actions={groupAgentActions} />
              ))}
            </div>
          </div>
        </Pane>
      </div>
      {pushed}
      {groupInviteJoin ? (
        <GroupInviteJoinModal key={groupInviteJoin.token} publicId={groupInviteJoin.publicId} joinToken={groupInviteJoin.joinToken} onClose={() => setGroupInviteJoin(null)} />
      ) : null}
    </div>
  )
}
