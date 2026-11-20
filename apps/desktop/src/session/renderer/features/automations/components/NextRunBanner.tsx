import { Clock } from '@/lib/icons'
import { RefreshFailed } from '@/components/ui/RefreshFailed';
import { Unknown } from '@/components/ui/Unknown';
import { AbsoluteTime } from '@renderer/lib/ui/absolute-time';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useScheduledAutomationRun } from '../use-automations';

interface NextRunBannerProps {
  automationId: string;
}

export function NextRunBanner({ automationId }: NextRunBannerProps) {
  const { translate } = useSessionMessages();
  const next = useScheduledAutomationRun(automationId);
  if (next.state === 'unknown') return <Unknown className="h-8 w-full rounded-lg" />;
  // A failed read, or a refresh failing over what was read (that stays drawn): said with the reading's own retry.
  const failed = <RefreshFailed reading={next} />;
  const scheduledAt = next.state === 'value' ? next.value?.scheduledAt : null;
  if (!scheduledAt) return failed;

  return (
    <>
      <div className="flex items-center gap-1.5 rounded-lg bg-background-1 p-2 text-foreground-muted">
        <Clock className="size-3 shrink-0" aria-hidden />
        {translate('automations.nextRunScheduled')} <AbsoluteTime value={scheduledAt} />
      </div>
      {failed}
    </>
  );
}
