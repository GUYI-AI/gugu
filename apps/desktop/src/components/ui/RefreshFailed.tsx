import { useTranslation } from 'react-i18next'
import { Button } from './Button'

/**
 * A reading that still shows its last value while its latest read failed (lib/readModel: `value` with `error`): says so
 * next to the value, with a retry — ❌ the old value drawn as if it were current.
 */
export function RefreshFailed({ error, onRetry }: { error: Error | null; onRetry?: () => void }) {
  const { t } = useTranslation('common')
  if (!error) return null
  return (
    <p role="alert" data-refresh-failed="" className="!m-0 flex items-center gap-2 text-[length:var(--font-caption)] text-[var(--danger-fg)]">
      <span>{t('staleRead.failed')}</span>
      {onRetry ? <Button variant="ghost" size="sm" onClick={onRetry}>{t('staleRead.retry')}</Button> : null}
    </p>
  )
}
