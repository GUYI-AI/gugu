import type { ReactNode } from 'react';
import { SHELL_RESTORE_LANE_PX, SIDEBAR_HEADER_CONTROLS_PX } from '@/lib/window-chrome';
import { cn } from '@renderer/utils/utils';

/**
 * Search shares the 40px header with layout and collapse on every desktop platform.
 * ShellSidebarToggle owns the two fixed controls, so they stay reachable when the list slides away.
 * GUYI-AI/gugu#2548 the sidebar as one list keeps only the bell up there (`controls={1}`): the collapse button is at its foot.
 */
export function SidebarSpace({ children, controls = 2, className }: { children?: ReactNode; controls?: 1 | 2; className?: string }) {
  return (
    <div
      className={cn('flex h-10 w-full shrink-0 items-center pr-3 [-webkit-app-region:drag]', className)}
      style={{ paddingLeft: controls === 1 ? SHELL_RESTORE_LANE_PX : SIDEBAR_HEADER_CONTROLS_PX }}
      data-sidebar-space=""
    >
      {children}
    </div>
  );
}
