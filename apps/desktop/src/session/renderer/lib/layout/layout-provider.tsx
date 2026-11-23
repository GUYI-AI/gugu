import { useMotionValue, useMotionValueEvent, type MotionValue } from 'framer-motion';
import { clampPaneWidth, definePaneWidth, readPaneWidth, writePaneWidth } from '@/lib/paneWidth';
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { clamp01, PANEL_LANDED_PX, PanelTrack, type SlotTarget } from './panel-track';
import { PANEL_SNAP_RATIO } from './panel-resize-handle';
import { setSidebarFold, sidebarFolds } from '@renderer/features/sidebar/sidebar-folds';

/** 侧栏宽度的边界与默认值。min 沿用改造前的 200px;max 取 Codex 同款 520。 */
export const SIDEBAR_MIN_WIDTH_PX = 200;
export const SIDEBAR_MAX_WIDTH_PX = 520;
// 第 16 版稿:零级栏展开 236 宽(一级侧边栏另有自己的默认宽)。
export const SIDEBAR_DEFAULT_WIDTH_PX = 236;

const SIDEBAR_PANE = definePaneWidth({ id: 'gugu.taskpage.sidebarWidth', initial: SIDEBAR_DEFAULT_WIDTH_PX, min: SIDEBAR_MIN_WIDTH_PX, max: SIDEBAR_MAX_WIDTH_PX });

export const clampSidebarWidth = (width: number): number => clampPaneWidth(SIDEBAR_PANE, width);

/**
 * GUYI-AI/gugu#2642 内层栏(打开一个群 / 项目时列表与正文之间那一列)的宽:拖它右边缘调。范围暂与左边列表同档,
 * 默认就是它一直以来写死的那个宽 —— 没拖过的人看到的与从前一样。宽度存自己的键,与列表各管各的。
 */
export const INNER_SIDEBAR_MIN_WIDTH_PX = 200;
export const INNER_SIDEBAR_MAX_WIDTH_PX = 520;
// 第 16 版稿:一级侧边栏 220 宽(比零级栏窄)。
export const INNER_SIDEBAR_DEFAULT_WIDTH_PX = 220;
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
 * #2548 the list collapses to a rail of its avatars, this wide: the list's gutter (8) + a row's 52px square (its padding 6
 * around the 40px avatar, 界面减法 #53) + 8, so every avatar sits on its middle (x = 34) without moving. The rail is always there, so the
 * list never goes away and there is no hover preview of it.
 */
export const SIDEBAR_RAIL_PX = 68;

/** 侧栏占位宽:收起宽 + 进度 × (宽 − 收起宽);#2548 收起宽就是那一列头像。 */
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

/**
 * The rows are laid out as the rail only while the list's content is the rail's width (a collapse has landed, an expand
 * not started): one restyle at a move's end, ❌ mid-spring. The names are invisible then (sidebarRailTextOpacity).
 */
