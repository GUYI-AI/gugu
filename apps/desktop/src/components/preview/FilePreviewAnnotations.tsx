import { observer } from 'mobx-react-lite';
import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { AnnotationEditor, AnnotationMarker } from '@renderer/features/sessions/annotations/annotation-editor';
import { sessionAnnotations } from '@renderer/features/sessions/annotations/session-annotations';
import type { FileTextRange } from './file-text-range';

export type FileAnnotationContext = { sessionId: string; path: string };
export type AnnotatedRange = { range: Range; quote: FileTextRange };
type AnchorPoint = { x: number; y: number };

function anchorStyle({ x, y }: AnchorPoint): CSSProperties {
  return { '--file-annotation-x': `${x}px`, '--file-annotation-y': `${y}px` } as CSSProperties;
}

function anchorRect(range: Range): DOMRect {
  return range.getClientRects()[0] ?? range.getBoundingClientRect();
}

function sourceBlock(root: HTMLElement, line: number): Element | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-file-source-start]')).find(block =>
    Number(block.dataset.fileSourceStart) <= line && Number(block.dataset.fileSourceEnd) >= line);
}

/** Wraps the file using positions in the reading surface, so its numbered markers scroll with the text. */
export const FilePreviewAnnotations = observer(function FilePreviewAnnotations({
  context, root, selection, onClose,
}: {
  context: FileAnnotationContext;
  root: RefObject<HTMLDivElement | null>;
  selection: AnnotatedRange | null;
  onClose: () => void;
}) {
  const draft = sessionAnnotations.forSession(context.sessionId);
  const items = draft.items.filter(item => item.kind === 'file').filter(item => item.path === context.path);
  const retained = useRef(new Map<string, Range>());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [positions, setPositions] = useState<Record<string, AnchorPoint>>({});
  const editing = selection ? undefined : items.find(item => item.id === editingId);
  const point = selection ? positions.selection : editing && positions[editing.id];

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const layout = () => {
      const rootBox = element.getBoundingClientRect();
      const scale = element.offsetWidth ? rootBox.width / element.offsetWidth : 1;
      if (!scale) return;
      const anchor = (rect: DOMRect) => ({ x: (rect.left - rootBox.left) / scale, y: (rect.top - rootBox.top) / scale });
      const next: Record<string, AnchorPoint> = {};
      for (const item of items) {
        const range = retained.current.get(item.id);
        const rect = range && element.contains(range.startContainer) && element.contains(range.endContainer)
          ? anchorRect(range) : sourceBlock(element, item.startLine)?.getBoundingClientRect();
        if (rect) next[item.id] = anchor(rect);
      }
      if (selection) next.selection = anchor(anchorRect(selection.range));
      setPositions(previous => Object.keys(previous).length === Object.keys(next).length &&
        Object.entries(next).every(([id, point]) => previous[id]?.x === point.x && previous[id]?.y === point.y) ? previous : next);
    };
    for (const id of retained.current.keys()) if (!items.some(item => item.id === id)) retained.current.delete(id);
    layout();
    const resize = new ResizeObserver(layout);
    resize.observe(element);
    return () => resize.disconnect();
  }, [root, items, selection]);

  const close = () => { setEditingId(null); onClose(); };
  return <>
    {items.map(item => {
      const position = positions[item.id];
      if (!position) return null;
      return <AnnotationMarker key={item.id} number={item.number} className="gg-file-annotation-marker absolute z-[1]" style={anchorStyle(position)}
        onClick={() => { onClose(); setEditingId(item.id); }} />;
    })}
    {point && <div data-occludes-browser-page className="gg-file-annotation-editor absolute z-[2] w-80 max-w-[calc(100%_-_16px)]" style={anchorStyle(point)}>
      <AnnotationEditor key={editing?.id ?? 'new'} number={editing?.number ?? draft.nextAnnotationNumber}
        initialValue={editing?.annotation} onCancel={close}
        onRemove={editing ? () => { draft.remove(editing.id); close(); } : undefined}
        onSave={value => {
          if (editing) draft.update(editing.id, value);
          else if (selection) {
            const item = draft.add({ kind: 'file', path: context.path, ...selection.quote, annotation: value });
            retained.current.set(item.id, selection.range);
          }
          close();
        }} />
    </div>}
  </>;
});
