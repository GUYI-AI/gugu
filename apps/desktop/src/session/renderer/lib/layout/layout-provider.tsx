import {
  animate,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from 'framer-motion';
import { clampPaneWidth, definePaneWidth, readPaneWidth, writePaneWidth } from '@/lib/paneWidth';
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { useState } from 'react';
import { NAV_COLUMN_WIDTH } from '@/lib/uiRuler';
import { clamp01, PANEL_SNAP_RATIO, PANEL_SPRING } from './panel-motion';
import { setSidebarFold, sidebarFolds } from '@renderer/features/sidebar/sidebar-folds';

/** 侧栏宽度的边界与默认值。min 沿用改造前的 200px;max 取 Codex 同款 520。 */
export const SIDEBAR_MIN_WIDTH_PX = 200;
export const SIDEBAR_MAX_WIDTH_PX = 520;
export const SIDEBAR_DEFAULT_WIDTH_PX = NAV_COLUMN_WIDTH;

const SIDEBAR_PANE = definePaneWidth({ id: 'gugu.taskpage.sidebarWidth', initial: SIDEBAR_DEFAULT_WIDTH_PX, min: SIDEBAR_MIN_WIDTH_PX, max: SIDEBAR_MAX_WIDTH_PX });

export const clampSidebarWidth = (width: number): number => clampPaneWidth(SIDEBAR_PANE, width);

/**
 * GUYI-AI/gugu#2642 内层栏(打开一个群 / 项目时列表与正文之间那一列)的宽:拖它右边缘调。范围暂与左边列表同档,
 * 默认就是它一直以来写死的那个宽 —— 没拖过的人看到的与从前一样。宽度存自己的键,与列表各管各的。
 */
export const INNER_SIDEBAR_MIN_WIDTH_PX = 200;
export const INNER_SIDEBAR_MAX_WIDTH_PX = 520;
export const INNER_SIDEBAR_DEFAULT_WIDTH_PX = SIDEBAR_DEFAULT_WIDTH_PX;
/** 内层栏最多占这张卡片(内层栏 + 正文)宽的这个比例 —— 与列表占会话页的比例同一个口径,正文至少留六成。 */
export const INNER_SIDEBAR_MAX_SHARE = 0.4;
export const INNER_SIDEBAR_WIDTH_STORAGE_KEY = 'gugu.taskpage.innerSidebarWidth';
/** 内层栏旁边的正文少于这个宽(窄窗口)时,这一列自己收起(useInnerSidebarCrowded)。 */
export const INNER_SIDEBAR_BODY_MIN_PX = 480;
const INNER_SIDEBAR_PANE = definePaneWidth({ id: INNER_SIDEBAR_WIDTH_STORAGE_KEY, initial: INNER_SIDEBAR_DEFAULT_WIDTH_PX, min: INNER_SIDEBAR_MIN_WIDTH_PX, max: INNER_SIDEBAR_MAX_WIDTH_PX });

export const clampInnerSidebarWidth = (width: number): number => clampPaneWidth(INNER_SIDEBAR_PANE, width);

/**
 * 内层栏此刻最宽能到哪:卡片宽(会话页宽 − 列表占位宽)的 INNER_SIDEBAR_MAX_SHARE,不过硬上限;`null` = 还没量到,只有硬上限。
 * 默认宽永远放得下(❌ 低于它):窗口再窄,这一列也不比从前更窄 —— 只有拖宽的那一截要给正文让路。
 */
export function innerSidebarMaxWidth(cardWidth: number | null): number {
  if (cardWidth == null) return INNER_SIDEBAR_MAX_WIDTH_PX;
  return Math.max(INNER_SIDEBAR_DEFAULT_WIDTH_PX, Math.min(INNER_SIDEBAR_MAX_WIDTH_PX, cardWidth * INNER_SIDEBAR_MAX_SHARE));
}

/**
 * 内层栏画出来的宽:用户选定的宽,夹进此刻放得下的范围。窗口变窄、列表拖宽时它跟着让(正文 ❌ 被挤没);
 * 选定的宽照旧存着,地方回来了它就回来。
 */
export function innerSidebarShownWidth(width: number, cardWidth: number | null): number {
  return Math.max(INNER_SIDEBAR_MIN_WIDTH_PX, Math.min(innerSidebarMaxWidth(cardWidth), width));
}

/**
 * #2548 the list collapses to a rail of its avatars, this wide: the list's gutter (12) + row padding (8) + avatar (32) + the
 * same 8 + 12 on the other side, so every avatar sits on its middle (x = 36) without moving. The rail is always there, so the
 * list never goes away and there is no hover preview of it.
 */
export const SIDEBAR_RAIL_PX = 72;

/** 侧栏占位宽:收起宽 + 进度 × (宽 − 收起宽);#2548 收起宽就是那一列头像。 */
export function sidebarOccupiedWidth(progress: number, width: number, rail: number): number {
  return rail + clamp01(progress) * (width - rail);
}

/**
 * The width the list is drawn and laid out at: its occupied width, landed on an end once it is within SIDEBAR_LANDED_PX of it.
 * The spring's sub-pixel tail (~130 ms) then moves nothing: the page beside it is not re-laid out for a fraction of a pixel.
 */
export function sidebarDrawnWidth(progress: number, width: number, rail: number): number {
  const occupied = sidebarOccupiedWidth(progress, width, rail);
  return occupied - rail < SIDEBAR_LANDED_PX ? rail : width - occupied < SIDEBAR_LANDED_PX ? width : occupied;
}

/**
 * #2548 收起成一列头像时,侧栏里文字(名字、预览、时间、搜索、分区头)的不透明度,由开合的同一条进度推出:
 * 只在进度的后一半里有字 —— 收起时字在前一半淡出,展开时在后一半淡入(一个式子两个方向都对)。
 */
export function sidebarRailTextOpacity(progress: number): number {
  return clamp01(2 * progress - 1);
}

/**
 * A fold has landed once its drawn edge is this close to where it goes. The rail layout switches there, ❌ at the spring's
 * formal rest: its sub-pixel tail ran on ~130 ms after the motion looked done, and the switch
 * landed as a late snap.
 */
export const SIDEBAR_LANDED_PX = 0.5;

/**
 * The rows are laid out as the rail (the count on the avatar's corner) only once the edge has landed on it: the last frame
 * of a collapse, the first of an expand. The flip is one restyle of the counts; ❌ mid-motion (it was at 0.45), where it was
 * a long frame inside the spring. The text (sidebarRailTextOpacity) is invisible there, so the names never jump; the corner
 * count fades in when it takes its place (left-sidebar).
 */
export function sidebarRailLayout(drawnWidth: number): boolean {
  return drawnWidth - SIDEBAR_RAIL_PX < SIDEBAR_LANDED_PX;
}

/**
 * #2548 dragging the edge of a sidebar that collapses to a rail: the sidebar follows the pointer, no threshold mid-drag.
 * At or above the minimum width it is a resize (progress 1). Below it the width rests at the minimum and the progress
 * carries the rest, so the occupied width is still where the pointer is, and the text fades with it as in a click
 * collapse. Continuous at the minimum (progress 1 on both sides).
 */
export function sidebarEdgeDrag(
  rawWidth: number,
  bounds: { rail: number; min: number; max: number }
): { width: number; progress: number } {
  const { rail, min, max } = bounds;
  if (rawWidth >= min) return { width: Math.max(min, Math.min(max, rawWidth)), progress: 1 };
  return { width: min, progress: min > rail ? clamp01((rawWidth - rail) / (min - rail)) : 0 };
}

/** Letting go snaps to the nearer state: expanded from half the way between the rail and the minimum width up. */
export function sidebarEdgeSnapsOpen(progress: number): boolean {
  return progress >= PANEL_SNAP_RATIO;
}

export interface WorkspaceLayoutContextValue {
  isLeftOpen: boolean;
  /** 用户选定的侧栏宽(px)。收起动画期间它**不变** —— 变的是下面那个。 */
  leftWidth: MotionValue<number>;
  /** 开合进度 0→1,由弹簧驱动。 */
  leftProgress: MotionValue<number>;
  /**
   * 侧栏此刻画出来的宽 = 收起宽 + 进度 × (宽 − 收起宽)。它也是侧栏在布局里占的宽(主区宽是「剩下的」):收起和展开
   * 都由这一个弹簧逐帧推出,两个方向的布局在同一时刻变 —— ❌ 按方向在动画开头或落定时一次性切。
   */
  leftAnimatedWidth: MotionValue<number>;
  /** 会话页根元素。 */
  workspaceRootRef: RefObject<HTMLDivElement | null>;
  setLeftWidth: (width: number, options?: { persist?: boolean }) => void;
  setCollapsed: (side: 'left', collapsed: boolean) => void;
  toggleLeft: () => void;
  /**
   * #2548 rail only: the edge is being dragged; `rawWidth` is where the pointer puts it (unclamped), `maxWidth` the
   * page's cap. The sidebar follows (sidebarEdgeDrag); open / collapsed does not change until the release.
   */
  dragLeftEdge: (rawWidth: number, maxWidth: number) => void;
  /** #2548 rail only: let go of the edge. Snaps to the nearer state (sidebarEdgeSnapsOpen) with the collapse spring. */
  releaseLeftEdge: () => void;
  /** 会话页根元素此刻的宽(px),WorkspaceLayout 量;0 = 还没量到。 */
  workspaceWidth: MotionValue<number>;
  /** #2642 用户选定的内层栏宽(px,存着的那个)。 */
  innerWidth: MotionValue<number>;
  /** #2642 内层栏此刻画出来的宽:选定的宽夹进这张卡片此刻放得下的范围(innerSidebarShownWidth)。这一列与它右边的分隔条都读它。 */
  innerShownWidth: MotionValue<number>;
  setInnerWidth: (width: number, options?: { persist?: boolean }) => void;
  /** #2642 内层栏此刻画着(这一列挂上 / 卸下时自己报,useInnerSidebarFrame):它右边那根分隔条只在这时才有。 */
  innerSidebarShown: boolean;
  /** 这一列挂上时登记一次,返回的函数在卸下时注销(按次数记:换对话时新旧两列的挂卸先后不影响结果)。 */
  registerInnerSidebarFrame: () => () => void;
  exitZenMode: () => void;
  toggleZenMode: (rightSidebar?: {
    isCollapsed: boolean;
    setCollapsed: (collapsed: boolean) => void;
  }) => void;
}

const WorkspaceLayoutContext = createContext<WorkspaceLayoutContextValue | undefined>(undefined);

/**
 * 会话页外层布局(左侧栏 ↔ 主区)的状态与动效来源。
 *
 * 改造前这里托管的是 react-resizable-panels 的 panel ref,折叠 = 一次瞬间的 flex-grow 改写,
 * 没有可插入过渡的量 —— product spec 那条「尺寸变化必须过渡:面板展开/收缩
 * 不允许瞬跳」在会话页一直是破的。现在宽度由 motion value 持有:
 *
 *     侧栏占位宽 = 进度(弹簧 0→1) × 用户选定宽
 *     主区宽     = 剩下的(flex-1)
 *
 * 于是"面板宽度"和"顶栏让位"读的是同一个数,不存在两条过渡各跑各的。详见 panel-motion.ts。
 *
 * ⚠️ 顺带退掉了 `released-sidebar-collapse`:那是给 #3904「窄宽度自动折叠」擦屁股的一次性放开,
 * 它擦的是 `react-resizable-panels:workspace-outer` 这个键。外层分栏组没了,那个键也随之作废,
 * 新的宽度键有自己的默认值,再也不会有"折了回不来"。
 */
export function useWorkspaceLayoutService(): WorkspaceLayoutContextValue {
  // Expanded until the user folds it (#2548 「默认展开」); the fold is stored with the sidebar's snapshot (sidebar-folds) and
  // the width under SIDEBAR_PANE, so a restart comes back as it was left.
  const [isLeftOpen, setIsLeftOpen] = useState(() => !sidebarFolds.has('left'));
  const prefersReducedMotion = useReducedMotion();
  const workspaceRootRef = useRef<HTMLDivElement | null>(null);

  const leftWidth = useMotionValue(readPaneWidth(SIDEBAR_PANE));
  const leftProgress = useMotionValue(isLeftOpen ? 1 : 0);
  const leftAnimatedWidth = useTransform([leftProgress, leftWidth], ([progress, width]: number[]) =>
    sidebarDrawnWidth(progress, width, SIDEBAR_RAIL_PX)
  );
  const runningAnimationRef = useRef<{ stop: () => void } | null>(null);
  /** An edge drag under way (rail only): the width it started from. */
  const edgeDragRef = useRef<{ startWidth: number } | null>(null);
  /**
   * A drag that snapped shut passed through the minimum width and left it there; the next open comes back at the width
   * the drag started from instead (nothing was stored, so the next start does too).
   */
  const restoreWidthRef = useRef<number | null>(null);

  const zenModeSnapshotRef = useRef<{
    leftOpen: boolean;
    rightCollapsed?: boolean;
    setRightCollapsed?: (collapsed: boolean) => void;
  } | null>(null);

  const setLeftWidth = useCallback(
    (width: number, options?: { persist?: boolean }) => {
      const next = clampSidebarWidth(width);
      leftWidth.set(next);
      if (options?.persist) writePaneWidth(SIDEBAR_PANE, next);
    },
    [leftWidth]
  );

  const workspaceWidth = useMotionValue(0);
  const innerWidth = useMotionValue(
    readPaneWidth(INNER_SIDEBAR_PANE)
  );
  // 卡片宽 = 会话页宽 − 列表此刻占的宽(❌ 读用户选定宽)。
  const innerShownWidth = useTransform([innerWidth, leftAnimatedWidth, workspaceWidth], ([width, left, root]: number[]) =>
    innerSidebarShownWidth(width, root > 0 ? root - left : null)
  );
  const [innerSidebarFrames, setInnerSidebarFrames] = useState(0);
  const registerInnerSidebarFrame = useCallback(() => {
    setInnerSidebarFrames((count) => count + 1);
    return () => setInnerSidebarFrames((count) => count - 1);
  }, []);
  const setInnerWidth = useCallback(
    (width: number, options?: { persist?: boolean }) => {
      const next = clampInnerSidebarWidth(width);
      innerWidth.set(next);
      if (options?.persist) writePaneWidth(INNER_SIDEBAR_PANE, next);
    },
    [innerWidth]
  );

  const setCollapsed = useCallback(
    (_side: 'left', collapsed: boolean, options?: { passing?: boolean }) => {
      const open = !collapsed;
      // Zen mode folds the list for the moment and puts it back: that is not the user's layout.
      if (!options?.passing) setSidebarFold('left', collapsed);
      setIsLeftOpen(open);

      const target = open ? 1 : 0;
      runningAnimationRef.current?.stop();
      runningAnimationRef.current = null;
      const restore = open ? restoreWidthRef.current : null;
      if (restore != null) {
        // Re-based so the occupied width stays put if this lands mid-collapse; from the rail (progress 0) it is the same.
        restoreWidthRef.current = null;
        const occupied = leftAnimatedWidth.get();
        leftWidth.set(restore);
        leftProgress.set(restore > SIDEBAR_RAIL_PX ? clamp01((occupied - SIDEBAR_RAIL_PX) / (restore - SIDEBAR_RAIL_PX)) : target);
      }
      if (prefersReducedMotion) {
        leftProgress.set(target);
        return;
      }
      runningAnimationRef.current = animate(leftProgress, target, PANEL_SPRING);
    },
    [leftAnimatedWidth, leftProgress, leftWidth, prefersReducedMotion]
  );

  const toggleLeft = useCallback(() => {
    setCollapsed('left', isLeftOpen);
  }, [isLeftOpen, setCollapsed]);

  const dragLeftEdge = useCallback(
    (rawWidth: number, maxWidth: number) => {
      if (!edgeDragRef.current) {
        // Grabbing the edge mid-animation takes over from the spring.
        runningAnimationRef.current?.stop();
        runningAnimationRef.current = null;
        edgeDragRef.current = { startWidth: restoreWidthRef.current ?? leftWidth.get() };
      }
      const next = sidebarEdgeDrag(rawWidth, { rail: SIDEBAR_RAIL_PX, min: SIDEBAR_MIN_WIDTH_PX, max: Math.min(SIDEBAR_MAX_WIDTH_PX, maxWidth) });
      leftWidth.set(next.width);
      leftProgress.set(next.progress);
    },
    [leftProgress, leftWidth]
  );

  const releaseLeftEdge = useCallback(() => {
    const drag = edgeDragRef.current;
    // Pressed and let go without moving: nothing changed, nothing to snap (❌ reverse a collapse that is still running).
    if (!drag) return;
    edgeDragRef.current = null;
    if (sidebarEdgeSnapsOpen(leftProgress.get())) {
      restoreWidthRef.current = null;
      writePaneWidth(SIDEBAR_PANE, leftWidth.get());
      setCollapsed('left', false);
    } else {
      restoreWidthRef.current = drag.startWidth;
      setCollapsed('left', true);
    }
  }, [leftProgress, leftWidth, setCollapsed]);

  const exitZenMode = useCallback(() => {
    const snapshot = zenModeSnapshotRef.current;
    if (!snapshot) return;

    setCollapsed('left', !snapshot.leftOpen, { passing: true });
    if (snapshot.setRightCollapsed && snapshot.rightCollapsed !== undefined) {
      snapshot.setRightCollapsed(snapshot.rightCollapsed);
    }
    zenModeSnapshotRef.current = null;
  }, [setCollapsed]);

  const toggleZenMode = useCallback(
    (rightSidebar?: { isCollapsed: boolean; setCollapsed: (collapsed: boolean) => void }) => {
      if (zenModeSnapshotRef.current) {
        exitZenMode();
        return;
      }

      zenModeSnapshotRef.current = {
        leftOpen: isLeftOpen,
        rightCollapsed: rightSidebar?.isCollapsed,
        setRightCollapsed: rightSidebar?.setCollapsed,
      };
      setCollapsed('left', true, { passing: true });
      rightSidebar?.setCollapsed(true);
    },
    [exitZenMode, isLeftOpen, setCollapsed]
  );

  return {
    isLeftOpen,
    leftWidth,
    leftProgress,
    leftAnimatedWidth,
    workspaceRootRef,
    setLeftWidth,
    setCollapsed,
    toggleLeft,
    dragLeftEdge,
    releaseLeftEdge,
    workspaceWidth,
    innerWidth,
    innerShownWidth,
    setInnerWidth,
    innerSidebarShown: innerSidebarFrames > 0,
    registerInnerSidebarFrame,
    exitZenMode,
    toggleZenMode,
  };
}

/**
 * #2642 内层栏那一列自己用:它画出来的宽(motion value,拖分隔条时逐帧跟手、❌ 重渲染),并在它挂着的时候报给工作区 ——
 * 它右边那根分隔条只在这一列画着时才有。
 */
export function useInnerSidebarFrame(): MotionValue<number> {
  const { innerShownWidth, registerInnerSidebarFrame } = useWorkspaceLayoutContext();
  useLayoutEffect(registerInnerSidebarFrame, [registerInnerSidebarFrame]);
  return innerShownWidth;
}

/**
 * 内层栏此刻挤不下:卡片宽(会话页宽 − 列表占位宽)减去这一列画出来的宽,剩给正文的不到 INNER_SIDEBAR_BODY_MIN_PX。
 * 还没量到会话页宽时不算挤。只在翻转时重渲染。
 */
export function useInnerSidebarCrowded(): boolean {
  const { workspaceWidth, leftAnimatedWidth, innerShownWidth } = useWorkspaceLayoutContext();
  const read = () => {
    const root = workspaceWidth.get();
    return root > 0 && root - leftAnimatedWidth.get() - innerShownWidth.get() < INNER_SIDEBAR_BODY_MIN_PX;
  };
  const [crowded, setCrowded] = useState(read);
  const update = () => setCrowded(read());
  useMotionValueEvent(workspaceWidth, 'change', update);
  useMotionValueEvent(leftAnimatedWidth, 'change', update);
  useMotionValueEvent(innerShownWidth, 'change', update);
  return crowded;
}

/**
 * #2548 whether the rows are laid out as the rail right now (sidebarRailLayout of the drawn edge, so it follows a click
 * collapse and a drag alike). Re-renders only when it flips.
 */
export function useLeftRailLayout(): boolean {
  const { leftAnimatedWidth } = useWorkspaceLayoutContext();
  const [railLayout, setRailLayout] = useState(() => sidebarRailLayout(leftAnimatedWidth.get()));
  useMotionValueEvent(leftAnimatedWidth, 'change', (drawn) => setRailLayout(sidebarRailLayout(drawn)));
  return railLayout;
}

/**
 * #2548 an element of the sidebar that moves with its open/close progress (0 = the rail, 1 = expanded):
 * `follow` writes the element's own style for a progress, on mount and on every change. Each element is written on its own
 * (opacity, padding, a mask), ❌ a CSS variable on the content layer: a custom property inherits, so writing one there each
 * frame restyled every element under it (~37k with the rows mounted, 210–790 ms a frame), read or not.
 */
export function useSidebarProgressFollow<T extends HTMLElement>(
  follow: (element: T, progress: number, railLayout: boolean) => void
): RefObject<T | null> {
  // Outside a workspace layout (a page without one) the element is drawn expanded.
  const layout = useContext(WorkspaceLayoutContext);
  const leftProgress = layout?.leftProgress;
  const leftWidth = layout?.leftWidth;
  const ref = useRef<T | null>(null);
  const followRef = useRef(follow);
  followRef.current = follow;
  useLayoutEffect(() => {
    const write = () => {
      const progress = leftProgress ? clamp01(leftProgress.get()) : 1;
      // From the progress itself: the drawn width (a transform) is only recomputed later in the frame.
      const railLayout = !!leftWidth && sidebarRailLayout(sidebarOccupiedWidth(progress, leftWidth.get(), SIDEBAR_RAIL_PX));
      if (ref.current) followRef.current(ref.current, progress, railLayout);
    };
    write();
    return leftProgress?.on('change', write);
  }, [leftProgress, leftWidth]);
  return ref;
}

export function WorkspaceLayoutContextProvider({ children }: { children: ReactNode }) {
  const value = useWorkspaceLayoutService();
  return (
    <WorkspaceLayoutContext.Provider value={value}>{children}</WorkspaceLayoutContext.Provider>
  );
}

export function useWorkspaceLayoutContext() {
  const context = useContext(WorkspaceLayoutContext);
  if (!context) {
    throw new Error(
      'useWorkspaceLayoutContext must be used within a WorkspaceLayoutContextProvider'
    );
  }
  return context;
}
