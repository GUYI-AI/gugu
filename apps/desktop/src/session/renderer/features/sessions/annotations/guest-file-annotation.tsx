import { reaction, comparer } from 'mobx';
import { createRoot } from 'react-dom/client';
import { EXTENSION_BRIDGE_EVENT_CHANNEL } from '@shared/extensions/bridge-protocol';
import type { FileAnnotationAsk, FileAnnotationMarkers } from '@shared/extensions/file-annotation-draft';
import type { BrowserWebviewElement } from '@renderer/features/browser/browser-webview-types';
import { AnnotationEditor } from './annotation-editor';
import { sessionAnnotations } from './session-annotations';

const watches = new WeakMap<BrowserWebviewElement, () => void>();
const editors = new WeakMap<Document, () => void>();

/** Marker events carry anchors only. Annotation words stay in the host's draft and editor. */
export function watchGuestFileAnnotations(guest: BrowserWebviewElement, { sessionId, path }: FileAnnotationAsk): boolean {
  watches.get(guest)?.();
  if (path === null) return true;
  if (!guest.send) return false;
  const draft = sessionAnnotations.forSession(sessionId);
  const stop = reaction(
    () => draft.items.filter(item => item.kind === 'file').filter(item => item.path === path)
      .map(({ id, number, startLine }) => ({ id, number, startLine })),
    markers => {
      const value: FileAnnotationMarkers = { path, markers };
      void guest.send?.(EXTENSION_BRIDGE_EVENT_CHANNEL, { type: 'fileAnnotationMarkers', value }).catch(() => close());
    },
    { fireImmediately: true, equals: comparer.structural },
  );
  const resize = new ResizeObserver(() => { if (!guest.isConnected) close(); });
  resize.observe(guest);
  const close = () => {
    stop();
    resize.disconnect();
    guest.removeEventListener('did-start-loading', close);
    watches.delete(guest);
  };
  guest.addEventListener('did-start-loading', close);
  watches.set(guest, close);
  return true;
}

export function editGuestFileAnnotation(guest: BrowserWebviewElement, container: HTMLElement | null, {
  sessionId, path, open,
}: FileAnnotationAsk, timeout: number): Promise<boolean> {
  if (!open || path === null) return Promise.resolve(false);
  const doc = guest.ownerDocument;
  const box = guest.getBoundingClientRect();
  const { rect, viewport } = open;
  const x = box.left + rect.x * box.width / viewport.width;
  const y = box.top + rect.y * box.height / viewport.height;
  if (!guest.isConnected || !box.width || !box.height || x > box.right || y > box.bottom ||
    x + rect.width * box.width / viewport.width < box.left || y + rect.height * box.height / viewport.height < box.top) return Promise.resolve(false);
  const draft = sessionAnnotations.forSession(sessionId);
  const editing = 'id' in open
    ? draft.items.filter(item => item.kind === 'file').find(item => item.id === open.id && item.path === path)
    : undefined;
  if ('id' in open && !editing) return Promise.resolve(false);

  editors.get(doc)?.();
  const mount = doc.createElement('div');
  const width = Math.min(320, Math.max(0, box.width - 16));
  if (!width) return Promise.resolve(false);
  mount.className = 'gugu-skin fixed';
  mount.dataset.occludesBrowserPage = '';
  Object.assign(mount.style, {
    zIndex: 'var(--z-popover)', width: `${width}px`,
    left: `${Math.max(box.left + 8, Math.min(x, box.right - width - 8))}px`,
    top: `${Math.max(box.top + 8, Math.min(y - 48, box.bottom - 48))}px`,
  });
  (container ?? doc.body).append(mount);
  const root = createRoot(mount);
  return new Promise(resolve => {
    const finish = (saved: boolean) => {
      const hadFocus = mount.contains(doc.activeElement);
      editors.delete(doc);
      clearTimeout(timer);
      doc.removeEventListener('pointerdown', outside, true);
      guest.removeEventListener('did-start-loading', cancel);
      root.unmount();
      mount.remove();
      if (hadFocus && guest.isConnected) guest.focus();
      resolve(saved);
    };
    const cancel = () => finish(false);
    const outside = (event: PointerEvent) => { if (!event.composedPath().includes(mount)) cancel(); };
    const timer = setTimeout(cancel, timeout);
    editors.set(doc, cancel);
    doc.addEventListener('pointerdown', outside, true);
    guest.addEventListener('did-start-loading', cancel);
    root.render(<AnnotationEditor number={editing?.number ?? draft.nextAnnotationNumber} initialValue={editing?.annotation}
      onCancel={cancel} onRemove={editing ? () => { draft.remove(editing.id); finish(true); } : undefined}
      onSave={annotation => {
        if (editing) draft.update(editing.id, annotation);
        else if ('selection' in open) draft.add({ kind: 'file', path, ...open.selection, annotation });
        finish(true);
      }} />);
  });
}
