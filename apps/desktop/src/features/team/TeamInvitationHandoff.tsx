import { useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/store/auth'
import { Button } from '@/components/ui/Button'
import { TeamDialog } from './TeamPrimitives'
import { teamInvitation } from './invitation'

export function TeamInvitationHandoff() {
  const invitation = useSyncExternalStore(teamInvitation.subscribe, teamInvitation.getSnapshot)
  const { t } = useTranslation('team'), { logout } = useAuth(), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false)
  if (!invitation.pending && !invitation.invalid) return null
  async function exit() {
    setBusy(true); setFailed(false)
    try { const result = await logout(); if (!result.success) { setFailed(true); setBusy(false) } }
    catch { setFailed(true); setBusy(false) }
  }
  return <TeamDialog title={t('acceptInvitation')} onClose={() => { if (!busy) teamInvitation.clear() }} actions={<>
    <Button disabled={busy} onClick={() => teamInvitation.clear()}>{t('cancel')}</Button>
    {invitation.pending && <Button variant="primary" disabled={busy} onClick={() => { void exit() }}>{t('accountSwitch')}</Button>}
  </>}><p>{t(invitation.invalid ? 'invitationInvalid' : 'invitationSwitchHint')}</p>{failed && <p role="alert">{t('updateFailed')}</p>}</TeamDialog>
}
