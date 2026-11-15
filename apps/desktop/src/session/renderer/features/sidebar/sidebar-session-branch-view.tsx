import { AgentStatusGlyph } from '@renderer/lib/components/agent-status-indicator';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { SessionBranchSummary } from './sidebar-session-branch';

const branchCountClass = 'inline-flex h-5 shrink-0 items-center gap-1 rounded-sm bg-foreground/5 px-1 text-[length:var(--font-caption)] leading-none text-foreground-muted tabular-nums';

/**
 * 「总数 | 在跑的」那枚药丸。行上它是子会话的开关;`label` 给了 = 分区头上那一枚(#2548 内层侧栏「我的智能体」:
 * 这个对话里我的智能体总数与在跑的),只是一个数,❌ 开关。
 */
export function SidebarSessionBranchCount({ summary, expanded, onToggle, label: countLabel }: {
  summary: SessionBranchSummary;
  expanded: boolean;
  onToggle?: () => void;
  label?: string;
}) {
  const { translate } = useSessionMessages();
  const label = countLabel ?? translate('sidebar.sessionBranchCount', { count: summary.total });
  const states = summary.active.map(({ presentation, count }) =>
    `${translate(`agentStatus.${presentation.label}`)} ${count}`).join(', ');
  const title = states ? `${label}: ${states}` : label;
  const content = <>
    <span data-branch-total>{summary.total}</span>
    {!expanded && summary.active.length > 0 ? <>
      <span aria-hidden className="mx-px h-2.5 border-l border-foreground/10" />
      {summary.active.map(({ presentation, count }) => (
        <span key={presentation.tone} className="inline-flex items-center gap-[3px]">
          <span className="inline-flex size-[9px] shrink-0 items-center justify-center"><AgentStatusGlyph presentation={presentation} label={translate(`agentStatus.${presentation.label}`)} variant="2" /></span>
          <span data-branch-running>{count}</span>
        </span>
      ))}
    </> : null}
  </>;
  if (countLabel !== undefined) {
    return <span data-session-branch-count={summary.total} role="img" aria-label={title} title={title} className={branchCountClass}>{content}</span>;
  }
  return (
    <button
      type="button"
      data-session-branch-count={summary.total}
      className={`${branchCountClass} group-hover/row:hidden hover:bg-foreground/10`}
      aria-label={`${translate(expanded ? 'sidebar.collapseChildSessions' : 'sidebar.expandChildSessions')}: ${label}`}
      aria-expanded={expanded}
      title={title}
      onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onClick={(event) => { event.stopPropagation(); onToggle?.(); }}
    >
      {content}
    </button>
  );
}
