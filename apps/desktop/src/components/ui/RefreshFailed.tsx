import { useTranslation } from 'react-i18next'
import { refreshFailure, retryOf, type Reading } from '../../lib/replica'
import { Button } from './Button'

/**
 * A reading that still shows its last value while its latest read failed (lib/replica: `value` with `error`): says so
 * next to the value, with a retry — ❌ the old value drawn as if it were current. Given the `reading`, it says the
 * reading's own failure (`refreshFailure`: an error reading's, or a failed refresh over a value) with the reading's own
 * retry (`reading.retry`); `error` / `onRetry` are for a failure that is not one reading's (a write, a check, several).
 */
export function RefreshFailed(props: { reading: Reading<unknown> } | { error: Error | null; onRetry?: () => void }) {
  const { t } = useTranslation('common')
  const error = 'reading' in props ? refreshFailure(props.reading) : props.error
  const retry = 'reading' in props ? retryOf(props.reading) : props.onRetry
  if (!error) return null
  return (
    <p role="alert" data-refresh-failed="" className="!m-0 flex items-center gap-2 text-[length:var(--font-caption)] text-[var(--danger-fg)]">
      <span>{t('staleRead.failed')}</span>
      {retry ? <Button variant="ghost" size="sm" onClick={() => retry()}>{t('staleRead.retry')}</Button> : null}
    </p>
  )
}
