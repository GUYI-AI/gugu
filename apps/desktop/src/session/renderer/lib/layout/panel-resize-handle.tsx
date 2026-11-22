import { motion, type MotionValue } from 'framer-motion';
import { useRef } from 'react';
import { cn } from '@renderer/utils/utils';

/**
 * 拖分隔条到目标宽度的一半以下就判定为"收起"(Codex 同款:它的 `min * 0.5`)。
 * 比"拖到 0 才算收起"好用得多 —— 手不用拖到底,而且松手位置离阈值远,不会误判。
 */
export const PANEL_SNAP_RATIO = 0.5;

/** 键盘调宽的步长:会话页的边与分栏的分界线(TrackCut)同一档,纯键盘用户也调得动。 */
export const KEYBOARD_STEP_PX = 16;
/** 命中带宽度(px)。视觉上的那条发丝线由面板自己的边框画,这一条只负责"抓得住"。 */
const HIT_STRIP_PX = 4;

/** 骑在面板右边界上:把手中线对准面板边缘,两侧各分一半命中带。把手和它的拖拽守卫共用这一份几何。 */
function stripStyle(offset: MotionValue<number>) {
  // Moved by transform: ❌ left, which lays the strip out again in every frame of a fold.
  return { width: HIT_STRIP_PX, left: 0, x: offset, marginLeft: -HIT_STRIP_PX / 2 };
}

interface PanelResizeHandleProps {
  /** 面板此刻的**占位**宽 —— 把手骑在这条边界上,所以它和面板是一起动的。 */
  offset: MotionValue<number>;
  /** 面板当前的目标宽(px)。拖拽以它为基准,而不是读 DOM —— 读 DOM 会读到动画中的中间值。 */
  getSize: () => number;
  minSize: number;
  maxSize: () => number;
  /** 拖拽过程中每一帧的新宽度(已 clamp)。 */
  onSize: (size: number) => void;
  /** 松手:最终宽度,调用方负责持久化。拖不收起,拖到 minSize 就停住(收起有各自的钮,或 `follow`)。 */
  onSizeCommit: (size: number) => void;
  onDraggingChange?: (dragging: boolean) => void;
  /**
   * #2548 a panel that collapses to a rail instead of away: no collapse threshold mid-drag. Every move hands over the raw
   * size the pointer asks for (unclamped) and the caller makes the panel follow it; letting go hands over to the caller,
   * which snaps. The keyboard steps go the same way. Given, onSize / onCollapse / onSizeCommit are not called.
   */
  follow?: { onMove: (rawSize: number) => void; onRelease: () => void };
  ariaLabel: string;
  className?: string;
}

/**
 * 侧栏 / 工作区面板的拖拽分隔条。
 *
 * 分隔条只负责把指针位移翻译成宽度;宽度在屏上怎么走归 PanelTrack(panel-track.ts)。
 *
 * **它是脱离文档流的**(绝对定位骑在边界上),这一点是动效的一部分而不是写法偏好:留在流里的话,
 * 面板一开始收起它就整条消失,主区会先横跳一个把手宽再开始滑 —— 那一下正是"发虚"。
 * 写法是 `group absolute … cursor-col-resize`,可见的线只在 hover 时才出现。
 *
 * 收起成一列(#2548,`follow`)的面板:拖的时候整块跟手,松手才由调用方吸到近的那一态。
 */
export function PanelResizeHandle({
  offset,
  getSize,
  minSize,
  maxSize,
  onSize,
  onSizeCommit,
  onDraggingChange,
  follow,
  ariaLabel,
  className,
}: PanelResizeHandleProps) {
  const dragRef = useRef<{ pointerId: number; startX: number; startSize: number } | null>(null);

  const clampSize = (size: number) => Math.max(minSize, Math.min(maxSize(), size));

  const applyDelta = (deltaPx: number, startSize: number) => {
    const next = clampSize(startSize + deltaPx);
    onSize(next);
    return next;
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onDraggingChange?.(false);
    if (follow) {
      follow.onRelease();
      return;
    }
    onSizeCommit(clampSize(drag.startSize + event.clientX - drag.startX));
  };

  return (
    <motion.div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      tabIndex={0}
      data-panel-resize-handle=""
      className={cn(
        // 与面板同档 z-40,靠 DOM 序压过它:同档后挂载者在上。不抬的话骑在边界上的命中带
        // 有一半被面板盖住,能抓的只剩 2px。
        'absolute inset-y-0 z-40 cursor-col-resize outline-none transition-colors hover:bg-border/60',
        className
      )}
      style={stripStyle(offset)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startSize: getSize(),
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        onDraggingChange?.(true);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (follow) {
          follow.onMove(drag.startSize + event.clientX - drag.startX);
          return;
        }
        applyDelta(event.clientX - drag.startX, drag.startSize);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const delta = event.key === 'ArrowRight' ? KEYBOARD_STEP_PX : -KEYBOARD_STEP_PX;
        if (follow) {
          follow.onMove(getSize() + delta);
          follow.onRelease();
          return;
        }
        onSizeCommit(applyDelta(delta, getSize()));
      }}
    />
  );
}

/**
 * 把手的拖拽守卫:与把手同一块几何、no-drag,排在把手两侧的面板**后面**。
 *
 * 窗口拖拽区按文档顺序叠,后来的盖前面的。把手骑在边界上,排在右边那块面板前面;右边面板里压到把手的拖拽带
 * (页签条、会话页顶栏带)会把那半截盖成「拖窗口」,按下去拖走的是窗口(mac 原生指针实测)。守卫排在后面,
 * 它的 no-drag 压得住。它只管拖拽区:不可点(pointer-events:none,指针照旧落在把手上)、不进焦点和读屏顺序,
 * ❌ 把把手本身挪到面板后面(那样 Tab 和读屏会在整个主区之后才走到分隔条)。
 */
export function PanelResizeDragGuard({ offset }: { offset: MotionValue<number> }) {
  return (
    <motion.div
      aria-hidden
      data-panel-resize-drag-guard=""
      className="pointer-events-none absolute inset-y-0 [-webkit-app-region:no-drag]"
      style={stripStyle(offset)}
    />
  );
}
