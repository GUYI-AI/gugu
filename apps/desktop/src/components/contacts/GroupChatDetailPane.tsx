import { useTranslation } from 'react-i18next'
import { groupDisplayName } from '@gugu/core/shared/ui/chatModels'
import type { ContactGroupChat } from '@gugu/core/shared/types/contacts'
import { normalizeGroupRole } from '@gugu/core/shared/enums/groupRoleModels'
import { useShownAgentName } from '@/hooks/useShownAgentName'
import { useAgentDisplayStatus } from '@/hooks/useAgentDisplayStatus'
import { agentLocationText, resolveAgentLocation } from '@/lib/agentRunningStatusModels'
import { cn } from '@/lib/cn'
import { MessageCircle } from '@/lib/icons'
import { useChatStore } from '../../store/chatContext'
import { useDevicesStore } from '../../store/devicesContext'
import { useAuth } from '../../store/auth'
import { groupRoster } from '../../hooks/useRoomCollab'
import { useReplica } from '../../lib/replica'
import { chatPublicId } from '../../lib/contactsListSort'
import { useShownAgentContactStatus } from '../contactAgentTone'
import { Avatar } from '../Avatar'
import { CopyValue } from '../CopyValue'
import { Pane, PaneHeader } from '../ui/Pane'
import { Unknown } from '../ui/Unknown'
import { PaneBackButton } from './ContactDetail'
import { ContactGroupAvatar } from './ContactSearch'
import { GroupInviteRow } from './GroupInvite'
import { useGroupProject } from './groupRowFacts'
import { ct, detailCaptionClass, detailPlaceholderClass, nameClampClass, profileBodyClass } from './contactsPanelStyles'
import { profileCardStyles as card } from './ContactProfileCard'

// 群资料:桌面通讯录的抽屉与手机群列表点进去的是同一份。头部(群头像 · 名字 · 项目群 · 人数 · 进入群聊)、
// 群号与项目文件夹、成员按「人 / Agent」分开列;我自己的 Agent 说它在哪台机器、此刻在做什么。

const VISIBLE_MEMBERS = 12
type RosterMember = { id: string; type: 'human' | 'agent'; role: string }

export function GroupChatDetailPane({
  group,
  mobile = false,
  onBack,
  onOpenGroupChat
}: {
  group: ContactGroupChat | null
  mobile?: boolean
  onBack?: () => void
  onOpenGroupChat?: (group: ContactGroupChat) => void
}) {
  if (!group) {
    return (
      <Pane paneRole="detail" mobile={mobile}>
        <PaneHeader divider mobile={mobile} title={ct('groupDetail.title')} />
        <div className={detailPlaceholderClass}>{ct('panel.selectGroupDetail')}</div>
      </Pane>
    )
  }
  return <GroupDetail group={group} mobile={mobile} onBack={onBack} onOpenGroupChat={onOpenGroupChat} />
}

