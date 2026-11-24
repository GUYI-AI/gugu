import {
  presentAgentStatus,
  type AgentStatusPresentation,
} from '@gugu/core/shared/agentStatusPresentation';
import { displayStatusOf } from '@gugu/core/shared/ui/agentConversationStatusModels';
import { AgentContactStatusMark } from '@/components/AgentContactStatusMark';
import { agentStatusHasMark } from '@/lib/agentStatusMark';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import type { AgentStatus, AgentStatusDetail } from '@shared/core/agents/agentEvents';

export type AgentIndicatorStatus = AgentStatus | null;

interface AgentStatusIndicatorProps {
  status: AgentIndicatorStatus;
  /** 附属态(spec agent-status-vocabulary):只改画法与那一句 —— 后台在跑画停住的字形、需要你写出在等什么。 */
  detail?: AgentStatusDetail | null;
  className?: string;
  disableTooltip?: boolean;
}

/**
 * 会话页一格 agent 状态。画成什么与聊天、手机同一个 `presentAgentStatus`(owner 2026-09-25 定表):
 * 标识与头像角同一个组件(AgentContactStatusMark):运行中 = 字形在转、后台运行中 = 字形停住、需要你 = 三角、
 * 出错了 = 「×」圆;空闲不画(#6209)。❌ 在会话页另拍一套。
 * ❌ 在这里画咕咕小鸟(#7243,owner 2026-10-15):任务页一屏同时在跑的会话多,每只小鸟每帧都要重画,开销随只数涨;
 * 小鸟只留在聊天与手机。
 */
export function AgentStatusIndicator({
  status,
  detail = null,
  className,
  disableTooltip,
}: AgentStatusIndicatorProps) {
  const { translate } = useSessionMessages();
  if (!status || status === 'idle') return null;
  const presentation = presentAgentStatus({ reading: { status, detail } });
  const label = translate(`agentStatus.${presentation.label}`);

  const indicator = (
    <span
      className="flex size-6 items-center justify-center"
      data-agent-status={status}
      data-status-detail={detail ?? undefined}
      data-agent-tone={presentation.tone}
    >
      <AgentStatusGlyph presentation={presentation} label={label} className={className} />
    </span>
  );

  if (disableTooltip) return indicator;

  return (
    <Tooltip>
      <TooltipTrigger render={indicator} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** 一格状态的字形本身(侧栏行按自己的布局摆它,不带外壳与提示);画法同头像角(AgentContactStatusMark)。 */
export function AgentStatusGlyph({
  presentation,
  label,
  className,
}: {
  presentation: AgentStatusPresentation;
  label: string;
  className?: string;
}) {
  const tone = displayStatusOf(presentation.tone);
  if (!agentStatusHasMark(tone)) return null;
  return (
    <span className={cn('inline-flex', className)} aria-label={label}>
      <AgentContactStatusMark tone={tone} />
    </span>
  );
}
