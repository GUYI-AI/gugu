/**
 * GUYI-AI/gugu#2548 C9, the sidebar's two-step intro (owner 11-12: the one-time 「侧栏可以收起来」 bubble grew a second
 * step). The rule only; the bubble is the head's (sidebar-one-list-chrome), drawn as the feature tour's card (TourBubble).
 *
 * 1. `collapse` — 侧栏可以收起来, on the collapse button (the head's 「«」).
 * 2. `history` — 会话历史, on the 会话历史 button (the head's last).
 *
 * - It comes up the first time the inner sidebar appears (a group, a project, the sample project) while the sidebar is
 *   expanded: the page gets crowded, which is when collapsing helps. Coming up belongs to this run; the step it is on is
 *   stored in the app settings (`interface.sidebarIntro`), so an intro left unfinished comes up again the next time the
 *   inner sidebar appears, on the step it was left at.
 * - Collapsing the sidebar by any route (its button, the shortcut, 消息 clicked again, a drag, zen mode) is step 1
 *   learned: up or not yet, the intro moves on to step 2. The rail hides 会话历史 with the names (proposal v1), so
 *   step 2 waits there and shows once the sidebar is expanded again.
 * - It ends for good on 跳过, 完成, 打开看看 and Escape.
 * - Never on the phone: the head is the task page's sidebar, and the task renderer is desktop-only
 *   (docs/design/ui-visual-spec.md §2, check-ui-visual-spec).
 */
export const SIDEBAR_INTRO_STEPS = ['collapse', 'history'] as const;
export type SidebarIntroStep = (typeof SIDEBAR_INTRO_STEPS)[number];
/** What is stored: the step it is on, or `ended`. */
export type SidebarIntroStored = SidebarIntroStep | 'ended';
export type SidebarIntro = { step: SidebarIntroStored; up: boolean };

export type SidebarIntroEvent =
  /** The inner sidebar came up (a group, a project or the sample project opened). */
  | { kind: 'opened'; expanded: boolean }
  /** The sidebar went from expanded to collapsed, by whatever route. */
  | { kind: 'collapsed' }
  /** 下一步 (step 1). */
  | { kind: 'next' }
  /** 上一步 (step 2). */
  | { kind: 'previous' }
  /** 跳过, 完成, 打开看看 or Escape. */
  | { kind: 'end' };

export function nextSidebarIntro(intro: SidebarIntro, event: SidebarIntroEvent): SidebarIntro {
  if (intro.step === 'ended') return intro;
  switch (event.kind) {
    case 'opened':
      return event.expanded && !intro.up ? { ...intro, up: true } : intro;
    case 'collapsed':
    case 'next':
      return intro.step === 'collapse' ? { ...intro, step: 'history' } : intro;
    case 'previous':
      return intro.step === 'history' ? { ...intro, step: 'collapse' } : intro;
    case 'end':
      return { ...intro, step: 'ended' };
  }
}

/**
 * The step drawn, or null. Drawn only while it is up and can be seen: the sidebar expanded (on the rail both buttons'
 * places are gone or hidden: a collapse moves step 1 on, and 会话历史 hides with the names), the head on screen (the
 * task page or its sidebar can be a hidden retained surface), the list not swapped for the bell's panel, and the feature
 * tour not on screen (two bubbles at once); hidden that way it is not ended.
 * `stored` undefined = the settings are not read yet: not drawn (❌ flash a bubble the user already ended).
 */
export function sidebarIntroShown(
  stored: SidebarIntroStored | undefined,
  up: boolean,
  view: { expanded: boolean; onScreen: boolean; notificationsOpen: boolean; touring: boolean }
): SidebarIntroStep | null {
  if (stored === undefined || stored === 'ended' || !up || !view.expanded || !view.onScreen) return null;
  if (view.notificationsOpen || view.touring) return null;
  return stored;
}
