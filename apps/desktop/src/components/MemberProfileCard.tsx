import { useShownAgentName } from '@/hooks/useShownAgentName'
import { useAvatarIdentity } from '@/lib/avatarIdentity'
import { useEffect, useState, type ReactNode } from 'react'
import type { AgentDisplayStatus, GroupMemberRole, GroupMemberType, ListenMode } from '@gugu/core/shared/types/chat'
import { LISTEN_MODES } from '@gugu/core/shared/types/chat'
import { createContactQrPayload, createGuguQrUrl } from '@gugu/core/shared/qrPayload'
import { Avatar } from './Avatar'
import { AgentOwnerLabel } from './AgentOwnerLabel'
import { useAuth } from '../store/auth'
import { OwnedAgentNameEditor } from './contacts/OwnedAgentNameEditor'
import { SharePosterDialog } from './SharePosterDialog'
import { PersonalSharePreview } from './referralPreview/ReferralPreview'
import { useTranslation } from 'react-i18next'
import { resolveMessagingValue } from '@/lib/localizedStoredValue'
import { useAgentContactStatusLabel } from './contactAgentTone'
import { useAgentDisplayStatus } from '../hooks/useAgentDisplayStatus'
import { Button } from './ui/Button'
import { Hint } from './ui/Tooltip'
import { Unknown } from './ui/Unknown'
import { FieldList } from './contactsDetailControls'
import { cn } from '@/lib/cn'
import { FacemaskCircle, MessageCircle, Search, Share } from '@/lib/icons'
import { ProfileCardAction } from './contacts/ProfileCardAction'
import { ShareAgentModal } from './contacts/ShareAgentModal'
import { peopleContacts } from './contacts/contactSelectors'
import { useContactsStore } from '../store/contactsContext'
import { useAgentSession } from '@/lib/projectGroupChatsBridge'
import { useMobileShell } from '@/hooks/useMobileShell'
import { useAgentSessionRow } from '@/components/session-watch/useAgentSessionRow'
import type { AgentSession } from '@/session/renderer/features/projects/stores/project-group-chats-bridge'
import { isImeComposing } from '@/lib/ime'

