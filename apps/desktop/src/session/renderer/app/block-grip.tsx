import { observer } from 'mobx-react-lite';
import type { DragEvent, ReactNode } from 'react';
import { ContextMenu } from '@/components/ui/Menu';
import { clearDraggedScreenContent, setDraggedScreenContent, type DraggedScreenContent } from '@renderer/lib/drag-screen-content';
import { dropShapeOf, hideDropHighlight, showDropHighlight } from '@renderer/lib/drop-highlight';
import { screenLayout, type WindowableContent } from './screen-layout';
import { IconButton } from '@/components/ui/IconButton';
import { X } from '@/lib/icons';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { closeScreenBlock, openInWindow, screenBlockElement, setBlockDropPreview } from './screen-layout-actions';

export const CloseSplitBlock = observer(function CloseSplitBlock({ blockId }: { blockId: string }) {
  const { translate } = useSessionMessages();
  if (screenLayout.order.length < 2) return null;
  const label = translate('screen.leaveSplit');
  return <IconButton size="sm" aria-label={label} title={label} onClick={() => closeScreenBlock(blockId)}><X /></IconButton>;
});

/**
 * 每块左上的把手(V2 小胶囊,照 iPadOS 26 窗口左上那颗):只在这屏分成几块时有,一块时没有 —— 只为挪动、拿走一块而在。
 * 它的样子只在这里和 index.css 的 .screen-block-grip:换样式只动这两处。
 * 按住拖:落在一块的边上 = 这一块挪过去;落在输入框上 = 插一枚 @(会话);拖到窗口外 = 单独成窗(会话、App);
 * 拖回内层侧栏(blockReturnDropTarget),或离开自己那块、松在哪儿都不收的地方 = 这一块从这屏拿走(取消并排);
 * 按 Esc 取消拖拽 = 什么都不变(@@@grip-drop-vs-cancel)。
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
      ref={stickyReveal}
      className="screen-block-grip"
      // ❌ 别 stopPropagation:React 19 会把原生 dragstart 停在根容器上,document 上开拖拽遮罩的那条(shieldNativeDrags)
      // 就听不到 —— 拖着 ⋮⋮ 经过网页(HTML 预览、浏览器页签、App 的页),指针一进去宿主就收不到移动。上面也没有别人接 dragstart。
      onDragStart={(event) => startBlockDrag(event, blockId, content)}
      onDragEnd={(event) => endBlockDrag(event, content)}
    >
      <i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" />
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

/**
 * @@@grip-sticky-reveal - 把手指着这一块的页头才显出来,但页头的空白是窗口拖拽区(app-region drag),那里页面收不到任何
 * 指针事件:只靠 :hover,指针从胶囊移向把手的半路就进了拖拽区,把手就没了(yangchichi 11-24)。所以一旦指到页头里收得到
 * 事件的东西(胶囊、按钮、把手)就挂上 data-grip-shown,直到页面看见一次落在这条页头之外的移动、指针离开窗口或窗口失焦
 * 才摘掉 —— 拖拽区里没有事件,半路也就没有什么能把它藏掉。
 */
function stickyReveal(grip: HTMLElement | null): (() => void) | undefined {
  const bar = grip?.closest<HTMLElement>('.session-tab-bar');
  if (!grip || !bar) return undefined;
  const doc = bar.ownerDocument;
  const view = doc.defaultView ?? window;
  const show = () => { bar.dataset.gripShown = ''; };
  const hide = () => { delete bar.dataset.gripShown; };
  const moved = (event: PointerEvent) => {
    if (!('gripShown' in bar.dataset)) return;
    const r = bar.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) hide();
  };
  const left = (event: PointerEvent) => { if (!event.relatedTarget) hide(); };
  bar.addEventListener('pointerover', show);
  doc.addEventListener('pointermove', moved, true);
  doc.addEventListener('pointerout', left, true);
  view.addEventListener('blur', hide);
  return () => {
    bar.removeEventListener('pointerover', show);
    doc.removeEventListener('pointermove', moved, true);
    doc.removeEventListener('pointerout', left, true);
    view.removeEventListener('blur', hide);
    hide();
  };
}

/**
 * 正被 ⋮⋮ 拖着的那一块。
 * @@@grip-drop-vs-cancel - 松手和按 Esc 取消,源上的 dragend 一模一样(都是 dropEffect none,拖拽中页面也收不到按键)。
 * 所以拖着 ⋮⋮ 时整页都收(dragover 一律 preventDefault):真松手一定在这页上触发一次 drop,取消则一次都没有。
 * 真落点照旧自己办(preventDefault / stopPropagation);一路冒到 document 还没人办的 drop = 松在了不收的地方。
 */
