import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { clampZoom, DOCUMENT_MAX_ZOOM, DOCUMENT_MIN_ZOOM, isPinchWheel, pinchZoom } from '@/session/shared/preview/pinch-zoom';
import { FILE_ZOOM_ATTRIBUTE, FILE_ZOOM_EVENT, isFileZoomCommand, type FileZoomCommand } from '@/session/shared/preview/file-zoom';

/** A file type's reading zoom, or an App page's (`app:<id>`: the host zooms the App's whole page, as a browser tab). */
export type FileZoomKind = 'markdown' | 'text-code' | 'html' | 'pdf' | 'image' | 'docx' | `app:${string}`;
const CHANGED = 'gugu:file-zoom-preference';
const keyOf = (kind: FileZoomKind) => `gugu.file-content-zoom.${kind}`;

const normalizeZoom = (kind: FileZoomKind, value: number) => kind === 'image' ? Math.max(1, value) : clampZoom(value, DOCUMENT_MIN_ZOOM, DOCUMENT_MAX_ZOOM);

/** The ratio a type was last left at: where a view of it opened next starts (both renderer roots read the same one). */
export function readFileZoom(kind: FileZoomKind): number {
  const value = Number(localStorage.getItem(keyOf(kind)) ?? 1);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return normalizeZoom(kind, value);
}
/**
 * Changes a type's remembered ratio and tells its subscribers: only for what has one view at a time (the image viewer,
 * an App's page). A view that can sit beside another of its type keeps its own (`createFileZoomView`).
 * `shownOn`: the view the person zoomed — the new ratio floats over it for a moment (zoom B: no lasting control).
 */
export function writeFileZoom(kind: FileZoomKind, value: number, shownOn?: Element | null): void {
  if (!Number.isFinite(value) || value <= 0 || value === readFileZoom(kind)) return;
  localStorage.setItem(keyOf(kind), String(value));
  window.dispatchEvent(new Event(CHANGED));
  if (shownOn) showZoomRatio(shownOn, readFileZoom(kind));
}

// @@@zoom-b — owner 11-05 picked B: a readable view has no lasting zoom control; the ratio shows up, centered near the
// top of the view that changed, only while it changes. One element per document, reused; it never takes a pointer.
const ratioShown = new WeakMap<Document, { element: HTMLElement; timer: number }>();
function showZoomRatio(on: Element, value: number) {
  const doc = on.ownerDocument;
  let shown = ratioShown.get(doc);
  if (!shown) {
    const element = doc.createElement('div');
    element.className = 'pointer-events-none fixed z-50 -translate-x-1/2 rounded-surface bg-foreground px-3 py-1 text-sm font-medium tabular-nums text-background shadow-lift transition-opacity duration-[var(--dur-fast)] data-[shown=false]:opacity-0';
    element.setAttribute('role', 'status');
    element.setAttribute('data-occludes-browser-page', '');
    shown = { element, timer: 0 };
    ratioShown.set(doc, shown);
  }
  const { element } = shown;
  if (!element.isConnected) doc.body.append(element);
  const box = on.getBoundingClientRect();
  element.style.left = `${box.left + box.width / 2}px`;
  element.style.top = `${box.top + 16}px`;
  element.textContent = `${Math.round(value * 100)}%`;
  element.dataset.shown = 'true';
  const view = doc.defaultView ?? window;
  view.clearTimeout(shown.timer);
  shown.timer = view.setTimeout(() => { element.dataset.shown = 'false'; }, 900);
}
export const subscribeFileZoom = (listener: () => void) => {
  window.addEventListener(CHANGED, listener);
  window.addEventListener('storage', listener);
  return () => { window.removeEventListener(CHANGED, listener); window.removeEventListener('storage', listener); };
};

/**
 * One open view's reading zoom (#2567): it starts from the ratio its type was last left at, and a change zooms this view
 * only — another view of the type, open beside it, keeps its own ratio. The change is remembered for the next view opened.
 */
