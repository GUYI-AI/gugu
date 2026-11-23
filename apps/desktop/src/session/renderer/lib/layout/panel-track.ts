import { animate } from 'framer-motion';

/**
 * @@@panel-track — the one place a panel's size moves on screen. A track is a row (or column) of slots before a `fill` that
 * takes the rest; callers say where slots go (`to` on the spring, `jump` at once) and never animate.
 *
 *  · The size is the state: every frame each slot is laid out at the size it is drawn at (❌ transforms over a layout that
 *    already landed), and the fill, in the flow, takes what is left — what is beside a moving panel re-lays out with it.
 *  · A slot going to or from nothing keeps its content at its open size, clipped at its drawn edge (its far edge rides the
 *    edge, as a sheet pulled out), and fades behind a soft edge (owner 11-21); so does a fill. Any other slot's content is
 *    its drawn size, unless the caller holds it (`content`: the list keeps its width through a fold), and then it stays put,
 *    clipped at the drawn edge.
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

/** Where a slot is drawn now, and the size its content is laid out at. */
export interface SlotGeometry {
  drawn: number;
  content: number;
}

/** One frame of a slot: its content's offset from the slot's start (px, ≤ 0), opacity, soft edge, out of reach. */
export interface SlotPaint {
  offset: number;
  opacity: number;
  soft: boolean;
  /** Drawn at nothing: inert (❌ visibility, which would restyle its whole subtree). */
  hidden: boolean;
}

/** The content size for a frame of a move from `from` to `target`, drawn at `drawn`: held at the open end to or from nothing. */
export function contentAt(drawn: number, from: { size: number; content: number }, target: Required<SlotTarget>): number {
  if (Math.min(from.size, target.size) < PANEL_LANDED_PX) return Math.max(from.content, target.content);
  return target.reflows ? drawn : Math.max(from.content, target.content);
}

/** A slot's content is clipped at its drawn edge. `faded`: a move to or from nothing, whose content is a sheet pulled out (its
 *  far edge on the drawn edge); any other held content stays where it is laid out, its near edge put (a rail keeps its
 *  avatars in place and fades its own text). */
export function paintSlot(slot: SlotGeometry, faded: boolean): SlotPaint {
  const clip = Math.max(0, slot.content - slot.drawn);
  const soft = faded && clip > PANEL_LANDED_PX;
  return {
    offset: faded ? -clip || 0 : 0,
    opacity: soft ? clamp01(slot.drawn / slot.content) : 1,
    soft,
    hidden: slot.drawn < PANEL_LANDED_PX,
  };
}

export interface PanelSlotNodes {
  /** In the flow: the slot's place in the layout, laid out at its drawn size. */
  place: HTMLElement;
  /** Fills `place` and clips the content (overflow clip, ❌ hidden: a hidden box can be scrolled, and focus coming into a
   *  page still off the edge scrolls it, moving everything beside it). */
  window: HTMLElement;
  /** The content, laid out at the slot's content size. */
  content: HTMLElement;
}

interface Slot {
  id: string;
  nodes: PanelSlotNodes | null;
  geometry: SlotGeometry;
  from: { size: number; content: number };
  target: Required<SlotTarget>;
}

export type PanelTrackListener = (drawn: ReadonlyMap<string, number>, landed: boolean) => void;

/** Slots (in order) and a fill, attached by PanelSlot; geometry is kept, and written when nodes come. */
export class PanelTrack {
  private readonly slots: Slot[];
  private fill: { place: HTMLElement; content: HTMLElement } | null = null;
  /** The track's length (px), when its owner measures it: what the fill's two ends are. */
  private extent = 0;
  private fillFrom = 0;
  private running: { stop: () => void } | null = null;
  private readonly listeners = new Set<PanelTrackListener>();

  /** `axis`: a row (x, sizes are widths) or a column (y, heights). `extent`: the track's length, if known. */
  constructor(
    slots: readonly { id: string; at: SlotTarget }[],
    private readonly axis: 'x' | 'y' = 'x',
    extent = 0
  ) {
    this.slots = slots.map(({ id, at }) => {
      const target = full(at);
      return { id, nodes: null, from: { size: target.size, content: target.content }, target, geometry: { drawn: target.size, content: target.content } };
    });
    this.extent = extent;
    this.fillFrom = this.fillAt('drawn');
  }

  attach(id: string, nodes: PanelSlotNodes | null): void {
    this.slot(id).nodes = nodes;
    if (nodes) this.write();
  }

