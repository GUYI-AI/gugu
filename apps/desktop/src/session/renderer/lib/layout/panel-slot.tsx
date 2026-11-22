import { useCallback, useRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '@renderer/utils/utils';
import type { PanelTrack } from './panel-track';

/**
 * One slot of a PanelTrack (panel-track.ts): its place in the flow, the window that clips it there, and its content. Sizes
 * are written by the track only; this renders the three boxes and hands them over.
 * `windowProps` go on the window (the box the panel is seen through: data attributes, z, a hidden style).
 * `fill`: the track's fill in the same three boxes (it takes the rest, nothing clips it), so a child that becomes or stops
 * being the last of a cut keeps its nodes (TrackCut).
 */
export function PanelSlot({
  track,
  id,
  axis = 'x',
  className,
  windowProps,
  fill = false,
  children,
}: {
  track: PanelTrack;
  id: string;
  /** The track's axis (PanelTrack): a slot in a row, or in a column. */
  axis?: 'x' | 'y';
  className?: string;
  windowProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | undefined>;
  fill?: boolean;
  children: ReactNode;
}) {
  const nodes = useRef<{ place?: HTMLDivElement | null; window?: HTMLDivElement | null; content?: HTMLDivElement | null }>({});
  const role = useRef(fill);
  const attach = useCallback(() => {
    const { place, window, content } = nodes.current;
    // Became the fill or stopped being it: what the other role's track wrote goes, the new track writes its own.
    if (role.current !== fill && place && window && content) {
      role.current = fill;
      for (const { style } of [place, window, content]) style.width = style.height = style.left = style.top = style.opacity = style.maskImage = '';
      window.inert = false;
    }
    if (fill) track.attachFill(place ?? null, content ?? null);
    else track.attach(id, place && window && content ? { place, window, content } : null);
  }, [track, id, fill]);
  const ref = (key: 'place' | 'window' | 'content') => (element: HTMLDivElement | null) => {
    nodes.current[key] = element;
    attach();
  };
  return (
    <div ref={ref('place')} data-panel-slot={fill ? undefined : id} className={cn(fill ? 'relative min-h-0 min-w-0 flex-1' : 'relative shrink-0', axis === 'x' ? 'h-full' : 'w-full', className)}>
      <div
        {...windowProps}
        ref={ref('window')}
        className={cn('absolute inset-0 overflow-clip', windowProps?.className)}
      >
        <div ref={ref('content')} className={cn('absolute top-0 left-0', fill ? 'size-full' : axis === 'x' ? 'h-full' : 'w-full')}>
          {children}
        </div>
      </div>
    </div>
  );
}
