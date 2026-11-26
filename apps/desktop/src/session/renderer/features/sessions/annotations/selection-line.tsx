import { useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { AnnotationConversation } from '@shared/browser-annotation';
import { AnnotationEditor } from './annotation-editor';
import { sessionAnnotations, type FileAnnotationSelection, type MessageAnnotationSelection } from './session-annotations';

/**
 * The small box at a selection: the host's one input beside selected words — a message's, a file's — where the person
 * writes a comment, numbered as the conversation's draft's next; saved, it joins that draft and goes with the next send.
 * Drawn by the shell's layer (`SelectionLineLayer`), mounted once; a press or a wheel anywhere else dismisses it.
 */
type Line = { id: string; at: DOMRect; within: HTMLElement; container: HTMLElement | null; number: number; save: (text: string) => void };
let lines: readonly Line[] = [];
const listeners = new Set<() => void>();
const changed = (next: readonly Line[]) => { lines = next; for (const listener of listeners) listener(); };

/** A comment on part of a message or a file, at `at` (this window's px), kept inside `within`; one per element. */
export function openCommentLine(conversation: AnnotationConversation, at: DOMRect, within: HTMLElement,
  selection: Omit<MessageAnnotationSelection, 'annotation'> | Omit<FileAnnotationSelection, 'annotation'>, container: HTMLElement | null = null): void {
  const draft = sessionAnnotations.forConversation(conversation);
  changed([...lines.filter((current) => current.within !== within), { id: crypto.randomUUID(), at, within, container, number: draft.nextAnnotationNumber,
    save: (text) => { if (text) draft.add({ ...selection, annotation: text }); } }]);
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
    <AnnotationEditor number={line.number} onCancel={() => close(line)} onSave={(text) => { line.save(text); close(line); }} />
  </div>;
}
