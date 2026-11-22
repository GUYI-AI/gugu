import { assignInlineVars } from '@vanilla-extract/dynamic';
import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@renderer/utils/utils';
import { useMediaQuery } from '@renderer/lib/hooks/use-media-query';
import * as styles from './sidebar-session-title.css';

/** Clear space between the readable end of the title and the first action drawn over it. */
const COVER_GAP_PX = 4;

/**
 * A sidebar row's title. Its width never depends on hover: the row's quick actions are drawn over
 * its tail (`cover`), so on hover the title fades out before them and a long title reveals its end
 * up to their left edge, instead of the lane narrowing and the reveal starting over.
 */
export function SidebarSessionTitle({ title, className, cover }: {
  title: string;
  className?: string;
  /**
   * The row's hover actions layer; its left edge is where the title stops while it is shown. An element, not a
   * ref: it is a later sibling, so its ref is attached only after this title's layout effect has run.
   */
  cover?: HTMLElement | null;
}) {
  const viewport = useRef<HTMLSpanElement>(null);
  const content = useRef<HTMLSpanElement>(null);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [metrics, setMetrics] = useState({ overflow: 0, cover: 0, distance: 0, duration: 0 });

  useLayoutEffect(() => {
    const outer = viewport.current;
    const inner = content.current;
    if (!outer || !inner) return;
    const over = cover ?? null;
    const text = document.createRange();
    const measure = () => {
      const lane = outer.clientWidth;
      // The text itself: the track is at least as wide as the lane (min-width: 100%).
      text.selectNodeContents(inner);
      const width = text.getBoundingClientRect().width;
      const overflow = lane > 0 && width - lane >= 1 ? width - lane : 0;
      // The actions layer is laid out (transparent) at rest too, so its edge is measurable before any hover.
      const intrusion = over ? outer.getBoundingClientRect().right - over.getBoundingClientRect().left : 0;
      const coverPx = intrusion > 0 ? Math.min(lane, intrusion + COVER_GAP_PX) : 0;
      const hidden = width - (lane - coverPx);
      const distance = lane > 0 && hidden >= 1 ? hidden : 0;
      const fontSize = Number.parseFloat(getComputedStyle(inner).fontSize);
      const duration = distance / (fontSize * 2);
      setMetrics((previous) => previous.overflow === overflow && previous.cover === coverPx
        && previous.distance === distance && previous.duration === duration
        ? previous : { overflow, cover: coverPx, distance, duration });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    observer.observe(inner);
    if (over) observer.observe(over);
    return () => observer.disconnect();
  }, [title, metrics.distance, cover]);

  return (
    <span
      ref={viewport}
      className={cn(styles.viewport, className)}
      data-overflow={metrics.overflow > 0 || undefined}
      data-reveal={metrics.distance > 0 || undefined}
      title={reducedMotion ? title : undefined}
      style={assignInlineVars({
        [styles.cover]: `${metrics.cover}px`,
        [styles.distance]: `${metrics.distance}px`,
        [styles.duration]: `${metrics.duration}s`,
      })}
    >
      <span
        ref={content}
        // Replacing an overflowing title or resizing its lane restarts at the beginning.
        key={`${title}:${metrics.distance}`}
        className={styles.content}
      >{title}</span>
    </span>
  );
}
