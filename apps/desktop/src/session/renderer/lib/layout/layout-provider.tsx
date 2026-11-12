import {
  animate,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from 'framer-motion';
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { useState } from 'react';
import { NAV_COLUMN_WIDTH } from '@/lib/uiRuler';
import { clamp01, PANEL_SNAP_RATIO, PANEL_SPRING } from './panel-motion';
import { useSidebarPeek } from './sidebar-peek';

/** 侧栏宽度的边界与默认值。min 沿用改造前的 200px;max 取 Codex 同款 520。 */
export const SIDEBAR_MIN_WIDTH_PX = 200;
export const SIDEBAR_MAX_WIDTH_PX = 520;
export const SIDEBAR_DEFAULT_WIDTH_PX = NAV_COLUMN_WIDTH;

const SIDEBAR_WIDTH_STORAGE_KEY = 'gugu.taskpage.sidebarWidth';

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH_PX;
  return Math.max(SIDEBAR_MIN_WIDTH_PX, Math.min(SIDEBAR_MAX_WIDTH_PX, width));
}

function readStoredSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (raw == null) return SIDEBAR_DEFAULT_WIDTH_PX;
    return clampSidebarWidth(Number.parseFloat(raw));
  } catch {
    return SIDEBAR_DEFAULT_WIDTH_PX;
  }
}

function writeStoredSidebarWidth(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    // 存储不可用:宽度这一项丢了就丢了,不该因此让侧栏用不了。
  }
}

/**
 * 侧栏占位宽:收起宽 + 进度 × (宽 − 收起宽)。收起宽 0 = 今天的 进度 × 宽(usePanelAnimatedSize);#2548 一个列表时收起成
 * 一列头像,收起宽就是那一列。
 */
export function sidebarOccupiedWidth(progress: number, width: number, rail: number): number {
  return rail + clamp01(progress) * (width - rail);
}

/**
 * #2548 收起成一列头像时,侧栏里文字(名字、预览、时间、搜索、分区头)的不透明度,由开合的同一条进度推出:
 * 只在进度的后一半里有字 —— 收起时字在前一半淡出,展开时在后一半淡入(一个式子两个方向都对)。
 */
export function sidebarRailTextOpacity(progress: number): number {
  return clamp01(2 * progress - 1);
}

/** 侧栏里文字跟着它淡入淡出的那个 CSS 变量(内容层上设,left-sidebar 里各段文字读)。 */
export const SIDEBAR_TEXT_OPACITY_VAR = '--gg-sidebar-text';

/**
 * #2548 the open/close progress itself (0 = the rail, 1 = expanded), as a CSS variable on the content layer: geometry that
 * has to move with everything else (the 「+」 sliding onto the avatars' axis, 创建智能体 narrowing) reads it. No rail = 1.
 */
export const SIDEBAR_PROGRESS_VAR = '--gg-sidebar-progress';

/**
 * #2548 on the rail a row's unread count sits on the avatar's top-right corner. It fades in near the end of collapsing
 * (mock v18: 快到头时头像右上角的数字淡入) and out first when expanding: the mirror of the text, offset so that the two
 * are both 0 around SIDEBAR_RAIL_LAYOUT_BELOW, where the count changes place.
 */
export function sidebarRailBadgeOpacity(progress: number): number {
  return clamp01((0.4 - progress) * 3);
}

/** The CSS variable the rail's corner badge reads (same layer as the text one). */
export const SIDEBAR_BADGE_OPACITY_VAR = '--gg-sidebar-badge';

/**
 * Below this progress the rows are laid out as the rail (the count on the avatar's corner, row bodies inert). The text
 * (sidebarRailTextOpacity) and the corner badge (sidebarRailBadgeOpacity) are both invisible around it, so the switch
 * between the two places is never seen: nothing jumps when collapsing starts.
 */
export const SIDEBAR_RAIL_LAYOUT_BELOW = 0.45;

