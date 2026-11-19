import { createRoot } from 'react-dom/client';
import type { FileAnnotationAsk } from '@shared/extensions/file-annotation-draft';
import type { BrowserWebviewElement } from '@renderer/features/browser/browser-webview-types';
import { AnnotationEditor } from './annotation-editor';
import { sessionAnnotations } from './session-annotations';

const editors = new WeakMap<Document, () => void>();

export function openGuestFileAnnotation(guest: BrowserWebviewElement, container: HTMLElement | null, {
  sessionId, path, open,
}: FileAnnotationAsk, timeout: number): Promise<boolean> {
  const doc = guest.ownerDocument;
  const box = guest.getBoundingClientRect();
  const { rect, viewport } = open;
  const x = box.left + rect.x * box.width / viewport.width;
  const y = box.top + rect.y * box.height / viewport.height;
  if (!guest.isConnected || !box.width || !box.height || x > box.right || y > box.bottom ||
    x + rect.width * box.width / viewport.width < box.left || y + rect.height * box.height / viewport.height < box.top) return Promise.resolve(false);
  const draft = sessionAnnotations.forSession(sessionId);

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
    root.render(<AnnotationEditor number={draft.nextAnnotationNumber}
      onCancel={cancel}
      onSave={annotation => {
        draft.add({ kind: 'file', path, ...open.selection, annotation });
        finish(true);
      }} />);
  });
}
