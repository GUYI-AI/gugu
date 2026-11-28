import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { SshLinkFailure } from '@/lib/sshLink'
import { showSshStatusInPlace, sshLinkNoticeReason } from '@/lib/sshLinkNotice'
import { useConversationVisibility } from '../chat/useConversationVisibility'
import './device-recovery.css'

export type RecoveryState = SshLinkFailure | 'connected' | 'checking' | 'offline'

export function DeviceRecoveryStatus({ deviceId, state }: { deviceId: string; state: RecoveryState }) {
  const { t } = useTranslation('settings')
  const reason = state === 'checking' || state === 'connected' || state === 'offline' ? null : sshLinkNoticeReason(state)
  const { ref, shown } = useConversationVisibility<HTMLSpanElement>(!!reason && typeof IntersectionObserver !== 'undefined')
  useEffect(() => {
    if (shown && reason) return showSshStatusInPlace(deviceId, reason)
  }, [shown, reason, deviceId])
  return <span ref={ref} role="status" className="gg-recovery-status" data-state={state}>
    <i aria-hidden="true" />{t(`devices.recovery.${state}.status`)}
  </span>
}
