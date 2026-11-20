import { useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/store/auth'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { copyTextWithFeedback } from '@/lib/copyTextWithFeedback'
import { useTeamApi, useTeamSession } from './context'
import { teamErrorCopy } from './copy'
import { TeamDialog } from './TeamPrimitives'
import { invitationFailure } from './invitation-receipt'
import { createTeamInviteIntentStore, subscribeInviteIntents } from './inviteIntentStore'
import type { TeamInvitation } from './types'

function subscribe(listener: () => void) {
  const stop = subscribeInviteIntents(listener); window.addEventListener('storage', listener)
  return () => { stop(); window.removeEventListener('storage', listener) }
}
function browserStorage() {
  try { return window.localStorage }
  catch {
    const denied = () => { throw new Error('Invitation storage unavailable') }
    return { getItem: denied, setItem: denied, removeItem: denied }
  }
}
export function TeamInviteDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const { t } = useTranslation('team'), api = useTeamApi(), session = useTeamSession(), { user } = useAuth()
  const store = useMemo(() => createTeamInviteIntentStore(browserStorage(), session.context?.team_id ?? '', user?.id ?? ''), [session.context?.team_id, user?.id])
  const initial = useMemo(() => { try { return { email: store.active()?.email ?? '', unavailable: false } } catch { return { email: '', unavailable: true } } }, [store])
  const [email, setEmail] = useState(initial.email), [result, setResult] = useState<TeamInvitation | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const raw = useSyncExternalStore(subscribe, () => store.raw(email))
  const stored = useMemo(() => { try { return { intent: store.decode(raw, email), unavailable: false } } catch { return { intent: null, unavailable: true } } }, [store, raw, email])
  const unavailable = initial.unavailable || stored.unavailable, receipt = result ?? stored.intent?.receipt
  const status = unavailable ? 'inviteStorageUnavailable' : stored.intent
    ? receipt?.invitation_created === false ? 'inviteNotCreated' : !receipt || receipt.invitation_created === null ? 'inviteOutcomeUnknown'
      : ({ pending: 'inviteMailPending', sending: 'inviteMailSending', accepted: 'inviteMailAccepted', failed: 'inviteMailFailed', unknown: 'inviteMailUnknown' } as const)[receipt.delivery.state]
    : null
  async function invite() {
    if (busy || unavailable) return
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError(t('emailRequired')); return }
    setBusy(true); setError(''); setResult(null)
    let command: ReturnType<typeof store.prepare> | null = null
    try {
      command = store.prepare(email)
      const response = await api.invite(command.email, command.idempotency_key)
      store.noteReceipt(command.email, command.idempotency_key, response)
      setResult(response); await onSaved()
    } catch (cause) {
      const failure = invitationFailure(cause)
      if (command && failure) {
        try { store.noteReceipt(command.email, command.idempotency_key, failure.receipt); setResult(failure.invitation) }
        catch { setError(t('inviteStorageUnavailable')); return }
      }
      setError(teamErrorCopy(cause, t))
    } finally { setBusy(false) }
  }
  function close() {
    if (busy) return
    try { if (stored.intent) store.acknowledge(stored.intent.email, stored.intent.idempotency_key) }
    catch { setError(t('inviteStorageUnavailable')); return }
    onClose()
  }
  const accepted = receipt?.delivery.state === 'accepted'
  return <TeamDialog title={t('invite')} onClose={close} actions={<>
    <Button disabled={busy} onClick={close}>{t('close')}</Button>
    {(!result || !accepted) && <Button variant="primary" disabled={busy || unavailable} onClick={() => { void invite() }}>{t(stored.intent ? 'checkOriginalInvite' : 'inviteAction')}</Button>}
    {result && <Button variant={accepted ? 'primary' : 'secondary'} disabled={busy} onClick={() => { void copyTextWithFeedback(result.invitation_url) }}>{t(accepted ? 'copyInvitation' : 'copyInvitationCompact')}</Button>}
  </>}>
    {!result && <Field.Root><Field.Label>{t('memberEmail')}</Field.Label><Field.Input type="email" autoComplete="off" value={email} disabled={busy || unavailable}
      onChange={event => { setEmail(event.target.value); setResult(null); setError('') }} /></Field.Root>}
    {status && <p role="status">{t(status)}</p>}
    {error && <p role="alert" className="gg-team-error">{error}</p>}
  </TeamDialog>
}
