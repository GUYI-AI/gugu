import { playSpring } from './panel-clock';

/**
 * @@@panel-track — the one place a panel's size moves on screen. A track is a row (or column) of slots before a `fill` that takes the rest; callers say where slots go (`to` moves
 * there, `jump` is there at once) and never animate.
 *
 *  · The layout is the state. A slot's size is its box's size: `jump` writes it, `to` writes it and has the platform move the box there (an animation of the size itself, ❌ a transform
 *    over a layout that already landed), so every frame is laid out at the size it is drawn at and what is beside a moving panel re-lays out with it. Nothing here keeps where a box is
 *    drawn: who needs it measures the box. A move's only own state is how far the spring has come, stepped in frames (@@@frame-clock) and handed to the platform's animations as their time.
 *  · A slot or the fill going to or from nothing keeps its content at its open size, on the edge that moves (a slot's far edge, the fill's near edge), as a sheet pulled out, fading
 *    behind a soft edge (owner 11-21). At nothing the content stays laid out at that size — the one thing the layout would not otherwise remember — out of the window and inert.
 *  · Between two open sizes content is its drawn size in every frame; one that does not reflow keeps the wider until it lands.
 */

/** What a row's box will rest at through a move — "<its content's resting size> <how much wider than now>" — and the event the box fires (a microtask on) as that is set or cleared. ❌ An attribute on the box: it restyles all that is in it (a `:has()` above), in the task that starts the move. */
export const PANEL_REST = 'panelrest';
export const panelRest = new WeakMap<Element, string | undefined>();
/** A size this close to nothing is nothing. */
export const PANEL_LANDED_PX = 0.5;
/** A fading slot's soft edge: transparent at its drawn edge, opaque this far in. */
export const PANEL_SOFT_EDGE_PX = 24;
const softEdge = (toward: string) => `linear-gradient(to ${toward}, transparent 0, black ${PANEL_SOFT_EDGE_PX}px)`;
/** The edge that moves: a slot's far end, the fill's near end. */
const SOFT_EDGE = { x: { slot: softEdge('left'), fill: softEdge('right') }, y: { slot: softEdge('top'), fill: softEdge('bottom') } };

/** Where a box at nothing is drawn: out of any window, at its own size (inert does not take back the app-region rects its content hands the window). ❌ visibility (it restyles the whole subtree), ❌ scale(0) (what measures the box reads nothing). */
const OUT_OF_WINDOW = 'translate(-100000px, -100000px)';

/** A move as the platform's animation, linear over a nominal time: the spring's progress is set as its time. */
export const MOVE = { duration: 1000, fill: 'both' } as const;

export const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/** Where a slot goes: the size it takes on screen. */
export interface SlotTarget {
  size: number;
  /** The size its content is laid out at whatever the slot's (default: the slot's, and at nothing the size it was open at). */
  content?: number;
  /** Between two open sizes its content is laid out at the drawn size in every frame (default: the wider, until it lands). */
  reflows?: boolean;
}

export interface PanelSlotNodes {
  /** In the flow: the slot's place, laid out at its drawn size. Through a move `panelRest` has for it the size its content will rest at, and how much wider than now that is. */
  place: HTMLElement;
  /** Fills `place` and clips the content (overflow clip, ❌ hidden: a hidden box can be scrolled, and focus coming into a page still off the edge scrolls it, moving everything beside it). */
  window: HTMLElement;
  /** The content, laid out at the slot's content size. */
  content: HTMLElement;
}

type SlotRider = (from: number, to: number, content: number) => Animation[]; // what moves with a slot through a move, as animations on the move's clock: made when it starts, gone when it lands
interface Slot {
  id: string;
  exit: 'slide' | 'clip'; // to or from nothing: slid out with its edge and faded (default), or held where it is laid out and clipped by its drawn edge — the track does not fade that one, what fades with it rides it (`ride`)
  riders: SlotRider[];
  nodes: PanelSlotNodes | null;
  /** What the caller last said: written when the nodes come, and what the next `to` is compared with. */
  target: SlotTarget;
}

/** Slots (in order) and a fill, attached by PanelSlot. */
export class PanelTrack {
  private readonly slots: Slot[];
  private fill: PanelSlotNodes | null = null;
  /** The move under way: the platform's animations of it, and the clock that steps them. */
  private move: Animation[] = [];
  private clock: { stop(): void } | null = null;
  private starts = new Map<string, number>(); private stepped = false; // where each slot was drawn as the move under way began, and whether that move has had a frame yet
  private readonly landings = new Set<() => void>();

  /** `axis`: a row (x, widths) or a column (y, heights). `extent`: the track's length as its owner measures it: the fill has this less the slots, so placing writes and never reads the layout back. */
  constructor(
    slots: readonly { id: string; at: SlotTarget; exit?: Slot['exit'] }[],
    private readonly axis: 'x' | 'y' = 'x',
    private extent = 0
  ) {
    this.slots = slots.map(({ id, at, exit = 'slide' }) => ({ id, exit, riders: [], nodes: null, target: at }));
  }

