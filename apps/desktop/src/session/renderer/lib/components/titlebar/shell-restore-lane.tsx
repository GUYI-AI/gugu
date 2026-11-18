import type { ReactNode } from 'react'
import { TITLEBAR_ACTION_TOP_PX, TITLEBAR_LEFT_EDGE_GAP_PX } from '@/lib/window-chrome'

/**
 * The restore lane's button (#2548 ⑤ the inner column's 「展开内层栏」): at the content surface's top-left, on the same
 * baseline as the sidebar toggle (shell-titlebar), where the leftmost tab strip leaves it its lane (reserveShellRestoreLane,
 * SHELL_RESTORE_LANE_PX). Mounted in the content surface, so it moves with it while the list opens or collapses.
 */
export function ShellRestoreLane({ children }: { children: ReactNode }) {
  return (
    <div
      className="absolute z-50 flex items-center [-webkit-app-region:no-drag]"
      style={{ top: TITLEBAR_ACTION_TOP_PX, left: TITLEBAR_LEFT_EDGE_GAP_PX }}
      data-shell-restore-lane=""
    >
      {children}
    </div>
  )
}
