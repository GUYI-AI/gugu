import type { DragEvent } from 'react';
import { getDraggedScreenContent, type DraggedScreenContent } from '@renderer/lib/drag-screen-content';
import { dropShapeOf, hideDropHighlight, showDropHighlight } from '@renderer/lib/drop-highlight';

/** 被拖的那条会话(左边一行、⋮⋮),项目一定在:挂父会话要在它所在的机器上做。 */
export type DraggedSessionRef = Extract<DraggedScreenContent, { kind: 'session' }>;

/**
 * 侧栏里接一条拖来的会话的那一处:会话行(挂到它下面)、「智能体」分区头(回到顶层)。
 * 正拖在这一处上、而且它收 = 共用的落点高亮移到它身上(@@@drop-highlight)。
 * 收不收由调用点的 `accepts` 说,❌ 收不了的也亮;dragover 不 preventDefault,浏览器就不给松手。
 */
export function sessionDropTarget(accepts: (dragged: DraggedSessionRef) => boolean, onDrop: (dragged: DraggedSessionRef) => void) {
  const taken = (event: DragEvent<HTMLElement>): DraggedSessionRef | null => {
    const dragged = getDraggedScreenContent(event.dataTransfer);
    if (dragged?.kind !== 'session') return null;
    return accepts(dragged) ? dragged : null;
  };
  return {
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!taken(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      showDropHighlight(dropShapeOf(event.currentTarget));
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hideDropHighlight();
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      hideDropHighlight();
      const dragged = taken(event);
      if (!dragged) return;
      event.preventDefault();
      onDrop(dragged);
    },
  };
}