export function sidebarRailLayout(progress: number): boolean {
  return progress < SIDEBAR_RAIL_LAYOUT_BELOW;
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
  /** 侧栏收起后指针停在左缘/开关钮上,浮出的那一份预览。 */
  isLeftPeeking: boolean;
  /** 用户选定的侧栏宽(px)。收起动画期间它**不变** —— 变的是下面那个。 */
  leftWidth: MotionValue<number>;
  /** 开合进度 0→1,由弹簧驱动。 */
  leftProgress: MotionValue<number>;
  /** 侧栏实际占位宽 = 收起宽 + 进度 × (宽 − 收起宽)。主区宽是"剩下的",所以两者永远同步。 */
  leftAnimatedWidth: MotionValue<number>;
  /**
   * GUYI-AI/gugu#2548 收起时留下的那一列宽(px):0 = 收起就整列让开(今天);>0 = 侧栏是一个列表时,收起成这么宽的一列头像
   * (内容不动,文字藏起来,见 left-sidebar)。这一列一直在,所以没有浮出预览。
   */
  leftRail: number;
  /** 同一个数,给动画里的变换读(useTransform 的输入得是 motion value)。 */
  leftRailWidth: MotionValue<number>;
  setLeftRail: (px: number) => void;
  /** 会话页根元素 —— 浮出预览要按它的左缘算,不是窗口。 */
  workspaceRootRef: RefObject<HTMLDivElement | null>;
  setLeftWidth: (width: number, options?: { persist?: boolean }) => void;
  setCollapsed: (
    side: 'left',
    collapsed: boolean,
    options?: {
      /** 这次收起是用户点按钮触发的:在指针离开之前压住 hover 唤出,否则会立刻回弹。 */
      suppressPeek?: boolean;
    }
  ) => void;
  toggleLeft: () => void;
  /**
   * #2548 rail only: the edge is being dragged; `rawWidth` is where the pointer puts it (unclamped), `maxWidth` the
   * page's cap. The sidebar follows (sidebarEdgeDrag); open / collapsed does not change until the release.
   */
  dragLeftEdge: (rawWidth: number, maxWidth: number) => void;
  /** #2548 rail only: let go of the edge. Snaps to the nearer state (sidebarEdgeSnapsOpen) with the collapse spring. */
  releaseLeftEdge: () => void;
  /** 开关按钮把自己的悬停状态报进来:悬停满 100ms 也会浮出侧栏。 */
  setTriggerHovered: (hovered: boolean) => void;
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
  // Starts expanded (#2548 「默认展开」). Open / collapsed is not stored, only the width is (SIDEBAR_WIDTH_STORAGE_KEY):
  // every start is expanded, and a stored width still wins over the default width.
  const [isLeftOpen, setIsLeftOpen] = useState(true);
  const prefersReducedMotion = useReducedMotion();
  const workspaceRootRef = useRef<HTMLDivElement | null>(null);

  const leftWidth = useMotionValue(readStoredSidebarWidth());
  const leftProgress = useMotionValue(1);
  const [leftRail, setLeftRailState] = useState(0);
  const leftRailWidth = useMotionValue(0);
  const setLeftRail = useCallback((px: number) => {
    leftRailWidth.set(px);
    setLeftRailState(px);
  }, [leftRailWidth]);
  const leftAnimatedWidth = useTransform([leftProgress, leftWidth, leftRailWidth], ([progress, width, rail]: number[]) =>
    sidebarOccupiedWidth(progress, width, rail)
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

  const peek = useSidebarPeek({
    // A rail never goes away, so there is nothing to peek at.
    isLeftOpen: isLeftOpen || leftRail > 0,
    rootRef: workspaceRootRef,
    getProgress: () => leftProgress.get(),
    getWidth: () => leftWidth.get(),
  });
  const { setTriggerHovered, suppressUntilPointerLeaves, dismiss: dismissPeek } = peek;

  const setLeftWidth = useCallback(
    (width: number, options?: { persist?: boolean }) => {
      const next = clampSidebarWidth(width);
      leftWidth.set(next);
      if (options?.persist) writeStoredSidebarWidth(next);
    },
    [leftWidth]
  );

  const setCollapsed = useCallback(
    (_side: 'left', collapsed: boolean, options?: { suppressPeek?: boolean }) => {
      const open = !collapsed;
      // 预览浮着时展开 = 把它钉住:它已经画在那儿了,再从 0 滑一次是重影 —— 直接跳到终值。
      const pin = open && peek.isPeekOpen;
      setIsLeftOpen(open);
      if (collapsed && options?.suppressPeek !== false) suppressUntilPointerLeaves();
      if (open) dismissPeek();

      const target = open ? 1 : 0;
      runningAnimationRef.current?.stop();
      runningAnimationRef.current = null;
      const restore = open ? restoreWidthRef.current : null;
      if (restore != null) {
        // Re-based so the occupied width stays put if this lands mid-collapse; from the rail (progress 0) it is the same.
        restoreWidthRef.current = null;
        const rail = leftRailWidth.get();
        const occupied = sidebarOccupiedWidth(leftProgress.get(), leftWidth.get(), rail);
        leftWidth.set(restore);
        leftProgress.set(restore > rail ? clamp01((occupied - rail) / (restore - rail)) : target);
      }
      if (pin || prefersReducedMotion) {
        leftProgress.set(target);
        return;
      }
      runningAnimationRef.current = animate(leftProgress, target, PANEL_SPRING);
    },
    [dismissPeek, leftProgress, leftRailWidth, leftWidth, peek.isPeekOpen, prefersReducedMotion, suppressUntilPointerLeaves]
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
      const next = sidebarEdgeDrag(rawWidth, {
        rail: leftRailWidth.get(),
        min: SIDEBAR_MIN_WIDTH_PX,
        max: Math.min(SIDEBAR_MAX_WIDTH_PX, maxWidth),
      });
      leftWidth.set(next.width);
      leftProgress.set(next.progress);
    },
    [leftProgress, leftRailWidth, leftWidth]
  );

  const releaseLeftEdge = useCallback(() => {
    const drag = edgeDragRef.current;
    // Pressed and let go without moving: nothing changed, nothing to snap (❌ reverse a collapse that is still running).
    if (!drag) return;
    edgeDragRef.current = null;
    if (sidebarEdgeSnapsOpen(leftProgress.get())) {
      restoreWidthRef.current = null;
      writeStoredSidebarWidth(leftWidth.get());
      setCollapsed('left', false);
    } else {
      restoreWidthRef.current = drag.startWidth;
      setCollapsed('left', true, { suppressPeek: false });
    }
  }, [leftProgress, leftWidth, setCollapsed]);

  const exitZenMode = useCallback(() => {
    const snapshot = zenModeSnapshotRef.current;
    if (!snapshot) return;

    setCollapsed('left', !snapshot.leftOpen);
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
      setCollapsed('left', true);
      rightSidebar?.setCollapsed(true);
    },
    [exitZenMode, isLeftOpen, setCollapsed]
  );

  return {
    isLeftOpen,
    isLeftPeeking: peek.isPeekOpen,
    leftWidth,
    leftProgress,
    leftAnimatedWidth,
    leftRail,
    leftRailWidth,
    setLeftRail,
    workspaceRootRef,
    setLeftWidth,
    setCollapsed,
    toggleLeft,
    dragLeftEdge,
    releaseLeftEdge,
    setTriggerHovered,
    exitZenMode,
    toggleZenMode,
  };
}

/**
 * #2548 whether the rows are laid out as the rail right now (sidebarRailLayout of the live progress, so it follows a click
 * collapse and a drag alike). Re-renders only when it flips.
 */
export function useLeftRailLayout(): boolean {
  const { leftProgress, leftRail } = useWorkspaceLayoutContext();
  const [railLayout, setRailLayout] = useState(() => sidebarRailLayout(leftProgress.get()));
  useMotionValueEvent(leftProgress, 'change', (progress) => setRailLayout(sidebarRailLayout(progress)));
  return leftRail > 0 && railLayout;
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
