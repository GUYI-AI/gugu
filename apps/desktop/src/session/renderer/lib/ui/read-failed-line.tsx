import { useTranslation } from 'react-i18next';
import { cn } from '@renderer/utils/utils';

/**
 * A reading that failed (lib/replica: `error`) where its value would go: says what could not be read, with a retry —
 * ❌ an empty list or "none" drawn as if it had been read.
 */
export function ReadFailedLine({ message, onRetry, className }: { message: string; onRetry: () => void; className?: string }) {
  const { t } = useTranslation('common');
  return (
    <div role="alert" data-read-failed="" className={cn('flex items-center gap-2 text-xs text-foreground-passive', className)}>
      <span className="min-w-0 truncate">{message}</span>
      <button type="button" className="shrink-0 rounded-sm px-1 text-foreground-muted hover:text-foreground" onClick={onRetry}>
        {t('staleRead.retry')}
      </button>
    </div>
  );
}