export interface FileZoomView {
  get(kind: FileZoomKind): number
  set(kind: FileZoomKind, value: number, shownOn?: Element | null): void
  subscribe(listener: () => void): () => void
}
export function createFileZoomView(): FileZoomView {
  const zooms = new Map<FileZoomKind, number>();
  const listeners = new Set<() => void>();
  const get = (kind: FileZoomKind) => {
    if (!zooms.has(kind)) zooms.set(kind, readFileZoom(kind));
    return zooms.get(kind)!;
  };
  return {
    get,
    set(kind, value, shownOn) {
      if (!Number.isFinite(value) || value <= 0) return;
      const next = normalizeZoom(kind, value);
      if (next === get(kind)) return;
      zooms.set(kind, next);
      localStorage.setItem(keyOf(kind), String(next));
      listeners.forEach(listener => listener());
      if (shownOn) showZoomRatio(shownOn, next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
/** A view made of parts (a preview panel's ⋯ menu row and the document under it) shares one zoom through this. */
export const FileZoomViewContext = createContext<FileZoomView | null>(null);

/** Native menus and page keys share the same viewer command, owned by actual focus. `apply` returning false leaves it to the window. */
export function bindFileZoom(element: HTMLElement, apply: (command: FileZoomCommand) => boolean | void): () => void {
  element.setAttribute(FILE_ZOOM_ATTRIBUTE, '');
  const command = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (!isFileZoomCommand(detail?.command)) return;
    detail.handled = apply(detail.command) !== false;
  };
  const key = (event: KeyboardEvent) => {
    if (!(event.target instanceof Node) || !element.contains(event.target)) return;
    if (event.defaultPrevented || event.isComposing || !(event.metaKey || event.ctrlKey) || event.altKey) return;
    const command = event.key === '0' ? 'resetZoom' : event.key === '+' || event.key === '=' ? 'zoomIn' : event.key === '-' ? 'zoomOut' : null;
    if (!command || apply(command) === false) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const focus = (event: PointerEvent) => {
    const target = event.target as HTMLElement;
    if (!target.closest('input, textarea, select, button, a, iframe, [contenteditable="true"]')) element.focus({ preventScroll: true });
  };
  const oldTabIndex = element.getAttribute('tabindex');
  if (oldTabIndex === null) element.tabIndex = -1;
  element.addEventListener(FILE_ZOOM_EVENT, command);
  // Window capture: the focused viewer owns its zoom keys before app hotkeys, which also listen in capture (code editor bridge, captured commands).
  const view = element.ownerDocument.defaultView ?? window;
  view.addEventListener('keydown', key, true);
  element.addEventListener('pointerdown', focus);
  return () => {
    element.removeEventListener(FILE_ZOOM_EVENT, command);
    view.removeEventListener('keydown', key, true);
    element.removeEventListener('pointerdown', focus);
    element.removeAttribute(FILE_ZOOM_ATTRIBUTE);
    if (oldTabIndex === null) element.removeAttribute('tabindex');
  };
}

export function zoomForCommand(current: number, command: FileZoomCommand): number {
  return command === 'resetZoom' ? 1 : current * (command === 'zoomIn' ? 1.2 : 1 / 1.2);
}

/**
 * Code editor: font size follows the text/code preference, and a pinch over the editor steps that preference
 * (one write per frame) instead of zooming the whole window.
 */
export function bindEditorFileZoom(container: HTMLElement, setFontSize: (px: number) => void, baseFontSize: number): () => void {
  const apply = () => setFontSize(baseFontSize * readFileZoom('text-code'));
  const offPreference = subscribeFileZoom(apply);
  const offCommand = bindFileZoom(container, command => writeFileZoom('text-code', clampZoom(zoomForCommand(readFileZoom('text-code'), command), DOCUMENT_MIN_ZOOM, DOCUMENT_MAX_ZOOM), container));
  let pendingDeltaY = 0;
  let frame = 0;
  const flush = () => {
    frame = 0;
    writeFileZoom('text-code', pinchZoom(readFileZoom('text-code'), pendingDeltaY, DOCUMENT_MIN_ZOOM, DOCUMENT_MAX_ZOOM), container);
    pendingDeltaY = 0;
  };
  const wheel = (event: WheelEvent) => {
    if (!isPinchWheel(event)) return;
    event.preventDefault();
    event.stopPropagation();
    pendingDeltaY += event.deltaY;
    if (!frame) frame = requestAnimationFrame(flush);
  };
  container.addEventListener('wheel', wheel, { capture: true, passive: false });
  apply();
  return () => {
    offPreference();
    offCommand();
    container.removeEventListener('wheel', wheel, { capture: true });
    if (frame) cancelAnimationFrame(frame);
  };
}

/** `view`: the zoom this view keeps; by default the enclosing `FileZoomViewContext`'s, else one of its own. */
export function useFileZoom(kind: FileZoomKind, ref: RefObject<HTMLElement | null>, onCommand?: (command: FileZoomCommand) => boolean | void, view?: FileZoomView) {
  const enclosing = useContext(FileZoomViewContext);
  const [own] = useState(createFileZoomView);
  const store = view ?? enclosing ?? own;
  const zoom = useSyncExternalStore(store.subscribe, () => store.get(kind), () => 1);
  const applyRef = useRef(onCommand);
  applyRef.current = onCommand;
  const storeRef = useRef(store);
  storeRef.current = store;
  // Bound to the element actually mounted, not to [ref, kind]: a reused panel moves its ref between files of the same kind.
  const bound = useRef<{ element: HTMLElement | null; kind: FileZoomKind; off?: () => void }>(undefined);
  useEffect(() => {
    const element = ref.current;
    if (bound.current?.element === element && bound.current.kind === kind) return;
    bound.current?.off?.();
    bound.current = {
      element,
      kind,
      off: element ? bindFileZoom(element, command => {
        if (applyRef.current) return applyRef.current(command);
        const store = storeRef.current;
        store.set(kind, clampZoom(zoomForCommand(store.get(kind), command), DOCUMENT_MIN_ZOOM, DOCUMENT_MAX_ZOOM), element);
      }) : undefined,
    };
  });
  useEffect(() => () => { bound.current?.off?.(); bound.current = undefined; }, []);
  const setZoom = useCallback((value: number | ((current: number) => number)) => store.set(kind, typeof value === 'function' ? value(store.get(kind)) : value, ref.current), [kind, ref, store]);
  return { zoom, setZoom };
}

/**
 * An App's page: the host zooms the whole page (the App writes no zoom code), remembered per App. The page's box is the
 * zoom target — a focused <webview> is the document's active element inside it, so the window's zoom keys reach it.
 */
export function bindAppPageZoom(box: HTMLElement, page: HTMLElement & { setZoomFactor(factor: number): void }, appId: string): () => void {
  const kind: FileZoomKind = `app:${appId}`;
  const apply = () => page.setZoomFactor(readFileZoom(kind));
  const offCommand = bindFileZoom(box, command => writeFileZoom(kind, clampZoom(zoomForCommand(readFileZoom(kind), command), DOCUMENT_MIN_ZOOM, DOCUMENT_MAX_ZOOM), box));
  const offPreference = subscribeFileZoom(apply);
  // A page applies its zoom once it can (and again after it loads anew: a navigation starts it at 100%).
  page.addEventListener('dom-ready', apply);
  return () => {
    offCommand();
    offPreference();
    page.removeEventListener('dom-ready', apply);
  };
}
