import { useGroupDisplayName } from '../../hooks/useGroupDisplayName'
import { messageForUser } from '@/lib/userFacingError';
/**
 * 群邀请一族 —— 从 ContactsPanel 抽出。
 *
 * 这五个组件（二维码分享 / 加群确认 / 公开群邀请行 / 群号搜索结果 / 加群弹层）
 * 共享同一件事：拿群号或邀请链接把人带进群。它们在 ContactsPanel 里分散在两处、
 * 相隔近两千行，中间隔着联系人详情、标签编辑、群聊详情等毫不相干的东西。
 * 放在一起既是内聚，也让 ContactsPanel 少背 500 行（该文件行数被 CI 冻结，只能减）。
 *
 * 视觉复用共享控件和字阶；二维码载荷、查询与入群流程留在原来的链路。
 */
import { useCallback, useState } from 'react'
import { X } from '@/lib/icons'
import type {
  ContactGroupChat,
  PublicGroupInviteGroup,
  PublicGroupInviteLookupResult,
} from '@gugu/core/shared/types/contacts'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { groupInviteLinkFor } from '../../lib/groupInviteShareUrl'
import { isProjectGroupChat } from '../../lib/groupMemberPermissions'
import { useGroupInviteJoin } from '../../lib/groupInviteJoin'
import { GroupInviteCard } from '../groups/GroupInviteCard'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Sheet } from '../ui/Sheet'
import { useTranslation } from 'react-i18next'
import { GroupInviteCode } from '../chat/GroupInviteShare'
import { groupSettings } from '../chat/useGroupChatSettings'
import { groupRoster } from '../../hooks/useRoomCollab'
import { useReplica, retryOf } from '../../lib/replica'
import { RefreshFailed } from '../ui/RefreshFailed'
import { publicGroupInvite } from '../../lib/publicGroupInvite'

/** 群聊详情里扫码加入的码。项目群不拉人(gugu-dev#181):不出码,说一句原因。 */
export function GroupInviteQrShare({ group }: { group: ContactGroupChat }) {
  const { t } = useTranslation('messaging')
  if (isProjectGroupChat(group.id)) {
    return <div data-testid="project-group-no-invite" className="text-[length:var(--font-caption)] text-[var(--muted-fg)]">{t('group.projectGroupNoInvite')}</div>
  }
  return <GroupInviteQr group={group} />
}

function GroupInviteQr({ group }: { group: ContactGroupChat }) {
  const { t } = useTranslation('contacts')
  // Only groups with a 群号 can be shared (channels and number-less groups never are).
  const hasGroupNumber = group.kind === 'group' && typeof group.public_id === 'number' && Number.isInteger(group.public_id) && group.public_id > 0
  // The group's own settings and roster readings (the same link and decision, groupInviteLinkFor, as its Invite sheet;
  // the poster needs the roster), ❌ a read of its own.
  const settings = useReplica(groupSettings, hasGroupNumber ? [group.id] : null)
  const roster = useReplica(groupRoster, hasGroupNumber ? [group.id, 'group'] : null)
  const failure = settings.state === 'error' ? settings.error : roster.state === 'error' ? roster.error : null
  const link = settings.state === 'value' ? groupInviteLinkFor(group.id, settings.value) : undefined

  // Sharing switched off: nothing to show. A failed read says why instead of hiding the section.
  if (!hasGroupNumber || link === null) return null
  return (
    <section className="!pt-4">
      <div className="!mb-3 text-[length:var(--font-body)] leading-[var(--lh-body)] text-[var(--text-secondary)]">{t('groupInvite.qrTitle')}</div>
      {failure ? <p role="alert" className="!m-0 text-[length:var(--font-body)] text-[var(--danger-fg)]">{messageForUser(failure)}</p>
        : link === undefined || roster.state !== 'value' ? <p className="!m-0 text-[length:var(--font-caption)] text-[var(--muted-fg)]">{t('common.loading')}</p>
        : <GroupInviteCode inviteLink={link} groupName={group.name} snapshot={roster.value} />}
    </section>
  )
}

