import { AutomationAgentAvatar } from './AutomationAgentAvatar';
import { CheckCircle2, Clock, Folder, MinusCircle, XCircle, type IconComponent } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import {
  useLatestAutomationRun,
  useScheduledAutomationRun,
} from '@renderer/features/automations/use-automations';
import {
  getProjectStore,
  projectDisplayName,
} from '@renderer/features/projects/stores/project-selectors';
import {
  getSessionPageStore,
  sessionAgentStatus,
  sessionAgentStatusDetail,
} from '@renderer/features/sessions/stores/session-selectors';
import { AgentStatusIndicator } from '@renderer/lib/components/agent-status-indicator';
import { AbsoluteTime } from '@renderer/lib/ui/absolute-time';
import { Switch } from '@renderer/lib/ui/switch';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { isSpentOneTimeAutomation, type Automation } from '@shared/core/automations/automation';
import type { AutomationRunStatus } from '@shared/core/automations/automation-run';
import { formatRunTriggerKindLabel } from '../automation-run-format';
import { scheduleRuleText } from '../session-schedule-format';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { ReadingSlot } from '@/components/ui/ReadingSlot';

const RUN_STATUS_ICON: Record<
  AutomationRunStatus,
  { Icon: IconComponent; textClass: string; spin?: boolean }
> = {
  scheduled: { Icon: Clock, textClass: 'text-foreground-muted' },
  queued: { Icon: Clock, textClass: 'text-foreground-muted' },
  creating_session: { Icon: Clock, textClass: 'text-foreground-muted', spin: true },
  launching_session: { Icon: Clock, textClass: 'text-foreground-muted', spin: true },
  starting_agent: { Icon: Clock, textClass: 'text-foreground-muted', spin: true },
  done: { Icon: CheckCircle2, textClass: 'text-foreground-success' },
  failed: { Icon: XCircle, textClass: 'text-foreground-error' },
  skipped: { Icon: MinusCircle, textClass: 'text-foreground-muted' },
};

interface AutomationRowProps {
  automation: Automation;
  readOnly?: boolean;
  onToggleEnabled?: (enabled: boolean) => void;
  onClick?: () => void;
}

export const AutomationRow = observer(function AutomationRow({
  automation,
  onToggleEnabled,
  readOnly = false,
  onClick,
}: AutomationRowProps) {
  const { locale, translate } = useSessionMessages();
  const latest = useLatestAutomationRun(automation.id);
  const next = useScheduledAutomationRun(automation.id);

  // #7221 agent 给自己排的:每次都送回建它的那条会话,状态就看那条会话的。
  const sessionId = latest.state === 'value' ? (latest.value?.sessionId ?? automation.agentSessionId ?? null) : null;
  const projectId = automation.projectId ?? null;
  // 别的机器上的项目与本机的是同一张项目表、同一张任务表(#6264 一套工作台)。
  const sessionPageStore = sessionId && projectId ? getSessionPageStore(projectId, sessionId) : undefined;
  const agentStatus = sessionPageStore ? sessionAgentStatus(sessionPageStore) : null;
  const agentStatusDetail = sessionPageStore ? sessionAgentStatusDetail(sessionPageStore) : null;
  const projectName = projectId ? projectDisplayName(getProjectStore(projectId)) : undefined;

  const trigger = automation.triggerConfig;
  const cronLabel = trigger?.at != null ? translate('automations.oneTime') : trigger?.expr ? scheduleRuleText(trigger, locale) : null;
  const cronTitle = cronLabel && trigger?.tz ? `${cronLabel} (${trigger.tz})` : cronLabel;
  const spent = isSpentOneTimeAutomation(automation);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      className="grid min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 rounded-lg px-4 py-3 text-left hover:bg-row-hover @min-[640px]:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_auto] @min-[640px]:gap-x-4"
    >
      <div className="flex min-w-0 flex-col justify-center gap-1">
        <div className="flex min-w-0 items-center gap-1">
          <span className={cn('truncate text-md font-medium', automation.enabled ? 'text-foreground' : 'text-foreground-muted')}>
            {automation.name}
          </span>
          <AgentStatusIndicator status={agentStatus} detail={agentStatusDetail} />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground-muted">
          {cronLabel && (
            <span title={cronTitle ?? undefined} className="flex min-w-0 max-w-full items-center gap-1">
              <Clock aria-hidden="true" className="size-3 shrink-0" />
              <span className="truncate">{cronTitle}</span>
            </span>
          )}
          <span className={cn('flex min-w-0 max-w-32 items-center gap-1', projectId == null && 'text-foreground-destructive/80')}>
            <Folder aria-hidden="true" className="size-3 shrink-0" />
            <span title={projectName} className="truncate">{projectId ? projectName : translate('automations.noProject')}</span>
          </span>
          {automation.agentSession && (
            <span className={cn('flex min-w-0 max-w-40 items-center gap-1', automation.agentSession.gone && 'text-foreground-destructive/80')}>
              <AutomationAgentAvatar sessionId={automation.agentSessionId} />
              <span className="truncate">
                {automation.agentSession.gone
                  ? translate('automations.byAgentGone')
                  : translate('automations.byAgent', { name: automation.agentSession.name ?? '' })}
              </span>
            </span>
          )}
        </div>
      </div>

      <div className="col-span-2 grid min-w-0 grid-cols-2 gap-3 text-xs text-foreground-muted @min-[640px]:col-span-1 @min-[640px]:col-start-2 @min-[640px]:row-start-1">
        <div className="flex min-w-0 flex-col gap-1">
          <ReadingSlot reading={latest} placeholder="w-full max-w-36">
            {(run) => {
              if (!run) return <span className="text-foreground-passive">{translate('automations.noRuns')}</span>;
              const { Icon, textClass, spin } = RUN_STATUS_ICON[run.status];
              const time = run.startedAt ?? run.finishedAt;
              return (
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5">
                    {spin ? <LoadingIndicator size="inline" className={textClass} /> : (
                      <Icon className={cn('size-3.5 shrink-0', textClass)} />
                    )}
                    {translate('automations.lastRunOn')}
                  </span>
                  {time != null && <AbsoluteTime value={time} showTimeZone className="text-sm tabular-nums text-foreground" />}
                  <span>{formatRunTriggerKindLabel(translate, run.triggerKind)}</span>
                </div>
              );
            }}
          </ReadingSlot>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          {automation.enabled ? (
            <ReadingSlot reading={next} placeholder="w-full max-w-32">
              {(run) => run?.scheduledAt != null ? (
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span>{translate('automations.nextRunScheduled')}</span>
                  <AbsoluteTime value={run.scheduledAt} showTimeZone className="text-sm tabular-nums text-foreground" />
                </div>
              ) : null}
            </ReadingSlot>
          ) : (
            <span className="text-foreground-passive">
              {translate(spent ? 'automations.oneTimeEnded' : 'automations.disabled')}
            </span>
          )}
        </div>
      </div>

      <div
        className="col-start-2 row-start-1 flex items-center justify-self-end @min-[640px]:col-start-3"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Switch
          aria-label={automation.name}
          checked={automation.enabled}
          disabled={readOnly || spent}
          onCheckedChange={(checked) => onToggleEnabled?.(checked)}
        />
      </div>
    </div>
  );
});
