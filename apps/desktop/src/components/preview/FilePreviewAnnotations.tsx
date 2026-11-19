import { observer } from 'mobx-react-lite';
import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';
import { AnnotationEditor } from '@renderer/features/sessions/annotations/annotation-editor';
import { sessionAnnotations } from '@renderer/features/sessions/annotations/session-annotations';
import type { FileTextRange } from './file-text-range';

export type FileAnnotationContext = { sessionId: string; path: string };
export type AnnotatedRange = { range: Range; quote: FileTextRange };

/** File comments are saved to the conversation; changing one means deleting it and selecting again. */
export const FilePreviewAnnotations = observer(function FilePreviewAnnotations({ context, root, selection, onClose }: {
  context: FileAnnotationContext;
  root: RefObject<HTMLDivElement | null>;
  selection: AnnotatedRange | null;
  onClose: () => void;
}) {
  const draft = sessionAnnotations.forSession(context.sessionId);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !selection) { setPosition(null); return; }
    const layout = () => {
      const rootBox = element.getBoundingClientRect();
      const scale = element.offsetWidth ? rootBox.width / element.offsetWidth : 1;
      if (!scale) return;
      const rect = selection.range.getClientRects()[0] ?? selection.range.getBoundingClientRect();
      setPosition({ '--file-annotation-x': `${(rect.left - rootBox.left) / scale}px`,
        '--file-annotation-y': `${(rect.top - rootBox.top) / scale}px` } as CSSProperties);
    };
    layout();
    const resize = new ResizeObserver(layout);
    resize.observe(element);
    return () => resize.disconnect();
  }, [root, selection]);
  if (!selection || !position) return null;
  return <div data-occludes-browser-page className="gg-file-annotation-editor absolute z-[2] w-80 max-w-[calc(100%_-_16px)]" style={position}>
    <AnnotationEditor number={draft.nextAnnotationNumber} onCancel={onClose} onSave={annotation => {
      draft.add({ kind: 'file', path: context.path, ...selection.quote, annotation });
      onClose();
    }} />
  </div>;
});
