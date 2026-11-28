import type { ReactNode } from 'react'
import { TITLEBAR_ACTION_TOP_PX, TITLEBAR_LEFT_EDGE_GAP_PX } from '@/lib/window-chrome'

/**
 * The restore lane's button (#2548 ⑤ the inner column's 「展开内层栏」): at the content surface's top-left, on the same
 * baseline as the sidebar toggle (shell-titlebar), where the leftmost tab strip leaves it its lane (reserveShellRestoreLane,
 * SHELL_RESTORE_LANE_PX). Mounted in the content surface, so it moves with it while the list opens or collapses.
 */
/** What follows the restore lane through the inner column's move: the lane and the strip that leaves it room (workspace-layout.tsx). */
export const RESTORE_LANE_FOLLOWER = 'gg-restore-lane-follower'

export function ShellRestoreLane({ children }: { children: ReactNode }) {
  return (
    <div
      className={`${RESTORE_LANE_FOLLOWER} absolute z-50 flex items-center [-webkit-app-region:no-drag]`}
      // Fades in over the second half of the inner column's fold and out over the first half of its unfold (the variable is
      // written on this element, workspace-layout.tsx @@@inner-fold-motion); 1 wherever no column moves.
      style={{ top: TITLEBAR_ACTION_TOP_PX, left: TITLEBAR_LEFT_EDGE_GAP_PX, opacity: 'var(--shell-restore-lane-shown, 1)' }}
      data-shell-restore-lane=""
    >
      {children}
    </div>
  )
}
