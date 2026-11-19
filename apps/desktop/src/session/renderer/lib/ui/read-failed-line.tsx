import { useTranslation } from 'react-i18next';
import { cn } from '@renderer/utils/utils';

/** A failed reading where its value would go, with a retry (❌ an empty list drawn as if read). */
export function ReadFailedLine({ message, onRetry, className }: { message: string; onRetry?: () => void; className?: string }) {
  const { t } = useTranslation('common');
  return (
    <div role="alert" data-read-failed="" className={cn('flex items-center gap-2 text-xs text-foreground-passive', className)}>
      <span className="min-w-0 truncate">{message}</span>
      {onRetry ? (
        <button type="button" className="shrink-0 rounded-sm px-1 text-foreground-muted hover:text-foreground" onClick={onRetry}>
          {t('staleRead.retry')}
        </button>
      ) : null}
    </div>
  );
}