// @@@float-one-edge (Refs #6104) — 名片是浮层:圆角 xl(12) + 一层 lift,❌ 不再叠描边。
const profileCardClass = 'gg-pop w-[284px] overflow-hidden rounded-xl bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-[var(--shadow-lift)]'
// 放进底部面板(手机,#6836)时铺满宽度,圆角、底色归面板,卡片不再叠第二层外框。
const profileFillClass = 'gg-pop w-full text-[var(--text-primary)]'
const profileSingleClass = 'gg-pop--single'
// @@@panel-chrome 名片内一条左边线 16,头与正文之间只留白;只有管理区上方一条线(与全 app 同一个灰)。
const profileHeaderClass = 'gg-pop-ph flex items-center gap-3.5 px-4 pb-1 pt-4'
const profileHeaderTextClass = 'gg-pop-ph-text flex min-w-0 flex-col'
// 名字最多两行:窄卡里一行放不下的名字(agent 名常是一句话)折行,❌ 截成省略号。
const profileNameClass = 'gg-pop-pn min-w-0 line-clamp-2 [overflow-wrap:anywhere] text-base font-semibold leading-snug text-[var(--text-primary)]'
// @@@one-card - 人和 agent 同一套动作区:「发消息」是唯一强调的按钮、独占一行;其下一行等分的次级动作(悄悄话 / 查找 / 分享),
// 与通讯录名片同一个 ProfileCardAction。❌ 按人 / agent 另排一套(两套曾经并存:人是整宽描边按钮,agent 是灰底图标方块)。
const profileActionsClass = 'gg-pop-pacts flex flex-col gap-2 px-4 pb-3 pt-3'
const profilePrimaryActionClass = 'w-full gap-2'
// 固定三格:某一项不出现(非主人看 agent 没有「分享」)时其余项留在原位,❌ 撑宽占掉它的位置。
const profileSecondaryRowClass = 'grid grid-cols-3 gap-1'
const profileFieldsClass = 'gg-pop-fields gap-x-2 gap-y-1.5 px-4 pb-3.5'
const profileFieldRowClass = 'gg-pop-field-row col-span-2 grid grid-cols-subgrid items-start text-[length:var(--font-caption)] leading-[var(--lh-caption)]'
const profileFieldLabelClass = 'gg-pop-field-label whitespace-nowrap text-[var(--text-tertiary)]'
const profileFieldValueClass = 'gg-pop-field-value min-w-0 [overflow-wrap:anywhere] text-[var(--text-secondary)]'
const profileAgentMetaClass = 'mt-1 flex min-w-0 items-start gap-2 text-xs leading-4 text-[var(--text-tertiary)]'
const profileListenClass = 'gg-pop-lm mx-4 border-t border-[var(--border-subtle)] pb-4 pt-3'
const profileListenLabelClass = 'gg-pop-lml flex min-w-0 items-center gap-2 text-sm leading-5 text-[var(--text-primary)]'
const profileListenSegmentClass = 'gg-pop-lmseg ml-auto flex h-8 w-32 shrink-0 rounded-[var(--radius-control)] bg-[var(--listen-mode-bg)] p-[2px]'
const profileListenButtonBaseClass = 'gg-pop-lmseg-btn flex-1 rounded-[var(--radius-document)] border-none px-0 font-[inherit] text-xs font-medium !transition-[background,color] !duration-[var(--dur-fast)] !ease-[var(--ease)]'
const profileListenButtonActiveClass = 'gg-pop-lmseg-btn--on bg-[var(--listen-mode-active-bg)] text-[var(--listen-mode-active-fg)] shadow-[var(--listen-mode-active-shadow)]'
const profileListenButtonInactiveClass = 'bg-transparent text-[var(--listen-mode-fg)]'

// @@@1255 — 管理区表单（群角色 / 移出群聊）。
// 设计稿的 .pop 资料卡本身没有管理表单（管理控件在群设置抽屉里），故这里借用设置抽屉的
// aset-row / aset-sel / .tgl / aset-danger 习语，但按资料卡 popover 的紧凑尺度落地（标签/选择走
// --font-body，而非照抄抽屉的 13px）。色值复用代码库既有组件（asClass.profileDanger）。
const profileManageClass = 'gg-pop-manage flex flex-col gap-2.5 border-t border-[var(--border-color)] px-4 pb-4 pt-3'
const profileManageRowClass = 'gg-pop-manage-row flex items-center justify-between gap-3'
// 双行（标签+描述）行用 flex-start 顶对齐开关，对齐 .aset-row 与群设置抽屉 通知/邀请链接 行的既有写法。
const profileManageLabelClass = 'gg-pop-manage-label text-[length:var(--font-body)] font-medium text-[var(--text-primary)]'
const profileManageSelectClass = 'gg-pop-manage-sel max-w-[52%] shrink-0 cursor-pointer rounded-lg border border-[var(--border-strong)] bg-[var(--bg-primary)] px-2 py-1.5 text-[length:var(--font-body)] text-[var(--text-primary)] outline-none [font-family:inherit] focus:border-[var(--accent)] disabled:cursor-default disabled:opacity-60'
// @@@2322 危险项 hover 归 --danger-tint(spec:状态反馈唯一允许的色相);rest 底 #ef44440d 是静止装饰 tint,
// 无对应 token(--danger-tint 是 hover 档)、观感逐值保持 → 保留字面值。
const profileManageDangerClass = 'gg-pop-manage-danger !mt-0.5 w-full cursor-pointer rounded-lg border-0 bg-[var(--danger-tint)] !py-2.5 text-[length:var(--font-body)] font-medium text-[var(--danger-fg)] [font-family:inherit] transition-[background] duration-[var(--dur-fast)] ease-[var(--ease)] hover:bg-[var(--danger-tint)] disabled:cursor-default disabled:opacity-50'
// @@@2247 - inline error line for a failed manage mutation, rendered inside the card portal (danger tint).
const profileManageErrorClass = 'gg-pop-manage-error mt-0.5 text-[length:var(--font-caption)] leading-[1.4] text-[var(--danger-fg)]'

