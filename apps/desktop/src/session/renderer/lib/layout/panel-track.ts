import { animate } from 'framer-motion';

/**
 * @@@panel-track — the one place a panel's size moves on screen: open, fold, and a change of size (a side page that wants
 * another width) are all a slot going from one size to another, played here and nowhere else.
 *
 * A track is a row of slots before one `fill` (the page, which takes the rest). Callers only say where each slot goes
 * (`to`); they never animate. The motion keeps the page from being laid out in every frame:
 *
 *  · **Laid out once at each end.** For the whole move a slot's place in the layout is the smaller of its two sizes and its
 *    content the larger, so the fill is laid out at its larger size too. Whatever grows is laid out at the start, whatever
 *    shrinks where it lands; in between, nothing is.
 *  · **Every frame is transforms (and opacity).** A slot's content is shown through a window that is moved, with the content
 *    moved back the other way, so the window clips it at the slot's drawn edge; the fill is moved so it starts at the drawn
 *    edges. A slot that opens from or closes to nothing fades with its size, behind a soft edge, so no glyph reads as cut
 *    (owner 09-13: nothing may look clipped; 11-21: a folding panel keeps its width, fades, soft edge).
 *  · **One spring for the track** (`PANEL_SPRING`): every edge that moves, moves on it.
 *
 * Jumps (no motion): the first placement, a slot appearing or going, a resize of the track, a drag, reduced motion.
 */
export const PANEL_SPRING = { type: 'spring', duration: 0.5, bounce: 0.1 } as const;

/**
 * Within this of where it goes, every edge has landed and the move ends there: the spring's sub-pixel tail (~130 ms)
 * would otherwise hold the last layout (e.g. the list's rail layout) back after the motion looks done.
 */
export const PANEL_LANDED_PX = 0.5;

/** The soft edge a fading slot shows at its drawn edge while it is clipped. */
export const PANEL_SOFT_EDGE_PX = 24;
/** Transparent at the drawn (right) edge, opaque PANEL_SOFT_EDGE_PX in. */
const SOFT_EDGE = `linear-gradient(to left, transparent 0, black ${PANEL_SOFT_EDGE_PX}px)`;

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Where a slot goes: the size it takes on screen, and the size its content is laid out at there (default: the same). */
export interface SlotTarget {
  size: number;
  content?: number;
}

/** A slot's state in the layout: what it occupies on screen now, its place in the layout, its content's laid-out size. */
export interface SlotGeometry {
  drawn: number;
  place: number;
  content: number;
}

/** What one frame writes for a slot. `window`/`inner` are x offsets (px); `soft` = fade + soft edge. */
export interface SlotPaint {
  window: number;
  inner: number;
  opacity: number;
  soft: boolean;
  /** Drawn at nothing: out of focus and reach (inert). It is already invisible (opacity 0); ❌ visibility, which would restyle its whole subtree. */
  hidden: boolean;
}

/**
 * The plan for a move from `drawn`/`content` (where a slot is now, maybe mid-move) to `target`: its place is the smaller
 * size, its content the larger, so the fill gets the larger too and neither is laid out again until it lands.
 */
export function planSlot(drawn: number, content: number, target: Required<SlotTarget>): { place: number; content: number } {
  return { place: Math.min(drawn, target.size), content: Math.max(content, target.content) };
}

/**
 * One frame of a track: each slot's paint and the fill's offset, from the slots' geometry in track order. A slot keeps its
 * content against its left edge and is moved by how far the slots before it are drawn from where they are laid out; so is
 * the fill. The fill is laid out at least as wide as it is drawn: what runs past its right end lies past the track's edge.
 */
export function paintTrack(slots: readonly SlotGeometry[]): { slots: SlotPaint[]; fill: number } {
  let shift = 0;
  const paint = slots.map((slot) => {
    const slotPaint = paintSlot(slot, shift);
    shift += slot.drawn - slot.place;
    return slotPaint;
  });
  return { slots: paint, fill: shift };
}

/**
 * A slot's window is laid out at its place's left edge, `content` wide; it is moved so its right end is on the drawn edge,
 * and the content is moved back by the same clip so it stays against the left edge. `shift`: how far the slot's drawn left
 * edge is from its laid-out one.
 */
function paintSlot(slot: SlotGeometry, shift: number): SlotPaint {
  const clip = Math.max(0, slot.content - slot.drawn);
  const clipped = clip > PANEL_LANDED_PX;
  // Fades only on the way to or from nothing: a rail (the list) keeps what it shows and fades its own text.
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
  /** Absolutely placed in `place`, against its outer edge: clips the content (overflow hidden). */
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

/**
 * A track: its slots (in order) and its fill. `to` says where slots go; `jump` puts them there now. The nodes are attached
 * by PanelSlot / the fill's ref; a track without nodes still keeps its geometry (it is written when they come).
 */
export class PanelTrack {
  private readonly slots: Slot[];
  private fill: HTMLElement | null = null;
  private running: { stop: () => void } | null = null;
  private readonly listeners = new Set<PanelTrackListener>();

  constructor(slots: readonly { id: string; at: SlotTarget }[]) {
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

  /**
   * Moves the slots there on the spring, from wherever they are drawn now (a move under way is taken over). A slot not
   * named keeps its target. Nothing to move = nothing happens.
   */
  to(targets: Readonly<Record<string, SlotTarget>>): void {
    const next = this.slots.map((slot) => (targets[slot.id] ? full(targets[slot.id]) : slot.target));
    // At rest the geometry is the target; mid-move the move already goes there.
    if (this.slots.every((slot, at) => same(slot.target, next[at]))) return;
    this.stop();
    this.slots.forEach((slot, at) => {
      slot.target = next[at];
      slot.from = slot.geometry.drawn;
      slot.geometry = { drawn: slot.from, ...planSlot(slot.from, slot.geometry.content, slot.target) };
    });
    // Frame 0 is written with the start's layout, in the same task as the click: the page is never drawn in between.
    this.write(true);
    // The move is ours before the spring starts: its first frame or its end may come before `animate` returns.
    const move = { stop: () => {} };
    this.running = move;
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

  /** Writes the current geometry: `layout` also writes the places and content sizes (the start and the landing only). */
  private write(layout: boolean): void {
    const translate = (offset: number) => (offset ? `translateX(${offset}px)` : '');
    const paint = paintTrack(this.slots.map((slot) => slot.geometry));
    // Its own compositor layer while it moves, so a frame repaints nothing; dropped at rest (layers cost memory).
    const moving = this.slots.some((slot) => slot.geometry.drawn !== slot.target.size) ? 'transform' : '';
    this.slots.forEach((slot, at) => {
      const nodes = slot.nodes;
      if (!nodes) return;
      const p = paint.slots[at];
      if (layout) {
        nodes.place.style.width = `${slot.geometry.place}px`;
        nodes.window.style.width = `${slot.geometry.content}px`;
        nodes.content.style.width = `${slot.geometry.content}px`;
      }
      nodes.window.style.transform = translate(p.window);
      nodes.content.style.transform = translate(p.inner);
      nodes.window.style.willChange = moving;
      nodes.content.style.willChange = moving;
      nodes.window.style.opacity = p.opacity < 1 ? String(p.opacity) : '';
      nodes.window.style.maskImage = p.soft ? SOFT_EDGE : '';
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
  return { size: target.size, content: target.content ?? target.size };
}

function same(a: Required<SlotTarget>, b: Required<SlotTarget>): boolean {
  return a.size === b.size && a.content === b.content;
}
