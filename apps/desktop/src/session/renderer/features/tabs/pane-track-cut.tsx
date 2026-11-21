import { useLayoutEffect, useMemo, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { setDragShield } from '@renderer/lib/drag-shield';
import { PanelSlot } from '@renderer/lib/layout/panel-slot';
import { PanelTrack } from '@renderer/lib/layout/panel-track';
import { cn } from '@renderer/utils/utils';

/** Arrow keys move a divider this far (as the session page's own edges do, panel-resize-handle). */
const KEYBOARD_STEP_PX = 16;

export interface TrackCutChild {
  id: string;
  /** The least this child may be along the cut (px). */
  min: number;
  node: ReactNode;
}

/**
 * @@@track-cut — a cut of the pane tree (its children side by side, or stacked) as a PanelTrack: every child but the last
 * is a slot, the last one takes the rest. A child's share becomes px of what the cut measures, with the one-pixel divider
 * after it inside its slot (the dividers are drawn over that pixel and ride the track), so a pane is as wide as before.
 *
 * `animate`: the shares' next change moves on the track's spring (the root cut: the pair's side page at another width,
 * an equalize). A drag, a resize of the cut and another set of children jump (and reduced motion, in the track).
 */
export function TrackCut({
  axis,
  shares,
  items,
  animate,
  onShares,
  onEqualize,
  divider,
  children,
}: {
  axis: 'x' | 'y';
  shares: readonly number[];
  items: readonly TrackCutChild[];
  animate: boolean;
  /** The person moved a divider: the cut's new shares. */
  onShares: (shares: number[]) => void;
  onEqualize: () => void;
  /** A divider with a gesture of its own (the chat workspace's): its index, ref, pointer and extra attributes. */
  divider?: { at: number; ref: React.Ref<HTMLDivElement>; onPointerDown: (event: PointerEvent<HTMLDivElement>) => void; props: Record<string, unknown> };
  /** Drawn over the cut (the chat workspace's collapse preview). */
  children?: ReactNode;
}) {
  const ids = items.map((item) => item.id);
  const idsKey = ids.join(',');
  // A new set of children is a new track: they are placed where they are, ❌ moved there.
  const track = useMemo(() => new PanelTrack(ids.slice(0, -1).map((id) => ({ id, at: { size: 0 } })), axis), [idsKey, axis]);
  const rootRef = useRef<HTMLDivElement>(null);
  const handles = useRef<(HTMLDivElement | null)[]>([]);
  const extent = useRef(0);
  const dragging = useRef(false);
  const sharesRef = useRef(shares);
  sharesRef.current = shares;

  const span = () => Math.max(0, extent.current - (items.length - 1));
  const targets = () => Object.fromEntries(ids.slice(0, -1).map((id, at) => [id, { size: (span() * (sharesRef.current[at] ?? 0)) / 100 + 1 }]));
  const size = axis === 'x' ? 'width' : 'height';

  // The dividers ride the edges as they are drawn.
  useLayoutEffect(() => track.subscribe((drawn) => {
    let edge = 0;
    ids.slice(0, -1).forEach((id, at) => {
      edge += drawn.get(id) ?? 0;
      const handle = handles.current[at];
      if (handle) handle.style.transform = `translate${axis.toUpperCase()}(${edge - 1}px)`;
    });
  }), [track]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const next = axis === 'x' ? root.clientWidth : root.clientHeight;
      if (next === extent.current) return;
      extent.current = next;
      track.jump(targets());
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [track]);

  const sharesKey = shares.join(',');
  const placed = useRef<PanelTrack | null>(null);
  useLayoutEffect(() => {
    const first = placed.current !== track;
    placed.current = track;
    if (animate && !first && !dragging.current && extent.current > 0) track.to(targets());
    else track.jump(targets());
  }, [sharesKey, track]);

  /** Shares with divider `at` moved to `edge` px from the cut's start, both of its neighbours kept at their minimum. */
  const sharesAt = (at: number, edge: number): number[] => {
    const whole = span();
    const px = sharesRef.current.map((share) => (whole * share) / 100);
    const before = px.slice(0, at).reduce((sum, value) => sum + value, 0) + at;
    const pair = px[at] + px[at + 1];
    const first = Math.min(pair - items[at + 1].min, Math.max(items[at].min, edge - before));
    const next = [...sharesRef.current];
    const total = next[at] + next[at + 1];
    next[at] = whole > 0 ? (first / whole) * 100 : next[at];
    next[at + 1] = total - next[at];
    return next;
  };
  const edgeOf = (at: number) => {
    const whole = span();
    return sharesRef.current.slice(0, at + 1).reduce((sum, share) => sum + (whole * share) / 100, 0) + at;
  };

  const drag = (at: number) => (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const handle = event.currentTarget;
    const root = rootRef.current!;
    const start = root.getBoundingClientRect()[axis === 'x' ? 'left' : 'top'];
    const grab = (axis === 'x' ? event.clientX : event.clientY) - start - edgeOf(at);
    dragging.current = true;
    setDragShield(true);
    handle.setPointerCapture(event.pointerId);
    const move = (next: globalThis.PointerEvent) => onShares(sharesAt(at, (axis === 'x' ? next.clientX : next.clientY) - start - grab));
    const end = () => {
      dragging.current = false;
      setDragShield(false);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.removeEventListener('lostpointercapture', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
  };
  const step = (at: number) => (event: KeyboardEvent<HTMLDivElement>) => {
    const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    const forth = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    if (event.key !== back && event.key !== forth) return;
    event.preventDefault();
    dragging.current = true;
    onShares(sharesAt(at, edgeOf(at) + (event.key === forth ? KEYBOARD_STEP_PX : -KEYBOARD_STEP_PX)));
    dragging.current = false;
  };

  const last = items[items.length - 1];
  return (
    <div ref={rootRef} className={cn('relative flex h-full w-full min-h-0 min-w-0 overflow-hidden', axis === 'y' && 'flex-col')} data-track-cut={axis}>
      {items.slice(0, -1).map((item) => (
        <PanelSlot key={item.id} track={track} id={item.id} axis={axis}>
          {/* The last pixel is the divider's. */}
          <div style={{ [size]: 'calc(100% - 1px)', [axis === 'x' ? 'height' : 'width']: '100%' }}>{item.node}</div>
        </PanelSlot>
      ))}
      <div ref={(element) => track.attachFill(element)} className="relative min-h-0 min-w-0 flex-1">{last.node}</div>
      {items.slice(0, -1).map((item, at) => {
        const own = divider?.at === at ? divider : undefined;
        return (
          <div
            key={`divider-${item.id}`}
            ref={(element) => {
              handles.current[at] = element;
              if (own && typeof own.ref === 'function') own.ref(element);
              else if (own?.ref && typeof own.ref === 'object') (own.ref as React.MutableRefObject<HTMLDivElement | null>).current = element;
            }}
            role="separator"
            tabIndex={0}
            aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
            aria-valuenow={Math.round(shares[at] ?? 0)}
            aria-valuemin={0}
            aria-valuemax={100}
            data-slot="resizable-handle"
            className={cn(
              'absolute top-0 left-0 bg-[var(--border-subtle)] focus-visible:outline-hidden after:absolute',
              axis === 'x'
                ? 'h-full w-px cursor-col-resize after:inset-y-0 after:-left-1 after:w-2'
                : 'h-px w-full cursor-row-resize after:inset-x-0 after:-top-1 after:h-2',
              own && 'touch-none'
            )}
            style={{ zIndex: 'var(--z-pane-divider)' }}
            onPointerDown={own ? (event) => { dragging.current = true; own.onPointerDown(event); } : drag(at)}
            onPointerUp={own ? () => { dragging.current = false; } : undefined}
            onKeyDown={step(at)}
            onDoubleClick={own ? undefined : onEqualize}
            {...own?.props}
          />
        );
      })}
      {children}
    </div>
  );
}