export function sidebarRailLayout(contentWidth: number): boolean {
  return contentWidth - SIDEBAR_RAIL_PX < PANEL_LANDED_PX;
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

/** The list's open/close progress (0 = the rail, 1 = its width) for where its edge is drawn. */
function listProgress(drawn: number, width: number): number {
  return width > SIDEBAR_RAIL_PX ? clamp01((drawn - SIDEBAR_RAIL_PX) / (width - SIDEBAR_RAIL_PX)) : 1;
}

export interface WorkspaceLayoutContextValue {
  isLeftOpen: boolean;
  /** 用户选定的侧栏宽(px)。收起动画期间它**不变** —— 变的是下面那个。 */
  leftWidth: MotionValue<number>;
  /** 开合进度 0→1(0 = 一列头像),由列表画出来的边推出。 */
  leftProgress: MotionValue<number>;
  /** 列表此刻画出来的宽(它的边):把手骑在上面,列表里的字跟着它淡。布局 ❌ 读它 —— 布局归 PanelTrack。 */
  leftAnimatedWidth: MotionValue<number>;
  /** #2548 the rows are laid out as the rail: the list's content is the rail's width (it lands there at the end of a collapse, leaves it at the start of an expand). */
  leftRailLayout: MotionValue<boolean>;
  /** #2642 内层栏画出来的右边缘 = 列表的边 + 内层栏画出来的宽:它右边那根分隔条骑在上面。 */
  innerEdge: MotionValue<number>;
  /** The session page's row: the list, the inner column, the page (panel-track.ts). WorkspaceLayout draws it. */
  track: PanelTrack;
  /** 会话页根元素。 */
  workspaceRootRef: RefObject<HTMLDivElement | null>;
  /** 会话页根元素量到的宽(WorkspaceLayout 报):内层栏放得下多宽由它推出。 */
  setWorkspaceWidth: (width: number) => void;
  /** A place without the list (App, Library): the list takes no room, ❌ motion either way. */
  setLeftWidth: (width: number, options?: { persist?: boolean }) => void;
  setCollapsed: (side: 'left', collapsed: boolean) => void;
  toggleLeft: () => void;
  /**
   * #2548 rail only: the edge is being dragged; `rawWidth` is where the pointer puts it (unclamped), `maxWidth` the
   * page's cap. The sidebar follows (sidebarEdgeDrag); open / collapsed does not change until the release.
   */
  dragLeftEdge: (rawWidth: number, maxWidth: number) => void;
  /** #2548 rail only: let go of the edge. Snaps to the nearer state (sidebarEdgeSnapsOpen) with the fold's spring. */
  releaseLeftEdge: () => void;
  /** #2642 用户选定的内层栏宽(px,存着的那个)。 */
  innerWidth: MotionValue<number>;
  /** #2642 内层栏此刻该画的宽:选定的宽夹进这张卡片此刻放得下的范围(innerSidebarShownWidth)。 */
  innerShownWidth: () => number;
  /**
   * 内层栏此刻挤不下:卡片宽减去这一列该画的宽,剩给正文的不到 INNER_SIDEBAR_BODY_MIN_PX(由目标推出,❌ 读此刻画到哪)。
   * 还没量到会话页宽时不算挤。
   */
  innerCrowded: MotionValue<boolean>;
  /** #2642 内层栏此刻的卡片宽(会话页宽 − 列表该占的宽);null = 还没量到。 */
  innerCardWidth: () => number | null;
  setInnerWidth: (width: number, options?: { persist?: boolean }) => void;
  /** #2642 内层栏此刻画着、展开着:它右边那根分隔条只在这时才有。 */
  innerSidebarShown: boolean;
  /** 这一列挂上时登记一次,返回的函数在卸下时注销(按次数记:换对话时新旧两列的挂卸先后不影响结果)。 */
  registerInnerSidebarFrame: () => () => void;
  /** 内层栏收起 / 展开(InnerSidebar 报):收起的那一列照旧挂着,只是收到 0 宽 —— 收和展都是同一段动效。 */
  setInnerFolded: (folded: boolean) => void;
  exitZenMode: () => void;
  toggleZenMode: () => void;
}

const WorkspaceLayoutContext = createContext<WorkspaceLayoutContextValue | undefined>(undefined);

/**
 * 会话页外层布局(列表 ↔ 内层栏 ↔ 正文)的状态:只推导每一格**该在哪**,怎么动过去归 PanelTrack。
 * 动:列表开合、拖边松手后的吸附、内层栏收起 / 展开。跳:首帧、拖动中、窗口宽窄、内层栏出现 / 离开、换到不带列表的页。
 *
 * #3904 那条「窄宽度自动折叠」owner 2026-09-05 推翻过(「新会话创建之后左侧栏就折叠,这个不好,别折叠啊」):
 * 侧栏折不折只由用户说了算,别再以任何形式加回来。
 */
export function useWorkspaceLayoutService(): WorkspaceLayoutContextValue {
  // Expanded until the user folds it (#2548 「默认展开」); the fold is stored with the sidebar's snapshot (sidebar-folds) and
  // the width under SIDEBAR_PANE, so a restart comes back as it was left.
  const [isLeftOpen, setIsLeftOpen] = useState(() => !sidebarFolds.has('left'));
  const workspaceRootRef = useRef<HTMLDivElement | null>(null);

  const leftWidth = useMotionValue(readPaneWidth(SIDEBAR_PANE));
  const innerWidth = useMotionValue(readPaneWidth(INNER_SIDEBAR_PANE));
  /** What the targets are derived from (read model inputs); refs, so a drag frame re-renders nothing. */
  const state = useRef({ open: isLeftOpen, rootWidth: 0, innerFrames: 0, innerFolded: false });
  const [innerSidebarShown, setInnerSidebarShown] = useState(false);

  const listTarget = (): SlotTarget => {
    const { open } = state.current;
    const width = leftWidth.get();
    return open ? { size: width, content: width } : { size: SIDEBAR_RAIL_PX, content: SIDEBAR_RAIL_PX };
  };
  // 卡片宽 = 会话页宽 − 列表该占的宽(❌ 读用户选定宽,❌ 读此刻画到哪)。
  const innerCardWidth = () => {
    const { rootWidth } = state.current;
    return rootWidth > 0 ? rootWidth - listTarget().size : null;
  };
  const innerShownWidth = () => innerSidebarShownWidth(innerWidth.get(), innerCardWidth());
  const innerTarget = (): SlotTarget => {
    const { innerFrames, innerFolded } = state.current;
    const width = innerShownWidth();
    return { size: innerFrames > 0 && !innerFolded ? width : 0, content: width };
  };
  const targets = () => ({ list: listTarget(), inner: innerTarget() });

  const [track] = useState(() => new PanelTrack([{ id: 'list', at: listTarget() }, { id: 'inner', at: { size: 0 } }]));
  const innerCrowded = useMotionValue(false);
  const crowded = () => {
    const card = innerCardWidth();
    return card !== null && card - innerShownWidth() < INNER_SIDEBAR_BODY_MIN_PX;
  };
  const move = useCallback(() => {
    innerCrowded.set(crowded());
    track.to(targets());
  }, [track, innerCrowded]);
  const jump = useCallback(() => {
    innerCrowded.set(crowded());
    track.jump(targets());
  }, [track, innerCrowded]);

  const leftAnimatedWidth = useMotionValue(track.drawn('list'));
  const leftProgress = useMotionValue(listProgress(track.drawn('list'), leftWidth.get()));
  const innerEdge = useMotionValue(track.drawn('list') + track.drawn('inner'));
  const leftRailLayout = useMotionValue(sidebarRailLayout(track.content('list')));
  useLayoutEffect(
    () =>
      // The edge first: a follower of the progress reads it (useSidebarProgressFollow) in the same frame.
      track.subscribe((drawn) => {
        const list = drawn.get('list')!;
        leftRailLayout.set(sidebarRailLayout(track.content('list')));
        leftAnimatedWidth.set(list);
        innerEdge.set(list + drawn.get('inner')!);
        leftProgress.set(listProgress(list, leftWidth.get()));
      }),
    [track, leftRailLayout, leftAnimatedWidth, innerEdge, leftProgress, leftWidth]
  );

  /** An edge drag under way (rail only): the width it started from. */
  const edgeDragRef = useRef<{ startWidth: number } | null>(null);
  /**
   * A drag that snapped shut passed through the minimum width and left it there; the next open comes back at the width
   * the drag started from instead (nothing was stored, so the next start does too).
   */
  const restoreWidthRef = useRef<number | null>(null);
  const zenModeSnapshotRef = useRef<{ leftOpen: boolean } | null>(null);

  const setLeftWidth = useCallback(
    (width: number, options?: { persist?: boolean }) => {
      const next = clampSidebarWidth(width);
      leftWidth.set(next);
      if (options?.persist) writePaneWidth(SIDEBAR_PANE, next);
      jump();
    },
    [leftWidth, jump]
  );

  const setInnerWidth = useCallback(
    (width: number, options?: { persist?: boolean }) => {
      const next = clampInnerSidebarWidth(width);
      innerWidth.set(next);
      if (options?.persist) writePaneWidth(INNER_SIDEBAR_PANE, next);
      jump();
    },
    [innerWidth, jump]
  );

  const setWorkspaceWidth = useCallback((width: number) => {
    if (state.current.rootWidth === width) return;
    state.current.rootWidth = width;
    jump();
  }, [jump]);

  const syncInnerShown = () => setInnerSidebarShown(state.current.innerFrames > 0 && !state.current.innerFolded);
  const registerInnerSidebarFrame = useCallback(() => {
    state.current.innerFrames += 1;
    syncInnerShown();
    jump();
    return () => {
      state.current.innerFrames -= 1;
      syncInnerShown();
      jump();
    };
  }, [jump]);
  const setInnerFolded = useCallback((folded: boolean) => {
    if (state.current.innerFolded === folded) return;
    state.current.innerFolded = folded;
    syncInnerShown();
    // No column yet (it is mounting folded): nothing to fold, it is placed with its frame.
    if (state.current.innerFrames > 0) move();
  }, [move]);

  const setCollapsed = useCallback(
    (_side: 'left', collapsed: boolean, options?: { passing?: boolean }) => {
      const open = !collapsed;
      // Zen mode folds the list for the moment and puts it back: that is not the user's layout.
      if (!options?.passing) setSidebarFold('left', collapsed);
      setIsLeftOpen(open);
      state.current.open = open;
      const restore = open ? restoreWidthRef.current : null;
      if (restore != null) {
        restoreWidthRef.current = null;
        leftWidth.set(restore);
      }
      move();
    },
    [leftWidth, move]
  );

  const toggleLeft = useCallback(() => {
    setCollapsed('left', isLeftOpen);
  }, [isLeftOpen, setCollapsed]);

  const dragLeftEdge = useCallback(
    (rawWidth: number, maxWidth: number) => {
      // Grabbing the edge mid-animation takes over from the spring (the jump stops it).
      if (!edgeDragRef.current) edgeDragRef.current = { startWidth: restoreWidthRef.current ?? leftWidth.get() };
      const next = sidebarEdgeDrag(rawWidth, { rail: SIDEBAR_RAIL_PX, min: SIDEBAR_MIN_WIDTH_PX, max: Math.min(SIDEBAR_MAX_WIDTH_PX, maxWidth) });
      leftWidth.set(next.width);
      // Below the minimum the list keeps the minimum's layout and is drawn as wide as the pointer says.
      track.jump({ list: { size: sidebarOccupiedWidth(next.progress, next.width, SIDEBAR_RAIL_PX), content: next.width }, inner: innerTarget() });
    },
    [leftWidth, track]
  );

  const releaseLeftEdge = useCallback(() => {
    const drag = edgeDragRef.current;
    // Pressed and let go without moving: nothing changed, nothing to snap (❌ reverse a collapse that is still running).
    if (!drag) return;
    edgeDragRef.current = null;
    if (sidebarEdgeSnapsOpen(listProgress(track.drawn('list'), leftWidth.get()))) {
      restoreWidthRef.current = null;
      writePaneWidth(SIDEBAR_PANE, leftWidth.get());
      setCollapsed('left', false);
    } else {
      restoreWidthRef.current = drag.startWidth;
      setCollapsed('left', true);
    }
  }, [leftWidth, setCollapsed, track]);

  const exitZenMode = useCallback(() => {
    const snapshot = zenModeSnapshotRef.current;
    if (!snapshot) return;
    setCollapsed('left', !snapshot.leftOpen, { passing: true });
    zenModeSnapshotRef.current = null;
  }, [setCollapsed]);

  const toggleZenMode = useCallback(() => {
    if (zenModeSnapshotRef.current) {
      exitZenMode();
      return;
    }
    zenModeSnapshotRef.current = { leftOpen: isLeftOpen };
    setCollapsed('left', true, { passing: true });
  }, [exitZenMode, isLeftOpen, setCollapsed]);

  return {
    isLeftOpen,
    leftWidth,
    leftProgress,
    leftAnimatedWidth,
    leftRailLayout,
    innerEdge,
    track,
    workspaceRootRef,
    setWorkspaceWidth,
    setLeftWidth,
    setCollapsed,
    toggleLeft,
    dragLeftEdge,
    releaseLeftEdge,
    innerWidth,
    innerShownWidth,
    innerCrowded,
    innerCardWidth,
    setInnerWidth,
    innerSidebarShown,
    registerInnerSidebarFrame,
    setInnerFolded,
    exitZenMode,
    toggleZenMode,
  };
}

/**
 * #2642 内层栏那一列自己用:挂着的时候报给工作区 —— 这一格据此有宽、它右边那根分隔条据此才有。宽度由 PanelTrack 写在这一格上,
 * 这一列撑满它。`folded`:收起着(这一列照旧挂着,收到 0 宽)。
 */
export function useInnerSidebarFrame(folded = false): void {
  const { registerInnerSidebarFrame, setInnerFolded } = useWorkspaceLayoutContext();
  // Folded first: a column that mounts folded is placed folded, ❌ placed open and then folded.
  useLayoutEffect(() => setInnerFolded(folded), [folded, setInnerFolded]);
  useLayoutEffect(registerInnerSidebarFrame, [registerInnerSidebarFrame]);
}

/** Whether the body beside the inner column has too little room (innerCrowded). Re-renders only when it flips. */
export function useInnerSidebarCrowded(): boolean {
  const { innerCrowded } = useWorkspaceLayoutContext();
  const [crowded, setCrowded] = useState(() => innerCrowded.get());
  useMotionValueEvent(innerCrowded, 'change', setCrowded);
  return crowded;
}

/** #2548 whether the rows are laid out as the rail right now (leftRailLayout). Re-renders only when it flips. */
export function useLeftRailLayout(): boolean {
  const { leftRailLayout } = useWorkspaceLayoutContext();
  const [railLayout, setRailLayout] = useState(() => leftRailLayout.get());
  useMotionValueEvent(leftRailLayout, 'change', setRailLayout);
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
  const leftRailLayout = layout?.leftRailLayout;
  const ref = useRef<T | null>(null);
  const followRef = useRef(follow);
  followRef.current = follow;
  useLayoutEffect(() => {
    const write = () => {
      const progress = leftProgress ? clamp01(leftProgress.get()) : 1;
      const railLayout = leftRailLayout?.get() ?? false;
      if (ref.current) followRef.current(ref.current, progress, railLayout);
    };
    write();
    const unsubscribe = [leftProgress?.on('change', write), leftRailLayout?.on('change', write)];
    return () => unsubscribe.forEach((off) => off?.());
  }, [leftProgress, leftRailLayout]);
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
