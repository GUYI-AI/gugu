import { animate } from 'framer-motion';

/**
 * @@@panel-track — the one place a panel's size moves on screen. A track is a row (or column) of slots before a `fill` that
 * takes the rest; callers say where slots go (`to` on the spring, `jump` at once) and never animate.
 *
 *  · Laid out once at each end: while moving, a slot's place is the smaller of its two sizes and its content the larger
 *    (a slot that `reflows` is laid out at its new size from the start: its text wraps once, ❌ jumps when it lands).
 *  · Every frame in between is transforms: the content is seen through a window moved to the drawn edge (the content moved
 *    back by as much), the fill moved to start there. A slot going to or from nothing fades behind a soft edge (owner 11-21).
 */
export const PANEL_SPRING = { type: 'spring', duration: 0.5, bounce: 0.1 } as const;

/** Every edge this close to where it goes ends the move: the spring's sub-pixel tail would hold the landing layout back. */
export const PANEL_LANDED_PX = 0.5;

/** A fading slot's soft edge: transparent at its drawn edge, opaque this far in. */
export const PANEL_SOFT_EDGE_PX = 24;
const SOFT_EDGE = { x: `linear-gradient(to left, transparent 0, black ${PANEL_SOFT_EDGE_PX}px)`, y: `linear-gradient(to top, transparent 0, black ${PANEL_SOFT_EDGE_PX}px)` };

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Where a slot goes: the size it takes on screen, and the size its content is laid out at there (default: the same). */
export interface SlotTarget {
  size: number;
  content?: number;
  /** Narrowing, its content takes the new size at the move's start; what it gives up is drawn over by the slot after it. */
  reflows?: boolean;
}

/** Where a slot is drawn now, its place in the layout, and its content's laid-out size. */
export interface SlotGeometry {
  drawn: number;
  place: number;
  content: number;
}

/** One frame of a slot: window and content offsets along the track (px), opacity, soft edge, out of reach. */
export interface SlotPaint {
  window: number;
  inner: number;
  opacity: number;
  soft: boolean;
  /** Drawn at nothing: inert (❌ visibility, which would restyle its whole subtree). */
  hidden: boolean;
}

/** A move from where a slot is drawn (maybe mid-move) to `target`: place the smaller size, lay the content out at the larger. */
export function planSlot(drawn: number, content: number, target: SlotTarget & { content: number }): { place: number; content: number } {
  const now = target.reflows && target.size >= PANEL_LANDED_PX;
  return { place: Math.min(drawn, target.size), content: now ? target.content : Math.max(content, target.content) };
}

/** One frame: each slot and the fill are moved by how far the slots before them are drawn from where they are laid out. */
export function paintTrack(slots: readonly SlotGeometry[]): { slots: SlotPaint[]; fill: number } {
  let shift = 0;
  const paint = slots.map((slot) => {
    const slotPaint = paintSlot(slot, shift);
    shift += slot.drawn - slot.place;
    return slotPaint;
  });
  return { slots: paint, fill: shift };
}

/** The window (content wide) is moved so its far end is on the drawn edge; the content back by as much. */
function paintSlot(slot: SlotGeometry, shift: number): SlotPaint {
  const clip = Math.max(0, slot.content - slot.drawn);
  const clipped = clip > PANEL_LANDED_PX;
  // Fades only on the way to or from nothing: a rail (the list) fades its own text.
  const soft = clipped && slot.place < PANEL_LANDED_PX;
  return {
    window: shift - clip || 0,
    inner: clip || 0,
    opacity: soft ? clamp01(slot.drawn / slot.content) : 1,
    soft,
    hidden: slot.drawn < PANEL_LANDED_PX,
  };
}

export interface PanelSlotNodes {
  /** In the flow: the slot's place in the layout. */
  place: HTMLElement;
  /** Absolutely placed in `place`, against its outer edge: clips the content (overflow clip, ❌ hidden: a hidden box can be
   *  scrolled, and focus coming into a page still off the edge scrolls it, moving everything beside it). */
  window: HTMLElement;
  /** The content, laid out at the slot's content size. */
  content: HTMLElement;
}

interface Slot {
  id: string;
  nodes: PanelSlotNodes | null;
  geometry: SlotGeometry;
  from: number;
  target: Required<SlotTarget>;
}

export type PanelTrackListener = (drawn: ReadonlyMap<string, number>, landed: boolean) => void;

/** Slots (in order) and a fill, attached by PanelSlot and the fill's ref; geometry is kept, and written when nodes come. */
export class PanelTrack {
  private readonly slots: Slot[];
  private fill: HTMLElement | null = null;
  private running: { stop: () => void } | null = null;
  private readonly listeners = new Set<PanelTrackListener>();

  /** `axis`: a row (x, sizes are widths) or a column (y, heights). */
  constructor(
    slots: readonly { id: string; at: SlotTarget }[],
    private readonly axis: 'x' | 'y' = 'x'
  ) {
    this.slots = slots.map(({ id, at }) => {
      const target = full(at);
      return { id, nodes: null, from: target.size, target, geometry: { drawn: target.size, place: target.size, content: target.content } };
    });
  }

