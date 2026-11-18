import type { HTMLAttributes, Ref } from 'react';
import { SIDEBAR_HEADER_CONTROLS_PX } from '@/lib/window-chrome';
import { cn } from '@renderer/utils/utils';

/**
 * A sidebar's 40px top band, the window's drag handle. `controls={2}` leaves the lane of two fixed shell controls at its
 * start. GUYI-AI/gugu#2548 the sidebar as one list carries its own controls in the band (`controls={0}`, its head:
 * collapse, bell, search, 会话历史), so it leaves no lane.
 */
export function SidebarSpace({
  children,
  controls = 2,
  className,
  ref,
  ...props
}: HTMLAttributes<HTMLDivElement> & { controls?: 0 | 2; ref?: Ref<HTMLDivElement> }) {
  return (
    <div
      {...props}
      ref={ref}
      className={cn('flex h-10 w-full shrink-0 items-center pr-3 [-webkit-app-region:drag]', className)}
      style={controls === 0 ? undefined : { paddingLeft: SIDEBAR_HEADER_CONTROLS_PX }}
      data-sidebar-space=""
    >
      {children}
    </div>
  );
}
