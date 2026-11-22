/**
 * The layer each pop-out window's popups go into (aux-window-host), by document. Kept apart from the window store
 * (aux-windows) so what only asks "where do popups drawn into this document go" does not load the screen's stores.
 * The main window has none: its popups go where they always did.
 */
const layers = new WeakMap<Document, HTMLElement>();

export function setAuxLayer(doc: Document, layer: HTMLElement): void {
  layers.set(doc, layer);
}

export function auxLayerOf(doc: Document): HTMLElement | null {
  return layers.get(doc) ?? null;
}