  attachFill(place: HTMLElement | null, content: HTMLElement | null = place): void {
    this.fill = place && content ? { place, content } : null;
    if (this.fill) this.write();
  }

  /** The track's length changed (its owner measured it); slots are placed by the next `jump` or `to`. */
  measure(extent: number): void {
    this.extent = extent;
  }

  /** Where a slot is drawn now (px). */
  drawn(id: string): number {
    return this.slot(id).geometry.drawn;
  }

  /** Where a slot's move started and where it goes (both its target at rest). */
  ends(id: string): { from: number; to: number } {
    const slot = this.slot(id);
    return { from: this.running ? slot.from.size : slot.target.size, to: slot.target.size };
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
      slot.from = { size: target.size, content: target.content };
      slot.geometry = { drawn: target.size, content: target.content };
    }
    this.fillFrom = this.fillAt('drawn');
    this.write();
  }

  /** Moves the slots there on the spring from where they are drawn now (a move under way is taken over). */
  to(targets: Readonly<Record<string, SlotTarget>>): void {
    // Reduced motion is the track's to honour, ❌ each caller's.
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return this.jump(targets);
    const next = this.slots.map((slot) => (targets[slot.id] ? full(targets[slot.id]) : slot.target));
    if (this.slots.every((slot, at) => same(slot.target, next[at]))) return;
    this.stop();
    this.fillFrom = this.fillAt('drawn');
    this.slots.forEach((slot, at) => {
      slot.target = next[at];
      slot.from = { ...slot.geometry, size: slot.geometry.drawn };
    });
    // Ours before frame 0 (not landed) and before the spring starts: its first frame or its end may come before `animate` returns.
    const move = { stop: () => {} };
    this.running = move;
    this.frame(0);
    const controls = animate(0, 1, {
      ...PANEL_SPRING,
      onUpdate: (progress) => {
        if (this.running !== move) return;
        if (this.slots.every((slot) => Math.abs(slot.from.size + progress * (slot.target.size - slot.from.size) - slot.target.size) < PANEL_LANDED_PX)) this.land();
        else this.frame(progress);
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

  private frame(progress: number): void {
    for (const slot of this.slots) {
      const drawn = slot.from.size + progress * (slot.target.size - slot.from.size);
      slot.geometry = { drawn, content: contentAt(drawn, slot.from, slot.target) };
    }
    this.write();
  }

  private land(): void {
    if (!this.running) return;
    this.stop();
    for (const slot of this.slots) slot.geometry = { drawn: slot.target.size, content: slot.target.content };
    this.fillFrom = this.fillAt('drawn');
    this.write();
  }

  /** The fill's size with the slots where they are drawn, or where they go (0 when the track is not measured). */
  private fillAt(end: 'drawn' | 'target'): number {
    if (this.extent <= 0) return 0;
    return Math.max(0, this.extent - this.slots.reduce((sum, slot) => sum + (end === 'drawn' ? slot.geometry.drawn : slot.target.size), 0));
  }

  private slot(id: string): Slot {
    const slot = this.slots.find((entry) => entry.id === id);
    if (!slot) throw new Error(`panel track has no slot ${id}`);
    return slot;
  }

  private write(): void {
    const size = this.axis === 'x' ? 'width' : 'height';
    const start = this.axis === 'x' ? 'left' : 'top';
    const px = (value: number) => (value ? `${value}px` : '');
    this.slots.forEach((slot) => {
      const nodes = slot.nodes;
      if (!nodes) return;
      const p = paintSlot(slot.geometry, Math.min(slot.from.size, slot.target.size) < PANEL_LANDED_PX);
      nodes.place.style[size] = `${slot.geometry.drawn}px`;
      nodes.content.style[size] = `${slot.geometry.content}px`;
      nodes.content.style[start] = px(p.offset);
      nodes.window.style.opacity = p.opacity < 1 ? String(p.opacity) : '';
      nodes.window.style.maskImage = p.soft ? SOFT_EDGE[this.axis] : '';
      nodes.window.inert = p.hidden;
    });
    if (this.fill) {
      // A fill coming from or going to nothing keeps its open size, its near edge on the last slot's edge.
      const ends = [this.fillFrom, this.fillAt('target')];
      const held = this.running && this.extent > 0 && Math.min(...ends) < PANEL_LANDED_PX ? Math.max(...ends) : 0;
      this.fill.content.style[size] = held ? `${held}px` : '';
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
