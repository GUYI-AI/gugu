import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import { resolveOrLoud } from '@gugu/core/shared/resolveOrLoud'
import { platform } from '@/platform'
import { Link, QrCode } from '@/lib/icons'
import { safeFailureLine } from '@/session/renderer/features/sessions/gugu-reason'
import { displayAvatarUrl } from '../../lib/dicebearAvatar'
import { useChatStore } from '../../store/chatContext'
import { useAgentLookPostersVersion } from '../agentAvatar/posters'
import { QrImage } from '../QrImage'
import { SharePosterDialog } from '../SharePosterDialog'
import { useToast } from '../toastContext'
import { Button } from '../ui/Button'
import { buildUnifiedMembers, GROUP_FACES } from './groupMemberModels'

/** Displayed size of a group's own invite QR code. */
const GROUP_INVITE_QR_SIZE = 208

interface GroupInviteShareProps {
  /** groupInviteLinkFor 的结果:为 null(开关关着、项目群)时调用方不画这里的任何东西。 */
  inviteLink: string
  groupName: string | null | undefined
  snapshot: GroupCollabSnapshot
}

/**
 * @@@group-share 分享一个群 = 它的邀请链接(复制)和海报(带码)。两副样子共用这一份动作:
 * - GroupInviteActions:一排按钮,放在邀请单的确认按钮旁边;
 * - GroupInviteCode:码直接画出来,是「没人可选」时邀请单的主体,也是通讯录里群资料页上的那张码。
 */
export function GroupInviteActions(props: GroupInviteShareProps) {
  const { t } = useTranslation('messaging')
  const share = useGroupInviteShare(props)
  return (
    <div data-testid="group-invite-link" data-layout="bar" className="flex min-w-0 items-center gap-2">
      <Button variant="secondary" size="sm" data-testid="group-invite-copy-link" title={props.inviteLink} onClick={share.copy}>
        <Link size={14} />{t('group.settings.copyLink')}
      </Button>
      <Button variant="secondary" size="sm" data-testid="group-invite-qr" onClick={share.openPoster}>
        <QrCode size={14} />{t('group.settings.qrCode')}
      </Button>
      {share.poster}
    </div>
  )
}

export function GroupInviteCode(props: GroupInviteShareProps) {
  const { t } = useTranslation('messaging')
  const share = useGroupInviteShare(props)
  return (
    <div data-testid="group-invite-link" data-layout="main" className="flex flex-col items-center gap-5">
      <QrImage value={props.inviteLink} size={GROUP_INVITE_QR_SIZE} alt={t('group.settings.qrCode')} />
      <div className="flex min-w-0 items-center gap-2">
        <Button variant="primary" data-testid="group-invite-copy-link" title={props.inviteLink} onClick={share.copy}>
          <Link size={14} />{t('group.settings.copyLink')}
        </Button>
        <Button variant="secondary" data-testid="group-invite-qr" onClick={share.openPoster}>
          <QrCode size={14} />{t('sharing.posterTitle', { ns: 'contacts' })}
        </Button>
      </div>
      {share.poster}
    </div>
  )
}

function useGroupInviteShare({ inviteLink, groupName, snapshot }: GroupInviteShareProps) {
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const { identitiesById } = useChatStore('identitiesById')
  const [showPoster, setShowPoster] = useState(false)
  // @@@445/#2470 海报 canvas 不走 React Avatar → 按同一口径预解析成员头像;小鸟的定格画好了会重渲染,这里跟着重读。
  useAgentLookPostersVersion()
  const copy = () => {
    void platform.writeClipboardText(inviteLink).then(
      () => toast(t('group.settings.inviteCopied'), 'success'),
      (error: unknown) => toast(t('actions.copyFailed', { ns: 'common' }), 'error', safeFailureLine(String((error as Error)?.message ?? error))),
    )
  }
  const totalMembers = snapshot.humans.length + snapshot.agents.length
  const poster = showPoster ? (
    <SharePosterDialog
      title={resolveOrLoud(groupName, 'group share poster title')}
      subtitle={t('group.settings.posterSubtitle', { count: totalMembers })}
      qrValue={inviteLink}
      memberAvatarUrls={buildUnifiedMembers(snapshot).slice(0, GROUP_FACES).map((m) => {
        const identity = identitiesById[m.id]
        return identity ? displayAvatarUrl(identity.avatar ?? null, m.id, `poster member "${identity.display_name || m.id}"`, identity.type) : null
      })}
      totalMemberCount={totalMembers}
      qrCaption={t('group.settings.posterQrCaption')}
      ctaText={t('group.settings.posterCta')}
      onClose={() => setShowPoster(false)}
    />
  ) : null
  return { copy, openPoster: () => setShowPoster(true), poster }
}
