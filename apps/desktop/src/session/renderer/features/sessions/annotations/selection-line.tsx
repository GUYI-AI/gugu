import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { notify } from '@/lib/notices';
import { useSendSelection } from '@renderer/lib/editor/cite-into-conversation';
import { AnnotationEditor } from './annotation-editor';

/**
 * The small box at a selection: the host's one input beside selected words — a message's, a file's — where the person
 * writes a line. What the line does is the opener's (`save`): a comment joins its conversation's draft, a file's Send goes
 * out at once (through `send`, the way typed words go). Drawn by the shell's layer (`SelectionLineLayer`), mounted once;
 * a press or a wheel anywhere else dismisses it.
 */
type Line = {
  id: string; at: DOMRect; within: HTMLElement; container: HTMLElement | null;
  number?: number; words?: { placeholder: string; submit: string };
  save: (text: string, send: ReturnType<typeof useSendSelection>) => Promise<void> | void;
};
let lines: readonly Line[] = [];
const listeners = new Set<() => void>();
const changed = (next: readonly Line[]) => { lines = next; for (const listener of listeners) listener(); };
const failed = (error: unknown) => notify({ tier: 'error', title: error instanceof Error ? error.message : String(error) });

/** The line at `at` (this window's px), kept inside `within`; one per element. */
export function openSelectionLine(line: Omit<Line, 'id'>): void {
  changed([...lines.filter((current) => current.within !== line.within), { ...line, id: crypto.randomUUID() }]);
}

function close(line: Line): void {
  changed(lines.filter((current) => current !== line));
  line.within.focus();
}

/** The shell's layer for selection lines, in whichever window their selection is. */
export function SelectionLineLayer() {
  const shown = useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => lines);
  return <>{shown.map((line) => createPortal(<SelectionLine line={line} />, line.container ?? line.within.ownerDocument.body, line.id))}</>;
}

function SelectionLine({ line }: { line: Line }) {
  const send = useSendSelection();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const doc = line.within.ownerDocument;
    const outside = (event: Event) => { if (!(event.target as Element | null)?.closest?.('[data-selection-line]')) close(line); };
    doc.addEventListener('pointerdown', outside, true);
    doc.addEventListener('wheel', outside, true);
    return () => { doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('wheel', outside, true); };
  }, [line]);
  const box = line.within.getBoundingClientRect(), width = Math.min(320, Math.max(0, box.width - 16));
  return <div data-occludes-browser-page data-selection-line className="gugu-skin fixed" style={{
    zIndex: 'var(--z-popover)', width,
    left: Math.max(box.left + 8, Math.min(line.at.left, box.right - width - 8)),
    top: Math.max(box.top + 8, Math.min(line.at.top - 48, box.bottom - 48)),
  }}>
    <AnnotationEditor number={line.number} words={line.words} busy={busy} onCancel={() => close(line)} onSave={(text) => {
      setBusy(true);
      Promise.resolve(line.save(text, send)).then(() => close(line), (error: unknown) => { setBusy(false); failed(error); });
    }} />
  </div>;
}
