import { useShownAgentName } from '@/hooks/useShownAgentName'
import { OwnedAgentNameEditor } from './OwnedAgentNameEditor'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { useAgentDisplayStatus } from '../../hooks/useAgentDisplayStatus'
import {
  agentContactPresentation,
  useShownAgentContactStatus,
  type AgentContactTone,
} from '../contactAgentTone'
import { Avatar } from '../Avatar'
import { AgentContactStatusMark } from '../AgentContactStatusMark'
import { AgentHarnessModelChips } from '../AgentHarnessModelChips'
import { CopyValue } from '../CopyValue'
import { Button } from '../ui/Button'
import { useTranslation } from 'react-i18next'
import { useEffect, useState } from 'react'
import { cn } from '@/lib/cn'
import { MessageCircle, Pencil, Settings, Share, Trash, UserPlus } from '@/lib/icons'
import { useContactsStore } from '../../store/contactsContext'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import type { AgentRequestState } from './agentContactRequest'
import { nameClampClass, profileCardStyles as styles } from './contactsPanelStyles'
import { ProfileCardAction } from './ProfileCardAction'
import { isImeComposing } from '@/lib/ime'
export type { AgentRequestState } from './agentContactRequest'



const avatarClass = () => cn(styles.avatarBase, styles.avatarRound)

// @@@2175 与 ContactsPanel 行同款。降暗(.standby)= 静默态(pending/offline);其余不降暗(要显眼)。
const statusClass = (tone: AgentContactTone) =>
  cn(styles.statusBase, (tone === 'pending' || tone === 'offline') && styles.statusStandby)

function displayName(contact: ContactUser): string {
  return contact.alias?.trim() || contact.display_name
}

// @@@2166① 文案与其它每一面同一张表(common:agentStatus.*):offline「待命」→「离线」(owner 拍板,11-24 定为「离线」)。
export function RemovedAgentContactBadge() {
  const { t } = useTranslation('contacts')
  return (
    // 颜色留在 inline:它是这个「已移除」状态面的可观测判据(单测按 style.color 判)。几何走类。
    <span
      data-agent-status-surface="contact-index"
      className="inline-flex items-center gap-1 text-xs"
      style={{ color: 'var(--danger-fg)' }}
    >
      {t('profile.removed')}
    </span>
  )
}

export function AgentContactProfileCard({
  contact,
  onSwitchToChat,
  onShare,
  onSettings,
  onDelete,
  requestState,
  onRequest,
  onOpenGroup,
}: {
  contact: ContactUser
  onSwitchToChat?: () => void
  onShare?: () => void
  onSettings?: () => void
  onDelete?: () => void
  requestState?: AgentRequestState | null
  onRequest?: () => void
  onOpenGroup?: () => void
}) {
  const shownName = useShownAgentName({ name: contact.display_name, agentType: contact.agent_type, createdAt: contact.created_at ?? undefined })
  const { t } = useTranslation('contacts')
  const { status, presence } = useAgentDisplayStatus(contact.id)
  const { allowsLiveActions } = agentContactPresentation(status)
  const { tone, label: statusLabel } = useShownAgentContactStatus(contact.id, status, presence.presentation) // #7199 收回着 ≠ 不在线
  const requestLabel = requestState === 'joined'
    ? onOpenGroup ? t('commonGroups.open') : t('commonGroups.joined')
    : requestState === 'requested'
      ? t('commonGroups.requested')
      : requestState === 'requesting'
        ? t('commonGroups.requesting')
        : t('commonGroups.requestJoin')
  const hasOwnedActions = Boolean(onSwitchToChat || onShare || onSettings)
  return (
    <div className={styles.card}>
      <div className={avatarClass()}>
        <Avatar name={shownName} avatarUrl={contact.avatar} seed={contact.id} size={96} isAgent />
      </div>
      <OwnedAgentNameEditor key={contact.id} agentId={contact.id} name={contact.display_name} ownerUserId={contact.owner_user_id} status={status} className={styles.name}>
        {shownName}
      </OwnedAgentNameEditor>
      {tone ? (
        <div className={statusClass(tone)}>
          <AgentContactStatusMark tone={tone} />
          {statusLabel}
        </div>
      ) : null}
      {/* 与群里的资料卡同一组:harness 与模型两枚胶囊(owner 11-26,兄弟界面一起改)。 */}
      <AgentHarnessModelChips agentId={contact.id} className="mt-2 justify-center" />
      {allowsLiveActions ? (
        hasOwnedActions ? <div className={styles.actions}>
          {allowsLiveActions && onSwitchToChat ? (
            <ProfileCardAction icon={MessageCircle} label={t('common.sendMessage')} testId={AUTOMATION_TEST_IDS.contactsDetailSendMessageButton} onClick={onSwitchToChat} />
          ) : null}
          {/* @@@1990 owner 门控与「删除」同款:handler 缺席即不渲染——分享 RPC(share_agent)与
              Agent 设置都是 owner-only,非 owner 渲染出来就是必撞 not-owned 的死按钮(无权就不给入口)。 */}
          {onShare ? (
            <ProfileCardAction icon={Share} label={t('common.share')} onClick={onShare} />
          ) : null}
          {onSettings ? (
            <ProfileCardAction icon={Settings} label={t('common.settings')} onClick={onSettings} />
          ) : null}
        </div> : null
      ) : null}
      {requestState ? (
        <div className={styles.actions}>
          <Button
            type="button"
            variant={requestState === 'available' ? 'primary' : 'ghost'}
            size="sm"
            className="min-w-[130px]"
            data-testid="contact-shared-agent-primary-action"
            disabled={requestState === 'joined' ? !onOpenGroup : requestState !== 'available' || !onRequest}
            onClick={requestState === 'joined' ? onOpenGroup : requestState === 'available' ? onRequest : undefined}
          >
            {requestState === 'joined' ? <MessageCircle size={19} /> : <UserPlus size={19} />}
            {requestLabel}
          </Button>
        </div>
      ) : null}
      {allowsLiveActions && onDelete ? (
        <button type="button" className={styles.delete} onClick={onDelete}>
          <Trash size={14} />
          {t('contextMenu.deleteAgent')}
        </button>
      ) : null}
    </div>
  )
}

