import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button'
import { SettingsNote, SettingsPage } from '../SettingsPrimitives'
import { PersonalAccountDeletion } from './PersonalAccountDeletion'
import { accountDeletionConfirmed, type AccountDeletionView } from './accountDeletionView'
import type { PhoneAccountClosureFlow, PhoneClosurePhase } from './phoneAccountClosureFlow'

type Confirmation = Omit<Extract<AccountDeletionView, { stage: 'confirm' }>, 'onDelete'>
const phaseKey: Record<PhoneClosurePhase, string> = { 'stop-agent': 'stopPhoneAgent', 'remove-device': 'removePhoneDevice', 'close-account': 'closePhoneAccount', 'erase-local': 'erasePhoneLocal' }

/** Controlled phone final step. A future Android/iOS adapter must supply the owner-scoped flow. */
export function PhoneAccountDeletion({ confirmation, flow, onCancel, onReturnToLogin }: {
  confirmation: Confirmation
  flow: PhoneAccountClosureFlow
  onCancel: () => void
  onReturnToLogin: () => void
}) {
  const { t } = useTranslation('settings')
  const state = useSyncExternalStore(flow.subscribe, flow.getSnapshot, flow.getSnapshot)
  const waivedCredits = useRef(confirmation.impact.remainingCredits)
  useEffect(() => () => { flow.cancel() }, [flow])

  if (state.status === 'idle') return <PersonalAccountDeletion onCancel={onCancel} view={{ ...confirmation, onDelete: () => {
    if (!confirmation.busy && accountDeletionConfirmed(confirmation.confirmation, confirmation.impact.remainingCredits, confirmation.waived)) {
      waivedCredits.current = confirmation.impact.remainingCredits
      void flow.start()
    }
  } }} />
  if (state.status === 'closed') return <PersonalAccountDeletion onCancel={onCancel}
    view={{ stage: 'deleted', waivedCredits: waivedCredits.current, onReturnToLogin }} />
  const key = phaseKey[state.phase]
  return <SettingsPage data-phone-account-closure={flow.platform}>
    <h2 className="gg-account-deletion-title">{t(`accountDeletion.${key}${state.status === 'failed' ? 'Failed' : ''}`)}</h2>
    <SettingsNote role={state.status === 'failed' ? 'alert' : 'status'}>
      {t(`accountDeletion.${state.status === 'local-pending' ? 'phoneLocalPending' : state.status === 'unconfirmed' ? 'closeResultUnknown' : state.status === 'failed' ? 'phoneStepHalted' : 'phoneStepWaiting'}`)}
    </SettingsNote>
    {state.status === 'unconfirmed' && <div className="gg-settings-actions"><Button onClick={() => { void flow.checkResult() }}>{t('accountDeletion.phoneCheckResult')}</Button></div>}
    {state.status === 'local-pending' && <div className="gg-settings-actions"><Button onClick={() => { void flow.retryLocal() }}>{t('accountDeletion.phoneRetry')}</Button></div>}
    {state.status === 'failed' && <>
      <SettingsNote>{t(`accountDeletion.${state.canRetry ? 'phoneRetryStep' : 'phoneRetryUnavailable'}`)}</SettingsNote>
      {state.canRetry && <div className="gg-settings-actions"><Button onClick={() => { void flow.retry() }}>{t('accountDeletion.phoneRetry')}</Button></div>}
    </>}
  </SettingsPage>
}
