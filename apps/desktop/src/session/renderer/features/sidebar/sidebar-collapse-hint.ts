/**
 * GUYI-AI/gugu#2548 C9, the one-time bubble over the sidebar's collapse button (「侧栏可以收起来」, mock v25). The rule only;
 * the bubble is the foot's (sidebar-one-list-chrome), drawn with the existing Popover.
 *
 * - It comes up the first time a group or a project is opened while the sidebar is expanded: the inner sidebar appears
 *   and the page gets crowded, which is when collapsing helps.
 * - It retires for good once either of its buttons is clicked (知道了 / 收起试试), or once the sidebar has been collapsed
 *   by any route (its button, the shortcut, 消息 clicked again, a drag, zen mode): they know. Retired is stored in the
 *   app settings (`interface.sidebarCollapseHintRetired`); coming up is not, so a start that never answered it brings it
 *   up again at the next group or project.
 * - Never on the phone: the foot is the task page's sidebar, and the task renderer is desktop-only
 *   (docs/design/ui-visual-spec.md §2, check-ui-visual-spec).
 */
export type SidebarCollapseHint = 'waiting' | 'showing' | 'retired';

export type SidebarCollapseHintEvent =
  /** A group or a project was opened (the inner sidebar came up for it). */
  | { kind: 'opened'; expanded: boolean }
  /** The sidebar went from expanded to collapsed, by whatever route. */
  | { kind: 'collapsed' }
  /** 知道了 or 收起试试. */
  | { kind: 'answered' };

export function nextSidebarCollapseHint(state: SidebarCollapseHint, event: SidebarCollapseHintEvent): SidebarCollapseHint {
  if (state === 'retired') return 'retired';
  if (event.kind === 'opened') return event.expanded ? 'showing' : state;
  return 'retired';
}

/** The stored answer wins; not read yet = not shown (❌ flash a bubble the user already answered). */
export function sidebarCollapseHintState(stored: boolean | undefined, session: SidebarCollapseHint): SidebarCollapseHint {
  if (stored === undefined || stored) return 'retired';
  return session;
}

/**
 * Drawn only while it applies and can be seen: expanded, the collapse button on screen (the task page or its sidebar can
 * be a hidden retained surface), and the list not swapped for the bell's panel.
 */
export function sidebarCollapseHintShown(
  state: SidebarCollapseHint,
  view: { expanded: boolean; onScreen: boolean; notificationsOpen: boolean }
): boolean {
  return state === 'showing' && view.expanded && view.onScreen && !view.notificationsOpen;
}