// #5645 备注编辑(微信同款):点进灰框直接改,回车/失焦保存,Esc 还原,80 字上限(= 库约束)。
// 直接读 contacts store 而不走 props:宿主 ContactsPanel 行数被 CI 冻结,MemberProfilePopover 同款。
export function PersonAliasField({ contact }: { contact: ContactUser }) {
  const { t } = useTranslation('contacts')
  const { updateContactAlias } = useContactsStore()
  const saved = contact.alias?.trim() ?? ''
  const [draft, setDraft] = useState(saved)
  const [saving, setSaving] = useState(false)

  useEffect(() => { setDraft(contact.alias?.trim() ?? '') }, [contact.id, contact.alias])

  const save = async () => {
    const next = draft.trim()
    if (next === saved || saving) return
    setSaving(true)
    try { await updateContactAlias(contact.id, next) } finally { setSaving(false) }
  }

  return (
    <div className={styles.aliasRow}>
      <label className={styles.aliasLabel} htmlFor="contact-alias-input">{t('profile.alias')}</label>
      <div className={styles.aliasBox}>
        <input
          id="contact-alias-input"
          data-testid={AUTOMATION_TEST_IDS.contactsDetailAliasInput}
          className={styles.aliasInput}
          value={draft}
          disabled={saving}
          maxLength={80}
          placeholder={t('profile.notSet')}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (isImeComposing(event)) return
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') setDraft(saved)
          }}
        />
        <Pencil size={14} className={styles.aliasPen} />
      </div>
    </div>
  )
}

export function PersonContactProfileCard({
  contact,
  onSwitchToChat
}: {
  contact: ContactUser
  onSwitchToChat?: () => void
}) {
  const { t } = useTranslation('contacts')
  const hasAlias = Boolean(contact.alias?.trim())
  return (
    <div className={styles.card}>
      <div className={avatarClass()}>
        <Avatar name={contact.display_name} avatarUrl={contact.avatar} seed={contact.id} size={96} />
      </div>
      <div className={styles.name}><span className={nameClampClass} title={displayName(contact)}>{displayName(contact)}</span></div>
      {hasAlias ? (
        <div className={styles.guguNumber} data-testid={AUTOMATION_TEST_IDS.contactsDetailOriginalName}>
          <span className={styles.guguNumberLabel}>{t('profile.originalName')}</span>
          <span className={styles.originalName}>{contact.display_name}</span>
        </div>
      ) : null}
      <div className={styles.guguNumber}>
        <span className={styles.guguNumberLabel}>{t('common.guguNumber')}</span>
        {contact.gugu_number == null ? (
          <span>{t('common.unassigned')}</span>
        ) : (
          <CopyValue value={String(contact.gugu_number)} message={t('common.copiedGuguNumber')} />
        )}
      </div>
      <PersonAliasField contact={contact} />
      <div className={styles.actions}>
        <ProfileCardAction icon={MessageCircle} label={t('common.sendMessage')} testId={AUTOMATION_TEST_IDS.contactsDetailSendMessageButton} onClick={onSwitchToChat} />
      </div>
    </div>
  )
}