  measure(extent: number): void { this.extent = extent; }

  attach(id: string, nodes: PanelSlotNodes | null): void {
    const slot = this.slot(id);
    slot.nodes = nodes;
    if (nodes && !this.moving) this.rest(nodes, slot.target, 'slot', this.extent);
  }

  attachFill(nodes: PanelSlotNodes | null): void {
    this.fill = nodes;
    if (!this.moving) this.restFill();
  }

  /** Whether a move is under way. */
  get moving(): boolean { return this.move.length > 0; }

  /** Where a slot is drawn now (px): through a move its box, measured; at rest where it was put (❌ a read of the layout: asked right after a write it lays the page out again). */
  drawn(id: string): number {
    const slot = this.slot(id);
    return !this.moving ? slot.target.size : this.stepped && slot.nodes ? this.sizeOf(slot.nodes.place) : this.starts.get(id)!; // before a move's first frame it is where it started
  }

  /** The size a slot's content is laid out at now (px). */
  content(id: string): number {
    const { nodes, target } = this.slot(id);
    return (nodes && heldPx(nodes.content, this.sides[0])) || (!this.moving ? (target.content ?? target.size) : this.stepped && nodes ? this.sizeOf(nodes.content) : this.starts.get(id)!);
  }

  /** `rider`'s animations go with every move of this slot from here on — the one under way too, from where it is (what mounts as a move starts rides it). */
  ride(id: string, rider: SlotRider): () => void {
    const { riders, nodes, target } = this.slot(id);
    riders.push(rider);
    for (const animation of this.moving && nodes ? rider(this.starts.get(id) ?? target.size, target.size, heldPx(nodes.content, this.sides[0]) || target.size) : []) this.move.push((animation.pause(), (animation.currentTime = this.move[0].currentTime), animation));
    return () => void riders.splice(riders.indexOf(rider), 1);
  }

  /** Called when a move ends: it landed, or a jump took it over. */
  onLanded(listener: () => void): () => void {
    this.landings.add(listener);
    return () => this.landings.delete(listener);
  }

  /** Puts the slots there now (a drag, a resize, a place without motion). */
  jump(targets: Readonly<Record<string, SlotTarget>>, landing = this.moving): void {
    this.stop();
    for (const slot of this.slots) {
      const open = slot.target.size || this.extent;
      slot.target = targets[slot.id] ?? slot.target;
      if (slot.nodes) this.rest(slot.nodes, slot.target, 'slot', open);
    }
    this.restFill();
    if (landing) for (const listener of this.landings) listener();
  }

  private restFill(): void {
    const fill = this.fillBox();
    if (fill) this.rest(fill, { size: this.left((slot) => slot.target.size) }, 'fill', this.extent);
    else if (this.fill) this.mark(this.fill.place);
  }

  private fillBox(): PanelSlotNodes | null {
    return this.fill && this.fill.content !== this.fill.place && this.extent > 0 ? this.fill : null;
  }

  private left(size: (slot: Slot) => number): number {
    return Math.max(0, this.extent - this.slots.reduce((sum, slot) => sum + size(slot), 0));
  }

  /** Moves the slots there from where they are drawn now (a move under way is taken over). */
  to(targets: Readonly<Record<string, SlotTarget>>): void {
    // Reduced motion is the track's to honour, ❌ each caller's.
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return this.jump(targets, true);
    if (this.slots.every((slot) => !targets[slot.id] || same(slot.target, targets[slot.id]))) return;
    const [size] = this.sides;
    // Where each is drawn now: mid-move measured, at rest where it was put.
    const from = new Map(this.slots.map((slot) => [slot.id, this.drawn(slot.id)]));
    const fillFrom = this.left((slot) => from.get(slot.id)!);
    this.stop();
    this.starts = from; this.stepped = false;
    const move: Animation[] = [];
    let distance = 0;
    for (const slot of this.slots) {
      slot.target = targets[slot.id] ?? slot.target;
      const nodes = slot.nodes;
      const start = from.get(slot.id)!;
      const end = slot.target.size;
      distance = Math.max(distance, Math.abs(start - end));
      if (!nodes) continue;
      this.sheet(nodes, start, slot.target, slot.exit === 'clip' ? 'held' : 'slot', move);
      for (const rider of slot.riders) move.push(...rider(start, end, heldPx(nodes.content, size) || Math.max(start, end)));
      nodes.place.style[size] = `${end}px`;
      if (Math.abs(start - end) >= PANEL_LANDED_PX) move.push(nodes.place.animate({ [size]: [`${start}px`, `${end}px`] }, MOVE));
    }
    // The fill takes what the slots leave; in the flow, it needs no size of its own.
    const fill = this.fillBox();
    const fillTo = this.left((slot) => slot.target.size);
    if (fill) this.sheet(fill, fillFrom, { size: fillTo, reflows: true }, 'fill', move);
    else if (this.fill && this.extent > 0) this.mark(this.fill.place, `${fillTo} ${fillTo - fillFrom}`);
    if (move.length === 0) return this.jump(targets, true); // nothing to move on screen: it has landed all the same
    for (const animation of move) animation.pause();
    this.move = move;
    this.clock = playSpring((progress) => {
      // There when every edge is within half a pixel: the spring's sub-pixel tail would hold the landing layout back.
      if (Math.abs(progress - 1) * distance < PANEL_LANDED_PX) return this.jump({});
      this.stepped = true;
      for (const animation of move) animation.currentTime = progress * MOVE.duration;
    }, () => { if (this.move === move) this.jump({}); });
  }

