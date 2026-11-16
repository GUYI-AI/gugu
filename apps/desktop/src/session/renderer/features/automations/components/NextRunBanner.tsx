import { Clock } from '@/lib/icons'
import { RefreshFailed } from '@/components/ui/RefreshFailed';
import { Unknown } from '@/components/ui/Unknown';
import { AbsoluteTime } from '@renderer/lib/ui/absolute-time';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useRetryAutomationRuns, useScheduledAutomationRun } from '../use-automations';

interface NextRunBannerProps {
  automationId: string;
}

export function NextRunBanner({ automationId }: NextRunBannerProps) {
  const { translate } = useSessionMessages();
  const next = useScheduledAutomationRun(automationId);
  const retry = useRetryAutomationRuns(automationId);
  if (next.state === 'unknown') return <Unknown className="h-8 w-full rounded-lg" />;
  if (next.state === 'error') return <RefreshFailed error={next.error} onRetry={retry} />;
  const scheduledAt = next.value?.scheduledAt;
  if (!scheduledAt) return null;

  return (
    <div className="flex items-center gap-1.5 rounded-lg bg-background-1 p-2 text-foreground-muted">
      <Clock className="size-3 shrink-0" aria-hidden />
      {translate('automations.nextRunScheduled')} <AbsoluteTime value={scheduledAt} />
    </div>
  );
}
