// #2548 固定到左侧栏 (Pin to sidebar). 置顶 only orders a session first within the list it is in; 固定到左侧栏 gives
// an agent that lives in a group or a project its own row at the top of the desktop left list, saying where it lives.

export type SidebarPinMenuAction = 'pin' | 'unpin';

/**
 * Which 固定到左侧栏 item the session menu offers, next to 置顶: none unless the desktop sidebar switch is on, none for a
 * child session (a child is never a row of the left list; it stays under its parent). Desktop only by construction: the
 * session menu lives in the task renderer, which never runs in the phone shell (ui-visual-spec §2, lint-enforced).
 */
export function sidebarPinMenuAction(input: {
  switchOn: boolean;
  parentSessionId: string | null | undefined;
  isPinnedToSidebar: boolean | undefined;
}): SidebarPinMenuAction | null {
  if (!input.switchOn) return null;
  if (input.parentSessionId !== null && input.parentSessionId !== undefined) return null;
  return input.isPinnedToSidebar === true ? 'unpin' : 'pin';
}

/** Where an agent lives; the pinned row names it. Callers may carry more (an id to open it). */
export type SidebarAgentHome = { kind: 'group' | 'project'; name: string };

/** The facts of a session this needs; both a mounted session's data and a listed directory row map onto it. */
export type SidebarPinCandidate = {
  sessionId: string;
  parentSessionId?: string | null;
  isPinnedToSidebar?: boolean;
  archivedAt?: string | null;
  lastInteractedAt?: string | null;
};

export type PinnedSidebarAgent<T extends SidebarPinCandidate, H extends SidebarAgentHome> = { session: T; home: H };

/**
 * The agents pinned to the top of the left list, in display order (newest interaction first, like the Pinned section).
 * A session counts when it is pinned to the sidebar, top-level, not archived, and its agent lives in a group or a
 * project (`homeOf` returns where; null = a standalone agent, which is a row of the list already). The same session
 * listed twice (overlapping snapshots) counts once, the later listing winning.
 */
export function pinnedSidebarAgents<T extends SidebarPinCandidate, H extends SidebarAgentHome>(
  sessions: readonly T[],
  homeOf: (session: T) => H | null
): PinnedSidebarAgent<T, H>[] {
  const latest = new Map<string, T>();
  for (const session of sessions) latest.set(session.sessionId, session);
  const pinned: PinnedSidebarAgent<T, H>[] = [];
  for (const session of latest.values()) {
    if (session.isPinnedToSidebar !== true || session.archivedAt) continue;
    if (session.parentSessionId !== null && session.parentSessionId !== undefined) continue;
    const home = homeOf(session);
    if (home) pinned.push({ session, home });
  }
  return pinned.sort((a, b) => interactedAt(b.session) - interactedAt(a.session));
}

function interactedAt(session: SidebarPinCandidate): number {
  const at = session.lastInteractedAt ? Date.parse(session.lastInteractedAt) : Number.NaN;
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}
