import { observer } from 'mobx-react-lite';
import type { DragEvent, ReactNode } from 'react';
import { ContextMenu } from '@/components/ui/Menu';
import { clearDraggedScreenContent, setDraggedScreenContent, type DraggedScreenContent } from '@renderer/lib/drag-screen-content';
import { dropShapeOf, hideDropHighlight, showDropHighlight } from '@renderer/lib/drop-highlight';
import { screenLayout, type WindowableContent } from './screen-layout';
import { closeScreenBlock, openInWindow, screenBlockElement, setBlockDropPreview } from './screen-layout-actions';

/**
 * 每块页签条最左的 ⋮⋮(照 Zen 分屏块的拖柄):只在这屏分成几块时有,一块时没有 —— 只为挪动、拿走一块而在。
 * 它的样子只在这里和 index.css 的 .screen-block-grip:换样式只动这两处。
 * 按住拖:落在一块的边上 = 这一块挪过去;落在输入框上 = 插一枚 @(会话);拖到窗口外 = 单独成窗(会话、App);
 * 拖回内层侧栏(blockReturnDropTarget),或离开自己那块、松在哪儿都不收的地方 = 这一块从这屏拿走(取消并排)。
 * 右键菜单由调用点给。不在这屏上的块(单独成窗的会话页)没有它。
 */
export const BlockGrip = observer(function BlockGrip({
  blockId,
  content,
  label,
  menu,
}: {
  blockId: string | null;
  content: DraggedScreenContent;
  label: string;
  menu?: ReactNode;
}) {
  if (!blockId || screenLayout.order.length <= 1 || !screenLayout.blocks.has(blockId)) return null;
  const grip = (
    <span
      role="button"
      tabIndex={0}
      draggable
      aria-label={label}
      title={label}
      data-block-grip=""
      className="screen-block-grip"
      // ❌ 别 stopPropagation:React 19 会把原生 dragstart 停在根容器上,document 上开拖拽遮罩的那条(shieldNativeDrags)
      // 就听不到 —— 拖着 ⋮⋮ 经过网页(HTML 预览、浏览器页签、App 的页),指针一进去宿主就收不到移动。上面也没有别人接 dragstart。
      onDragStart={(event) => startBlockDrag(event, blockId, content)}
      onDragEnd={(event) => endBlockDrag(event, blockId, content)}
    >
      <span className="screen-block-grip-lines" aria-hidden="true" />
    </span>
  );
  if (!menu) return grip;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger className="flex h-full items-center">{grip}</ContextMenu.Trigger>
      <ContextMenu.Content finalFocus={false}>{menu}</ContextMenu.Content>
    </ContextMenu.Root>
  );
});

/** 正被 ⋮⋮ 拖着的那一块,和指针最后在窗口里的位置(dragend 的坐标各平台不可靠,拖的过程中记下来)。 */
let blockDrag: { blockId: string; x: number; y: number; stop: () => void } | null = null;

/**
 * 拖完:有落点接了(drop 先到)或源上的 dragend 到了,哪个先到都收掉。落点把这一块挪走、拿走时 ⋮⋮ 跟着卸了,
 * 它的 dragend 就不会再来 —— 只等 dragend 会留下一条过期的「正在拖」。
 */
function finishBlockDrag(): void {
  blockDrag?.stop();
  blockDrag = null;
}

function startBlockDrag(event: DragEvent<HTMLElement>, blockId: string, content: DraggedScreenContent): void {
  setDraggedScreenContent(event.dataTransfer, content, event.currentTarget.closest<HTMLElement>('.session-tab-bar'));
  const view = event.currentTarget.ownerDocument;
  const track = (over: globalThis.DragEvent) => {
    if (blockDrag) Object.assign(blockDrag, { x: over.clientX, y: over.clientY });
  };
  // 捕获阶段先看到每一次 drop(落点会 stopPropagation);等这次分发走完、落点办完再收。
  const dropped = () => setTimeout(finishBlockDrag, 0);
  view.addEventListener('dragover', track, true);
  view.addEventListener('drop', dropped, true);
  blockDrag = {
    blockId,
    x: event.clientX,
    y: event.clientY,
    stop: () => {
      view.removeEventListener('dragover', track, true);
      view.removeEventListener('drop', dropped, true);
    },
  };
}

const windowable = (content: DraggedScreenContent): content is DraggedScreenContent & WindowableContent =>
  content.kind === 'session' || content.kind === 'app';

function endBlockDrag(event: DragEvent<HTMLElement>, blockId: string, content: DraggedScreenContent): void {
  const drag = blockDrag;
  finishBlockDrag();
  clearDraggedScreenContent();
  setBlockDropPreview(null);
  if (droppedOutsideWindow(event)) {
    if (windowable(content)) openInWindow(content.kind === 'session' ? { kind: 'session', projectId: content.projectId, sessionId: content.sessionId } : { kind: 'app', tabKind: content.tabKind }, { screenX: event.screenX, screenY: event.screenY });
    return;
  }
  // 有落点接了(一块的边、输入框、内层侧栏):那边已经办了。没人接、指针又离开了自己那块 = 拿走这一块。
  if (event.dataTransfer.dropEffect !== 'none' || !drag) return;
  const own = screenBlockElement(blockId)?.getBoundingClientRect();
  const stayed = own && drag.x >= own.left && drag.x <= own.right && drag.y >= own.top && drag.y <= own.bottom;
  if (!stayed && screenLayout.blocks.has(blockId)) closeScreenBlock(blockId);
}

/** 内层侧栏接 ⋮⋮ 拖回来的那一块:松手 = 这一块从这屏拿走(取消并排)。别的拖拽照旧交给侧栏里的行。 */
export function blockReturnDropTarget() {
  return {
    onDragOverCapture: (event: DragEvent<HTMLElement>) => {
      if (!blockDrag) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      showDropHighlight(dropShapeOf(event.currentTarget));
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (blockDrag && !event.currentTarget.contains(event.relatedTarget as Node | null)) hideDropHighlight();
    },
    onDropCapture: (event: DragEvent<HTMLElement>) => {
      if (!blockDrag) return;
      event.preventDefault();
      event.stopPropagation();
      hideDropHighlight();
      const { blockId } = blockDrag;
      finishBlockDrag();
      if (screenLayout.blocks.has(blockId)) closeScreenBlock(blockId);
    },
  };
}

/**
 * 原生拖拽松手在窗口外:没有任何落点接(dropEffect 是 none),指针又在这扇窗的框外 —— 拖到窗口外 = 单独成窗。
 * 按屏幕坐标和这扇窗的框比(落在咕咕的另一扇窗上也算外面,那扇窗的落点会先接走,这里就不是 none)。
 */
export function droppedOutsideWindow(event: DragEvent<HTMLElement>): boolean {
  if (event.dataTransfer.dropEffect !== 'none') return false;
  const view = event.currentTarget.ownerDocument.defaultView ?? window;
  const { screenX, screenY } = event;
  return (
    screenX < view.screenX ||
    screenY < view.screenY ||
    screenX > view.screenX + view.outerWidth ||
    screenY > view.screenY + view.outerHeight
  );
}