function GroupDetail({ group, mobile, onBack, onOpenGroupChat }: { group: ContactGroupChat; mobile: boolean; onBack?: () => void; onOpenGroupChat?: (group: ContactGroupChat) => void }) {
  const { t } = useTranslation('messaging')
  const { devices } = useDevicesStore()
  const bound = useGroupProject(group.id)
  // The chat's roster replica (the IM library's copy first, the same write path): ❌ a loader of its own (open-flicker CH22).
  const roster = useReplica(groupRoster, [group.id, 'group'])
  const members: RosterMember[] | null = roster.state === 'value' ? [...roster.value.humans, ...roster.value.agents] : null
  const visible = members ? members.slice(0, VISIBLE_MEMBERS) : []
  const folderMachine = bound ? agentLocationText(resolveAgentLocation(bound.device.device_id, devices), t) : null

  return (
    <Pane paneRole="detail" mobile={mobile}>
      {/* @@@1238-top 群详情列头与会话头同高同线,标题字阶来自 PaneHeader。 */}
      <PaneHeader
        divider
        mobile={mobile}
        title={ct('groupDetail.title')}
        leading={mobile && onBack ? <PaneBackButton label={ct('panel.backToGroupList')} onBack={onBack} /> : undefined}
      />

      {/* The same card as an agent's or a person's (profileCardStyles): centred avatar, name, count, one faint line for the
          number, one row of light actions; members below under their section titles only. */}
      <div className={cn(profileBodyClass, mobile && '!pb-[max(24px,env(safe-area-inset-bottom))]')}>
        <div className="w-full max-w-[480px]">
          <div className={card.card}>
            <ContactGroupAvatar group={group} size={96} />
            <div className={card.name}><span className={nameClampClass} title={groupDisplayName(group)}>{groupDisplayName(group)}</span></div>
            <div className={card.statusBase}>
              {[bound ? ct('groupDetail.projectGroup') : null, ct('groupDetail.memberCount', { count: group.member_count })].filter(Boolean).join(' · ')}
            </div>
            {chatPublicId(group) ? (
              <div className={card.guguNumber}>
                <span className={card.guguNumberLabel}>{ct('groupDetail.number')}</span>
                <CopyValue value={chatPublicId(group)!} message={ct('groupDetail.copiedNumber')} />
              </div>
            ) : null}
            {bound ? <div className={cn(card.guguNumber, 'max-w-full')}><span className="truncate">{[folderMachine, bound.project.rootPath].filter(Boolean).join(' · ')}</span></div> : null}
            <div className={cn(card.actions, 'flex-wrap justify-center')}>
              <button type="button" className={card.action} onClick={() => onOpenGroupChat?.(group)}>
                <MessageCircle size={19} />{ct('panel.enterGroup')}
              </button>
              <GroupInviteRow group={group} />
            </div>
          </div>

          <div className="!mt-8">
            {roster.state !== 'value' || visible.length === 0 ? (
              <div className="text-sm text-[var(--muted-fg)]" role={roster.state === 'error' ? 'alert' : undefined}>
                {roster.state === 'unknown' ? <Unknown className="w-40" /> : roster.state === 'error' ? roster.error.message : ct('groupDetail.emptyMembers')}
              </div>
            ) : (
              <>
                <MemberList label={ct('groupDetail.people')} total={roster.value.humans.length} members={visible.filter((m) => m.type !== 'agent')} />
                <MemberList label={ct('groupDetail.agents')} total={roster.value.agents.length} members={visible.filter((m) => m.type === 'agent')} />
                {members && members.length > visible.length ? (
                  <div className={cn(detailCaptionClass, '!mt-3')}>{ct('groupDetail.remainingMembers', { count: members.length - visible.length })}</div>
                ) : null}
                {members && group.member_count > members.length ? (
                  <div className={cn(detailCaptionClass, '!mt-3')}>{ct('groupDetail.pendingSync', { count: group.member_count - members.length })}</div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </Pane>
  )
}

function MemberList({ label, total, members }: { label: string; total: number; members: RosterMember[] }) {
  const { identitiesById } = useChatStore('identitiesById')
  const { user } = useAuth()
  const names = useShownAgentName(members.map((member) => ({ name: identitiesById[member.id]?.display_name ?? '', createdAt: member.type === 'agent' ? identitiesById[member.id]?.created_at ?? undefined : undefined })))
  if (total === 0) return null
  return (
    <div className="!mb-4 max-w-[620px]">
      <div className={cn(detailCaptionClass, '!mb-1 flex justify-between')}><span>{label}</span><span>{total}</span></div>
      {members.map((member, index) => {
        const identity = identitiesById[member.id]
        const mine = member.type === 'agent' && !!user?.id && identity?.owner_user_id === user.id
        return (
          <div key={member.id} className="flex min-h-[var(--control-h-touch)] min-w-0 items-center gap-3">
            <Avatar name={names[index]!} avatarUrl={identity?.avatar} seed={member.id} size="sm" isAgent={member.type === 'agent'} />
            <span className="min-w-0 flex-1 truncate text-[length:var(--font-body)] text-[var(--fg)]">{names[index]}</span>
            <span className="shrink-0 text-xs text-[var(--muted-fg)]">
              {mine ? <OwnAgentWhere agentId={member.id} deviceId={identity?.device_id} /> : ct(`profile.roles.${normalizeGroupRole(member.role)}`)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** 我自己的 Agent:在哪台机器 · 此刻的状态(与通讯录 Agent 行同一句)。 */
function OwnAgentWhere({ agentId, deviceId }: { agentId: string; deviceId: string | null | undefined }) {
  const { t } = useTranslation('messaging')
  const { devices } = useDevicesStore()
  const { status, presence } = useAgentDisplayStatus(agentId)
  const { label } = useShownAgentContactStatus(agentId, status, presence.presentation)
  return <>{[agentLocationText(resolveAgentLocation(deviceId, devices), t), label].filter(Boolean).join(' · ')}</>
}
