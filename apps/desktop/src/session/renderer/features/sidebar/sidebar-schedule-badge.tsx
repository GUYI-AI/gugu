import { metadataSeparator } from '@/i18n/format'
import { Clock } from '@/lib/icons';
import type { SessionpageScheduleDigest } from '@gugu/session-core/session-record/contract';
import { formatScheduleWhen } from '@renderer/features/automations/session-schedule-format';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';

/**
 * 这个任务还会回来:它给自己排了定时(#7221 schedule_create)。行尾那一格只画一枚图标 —— 空闲时盖掉「3h」那个时间,
 * 别的状态(在跑、需要你、出错…)时让位给那个状态的标志(owner 10-19 C)。只画「还会回来」:行上的标志只说这个 agent
 * 此刻怎样,某一次没送到挂在那条定时自己身上(输入框上方的芯片与弹层:原因、重试),❌ 在行上画 ⚠(owner 11-28)。
 * 不写时间:那一格窄,写字挤标题(owner 10-19:「有定时标志的时候就不用具体时间了」)。几点、做什么、几条在 tooltip 里。
 *
 * 那一格一 hover 就让给置顶 / 归档(pointer-events-none 加淡出),所以 tooltip 不挂在这里,挂在 hover 层里接过来的那一枚
 * (`SidebarScheduleHoverMark`)上。这一枚只带读屏的整句。
 */
export function SidebarScheduleMark({ digest, emphasized }: { digest: SessionpageScheduleDigest; emphasized: boolean }) {
  const lines = useScheduleLines(digest);
  return (
    <span
      className={cn(
        'flex size-5 items-center justify-center',
        emphasized ? 'text-foreground-muted' : 'text-foreground-passive'
      )}
      data-session-schedule="pending"
      aria-label={lines.join(metadataSeparator())}
    >
      <Clock className="size-3" />
    </span>
  );
}

/**
 * hover 层里排在置顶 / 归档左边的那一枚:指针停在它上面出 tooltip。与那两枚钮同样 24px 的目标、同样 4px 的间距,
 * 不是按钮(点它没有动作 —— 要动去任务里那条托盘),读屏已经从静止那一枚读到整句,这里 aria-hidden。
 */
export function SidebarScheduleHoverMark({ digest }: { digest: SessionpageScheduleDigest }) {
  const lines = useScheduleLines(digest);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-hidden
            data-session-schedule-hover="pending"
            className="flex size-6 items-center justify-center rounded-sm text-foreground-tertiary-passive"
          >
            <Clock className="size-3.5" />
          </span>
        }
      />
      <TooltipContent className="max-w-80 whitespace-pre-line" data-testid="session-schedule-tooltip">
        {lines.join('\n')}
      </TooltipContent>
    </Tooltip>
  );
}

/** 下一个几点回来做什么、几条。 */
function useScheduleLines(digest: SessionpageScheduleDigest): string[] {
  const { locale, translate } = useSessionMessages();
  const nextAt = digest.nextAt ? Date.parse(digest.nextAt) : null;
  const lines: string[] = [];
  if (nextAt != null) {
    const when = formatScheduleWhen(nextAt, locale, translate);
    lines.push(
      digest.count > 1
        ? translate('sessionSchedule.badgeMany', { count: digest.count, when, title: digest.title })
        : translate('sessionSchedule.badgeOne', { when, title: digest.title })
    );
  }
  return lines;
}