  stop(): void {
    const move = this.move;
    this.move = [];
    this.clock?.stop();
    this.clock = null;
    for (const animation of move) animation.cancel();
  }

  /** A box for the length of a move from `start` to `target`. To or from nothing it is a sheet: its content at its open size on the edge that moves, the window fading with the share of it that is drawn. */
  private sheet(nodes: PanelSlotNodes, start: number, target: SlotTarget, role: 'slot' | 'held' | 'fill', move: Animation[]): void {
    const [size, near, far] = this.sides;
    const end = target.size;
    const faded = Math.min(start, end) < PANEL_LANDED_PX || !!nodes.window.style.maskImage; // or turned round part-way: still a sheet
    const now = heldPx(nodes.content, size) || start;
    // A sheet is its open size (opening: where it goes; closing: what it is). Else it reflows, or keeps the wider end.
    const held = faded ? (target.content ?? (end >= PANEL_LANDED_PX ? end : now)) : target.reflows && target.content === undefined ? null : Math.max(now, target.content ?? end);
    nodes.content.style[size] = held === null ? '100%' : `${held}px`;
    const rest = faded ? held! : (target.content ?? end);
    this.mark(nodes.place, `${rest} ${rest - (held ?? start)}`);
    nodes.content.style[near] = faded && role === 'slot' ? 'auto' : '';
    nodes.content.style[far] = faded && role === 'slot' ? '0' : '';
    nodes.window.style.maskImage = faded && role !== 'held' ? SOFT_EDGE[this.axis][role] : '';
    nodes.window.style.transform = '';
    nodes.window.inert = false;
    if (faded && held && role !== 'held') move.push(nodes.window.animate({ opacity: [clamp01(start / held), clamp01(end / held)] }, MOVE));
  }

  /** A box at rest at `target`. */
  private rest(nodes: PanelSlotNodes, target: SlotTarget, role: 'slot' | 'fill', open: number): void {
    const [size, near, far] = this.sides;
    const gone = target.size < PANEL_LANDED_PX;
    const kept = gone && target.content === undefined ? heldPx(nodes.content, size) || open : 0; // at nothing: the size it was open at
    if (role === 'slot') nodes.place.style[size] = `${target.size}px`;
    this.mark(nodes.place);
    if (target.content !== undefined) nodes.content.style[size] = `${target.content}px`;
    else if (!gone) nodes.content.style[size] = role === 'slot' ? '100%' : '';
    else if (kept > 0) nodes.content.style[size] = `${kept}px`;
    nodes.content.style[near] = nodes.content.style[far] = '';
    nodes.window.style.maskImage = '';
    nodes.window.style.transform = gone ? OUT_OF_WINDOW : '';
    nodes.window.inert = gone;
  }

  private mark(place: HTMLElement, rest?: string): void { // a row's only: what is decided from a width is decided once (pane-dimension-provider, the chat strip)
    if (this.axis !== 'x' || panelRest.get(place) === rest) return;
    panelRest.set(place, rest);
    queueMicrotask(() => place.dispatchEvent(new Event(PANEL_REST)));
  }
  private get sides() {
    return this.axis === 'x' ? (['width', 'left', 'right'] as const) : (['height', 'top', 'bottom'] as const);
  }

  /** A box's size as it is laid out now, mid-move too (❌ its rect: a retained page hidden around it is scaled to nothing). */
  private sizeOf(element: HTMLElement): number {
    return parseFloat(element.ownerDocument.defaultView!.getComputedStyle(element)[this.sides[0]]) || 0;
  }

  private slot(id: string): Slot {
    const slot = this.slots.find((entry) => entry.id === id);
    if (!slot) throw new Error(`panel track has no slot ${id}`);
    return slot;
  }
}

/** The size a content box is held at by its own style (0: it follows its box). */
function heldPx(content: HTMLElement, size: 'width' | 'height'): number {
  return content.style[size].endsWith('px') ? parseFloat(content.style[size]) : 0;
}

function same(a: SlotTarget, b: SlotTarget): boolean {
  return a.size === b.size && a.content === b.content && (a.reflows ?? false) === (b.reflows ?? false);
}
