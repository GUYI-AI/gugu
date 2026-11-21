import { CalendarClock } from '@/lib/icons'
import { ReadingSlot } from '@/components/ui/ReadingSlot';
import { AbsoluteTime } from '@renderer/lib/ui/absolute-time';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useScheduledAutomationRun } from '../use-automations';

interface NextRunBannerProps {
  automationId: string;
}

export function NextRunBanner({ automationId }: NextRunBannerProps) {
  const { translate } = useSessionMessages();
  const next = useScheduledAutomationRun(automationId);
  return (
    <ReadingSlot reading={next} placeholder="h-8 w-full rounded-lg">
      {(run) => run?.scheduledAt ? (
        <div className="flex items-center gap-1.5 rounded-lg bg-background-1 p-2 text-foreground-muted">
          <CalendarClock className="size-3 shrink-0" aria-hidden />
          {translate('automations.nextRunScheduled')} <AbsoluteTime value={run.scheduledAt} />
        </div>
      ) : null}
    </ReadingSlot>
  );
}
