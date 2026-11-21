import { isNeedsYou, presentationAttention, type AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation';

// @@@sessionpage otty-state — a row's status bucket, read from the same presentation as the agent avatar:
// needs-you = waits and failures (errors keep their red row status), working = running or parked, null = idle.
// It never orders a list: rows sort by recent activity (compareByRecentActivity) and status is only the row's
// badge. It decides what stays visible (needs-you never folds, idle families fold) and feeds the counts, which
// are read-gated (isNeedsYou). It reads the raw state, not the read bit, and a family follows its root.
export type SidebarStateGroup = 'needs-you' | 'working';

/** Map the shared presentation to its sidebar section; null = idle (flat, unlabelled). */
export function sidebarStateGroup(presentation: AgentStatusPresentation | null): SidebarStateGroup | null {
  if (presentationAttention(presentation) !== null) return 'needs-you';
  switch (presentation?.tone) {
    case 'running':
    case 'parked':
      return 'working';
    default:
      return null;
  }
}

/** One conversation as the project needs-you count reads it. */
export type NeedsYouCountEntry = { presentation?: AgentStatusPresentation | null; unseen: boolean; hostOnline?: boolean };

/**
 * A project's needs-you count: the desktop project dot and the phone project-group avatar badge read this one rule —
 * waits and unread failures (isNeedsYou) on hosts that are reachable.
 */
export function needsYouCount(entries: readonly NeedsYouCountEntry[]): number {
  return entries.filter((entry) => isNeedsYou(entry.presentation, entry.unseen) && entry.hostOnline !== false).length;
}
