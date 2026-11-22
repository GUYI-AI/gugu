/**
 * Where popups go in pop-out windows (aux-window-host). A pop-out is another document drawn by this renderer, while the
 * app-wide hosts (the image viewer, forward pages, notices) and the shell's slot content live in the main window's tree:
 * left alone, what they open lands in the main window, behind the pop-out the person is using.
 *
 * The rule: a popup opens in the window its request came from, fixed when it opens. A request that carries an element
 * (a thumbnail, an App's page, a pane's slot) came from that element's document; one that does not came from the window
 * the person last pressed or typed in (`requestDocument`).
 *
 * Kept apart from the window store (aux-windows) so what only asks "where do popups go" does not load the screen's stores.
 * The main window has no layer: its popups go where they always did.
 */
type AuxLayer = { doc: Document; layer: HTMLElement; toasterId: string };

const layers = new Map<Document, AuxLayer>();
const listeners = new Set<() => void>();
const tracked = new WeakSet<Document>();
let snapshot: readonly AuxLayer[] = [];
let lastInput: Document | null = null;
let seq = 0;

function trackInput(doc: Document): void {
  if (tracked.has(doc)) return;
  tracked.add(doc);
  const mark = () => {
    lastInput = doc;
  };
  doc.addEventListener('pointerdown', mark, true);
  doc.addEventListener('keydown', mark, true);
}

function changed(): void {
  snapshot = [...layers.values()];
  for (const listener of listeners) listener();
}

/** A pop-out window opened (`layer` = where its popups go). Returns the undo for when it closes. */
export function setAuxLayer(doc: Document, layer: HTMLElement): () => void {
  trackInput(document);
  trackInput(doc);
  layers.set(doc, { doc, layer, toasterId: `aux-${++seq}` });
  changed();
  return () => {
    layers.delete(doc);
    if (lastInput === doc) lastInput = null;
    changed();
  };
}

export function auxLayerOf(doc: Document): HTMLElement | null {
  return layers.get(doc)?.layer ?? null;
}

/** The open pop-out a request with no element of its own came from: the one last pressed or typed in, if any. */
function requestPopOut(): AuxLayer | undefined {
  return lastInput ? layers.get(lastInput) : undefined;
}

/** The document a request with no element of its own came from: that pop-out's, else the main window's. */
export function requestDocument(): Document {
  return requestPopOut()?.doc ?? document;
}

/** Where a popup opened now for such a request goes: that pop-out's layer, or null for the main window. */
export function requestLayer(): HTMLElement | null {
  return requestPopOut()?.layer ?? null;
}

/** The notices toaster of the window a request came from (NoticeHost draws one per pop-out); undefined = the main window's. */
export function requestToasterId(): string | undefined {
  return requestPopOut()?.toasterId;
}

/** Open pop-outs, for hosts that draw something in each (NoticeHost). */
export function readAuxLayers(): readonly AuxLayer[] {
  return snapshot;
}

export function subscribeAuxLayers(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