  attach(id: string, nodes: PanelSlotNodes | null): void {
    this.slot(id).nodes = nodes;
    if (nodes) this.write(true);
  }

  attachFill(fill: HTMLElement | null): void {
    this.fill = fill;
    if (fill) this.write(true);
  }

  /** Where a slot is drawn now (px). */
  drawn(id: string): number {
    return this.slot(id).geometry.drawn;
  }

  /** The size a slot's content is laid out at now. */
  content(id: string): number {
    return this.slot(id).geometry.content;
  }

  /** Called after every write: each slot's drawn size, and whether the track is at rest. */
  subscribe(listener: PanelTrackListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Puts the slots there now (a drag, a resize, a place without motion). */
  jump(targets: Readonly<Record<string, SlotTarget>>): void {
    this.stop();
    for (const slot of this.slots) {
      const target = targets[slot.id] ? full(targets[slot.id]) : slot.target;
      slot.target = target;
      slot.from = target.size;
      slot.geometry = { drawn: target.size, place: target.size, content: target.content };
    }
    this.write(true);
  }

  /** Moves the slots there on the spring from where they are drawn now (a move under way is taken over). */
  to(targets: Readonly<Record<string, SlotTarget>>): void {
    // Reduced motion is the track's to honour, ❌ each caller's.
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return this.jump(targets);
    const next = this.slots.map((slot) => (targets[slot.id] ? full(targets[slot.id]) : slot.target));
    if (this.slots.every((slot, at) => same(slot.target, next[at]))) return;
    this.stop();
    this.slots.forEach((slot, at) => {
      slot.target = next[at];
      slot.from = slot.geometry.drawn;
      slot.geometry = { drawn: slot.from, ...planSlot(slot.from, slot.geometry.content, slot.target) };
    });
    // Ours before frame 0 (not landed) and before the spring starts: its first frame or its end may come before `animate` returns.
    const move = { stop: () => {} };
    this.running = move;
    // Frame 0 with the start's layout, in the click's task.
    this.write(true);
    const controls = animate(0, 1, {
      ...PANEL_SPRING,
      onUpdate: (progress) => {
        if (this.running !== move) return;
        for (const slot of this.slots) slot.geometry.drawn = slot.from + progress * (slot.target.size - slot.from);
        if (this.slots.every((slot) => Math.abs(slot.geometry.drawn - slot.target.size) < PANEL_LANDED_PX)) this.land();
        else this.write(false);
      },
      onComplete: () => {
        if (this.running === move) this.land();
      },
    });
    if (this.running === move) move.stop = () => controls.stop();
    else controls.stop();
  }

  stop(): void {
    const running = this.running;
    this.running = null;
    running?.stop();
  }

  private land(): void {
    if (!this.running) return;
    this.stop();
    for (const slot of this.slots) slot.geometry = { drawn: slot.target.size, place: slot.target.size, content: slot.target.content };
    this.write(true);
  }

  private slot(id: string): Slot {
    const slot = this.slots.find((entry) => entry.id === id);
    if (!slot) throw new Error(`panel track has no slot ${id}`);
    return slot;
  }

  /** `layout`: also the places and content sizes (only at a move's two ends). */
  private write(layout: boolean): void {
    const size = this.axis === 'x' ? 'width' : 'height';
    const translate = (offset: number) => (offset ? `translate${this.axis.toUpperCase()}(${offset}px)` : '');
    const paint = paintTrack(this.slots.map((slot) => slot.geometry));
    // Own layers while moving, so a frame repaints nothing; dropped at rest.
    const moving = this.slots.some((slot) => slot.geometry.drawn !== slot.target.size) ? 'transform' : '';
    this.slots.forEach((slot, at) => {
      const nodes = slot.nodes;
      if (!nodes) return;
      const p = paint.slots[at];
      if (layout) {
        nodes.place.style[size] = `${slot.geometry.place}px`;
        nodes.window.style[size] = `${slot.geometry.content}px`;
        nodes.content.style[size] = `${slot.geometry.content}px`;
      }
      nodes.window.style.transform = translate(p.window);
      nodes.content.style.transform = translate(p.inner);
      nodes.window.style.willChange = moving;
      nodes.content.style.willChange = moving;
      nodes.window.style.opacity = p.opacity < 1 ? String(p.opacity) : '';
      nodes.window.style.maskImage = p.soft ? SOFT_EDGE[this.axis] : '';
      nodes.window.inert = p.hidden;
    });
    if (this.fill) {
      this.fill.style.transform = translate(paint.fill);
      this.fill.style.willChange = moving;
    }
    const drawn = new Map(this.slots.map((slot) => [slot.id, slot.geometry.drawn]));
    const landed = !this.running;
    for (const listener of this.listeners) listener(drawn, landed);
  }
}

function full(target: SlotTarget): Required<SlotTarget> {
  return { size: target.size, content: target.content ?? target.size, reflows: target.reflows ?? false };
}

function same(a: Required<SlotTarget>, b: Required<SlotTarget>): boolean {
  return a.size === b.size && a.content === b.content && a.reflows === b.reflows;
}
