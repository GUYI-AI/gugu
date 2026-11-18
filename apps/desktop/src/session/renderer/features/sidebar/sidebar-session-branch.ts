import type { AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation';
import type { SessionTreeNode } from '../sessions/session-tree';

export type SessionBranchSummary = {
  total: number;
  /** Foreground running only; parked background/scheduled work is not running. */
  active: { count: number; presentation: AgentStatusPresentation }[];
};

/** Count the parent edge, not spawn history; a hidden descendant is still counted. */
export function summarizeSessionBranches<T extends {
  id: string;
  presentation?: AgentStatusPresentation | null;
}>(nodes: Iterable<SessionTreeNode<T>>): ReadonlyMap<string, SessionBranchSummary> {
  const summaries = new Map<string, SessionBranchSummary>();
  const visit = (node: SessionTreeNode<T>): SessionBranchSummary => {
    const cached = summaries.get(node.item.id);
    if (cached) return cached;
    let running: SessionBranchSummary['active'][number] | undefined;
    const addRunning = (presentation: AgentStatusPresentation, count: number) => {
      running = { presentation, count: (running?.count ?? 0) + count };
    };
    let total = 0;
    for (const child of node.children) {
      const summary = visit(child);
      total += summary.total + 1;
      const presentation = child.item.presentation;
      if (presentation?.tone === 'running') addRunning(presentation, 1);
      for (const state of summary.active) addRunning(state.presentation, state.count);
    }
    const summary = {
      total,
      active: running ? [running] : [],
    };
    summaries.set(node.item.id, summary);
    return summary;
  };
  for (const node of nodes) visit(node);
  return summaries;
}
