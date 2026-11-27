/** Following a box after it starts being followed: until it holds still this many frames, or this long. */
const FOLLOW_STILL_FRAMES = 10;
const FOLLOW_MAX_MS = 2_000;

/** From the element up to the document root (through shadow roots): any of them resizing may move the element. */
export function ancestorsOf(element: HTMLElement): Element[] {
  const out: Element[] = [];
  let node: Node | null = element;
  while (node) {
    if (node instanceof Element) out.push(node);
    const parent: Node | null = node.parentNode;
    node = parent instanceof ShadowRoot ? parent.host : parent;
  }
  return out;
}

/**
 * @@@follow-box — a native view drawn over a box of the page (a browser tab's page, an App's page) moves with that box.
 * Nothing reports a box moving, so this watches what moves it: an ancestor resized (a PanelTrack's boxes, in every frame of
 * a move), an ancestor restyled (a framer slide, a class that hides it), the window resized or shown again, a scroll. A box that
 * slides in by a CSS animation moves by a transform none of these see: from the start it is followed frame by frame until
 * it holds still, bounded for one that never settles. ❌ a resident frame loop: it keeps the main thread in every frame
 * beside any running animation (Air 11-23: renderer 6% → 25–30% beside a group page's spinners).
 *
 * `onChange(moving)`: `moving` — a frame of a motion (the box is not where it was last time, or an ancestor was resized),
 * where a hit test would lay out the whole page in the middle of the frame the motion has just written.
 */
export function followBox(element: HTMLElement, onChange: (moving: boolean) => void): () => void {
  const doc = element.ownerDocument;
  const win = doc.defaultView!;
  const rectOf = () => { const r = element.getBoundingClientRect(); return `${r.left},${r.top},${r.width},${r.height}`; };
  let changedAt = rectOf();
  let followedIn: unknown; // the frame the start follow placed in: a resize reported later in that frame is already placed for
  const change = (resized?: unknown) => {
    const box = rectOf();
    const moving = resized === true || box !== changedAt;
    changedAt = box;
    onChange(moving);
  };
  const followUntil = win.performance.now() + FOLLOW_MAX_MS;
  let lastBox = '';
  let still = 0;
  let frame = 0;
  const follow = () => {
    const box = rectOf();
    if (box !== changedAt) { change(); followedIn = doc.timeline.currentTime; }
    still = box === lastBox ? still + 1 : 0;
    lastBox = box;
    frame = still < FOLLOW_STILL_FRAMES && win.performance.now() < followUntil ? win.requestAnimationFrame(follow) : 0;
  };
  frame = win.requestAnimationFrame(follow);
  // An ancestor resized is a frame of a motion too (a panel's fold or a divider drag resizes them every frame), whether this box
  // moved by it or not: no hit test there — an earlier observer of the same delivery has just written styles, and a hit test
  // laid the page out again in every frame. The occlusion sample after the motion settles is the caller's.
  const resized = new ResizeObserver(() => { if (followedIn !== doc.timeline.currentTime) change(true); });
  // Hidden in place by a class or style above it (a slot covered by what opens beside its page, AppPeekSlot) moves no
  // box: the change itself says so.
  const restyled = new MutationObserver(change);
  for (const node of ancestorsOf(element)) {
    resized.observe(node);
    restyled.observe(node, { attributes: true, attributeFilter: ['style', 'class', 'hidden', 'inert'] });
  }
  win.addEventListener('resize', change);
  doc.addEventListener('scroll', change, true);
  doc.addEventListener('visibilitychange', change);
  return () => {
    if (frame) win.cancelAnimationFrame(frame);
    resized.disconnect();
    restyled.disconnect();
    win.removeEventListener('resize', change);
    doc.removeEventListener('scroll', change, true);
    doc.removeEventListener('visibilitychange', change);
  };
}
