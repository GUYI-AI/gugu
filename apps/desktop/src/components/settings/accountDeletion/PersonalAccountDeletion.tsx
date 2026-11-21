import { useTranslation } from 'react-i18next'
import { compareCreditAmounts } from '@gugu/core/billing/creditAmount'
import { formatCredits } from '@/lib/billing/spendingPowerCopy'
import { Button } from '../../ui/Button'
import { Field } from '../../ui/Field'
import { Sheet } from '../../ui/Sheet'
import { SettingsRow } from '../SettingsPrimitives'
import { accountDeletionCanSubmit, type AccountDeletionView } from './accountDeletionView'
import '../../../i18n/registerSettingsCatalog'
import './account-deletion.css'

/** The approved single-dialog flow. A native operation owns every side effect. */
export function PersonalAccountDeletion({ view, onCancel }: { view: AccountDeletionView; onCancel: () => void }) {
  const { t } = useTranslation('settings')
  const ready = view.phase === 'ready'
  const busy = !['ready', 'unconfirmed', 'local-pending'].includes(view.phase)
  const hasCredits = view.remainingCredits !== null && compareCreditAmounts(view.remainingCredits, 0) > 0
  const canCancel = view.canCancel ?? (ready || view.phase === 'loading')
  const canSubmit = accountDeletionCanSubmit(view)
  const primary = view.phase === 'unconfirmed' ? view.onCheckResult
    : view.phase === 'local-pending' ? view.onRetryLocal : view.onDelete
  const primaryLabel = view.phase === 'unconfirmed' ? 'phoneCheckResult'
    : view.phase === 'local-pending' ? 'continueLocalCleanup' : 'entry'
  const status = view.phase === 'loading' ? 'loadingBalance'
    : view.phase === 'sending' ? 'sendingCode'
      : view.phase === 'preparing' ? 'preparing'
        : view.phase === 'confirming' ? 'deleting'
          : view.phase === 'cancelling' ? 'cancelling'
            : view.phase === 'unconfirmed' ? view.unknownBeforeConfirmation ? 'phoneRetryUnavailable' : 'closeResultUnknown'
              : view.phase === 'local-pending' ? 'phoneLocalPending' : null
  return <Sheet onClose={() => { if (canCancel) onCancel() }} onEscape={() => !canCancel}
    closeOnBackdrop={canCancel} desktopWidth="400px" mobileFitContent
    ariaLabel={t('accountDeletion.entry')} dimNested zIndex="var(--z-settings-modal)">
    <form className="gg-account-deletion-dialog" onSubmit={event => {
      event.preventDefault()
      if (canSubmit || view.phase === 'unconfirmed' || view.phase === 'local-pending') primary()
    }}>
      <h2>{t('accountDeletion.entry')}</h2>
      <div className="gg-account-deletion-impact">
        <p>{t('accountDeletion.compactImpact')}</p>
        <p>{t('accountDeletion.compactHistory')}</p>
      </div>
      {hasCredits && <label className="gg-account-deletion-consent">
        <input type="checkbox" checked={view.waived} onChange={event => view.onWaive(event.target.checked)} disabled={!ready} />
        <span>{t('accountDeletion.compactWaive', { amount: formatCredits(view.remainingCredits!) })}</span>
      </label>}
      <Field.Root invalid={!!view.error}>
        <Field.Label className="sr-only">{t('accountDeletion.code')}</Field.Label>
        <div className="gg-account-deletion-code">
          <Field.Input variant="bare" value={view.code} onValueChange={value => view.onCode(value.replace(/\D/g, ''))}
            placeholder={t('accountDeletion.code')} inputMode="numeric" autoComplete="one-time-code" maxLength={6} disabled={!ready} />
          <Button variant="ghost" size="sm" disabled={!ready || view.remainingCredits === null} onClick={view.onResend}>
            {t(view.codeSent ? 'accountDeletion.resend' : 'accountDeletion.sendCode')}
          </Button>
        </div>
        {view.error && <Field.Error match>{view.error}</Field.Error>}
      </Field.Root>
      {status && <p className="gg-account-deletion-status" role="status">{t(`accountDeletion.${status}`)}</p>}
      <div className="gg-account-deletion-actions">
        <Button size="sm" onClick={onCancel} disabled={!canCancel}>{t('accountDeletion.cancel')}</Button>
        <Button type="submit" size="sm" variant="danger" disabled={busy || (ready && !canSubmit)}>
          {t(`accountDeletion.${primaryLabel}`)}
        </Button>
      </div>
    </form>
  </Sheet>
}

export function PersonalAccountDeletionEntry({ available, personal, hasOriginalOperation = false, onOpen }: {
  available: boolean; personal: boolean; hasOriginalOperation?: boolean; onOpen: () => void
}) {
  const { t } = useTranslation('settings')
  if (!hasOriginalOperation && (!available || !personal)) return null
  return <SettingsRow title={t('accountDeletion.entry')}
    control={<Button variant="ghost" size="sm" onClick={onOpen} className="text-[var(--danger-fg)]">{t('accountDeletion.entry')}</Button>} />
}