function listenModeButtonClass(active: boolean): string {
  return cn(profileListenButtonBaseClass, active ? profileListenButtonActiveClass : profileListenButtonInactiveClass)
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface MemberProfileCardModel {
  id: string
  guguNumber?: number | null
  displayName: string; removedAt?: string | null
  avatar: string | null
  email: string | null
  /** Bio text from ContactUser.bio or agent profile. Null = no bio set. */
  bio?: string | null
  type: GroupMemberType
  ownerUserId?: string | null
  ownerDisplayName?: string | null
  role: GroupMemberRole
  profileScope?: 'group' | 'direct'
  /**
   * 'former' = 不在当前名册、只因发过消息而有资料(退群 / 被移出);成员列表不列他,消息气泡与资料卡照常。
   * 'unknown' = 名册还没读到:角色、档位画占位,不出管理控件 —— ❌ 当成已退群的「成员」。
   */
  membership?: 'current' | 'former' | 'unknown'
  agentStatus?: AgentDisplayStatus
  /** listen_mode from GroupAgentItem (agent-only, group scope). */
  listenMode?: ListenMode
  agentMeta?: {
    currentTaskTitle?: string | null
    lastAction?: string | null
  }
}

export type MemberProfileChatTarget = {
  id: string
  displayName: string
  avatar: string | null
  email: string | null
  bio: string | null
  type: GroupMemberType
  /** 这个 agent 是某台机器上的一条会话:「发消息」打开的是它的会话页,❌ 另开一个空私聊。 */
  session?: AgentSession
}

// @@@profile-edit-controls - Rendered for a group owner/admin (role, remove) and for an agent's owner
// (listen mode, take it out of the group). Each handler is optional; the card renders only what is wired.
export interface MemberProfileEditControls {
  canChangeRole?: boolean
  onChangeRole?: (role: GroupMemberRole) => Promise<void> | void
  // @@@1208 (#857 收尾) listen-mode 变更:agent 的主人看它时父级才给这个回调,分段控件变可交互(否则只读镜像)。
  onChangeListenMode?: (mode: ListenMode) => Promise<void> | void
  /** The group owner looking at another human: hand the group over (asks first), or why this group cannot be handed over. */
  transferOwner?: { onTransfer: () => void } | { blockedReason: string }
  canRemove?: boolean
  removeLabel?: string
  /** What the removal does, shown under the button (topics: the person can still read it). */
  removeHint?: string
  onRemove?: () => Promise<void> | void
  busy?: boolean
  // @@@2247 - error text for the last manage-control mutation (remove / role / listen). The
  // card is a portal overlay, so the drawer-body error line renders BEHIND it and the owner sees nothing
  // (e.g. "移出群聊" on a ghost member fails fail-loud but silently). Surface it INSIDE the card instead.
  editError?: string | null
}

// @@@profile-alias - Provided only when the member is one of the viewer's contacts
// (self and non-contacts are absent from the contacts list, so they get no editor).
export interface MemberProfileAliasControls {
  alias: string | null
  onSave: (alias: string) => Promise<void> | void
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function AliasField({ controls }: { controls: MemberProfileAliasControls }) {
  const { t } = useTranslation('contacts')
  const saved = controls.alias ?? ''
  const [draft, setDraft] = useState(saved)
  const [saving, setSaving] = useState(false)

  useEffect(() => { setDraft(controls.alias ?? '') }, [controls.alias])

  const save = async () => {
    const next = draft.trim()
    if (next === saved || saving) return
    setSaving(true)
    try { await controls.onSave(next) } finally { setSaving(false) }
  }

  return (
    <div className={profileFieldRowClass}>
      <span className={profileFieldLabelClass}>{t('profile.alias')}</span>
      <input
        data-profile-alias-input
        value={draft}
        disabled={saving}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (isImeComposing(event)) return
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') setDraft(saved)
        }}
        placeholder={t('profile.notSet')}
        maxLength={80}
        style={{ minWidth: 0, height: 24, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-document)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 'var(--font-caption)', padding: '0 6px', outline: 'none', fontFamily: 'inherit' }}
      />
    </div>
  )
}