export function GroupJoinConfirmDialog({
  group,
  onConfirm,
  onCancel,
}: {
  group: Pick<PublicGroupInviteGroup, 'name' | 'public_id' | 'member_count' | 'join_mode'>
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation('contacts')
  const groupName = useGroupDisplayName(group)
  // #855 — guard against a double-click double-join (the join RPC's `joining` guard reads a stale
  // closure on concurrent calls, so disable at the button on first confirm).
  const [submitting, setSubmitting] = useState(false)
  // @@@group-join-mode (#1018 step3 #858) — approval 群文案为「申请加入」+ 审批提示。
  const isApproval = group.join_mode === 'approval'
  return (
    <Sheet
      onClose={onCancel}
      desktopWidth="380px"
      testId={AUTOMATION_TEST_IDS.groupJoinConfirmDialog}
      ariaLabel={t('groupInvite.confirmTitle')}
    >
      <div
        style={{ position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, overflow: 'hidden' }}
      >
        <div style={{ padding: 20 }}>
          <div style={{ fontSize: 'var(--font-title)', lineHeight: 'var(--lh-title)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
            {isApproval ? t('groupInvite.requestTitle') : t('groupInvite.joinTitle')}
          </div>
          <div
            style={{
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-surface)',
              background: 'var(--bg-elevated)',
              padding: '12px 16px',
              display: 'flex',
              flexDirection: 'column',
              gap: 4
            }}
          >
            <div style={{ fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {groupName}
            </div>
            <div style={{ fontSize: 'var(--font-caption)', lineHeight: 'var(--lh-caption)', color: 'var(--text-secondary)' }}>
              {t('groupInvite.groupNumberHash', { number: group.public_id })}
            </div>
            <div style={{ fontSize: 'var(--font-caption)', lineHeight: 'var(--lh-caption)', color: 'var(--text-secondary)' }}>
              {t('groupInvite.memberCount', { count: group.member_count })}
            </div>
          </div>
          {isApproval ? (
            <div style={{ fontSize: 'var(--font-body)', color: 'var(--text-secondary)', marginTop: 8, lineHeight: 'var(--lh-body)' }}>
              {t('groupInvite.approvalHint')}
            </div>
          ) : null}
        </div>
        <div style={{ height: 56, borderTop: '1px solid var(--border-subtle)', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
          <Button
            onClick={onCancel}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            data-testid={AUTOMATION_TEST_IDS.groupJoinConfirmButton}
            disabled={submitting}
            onClick={() => { if (submitting) return; setSubmitting(true); onConfirm() }}
          >
            {isApproval ? t('groupInvite.requestJoin') : t('groupInvite.join')}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}

function PublicGroupInviteRow({
  group,
  canJoin,
  joining,
  joinError,
  onJoin,
}: {
  group: PublicGroupInviteGroup
  canJoin: boolean
  joining: boolean
  joinError: string | null
  onJoin: () => void
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)

  return (
    <>
      <div style={{ padding: '0 10px' }}>
        <GroupInviteCard
          group={group}
          density="list"
          joinTokenAvailable={canJoin}
          joining={joining}
          joinError={joinError}
          onJoin={canJoin ? () => setConfirmOpen(true) : undefined}
        />
      </div>
      {confirmOpen && (
        <GroupJoinConfirmDialog
          group={group}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => { setConfirmOpen(false); onJoin() }}
        />
      )}
    </>
  )
}

function PublicGroupInviteSearchResult({
  lookup,
  canJoin,
  joining,
  joinError,
  onJoin,
}: {
  lookup: PublicGroupInviteLookupResult | null
  canJoin: boolean
  joining: boolean
  joinError: string | null
  onJoin: () => void
}) {
  const { t } = useTranslation('contacts')
  if (!lookup) return null
  if (lookup.status === 'not_found' || !lookup.group) {
    return <div style={{ padding: 16, color: 'var(--text-secondary)', fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)' }}>{t('groupInvite.notFound')}</div>
  }
  return <PublicGroupInviteRow group={lookup.group} canJoin={canJoin} joining={joining} joinError={joinError} onJoin={onJoin} />
}

// @@@1169 (b) - token-gated group join via a scanned/pasted invite QR (a /join/:inviteCode route).
// This replaces the retired 数字群号 SEARCH entry: a foreign group is reachable only through its invite
// QR (which carries the unguessable join_token), driven by qrScanRoute's 'group_join' route — bypassing
// the (removed) 群号 search box, so sequential-号 enumeration is impossible.
export function GroupInviteJoinModal({
  publicId,
  joinToken,
  onClose,
}: {
  publicId: number
  joinToken?: string
  onClose: () => void
}) {
  const { t } = useTranslation('contacts')
  const reading = useReplica(publicGroupInvite, [publicId])
  const { joining, joinError, join } = useGroupInviteJoin()
  const group = reading.state === 'value' ? reading.value.group : null

  const onJoin = useCallback(async () => {
    if (!group || !joinToken || joining) return
    const entry = publicGroupInvite.at(publicId)
    try {
      const result = await join(group, joinToken)
      entry.set({ status: result.status === 'joined' ? 'joined' : 'available', group: result.group })
      if (result.status === 'joined') onClose()
    } catch {
      // useGroupInviteJoin owns the localized error and logs the original failure.
    }
  }, [group, publicId, joinToken, joining, join, onClose])

  return (
    <Sheet
      onClose={onClose}
      desktopWidth="380px"
      ariaLabel={t('groupInvite.joinTitle')}
    >
      <div
        style={{ position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, overflow: 'hidden' }}
      >
        <div style={{ padding: 16, borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 'var(--font-title)', lineHeight: 'var(--lh-title)', fontWeight: 600, color: 'var(--text-primary)' }}>{t('groupInvite.joinTitle')}</span>
          <IconButton aria-label={t('common.close')} onClick={onClose}><X size={16} /></IconButton>
        </div>
        {reading.state === 'unknown' ? (
          <div style={{ padding: 16, color: 'var(--text-secondary)', fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)' }}>{t('groupInvite.lookingUp')}</div>
        ) : reading.state === 'error' ? (
          <div style={{ padding: 16, color: 'var(--danger-fg)', fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)' }}>
            {t('groupInvite.lookupFailed')}{' '}
            <Button variant="ghost" size="sm" onClick={retryOf(reading)}>{t('common.retry')}</Button>
          </div>
        ) : (
          <>
            <PublicGroupInviteSearchResult lookup={reading.value} canJoin={joinToken != null} joining={joining} joinError={joinError} onJoin={onJoin} />
            {/* Looked up before, its lookup again failing: what was read stays, the failure said with a retry (❌ drawn as current). */}
            {reading.error ? <div className="px-4 pb-4"><RefreshFailed reading={reading} /></div> : null}
          </>
        )}
      </div>
    </Sheet>
  )
}