let blockDrag: { blockId: string; stop: () => void } | null = null;

/**
 * 拖完:有过一次 drop、或源上的 dragend 到了,哪个先到都收掉。落点把这一块挪走、拿走时 ⋮⋮ 跟着卸了,
 * 它的 dragend 就不会再来 —— 只等 dragend 会留下一条过期的「正在拖」。
 */
function finishBlockDrag(): void {
  blockDrag?.stop();
  blockDrag = null;
}

/**
 * 跟手的那张图是整块,❌ 只有页签条:会话卡和它展开的右侧栏是一个单位,一起浮起、一起落下(yangchichi 11-24)。
 * 活的页(网页、终端、App)拍不进拖拽图,所以画一张按比例的小图:块里每张卡片一格,第一格写这一块的名字。
 */
const GHOST_SCALE = 0.4;
function blockDragImage(blockId: string, title: string): HTMLElement | null {
  const block = screenBlockElement(blockId);
  if (!block) return null;
  const rect = block.getBoundingClientRect();
  const cards = [...block.ownerDocument.querySelectorAll<HTMLElement>('[data-chat-card], [data-chat-tool-card]')]
    .map((card) => card.getBoundingClientRect())
    .filter((card) => card.left >= rect.left - 1 && card.right <= rect.right + 1 && card.width > 0);
  const ghost = block.ownerDocument.createElement('div');
  ghost.className = 'screen-block-ghost';
  for (const card of cards.length ? cards : [rect]) {
    const cell = block.ownerDocument.createElement('div');
    Object.assign(cell.style, { width: `${card.width * GHOST_SCALE}px`, height: `${rect.height * GHOST_SCALE}px` });
    ghost.appendChild(cell);
  }
  ghost.firstElementChild!.textContent = title || block.querySelector('[data-chat-workspace-title]')?.textContent?.trim() || '';
  block.ownerDocument.body.appendChild(ghost);
  return ghost;
}

function startBlockDrag(event: DragEvent<HTMLElement>, blockId: string, content: DraggedScreenContent): void {
  setDraggedScreenContent(event.dataTransfer, content);
  const ghost = blockDragImage(blockId, content.title);
  if (ghost) {
    // 指针咬在小图左上那颗把手的位置,像拎着它走。
    event.dataTransfer.setDragImage(ghost, 32 * GHOST_SCALE + 4, 36 * GHOST_SCALE + 4);
    // 快照要等这一帧画完才能拆(同 drag-screen-content 的 makeDragImage)。
    requestAnimationFrame(() => ghost.remove());
  }
  const view = event.currentTarget.ownerDocument;
  const accept = (over: globalThis.DragEvent) => over.preventDefault();
  // 冒到 document 还没人办:松在了不收的地方。离开了自己那块才拿走它(在自己那块上松手 = 没挪)。
  const unclaimed = (drop: globalThis.DragEvent) => {
    if (drop.defaultPrevented) return;
    drop.preventDefault();
    const own = screenBlockElement(blockId)?.getBoundingClientRect();
    const stayed = own && drop.clientX >= own.left && drop.clientX <= own.right && drop.clientY >= own.top && drop.clientY <= own.bottom;
    if (!stayed && screenLayout.blocks.has(blockId)) closeScreenBlock(blockId);
  };
  // 捕获阶段先看到每一次 drop(落点会 stopPropagation);等这次分发走完、落点办完再收。
  const dropped = () => setTimeout(finishBlockDrag, 0);
  view.addEventListener('dragover', accept, true);
  view.addEventListener('drop', unclaimed);
  view.addEventListener('drop', dropped, true);
  blockDrag = {
    blockId,
    stop: () => {
      view.removeEventListener('dragover', accept, true);
      view.removeEventListener('drop', unclaimed);
      view.removeEventListener('drop', dropped, true);
    },
  };
}

const windowable = (content: DraggedScreenContent): content is DraggedScreenContent & WindowableContent =>
  content.kind === 'session' || content.kind === 'app';

/** 源上的 dragend:拖到窗口外 = 单独成窗;别的(落点办过了、松在不收的地方已经在 drop 里办了、Esc 取消)什么都不做。 */
function endBlockDrag(event: DragEvent<HTMLElement>, content: DraggedScreenContent): void {
  finishBlockDrag();
  clearDraggedScreenContent();
  setBlockDropPreview(null);
  if (droppedOutsideWindow(event) && windowable(content)) {
    openInWindow(content.kind === 'session' ? { kind: 'session', projectId: content.projectId, sessionId: content.sessionId } : { kind: 'app', tabKind: content.tabKind }, { screenX: event.screenX, screenY: event.screenY });
  }
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

