import { useLayoutEffect, useMemo, useReducer, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { setDragShield } from '@renderer/lib/drag-shield';
import { KEYBOARD_STEP_PX } from '@renderer/lib/layout/panel-resize-handle';
import { PanelSlot } from '@renderer/lib/layout/panel-slot';
import { PanelTrack } from '@renderer/lib/layout/panel-track';
import { cn } from '@renderer/utils/utils';

export interface TrackCutChild {
  id: string;
  /** The least this child may be along the cut (px). */
  min: number;
  /** Keeps the size its share gives it: the dividers beside it neither drag nor take keys (a folded section). */
  fixed?: boolean;
  node: ReactNode;
}

/**
 * @@@track-cut — a cut (the pane tree's, the screen's blocks, the changes sections) as a PanelTrack: every child but the
 * last is a slot holding its share of the measured span plus the one-pixel divider drawn over its far edge; the last takes
 * the rest. `animate`: a change of shares moves on the spring, and so does a last child coming (a side page opening) or,
 * with `exit`, going (drawn until it is off); a drag, a resize and any other set of children jump.
 */
export function TrackCut({
  axis,
  shares,
  items,
  animate,
  exit = false,
  disabled = false,
  onShares,
  onEqualize,
  divider,
  children,
}: {
  axis: 'x' | 'y';
  /** Each child's share (%); or the shares for the span the cut measures (a child kept at a width in px). */
  shares: readonly number[] | ((span: number) => readonly number[]);
  items: readonly TrackCutChild[];
  animate: boolean;
  /** A last child going away moves off too: its node still renders after it is gone from `items`. */
  exit?: boolean;
  /** Dividers neither drag nor take keys (a page in full screen over the cut). */
  disabled?: boolean;
  /** The person moved a divider: the cut's new shares, and the span (px, less the dividers) they are of. */
  onShares: (shares: number[], span: number) => void;
  onEqualize: () => void;
  /** A divider with a gesture of its own (the chat workspace's): its index, ref, pointer and extra attributes. */
  divider?: { at: number; ref: React.RefObject<HTMLDivElement | null>; onPointerDown: (event: PointerEvent<HTMLDivElement>) => void; props: Record<string, unknown> };
  /** Drawn over the cut (the chat workspace's collapse preview). */
  children?: ReactNode;
}) {
  const extent = useRef(0);
  // A last child that went away while `animate`: drawn as the fill until the track lands.
  const leaving = useRef<TrackCutChild | null>(null);
  const previous = useRef(items);
  // Set by the move that takes it off: a write before it (a slot attaching) is not that move landing.
  const exiting = useRef(false);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const was = previous.current.map((item) => item.id);
  if (was.join(',') !== items.map((item) => item.id).join(',')) {
    leaving.current = animate && exit && was.length === items.length + 1 && items.every((item, at) => item.id === was[at]) ? previous.current[was.length - 1] : null;
  }
  previous.current = items;
  const drawnItems = leaving.current ? [...items, leaving.current] : items;
  const ids = drawnItems.map((item) => item.id);
  const idsKey = ids.join(',');
  const last = useRef<{ track: PanelTrack | null; ids: string[] }>({ track: null, ids: [] });
  // Another set of children is another track. A last child added comes in from where the cut's end was drawn; the rest
  // are placed where they are, ❌ moved there.
  const { track, entering } = useMemo(() => {
    const was = last.current;
    const entering = animate && was.track !== null && ids.length === was.ids.length + 1 && was.ids.every((id, at) => id === ids[at]);
    const drawnSlots = was.ids.slice(0, -1).reduce((sum, id) => sum + (was.track?.drawn(id) ?? 0), 0);
    const at = (id: string) => (entering ? (id === was.ids.at(-1) ? extent.current - drawnSlots : was.track!.drawn(id)) : 0);
    const next = new PanelTrack(ids.slice(0, -1).map((id) => ({ id, at: { size: at(id) } })), axis);
    last.current = { track: next, ids };
    return { track: next, entering };
  }, [idsKey, axis]);
  const rootRef = useRef<HTMLDivElement>(null);
  const handles = useRef<(HTMLDivElement | null)[]>([]);
  const dragging = useRef(false);
  // The person moved a divider: the shares that come of it are placed, ❌ moved on the spring.
  const moved = useRef(false);
  const span = () => Math.max(0, extent.current - (items.length - 1));
  const sharesFor = useRef(shares);
  sharesFor.current = shares;
  const sharesNow = (): readonly number[] => (typeof sharesFor.current === 'function' ? sharesFor.current(span()) : sharesFor.current);
  /** Each child's px: its share, but at least its minimum, taken from those above theirs (a narrow cut). */
  const sizes = () => {
    const whole = span();
    const px = items.map((item, at) => (whole * (sharesNow()[at] ?? 0)) / 100);
    const short = items.reduce((sum, item, at) => sum + Math.max(0, item.min - px[at]), 0);
    const spare = items.reduce((sum, item, at) => sum + Math.max(0, px[at] - item.min), 0);
    const give = spare > 0 ? Math.min(1, short / spare) : 0;
    return px.map((value, at) => Math.max(items[at].min, value - Math.max(0, value - items[at].min) * give));
  };
  // The last child before one leaving has no divider after it. A pane re-wraps at its new size once, as the move starts.
  const targets = () => {
    const px = sizes();
    return Object.fromEntries(ids.slice(0, -1).map((id, at) => [id, { size: px[at] + (at < items.length - 1 ? 1 : 0), reflows: !items[at].fixed }]));
  };
  const userShares = (next: number[]) => {
    moved.current = true;
    onShares(next, span());
  };
  const size = axis === 'x' ? 'width' : 'height';

  // The dividers ride the edges as they are drawn.
  useLayoutEffect(() => track.subscribe((drawn, landed) => {
    if (landed && exiting.current) {
      exiting.current = false;
      leaving.current = null;
      redraw();
    }
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

  const sharesKey = sharesNow().join(',');
  const placed = useRef<PanelTrack | null>(null);
  useLayoutEffect(() => {
    const first = placed.current !== track;
    placed.current = track;
    const byHand = moved.current || dragging.current;
    moved.current = false;
    const moves = animate && (!first || entering) && !byHand && extent.current > 0;
    exiting.current = moves && leaving.current !== null;
    if (moves) track.to(targets());
    else track.jump(targets());
    if (!moves && leaving.current) {
      leaving.current = null;
      redraw();
    }
  }, [sharesKey, track]);

  /** Shares with divider `at` moved to `edge` px from the cut's start, both of its neighbours kept at their minimum. */
  const sharesAt = (at: number, edge: number): number[] => {
    const whole = span();
    const now = sharesNow();
    const px = sizes();
    const before = px.slice(0, at).reduce((sum, value) => sum + value, 0) + at;
    const pair = px[at] + px[at + 1];
    const first = Math.min(pair - items[at + 1].min, Math.max(items[at].min, edge - before));
    const next = [...now];
    const total = next[at] + next[at + 1];
    next[at] = whole > 0 ? (first / whole) * 100 : next[at];
    next[at + 1] = total - next[at];
    return next;
  };
  const edgeOf = (at: number) => sizes().slice(0, at + 1).reduce((sum, value) => sum + value, 0) + at;

  const drag = (at: number) => (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const handle: HTMLDivElement = event.currentTarget;
    const root = rootRef.current!;
    const start = root.getBoundingClientRect()[axis === 'x' ? 'left' : 'top'];
    const grab = (axis === 'x' ? event.clientX : event.clientY) - start - edgeOf(at);
    dragging.current = true;
    setDragShield(true);
    handle.setPointerCapture(event.pointerId);
    const gesture = new AbortController();
    const { signal } = gesture;
    handle.addEventListener('pointermove', (next) => userShares(sharesAt(at, (axis === 'x' ? next.clientX : next.clientY) - start - grab)), { signal });
    const end = () => { dragging.current = false; setDragShield(false); gesture.abort(); };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, end, { signal });
  };
  const step = (at: number) => (event: KeyboardEvent<HTMLDivElement>) => {
    const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    const forth = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    if (event.key !== back && event.key !== forth) return;
    event.preventDefault();
    userShares(sharesAt(at, edgeOf(at) + (event.key === forth ? KEYBOARD_STEP_PX : -KEYBOARD_STEP_PX)));
  };

  return (
    <div ref={rootRef} className={cn('relative flex h-full w-full min-h-0 min-w-0 overflow-hidden', axis === 'y' && 'flex-col')} data-track-cut={axis}>
      {drawnItems.map((item, at) => {
        const fill = at === drawnItems.length - 1;
        return (
          <PanelSlot key={item.id} track={track} id={item.id} axis={axis} fill={fill}>
            {/* A slot's last pixel is the divider's. */}
            <div style={{ display: 'flex', flexDirection: 'column', [size]: fill ? '100%' : 'calc(100% - 1px)', [axis === 'x' ? 'height' : 'width']: '100%' }}>{item.node}</div>
          </PanelSlot>
        );
      })}
      {drawnItems.slice(0, -1).map((item, at) => {
        const own = divider?.at === at ? divider : undefined;
        const inert = disabled || !!leaving.current || item.fixed || drawnItems[at + 1].fixed;
        return (
          <div
            key={`divider-${item.id}`}
            ref={(element) => {
              handles.current[at] = element;
              if (own) own.ref.current = element;
            }}
            role="separator"
            tabIndex={inert ? -1 : 0}
            aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
            aria-valuenow={Math.round(sharesNow()[at] ?? 0)}
            aria-disabled={inert || undefined}
            aria-valuemin={0}
            aria-valuemax={100}
            data-slot="resizable-handle"
            className={cn(
              'absolute top-0 left-0 bg-[var(--border-subtle)] focus-visible:outline-hidden after:absolute',
              axis === 'x'
                ? 'h-full w-px cursor-col-resize after:inset-y-0 after:-left-1 after:w-2'
                : 'h-px w-full cursor-row-resize after:inset-x-0 after:-top-1 after:h-2',
              own && 'touch-none',
              inert && 'pointer-events-none'
            )}
            style={{ zIndex: 'var(--z-pane-divider)' }}
            onPointerDown={inert ? undefined : own ? (event) => { dragging.current = true; own.onPointerDown(event); } : drag(at)}
            onPointerUp={own ? () => { dragging.current = false; } : undefined}
            onKeyDown={inert ? undefined : step(at)}
            onDoubleClick={own || inert ? undefined : onEqualize}
            {...own?.props}
          />
        );
      })}
      {children}
    </div>
  );
}