function DataRow({ field, label, value }: { field: string; label: string; value: ReactNode }) {
  return (
    <div className={profileFieldRowClass}>
      <span className={profileFieldLabelClass}>{label}</span>
      <span data-profile-field={field} className={profileFieldValueClass}>{value}</span>
    </div>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────

export function MemberProfileCard({
  member,
  onOpenChat,
  onWhisper,
  onFindMessages,
  editControls,
  aliasControls,
  fill = false,
}: {
  member: MemberProfileCardModel
  onOpenChat?: (target: MemberProfileChatTarget) => void
  // @@@whisper (#820) — 群聊模式下悄悄话入口；仅 isGroupProfile && onWhisper 时渲染。
  onWhisper?: (target: MemberProfileChatTarget) => void
  /** 「查找 TA 的消息」:这个会话的全局搜索,带 in: 和 from: 两枚可删的标签。 */
  onFindMessages?: () => void
  editControls?: MemberProfileEditControls
  aliasControls?: MemberProfileAliasControls
  fill?: boolean
}) {
  const { t } = useTranslation(['contacts', 'messaging'])
  const isAgent = member.type === 'agent'
  const identity = useAvatarIdentity(isAgent ? member.id : '')
  const shownName = useShownAgentName({ name: member.displayName, createdAt: isAgent ? identity?.created_at ?? undefined : undefined })
  // single = direct scope (not in a group) → matches prototype .pop.single
  const isSingle = member.profileScope !== 'group'
  const isGroupProfile = !isSingle
  const status = member.agentStatus
  const { presence } = useAgentDisplayStatus(isAgent ? member.id : null)
  const statusLabel = useAgentContactStatusLabel(status, presence.presentation)
  const { user } = useAuth()
  // Desktop: the session bridge the task bundle publishes. The phone has no such bundle: it finds the agent's session in
  // its session directory, as its agent chat header and Partners rows do (#673, #658).
  const phone = useMobileShell()
  const bridged = useAgentSession(isAgent && !phone ? member.id : null)
  const row = useAgentSessionRow(isAgent && phone ? member.id : null)
  const session: AgentSession | undefined = phone
    ? (row ? { projectId: row.session.projectId, sessionId: row.session.conversationId } : undefined)
    : bridged
  // 别人的 agent 不能私聊(#509):不画能点的「发消息」(#6832)。通讯录那边同一条规则见 ContactsPanel 的 isOwnedAgent。
  // An agent's「发消息」opens its session and nothing else (#622): no session found → no button, ❌ a DM fallback. The DM
  // itself stays reachable where the product offers it; only this entry is closed.
  const canOpenChat = !!onOpenChat && (!isAgent || (member.ownerUserId === user?.id && !!session))
  const editBusy = !!editControls?.busy
  const rosterUnknown = member.membership === 'unknown'
  const showEdits = isGroupProfile && !rosterUnknown && (editControls?.canChangeRole || editControls?.canRemove || editControls?.transferOwner)
  const roleLabel = rosterUnknown ? <Unknown /> : member.role === 'owner' ? t('profile.roles.owner') : member.role === 'admin' ? t('profile.roles.admin') : t('profile.roles.member')

  // Listen-mode (收听模式): agent-only, group scope.
  // member.listenMode comes from GroupAgentItem.listen_mode via toAgentProfile.
  // Defaults to 'active' when absent (matches DB default).
  const showListenMode = isAgent && isGroupProfile
  const listenMode: ListenMode = member.listenMode ?? 'active'
  // @@@1208 (#857 收尾) 仅当父级(agent 的主人)接了 onChangeListenMode 才让分段控件可交互;否则只读镜像。
  const canEditListenMode = showListenMode && !!editControls?.onChangeListenMode

  // @@@share — 同一个「分享」,各自用已有的那条路:
  // 人 (#1111) 复用 contact QR 分享卡(SharePosterDialog),由咕咕号生成 add-me QR;无咕咕号 → 按钮禁用并说明原因。
  // agent 走通讯录名片同一个 ShareAgentModal(share_agent:选好友 → 发入群邀请)。它是 owner-only,非主人不给入口
  // (与 ContactsPanel 的 isOwnedAgent 同一条规则);❌ 给 agent 出咕咕号海报(agent 的号是懒分配的,群里那张卡常常没有号)。
  const [showShare, setShowShare] = useState(false)
  const { contacts } = useContactsStore()
  const ownedAgentContact = isAgent && member.ownerUserId === user?.id ? contacts.find((c) => c.id === member.id) : undefined
  const shareQrValue =
    !isAgent && typeof member.guguNumber === 'number' && Number.isInteger(member.guguNumber) && member.guguNumber > 0
      ? createGuguQrUrl(createContactQrPayload(member.guguNumber))
      : null
  const showShareAction = !isAgent || !!ownedAgentContact
  const canShare = isAgent ? !!ownedAgentContact : shareQrValue !== null
  const SelfOrContactShare = member.id === user?.id ? PersonalSharePreview : SharePosterDialog

  const handleOpenChat = () => {
    if (!onOpenChat) return
    onOpenChat({
      id: member.id,
      displayName: member.displayName,
      avatar: member.avatar,
      email: member.email,
      bio: member.bio ?? null,
      type: member.type,
      session,
    })
  }

  // Keep the actual avatar at the card's size; badges must remain outside its bounds. One size for people and agents.
  const avatarSize = phone ? 64 : 56
  const listenHeading = t('profile.listenModeDescription')

  return (
    <>
    <div className={cn(fill ? profileFillClass : profileCardClass, isSingle && profileSingleClass)}>
      {/* ── Header: avatar + name + tag (prototype .ph, line 445-446) ── */}
      <div className={profileHeaderClass}>
        <div style={{ width: avatarSize, height: avatarSize, flexShrink: 0, position: 'relative' }}>
          <Avatar
            name={shownName}
            avatarUrl={member.avatar}
            seed={member.id}
            size={avatarSize}
            isAgent={isAgent}
            agentStatus={status}
          />
        </div>
        <div className={profileHeaderTextClass} style={{ flex: 1, minWidth: 0 }}>
          {isAgent ? <OwnedAgentNameEditor key={member.id} agentId={member.id} name={member.displayName} ownerUserId={member.ownerUserId} status={status} membership={member.membership} className={cn('text-base font-semibold', !phone && '[--control-h-sm:24px]')}><span className={profileNameClass}>{shownName}</span></OwnedAgentNameEditor> : <div className={profileNameClass}>{member.displayName}</div>}
          {/* One metadata line, the same cells-with-gap idiom as the agent's row in the member list. */}
          {isAgent ? (
            <div data-profile-agent-meta className={profileAgentMetaClass}>
              {statusLabel ? <span className="shrink-0">{statusLabel}</span> : null}
              <span className="min-w-0 line-clamp-2 [overflow-wrap:anywhere]" data-profile-agent-owner><AgentOwnerLabel ownerUserId={member.ownerUserId} ownerDisplayName={member.ownerDisplayName} /></span>
            </div>
          ) : null}
        </div>
      </div>

      {/* ── Action buttons (prototype .pacts) — one layout for people and agents, see @@@one-card ── */}
      <div className={profileActionsClass}>
        {/* 发消息 — wired to existing onOpenChat handler */}
        {canOpenChat ? (
          <Button
            size="lg"
            variant="primary"
            data-testid="member-profile-send-message-button"
            className={profilePrimaryActionClass}
            onClick={handleOpenChat}
          >
            <MessageCircle size={16} />
            <span className="truncate">{t('common.sendMessage')}</span>
          </Button>
        ) : null}

        <div className={profileSecondaryRowClass}>
          {/* 悄悄话 — 群聊模式且父组件提供 onWhisper 时显示（对标设计稿 .pbtn.hide-single）。 */}
          {isGroupProfile && onWhisper ? (
            <ProfileCardAction
              stacked
              icon={FacemaskCircle}
              label={t('profile.whisper')}
              onClick={() => {
                onWhisper({
                  id: member.id,
                  displayName: member.displayName,
                  avatar: member.avatar,
                  email: member.email,
                  bio: member.bio ?? null,
                  type: member.type,
                })
              }}
            />
          ) : null}

          {onFindMessages ? (
            <ProfileCardAction
              stacked
              icon={Search}
              label={t('profile.findMessagesShort')}
              title={t('profile.findMessages')}
              testId="member-profile-find-messages-button"
              onClick={onFindMessages}
            />
          ) : null}

          {showShareAction ? (
            <ProfileCardAction
              stacked
              icon={Share}
              label={t('common.share')}
              disabled={!canShare}
              title={canShare ? undefined : t('profile.shareUnavailable')}
              onClick={() => { if (canShare) setShowShare(true) }}
            />
          ) : null}
        </div>
      </div>

      {/* ── Data fields (咕咕号 / 群角色 / etc) ─────
          Not in prototype visual but preserved for existing tests and data display.
          咕咕号 always rendered — direct profiles need it too (test invariant).
          @@@1344(a) — group-agent 卡隐藏群语境字段(备注/群角色/咕咕号/任务/动作)，保留身份字段
          (简介/邮箱)、收听模式与管理区。直接资料卡与群里的人类成员卡保留完整字段。 ─── */}
      {member.bio || member.email || !(isAgent && isGroupProfile) ? (
        <FieldList className={profileFieldsClass}>
          {member.bio ? <DataRow field="bio" label={t('profile.bio')} value={member.bio} /> : null}
          {member.email ? <DataRow field="email" label={t('profile.email')} value={member.email} /> : null}
          {!(isAgent && isGroupProfile) ? (
            <>
              {aliasControls ? <AliasField controls={aliasControls} /> : null}
              {isGroupProfile ? (
                <DataRow field="role" label={t('profile.groupRole')} value={roleLabel} />
              ) : null}
              <DataRow field="id" label={t('common.guguNumber')} value={member.guguNumber == null ? t('common.unassigned') : member.guguNumber} />
              {isAgent ? (
                <>
                  {member.agentMeta?.currentTaskTitle ? (
                    <DataRow field="current-task" label={t('profile.currentTask')} value={member.agentMeta.currentTaskTitle} />
                  ) : null}
                  {member.agentMeta?.lastAction ? (
                    <DataRow field="last-action" label={t('profile.lastAction')} value={resolveMessagingValue(member.agentMeta.lastAction)} />
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
        </FieldList>
      ) : null}

      {/* ── 收听模式 segmented control (prototype .lm/.lmseg, lines 453-457)
          Agent-only, room scope. The parent supplies onChangeListenMode for the agent owner
          or a current source-group manager. Other viewers retain the read-only projection. ── */}
      {showListenMode ? (
        <div className={profileListenClass}>
          <div className="flex h-8 items-center gap-3">
            <div className={profileListenLabelClass}>{listenHeading}</div>
            <div className={profileListenSegmentClass} role="group" aria-label={listenHeading}>
              {rosterUnknown ? <Unknown /> : LISTEN_MODES.map((mode) => (
                <Hint key={mode} label={t(`group.memberList.listen.${mode}Hint`, { ns: 'messaging' })} side="top">
                  <button
                    type="button"
                    className={listenModeButtonClass(listenMode === mode)}
                    aria-pressed={listenMode === mode}
                    disabled={canEditListenMode ? editBusy : undefined}
                    style={{ cursor: canEditListenMode ? 'pointer' : 'default' }}
                    onClick={canEditListenMode ? () => { void editControls?.onChangeListenMode?.(mode) } : undefined}
                  >
                    {mode === 'passive' ? t('profile.listenModes.passive') : t('profile.listenModes.proactive')}
                  </button>
                </Hint>
              ))}
            </div>
          </div>
          {/* 只接了档位的卡(消息头像 / 话题)没有下面那块管理区,没改成的原因就写在分段下面。 */}
          {!showEdits && editControls?.editError ? (
            <div className={profileManageErrorClass} role="alert" data-profile-edit-error={member.id}>
              {editControls.editError}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ── Edit controls (group owner/admin: role, remove; agent owner: take it out of the group) ── */}
      {showEdits ? (
        <div className={profileManageClass}>
          {editControls?.canChangeRole ? (
            <div className={profileManageRowClass}>
              <span className={profileManageLabelClass}>{t('profile.groupRole')}</span>
              <select
                data-profile-role-select={member.id}
                className={profileManageSelectClass}
                value={member.role}
                disabled={editBusy}
                onChange={(event) => editControls.onChangeRole?.(event.target.value as GroupMemberRole)}
              >
                {/* Ownership is not a role pick: it moves through the transfer action below. */}
                {(['admin', 'member'] as const).map((role) => <option key={role} value={role}>{role === 'admin' ? t('profile.roles.admin') : t('profile.roles.member')}</option>)}
              </select>
            </div>
          ) : null}
          {editControls?.transferOwner ? (
            <Button
              size="sm"
              variant="secondary"
              data-profile-transfer-owner={member.id}
              className="w-full"
              onClick={'onTransfer' in editControls.transferOwner ? editControls.transferOwner.onTransfer : undefined}
              disabled={editBusy || !('onTransfer' in editControls.transferOwner)}
            >
              {t('group.memberList.transferOwner', { ns: 'messaging' })}
            </Button>
          ) : null}
          {editControls?.transferOwner && 'blockedReason' in editControls.transferOwner ? (
            <div className="text-[length:var(--font-caption)] leading-[1.4] text-[var(--faint-fg)]" data-profile-transfer-owner-hint={member.id}>{editControls.transferOwner.blockedReason}</div>
          ) : null}
          {editControls?.canRemove ? (
            <button
              type="button"
              data-profile-remove-button={member.id}
              className={profileManageDangerClass}
              onClick={() => editControls.onRemove?.()}
              disabled={editBusy}
            >
              {editControls?.removeLabel ?? (isAgent && member.ownerUserId === user?.id ? t('profile.agentLeaveGroup') : t('profile.removeFromGroup'))}
            </button>
          ) : null}
          {editControls?.canRemove && editControls.removeHint ? (
            <div className="text-[length:var(--font-caption)] leading-[1.4] text-[var(--faint-fg)]" data-profile-remove-hint={member.id}>{editControls.removeHint}</div>
          ) : null}
          {editControls?.editError ? (
            <div className={profileManageErrorClass} role="alert" data-profile-edit-error={member.id}>
              {editControls.editError}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
    {showShare && shareQrValue ? (
      <SelfOrContactShare
        title={member.displayName}
        subtitle="咕咕"
        qrValue={shareQrValue}
        onClose={() => { setShowShare(false) }}
      />
    ) : null}
    {showShare && ownedAgentContact ? (
      <ShareAgentModal agent={ownedAgentContact} contacts={peopleContacts(contacts)} zIndex="var(--z-modal-top)" onClose={() => { setShowShare(false) }} />
    ) : null}
    </>
  )
}
