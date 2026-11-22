import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { selectionWords, type FileSelectionAsk } from '@shared/extensions/file-selection';
import type { AnnotationConversation } from '@shared/browser-annotation';
import { selectionCite, type SelectionCite } from '@/components/preview/quote-preview-file';
import { citeIntoConversation, useSendSelection } from '@renderer/lib/editor/cite-into-conversation';
import { notify } from '@/lib/notices';
import { i18n } from '@/i18n';
import { AnnotationEditor } from './annotation-editor';

/**
 * A selection's Send line (file-selection.ts): the host's own box at the selection, where the person writes a line and
 * sends it with the selection's cite — whoever drew the menu (an App page's runtime, the host's text preview), only this
 * box sends. Drawn by the shell's layer (`FileSelectionLayer`), so it goes out the way typed words do; a press or a wheel
 * anywhere else dismisses it.
 */
type Line = { id: string; at: DOMRect; within: HTMLElement; container: HTMLElement | null; conversation: AnnotationConversation; cite: SelectionCite };
let lines: readonly Line[] = [];
const listeners = new Set<() => void>();
const changed = (next: readonly Line[]) => { lines = next; for (const listener of listeners) listener(); };
const failed = (error: unknown) => notify({ tier: 'error', title: error instanceof Error ? error.message : String(error) });

/** The Send line at `at` (this window's px), kept inside `within`; one per element. */
export function openSendLine(line: Omit<Line, 'id'>): void {
  changed([...lines.filter((current) => current.within !== line.within), { ...line, id: crypto.randomUUID() }]);
}

/** Cite or Send pressed on an App page's menu (the runtime drew it in `guest`): a draft, or the Send line at the selection. */
export function runFileSelection(guest: HTMLElement, container: HTMLElement | null, ask: FileSelectionAsk): void {
  const cite = selectionCite(ask.conversation, ask.file, ask.pick);
  if (ask.action === 'cite') { citeIntoConversation(ask.conversation, cite).catch(failed); return; }
  // The page's CSS px, scaled to the guest's box (its zoom and the window's included).
  const box = guest.getBoundingClientRect(), scale = box.width / ask.viewport.width;
  openSendLine({ at: new DOMRect(box.x + ask.rect.x * scale, box.y + ask.rect.y * scale, ask.rect.width * scale, ask.rect.height * scale), within: guest, container, conversation: ask.conversation, cite });
}

function close(line: Line): void {
  changed(lines.filter((current) => current !== line));
  line.within.focus();
}

/** The shell's layer for Send lines, in whichever window their selection is. */
export function FileSelectionLayer() {
  const shown = useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => lines);
  return <>{shown.map((line) => createPortal(<SendLine line={line} />, line.container ?? line.within.ownerDocument.body, line.id))}</>;
}

function SendLine({ line }: { line: Line }) {
  const send = useSendSelection();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const doc = line.within.ownerDocument;
    const outside = (event: Event) => { if (!(event.target as Element | null)?.closest?.('[data-file-selection-send]')) close(line); };
    doc.addEventListener('pointerdown', outside, true);
    doc.addEventListener('wheel', outside, true);
    return () => { doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('wheel', outside, true); };
  }, [line]);
  const box = line.within.getBoundingClientRect(), width = Math.min(320, Math.max(0, box.width - 16));
  const words = selectionWords(i18n.language);
  return <div data-occludes-browser-page data-file-selection-send className="gugu-skin fixed" style={{
    zIndex: 'var(--z-popover)', width,
    left: Math.max(box.left + 8, Math.min(line.at.left, box.right - width - 8)),
    top: Math.max(box.top + 8, Math.min(line.at.top - 48, box.bottom - 48)),
  }}>
    <AnnotationEditor words={{ placeholder: words.sendPlaceholder, submit: words.send }} busy={busy} onCancel={() => close(line)} onSave={(text) => {
      setBusy(true);
      send(line.conversation, line.cite, text).then(() => close(line), (error: unknown) => { setBusy(false); failed(error); });
    }} />
  </div>;
}
