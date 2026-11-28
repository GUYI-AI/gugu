import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useInterface } from '@/lib/viewStateTable';
import { SidebarMenu } from './sidebar-primitives';

export const DEFAULT_TOPIC_ROWS = 6;

export function TopicViewport({ children, all, total, label }: { children: ReactNode; all: boolean; total: number; label: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const id = useId();
  const [preferred, save] = useInterface('gugu.taskpage.topicRows', DEFAULT_TOPIC_ROWS);
  const [preview, setPreview] = useState<number | null>(null);
  const drag = useRef<{ pointer: number; y: number; rows: number } | null>(null);
  const [geometry, setGeometry] = useState({ row: 32, capacity: DEFAULT_TOPIC_ROWS });

  useLayoutEffect(() => {
    const menu = viewport.current;
    const stack = menu?.closest<HTMLElement>('[data-region="inner-sidebar-scroll"]');
    const content = menu?.firstElementChild;
    const section = menu?.parentElement;
    const header = menu?.previousElementSibling;
    if (all || !stack || !header || !content || !section) return;
    const measure = () => {
      const height = content.querySelector('[role="listitem"]')?.getBoundingClientRect().height;
      if (!height) return;
      // Both module headings, their section margins, and one agent row stay within reach.
      const gap = parseFloat(getComputedStyle(section).marginBottom) || 0;
      const reserved = 2 * (header.getBoundingClientRect().height + gap) + height;
      setGeometry({ row: height, capacity: Math.max(1, Math.floor((stack.clientHeight - reserved) / height)) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stack);
    // The shell portal can populate the slot after this layout effect, including when unfolding.
    observer.observe(content);
    return () => observer.disconnect();
  }, [all]);

  const max = Math.max(1, Math.min(total, geometry.capacity));
  const clamp = (rows: number) => Math.min(max, Math.max(1, rows));
  const visible = clamp(preview ?? preferred);
  const rowsAt = (y: number, start: { rows: number; y: number }) => clamp(start.rows + Math.round((y - start.y) / geometry.row));

  return (
    <>
      <SidebarMenu ref={viewport} id={id} data-inner-rows="" data-topic-viewport={all ? undefined : ''}
        className={all ? undefined : 'overflow-x-hidden overflow-y-auto overscroll-y-contain [overflow-anchor:none]'}
        style={all ? undefined : { maxHeight: Math.max(1, Math.min(geometry.capacity, preview ?? preferred)) * geometry.row }}>
        {children}
      </SidebarMenu>
      {!all && max > 1 && (
        <div role="separator" aria-label={label} aria-controls={id} aria-orientation="horizontal"
          aria-valuemin={1} aria-valuemax={max} aria-valuenow={visible} tabIndex={0} data-topic-resize=""
          onKeyDown={event => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            save(clamp(visible + (event.key === 'ArrowUp' ? -1 : 1)));
          }}
          onPointerDown={event => {
            if (event.button !== 0 || !event.isPrimary) return;
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { pointer: event.pointerId, rows: visible, y: event.clientY };
          }}
          onPointerMove={event => {
            if (drag.current?.pointer === event.pointerId) setPreview(rowsAt(event.clientY, drag.current));
          }}
          onPointerUp={event => {
            const start = drag.current;
            if (start?.pointer !== event.pointerId) return;
            const chosen = rowsAt(event.clientY, start);
            if (chosen !== start.rows) save(chosen);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={() => { drag.current = null; setPreview(null); }}
        />
      )}
    </>
  );
}
