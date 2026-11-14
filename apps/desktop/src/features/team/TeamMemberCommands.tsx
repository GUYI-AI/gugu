import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { DropdownMenu, MenuItem } from '@/components/ui/Menu'
import { copyTextWithFeedback } from '@/lib/copyTextWithFeedback'
import { useTeamApi } from './context'
import { teamErrorCopy } from './copy'
import { TeamDialog } from './TeamPrimitives'
import { useTeamCommandKey } from './operations'
import type { TeamInvitation, TeamMember } from './types'

export function TeamInviteDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const { t } = useTranslation('team'), api = useTeamApi(), key = useTeamCommandKey()
  const [email, setEmail] = useState(''), [result, setResult] = useState<TeamInvitation | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function invite() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError(t('emailRequired')); return }
    setBusy(true); setError('')
    try { setResult(await api.invite(email.trim(), key({ email: email.trim() }))); await onSaved() }
    catch (cause) { setError(teamErrorCopy(cause, t)) }
    finally { setBusy(false) }
  }
  return <TeamDialog title={t('invite')} onClose={() => { if (!busy) onClose() }} actions={result
    ? <><Button onClick={onClose}>{t('close')}</Button><Button variant="primary" onClick={() => { void copyTextWithFeedback(result.invitation_url) }}>{t('copyInvitation')}</Button></>
    : <><Button disabled={busy} onClick={onClose}>{t('cancel')}</Button><Button variant="primary" disabled={busy} onClick={() => { void invite() }}>{t('inviteAction')}</Button></>}>
    {result ? <p role="status">{t('invitedNotice')}</p> : <Field.Root><Field.Label>{t('memberEmail')}</Field.Label>
      <Field.Input type="email" autoComplete="off" value={email} disabled={busy} onChange={event => setEmail(event.target.value)} /></Field.Root>}
    {error && <p role="alert" className="gg-team-error">{error}</p>}
  </TeamDialog>
}

export function TeamEmailDialog({ member, onClose, onSaved }: { member: TeamMember; onClose: () => void; onSaved: () => Promise<void> }) {
  const { t } = useTranslation('team'), api = useTeamApi(), key = useTeamCommandKey()
  const [email, setEmail] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [sent, setSent] = useState(false)
  async function change() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError(t('emailRequired')); return }
    const command = { member_id: member.id, new_email: email.trim(), expected_revision: member.revision }
    setBusy(true); setError('')
    try { await api.changeEmail(member.id, command.new_email, member.revision, key(command)); setSent(true); await onSaved() }
    catch (cause) { setError(teamErrorCopy(cause, t)) }
    finally { setBusy(false) }
  }
  return <TeamDialog title={t('changeLoginEmail')} onClose={() => { if (!busy) onClose() }} actions={sent ? <Button onClick={onClose}>{t('close')}</Button>
    : <><Button disabled={busy} onClick={onClose}>{t('cancel')}</Button><Button variant="primary" disabled={busy} onClick={() => { void change() }}>{t('sendVerification')}</Button></>}>
    <p>{member.name}</p>{sent ? <p role="status">{t('emailVerificationSent')}</p> : <>
      <Field.Root><Field.Label>{t('newEmail')}</Field.Label><Field.Input type="email" autoComplete="off" value={email} disabled={busy} onChange={event => setEmail(event.target.value)} /></Field.Root>
      <p className="gg-team-muted">{t('memberMustConfirmEmail')}</p></>}
    {error && <p role="alert" className="gg-team-error">{error}</p>}
  </TeamDialog>
}

export function TeamDisableDialog({ member, candidates, onMore, loadingMore, onClose, onSaved }: {
  member: TeamMember; candidates: TeamMember[]; onMore?: () => void; loadingMore?: boolean; onClose: () => void; onSaved: () => Promise<void>
}) {
  const { t } = useTranslation('team'), api = useTeamApi(), key = useTeamCommandKey()
  const [operation, setOperation] = useState<string | null>(null), [complete, setComplete] = useState(false)
  const [handoff, setHandoff] = useState<string | undefined>()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function disable() {
    setBusy(true); setError('')
    try {
      const operationId = operation ?? (await api.disable(member.id, handoff, member.revision,
        key({ member_id: member.id, handoff_member_id: handoff, expected_revision: member.revision }))).revocation.operation_id
      setOperation(operationId)
      // Even an initial 'complete' must be read back with all three effective-access checks.
      const result = await api.revocationResult(operationId)
      setComplete(result.state === 'complete')
      await onSaved()
    } catch (cause) { setError(teamErrorCopy(cause, t)) }
    finally { setBusy(false) }
  }
  return <TeamDialog title={t('disableTitle')} onClose={() => { if (!busy) onClose() }} actions={complete ? <Button onClick={onClose}>{t('close')}</Button> : <>
    <Button disabled={busy} onClick={onClose}>{t('cancel')}</Button>
    <Button variant="primary" disabled={busy} onClick={() => { void disable() }}>{operation ? t('retry') : t('disable')}</Button>
  </>}>
    {complete ? <p role="status">{t('revoked')}</p> : <><p>{t('disableHint', { name: member.name })}</p>
      <div className="gg-team-value-row"><span>{t('handoffTo')}</span><DropdownMenu.Root>
        <DropdownMenu.Trigger render={<Button disabled={busy || operation !== null}>{handoff ? candidates.find(candidate => candidate.id === handoff)?.name : t('defaultHandoff')}</Button>} />
        <DropdownMenu.Content><MenuItem onClick={() => setHandoff(undefined)}>{t('defaultHandoff')}</MenuItem>
          {candidates.filter(candidate => candidate.state === 'active' && candidate.id !== member.id).map(candidate => <MenuItem key={candidate.id} onClick={() => setHandoff(candidate.id)}>{candidate.name}</MenuItem>)}
          {onMore && <MenuItem disabled={loadingMore} closeOnClick={false} onClick={onMore}>{t('more')}</MenuItem>}
        </DropdownMenu.Content></DropdownMenu.Root></div>
      {operation && <p role="status">{t('revokePending')}</p>}</>}
    {error && <p role="alert" className="gg-team-error">{error}</p>}
  </TeamDialog>
}
