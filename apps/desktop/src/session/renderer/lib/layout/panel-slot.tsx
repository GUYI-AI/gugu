import { useCallback, useRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '@renderer/utils/utils';
import type { PanelTrack } from './panel-track';

/**
 * One slot of a PanelTrack (panel-track.ts): its place in the flow, the window that clips it at its drawn edge, and its
 * content. Sizes and transforms are written by the track only; this renders the three boxes and hands them over.
 * `windowProps` go on the window (the box the panel is seen through: data attributes, z, a hidden style).
 */
export function PanelSlot({
  track,
  id,
  axis = 'x',
  className,
  windowProps,
  children,
}: {
  track: PanelTrack;
  id: string;
  /** The track's axis (PanelTrack): a slot in a row, or in a column. */
  axis?: 'x' | 'y';
  className?: string;
  windowProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | undefined>;
  children: ReactNode;
}) {
  const nodes = useRef<{ place?: HTMLDivElement | null; window?: HTMLDivElement | null; content?: HTMLDivElement | null }>({});
  const attach = useCallback(() => {
    const { place, window, content } = nodes.current;
    track.attach(id, place && window && content ? { place, window, content } : null);
  }, [track, id]);
  const ref = (key: 'place' | 'window' | 'content') => (element: HTMLDivElement | null) => {
    nodes.current[key] = element;
    attach();
  };
  return (
    <div ref={ref('place')} data-panel-slot={id} className={cn('relative shrink-0', axis === 'x' ? 'h-full' : 'w-full', className)}>
      <div
        {...windowProps}
        ref={ref('window')}
        className={cn('absolute top-0 left-0 overflow-hidden', axis === 'x' ? 'h-full' : 'w-full', windowProps?.className)}
      >
        <div ref={ref('content')} className={cn('absolute top-0 left-0', axis === 'x' ? 'h-full' : 'w-full')}>
          {children}
        </div>
      </div>
    </div>
  );
}
