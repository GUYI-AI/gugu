import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/store/auth'
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsPrimitives'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { TeamDialog } from './TeamPrimitives'
import { teamErrorCopy, teamRoleLabel } from './copy'
import { useTeamApi, useTeamSession } from './context'
import { openTeamPage } from './navigation'
import { useTeamCommandKey } from './operations'

export function TeamAccountMembership() {
  const { t } = useTranslation('team'), session = useTeamSession()
  if (session.status !== 'ready' || !session.context) return null
  return <SettingsGroup presentation="summary"><SettingsRow title={session.context.team_name}
    control={<span className="gg-team-account-role">{teamRoleLabel(session.context.role, t)}</span>}
    onClick={() => openTeamPage()} /></SettingsGroup>
}

function ConfirmEmailDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('team'), session = useTeamSession(), api = useTeamApi(), { logout } = useAuth(), key = useTeamCommandKey()
  const [code, setCode] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const pending = session.profile?.pending_email_change
  if (!pending) return null
  async function confirm() {
    if (!pending || !/^\d{6}$/.test(code)) { setError(t('codeRequired')); return }
    setBusy(true); setError('')
    try {
      await api.confirmEmailChange(pending.challenge_id, code, key({ challenge: pending.challenge_id, code }))
      await logout()
    } catch (cause) { setError(teamErrorCopy(cause, t)); setBusy(false) }
  }
  return <TeamDialog title={t('confirmEmail')} onClose={() => { if (!busy) onClose() }} actions={<>
    <Button onClick={onClose} disabled={busy}>{t('cancel')}</Button>
    <Button variant="primary" onClick={() => { void confirm() }} disabled={busy}>{t('confirmEmail')}</Button>
  </>}><p>{t('confirmEmailHint', { email: pending.new_email })}</p>
    <Field.Root><Field.Label>{t('code')}</Field.Label><Field.Input autoComplete="one-time-code" inputMode="numeric" value={code}
      maxLength={6} disabled={busy} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} /></Field.Root>
    {error && <p role="alert" className="gg-team-error">{error}</p>}
  </TeamDialog>
}

export function TeamAccountMethods() {
  const { t } = useTranslation('team'), session = useTeamSession(), [confirm, setConfirm] = useState(false)
  if (session.status !== 'ready' || !session.profile) return null
  return <><SettingsGroup presentation="summary"><SettingsRow title={t('email')} control={session.profile.profile.email} />
    {session.profile.pending_email_change && <SettingsRow title={t('confirmEmail')} description={session.profile.pending_email_change.new_email}
      control={<Button onClick={() => setConfirm(true)}>{t('confirmEmail')}</Button>} />}
  </SettingsGroup>{confirm && <ConfirmEmailDialog onClose={() => setConfirm(false)} />}</>
}
