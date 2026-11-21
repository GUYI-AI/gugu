import type { DragEvent } from 'react';
import { getDraggedScreenContent, type DraggedScreenContent } from '@renderer/lib/drag-screen-content';
import { dropShapeOf, hideDropHighlight, showDropHighlight } from '@renderer/lib/drop-highlight';

/** 被拖的那条会话(左边一行、⋮⋮),项目一定在:挂父会话要在它所在的机器上做。 */
export type DraggedSessionRef = Extract<DraggedScreenContent, { kind: 'session' }>;

/**
 * 收不收:`true` 收;一句话 = 不收,而且要让人看见为什么(会成环、已经挂在这);`false` = 不收也不说(拖到它自己上、不相干的落点)。
 */
export type DropVerdict = boolean | string;

/**
 * 接一条拖来的会话的那一处:侧栏会话行与通讯录导图节点(挂到它下面)、「智能体」分区头与导图空白处(回到顶层)。
 * 正拖在这一处上 = 共用的落点高亮移到它身上(@@@drop-highlight):收就是那个框;不收而有原因,框变红、原因写在框下,
 * 光标是「不能放」(dropEffect none:dragover 照样 preventDefault 才能定光标,松手浏览器不给 drop)。
 */
export function sessionDropTarget(accepts: (dragged: DraggedSessionRef) => DropVerdict, onDrop: (dragged: DraggedSessionRef) => void) {
  const judged = (event: DragEvent<HTMLElement>) => {
    const dragged = getDraggedScreenContent(event.dataTransfer);
    return dragged?.kind === 'session' ? { dragged, verdict: accepts(dragged) } : null;
  };
  return {
    onDragOver: (event: DragEvent<HTMLElement>) => {
      const judgement = judged(event);
      if (!judgement || judgement.verdict === false) return;
      event.preventDefault();
      const refused = judgement.verdict === true ? undefined : judgement.verdict;
      event.dataTransfer.dropEffect = refused ? 'none' : 'move';
      showDropHighlight({ ...dropShapeOf(event.currentTarget), refused });
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hideDropHighlight();
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      hideDropHighlight();
      const judgement = judged(event);
      if (judgement?.verdict !== true) return;
      event.preventDefault();
      onDrop(judgement.dragged);
    },
  };
}
