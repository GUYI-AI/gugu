import { motion, useTransform } from 'framer-motion';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { ShellSidebarToggle } from '@renderer/lib/components/titlebar/shell-titlebar';
import { useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import {
  INNER_SIDEBAR_MIN_WIDTH_PX,
  innerSidebarMaxWidth,
  innerSidebarShownWidth,
  SIDEBAR_LANDED_PX,
  SIDEBAR_MIN_WIDTH_PX,
  SIDEBAR_RAIL_PX,
  sidebarOccupiedWidth,
  sidebarRailLayout,
} from '@renderer/lib/layout/layout-provider';
import { PanelResizeDragGuard, PanelResizeHandle } from '@renderer/lib/layout/panel-resize-handle';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { RETAINED_SURFACE_HIDDEN_STYLE } from '@/lib/retainedSurface';
import './workspace-surface.css';

/** 侧栏最宽不超过会话页宽度的这个比例 —— 窗口小的时候 520px 会把主区挤没。 */
const SIDEBAR_MAX_SHARE = 0.4;

interface WorkspaceLayoutProps {
  leftSidebar: ReactNode;
  mainContent: ReactNode;
  /** #2548 内层侧栏:列表与正文之间的那一列(打开一个群 / 项目时才有,不该出现时它自己什么都不画)。 */
  innerSidebar?: ReactNode;
  /** #2548 ⑤ 内层栏收起时正文左上角那枚展开钮(ShellRestoreLane);不在时它自己什么都不画。 */
  innerSidebarRestore?: ReactNode;
  /** A place of its own on the far-left rail (App, Library): no task list beside it. The sidebar stays
   *  mounted, only not shown — swapping the layout out rebuilt the whole task tree on every way back. */
  sidebarHidden?: boolean;
}

/**
 * 侧栏折不折只由用户说了算(顶栏按钮 / 快捷键 / 拖分隔条)。
 *
 * #3904 曾加过一条「窄宽度自动让位」:会话页下量到分栏组宽度不够就替用户把左侧栏折起来。
 * owner 2026-09-05 推翻:「新会话创建之后左侧栏就折叠,这个不好,别折叠啊」。这条规则从来没进
 * behavior spec,是实现侧自己加的 —— 它连同它的两条放大器(量到的不是窗口宽、折了回不来)
 * 一起在那次删掉了,别再以任何形式加回来。
 *
 * ## 这一层的几何
 *
 * 外层不再是 react-resizable-panels 的分栏组:那个库把宽度记在自己的 flex 布局里,程序性
 * collapse 是**瞬间**改 flex-grow,没有可插入过渡的量。现在是一条普通 flex 行 —— 侧栏宽度由
 * 弹簧驱动的 motion value 给,主区吃剩下的(flex-1),所以两者由同一个数推出、不会脱节。
 * 细节见 panel-motion.ts。
 *
 * #2548 the list collapses to a rail of its avatars (SIDEBAR_RAIL_PX) and is always there. Its content layer keeps the
 * list's width through a fold and is clipped at the drawn edge (@@@overlay-collapse below).
 */
export function WorkspaceLayout({ leftSidebar, mainContent, innerSidebar = null, innerSidebarRestore = null, sidebarHidden = false }: WorkspaceLayoutProps) {
  const { translate } = useSessionMessages();
  const {
    leftWidth,
    leftProgress,
    leftAnimatedWidth,
    leftLayoutWidth,
    workspaceRootRef,
    setLeftWidth,
    dragLeftEdge,
    releaseLeftEdge,
    workspaceWidth,
    innerWidth,
    innerShownWidth,
    setInnerWidth,
    innerSidebarShown,
  } = useWorkspaceLayoutContext();
  const [isResizing, setIsResizing] = useState(false);

  // #2642 会话页的宽:内层栏放得下多宽由它推出(窗口变窄时那一列跟着让)。
  useLayoutEffect(() => {
    const root = workspaceRootRef.current;
    if (!root) return;
    const measure = () => workspaceWidth.set(root.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [workspaceRootRef, workspaceWidth]);
  // @@@overlay-collapse - during a fold the page keeps its laid-out width (leftLayoutWidth) and follows the list's drawn edge
  // by transform, so its left edge stays where the list ends, as when the width animated. Landed, it stays put through the
  // spring's sub-pixel tail.
  const pageShift = useTransform([leftAnimatedWidth, leftLayoutWidth], ([drawn, laidOut]: number[]) =>
    Math.abs(drawn - laidOut) < SIDEBAR_LANDED_PX ? 0 : drawn - laidOut
  );
  // #2642 内层栏的右边缘 = 列表画出来的边 + 内层栏画出来的宽(内层栏紧挨列表,左右都不留缝,desktop-shell.css)。
  const innerEdge = useTransform([leftAnimatedWidth, innerShownWidth], ([left, inner]: number[]) => left + inner);
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const move = (shift: number) => {
      // A place without this list has no list edge to follow, including while a fold is still running.
      const transform = !sidebarHidden && shift ? `translateX(${shift}px)` : '';
      content.style.transform = transform;
      // The inner sidebar is the page's previous sibling (WorkspaceLayout renders it there; InnerSidebar owns the element).
      const inner = content.previousElementSibling;
      if (inner instanceof HTMLElement && inner.dataset.region === 'inner-sidebar') inner.style.transform = transform;
    };
    move(pageShift.get());
    return pageShift.on('change', move);
  }, [pageShift, sidebarHidden]);
  const showInnerHandle = innerSidebarShown && !sidebarHidden;

  // GUYI-AI/gugu#2548 the rail is the expanded list itself, only narrow: the avatars' left edges stay put and the text fades
  // with the progress (sidebarRailTextOpacity, left-sidebar). The layer keeps the list's width through the fold, clipped at
  // the drawn edge, and takes the rail's width where the edge lands on it, with the rows' rail layout (sidebarRailLayout).
  const contentWidth = useTransform([leftProgress, leftWidth], ([progress, width]: number[]) =>
    sidebarRailLayout(sidebarOccupiedWidth(progress, width, SIDEBAR_RAIL_PX)) ? SIDEBAR_RAIL_PX : width
  );
  // Clipped at its drawn edge, ❌ resized: a width there re-laid out the aside in every frame of a fold.
  const asideClip = useTransform([contentWidth, leftAnimatedWidth], ([width, drawn]: number[]) => `inset(0 ${Math.max(0, width - drawn)}px 0 0)`);

  const maxSidebarWidth = () => {
    const rootWidth = workspaceRootRef.current?.clientWidth ?? 0;
    return rootWidth > 0 ? rootWidth * SIDEBAR_MAX_SHARE : Number.POSITIVE_INFINITY;
  };
  /** #2642 内层栏与正文合起来那张卡片此刻的宽;null = 还没量到。与画这一列的变换读同一个会话页宽(workspaceWidth)。 */
  const innerCardWidth = () => {
    const rootWidth = workspaceWidth.get();
    return rootWidth > 0 ? rootWidth - leftLayoutWidth.get() : null;
  };
  /** 内层栏此刻画出来的宽,由源头现算:innerShownWidth 是变换,下一帧才更新,连按两下方向键第二下会读到旧值、吞掉一步(浏览器用例实测)。 */
  const innerShownNow = () => innerSidebarShownWidth(innerWidth.get(), innerCardWidth());
  // #2642 这一下手势真改了画出来的宽才存:按下不动就松手、在上限处再按右键,画出来的宽没变 —— 存着的那个宽(可能更宽,
  // 只是此刻被窗口夹着)❌ 被夹出来的值覆盖。
  const innerResizedRef = useRef(false);

  return (
    <div
      ref={workspaceRootRef}
      className="relative flex h-full w-full overflow-hidden"
      data-workspace-shell=""
      // #2548 the content is a card stacked on the one list only while the list is beside it (desktop-shell.css).
      data-workspace-sidebar-hidden={sidebarHidden ? '' : undefined}
    >
      {/* @@@overlay-collapse - the list's place in the layout. The list itself (the aside) is drawn over the page, clipped at
          its drawn edge: a fold re-lays out the page once (at the start of a collapse, where an expand lands), not each frame. */}
      <motion.div aria-hidden className="h-full shrink-0" style={{ width: sidebarHidden ? 0 : leftLayoutWidth }} />
      <motion.aside
        data-workspace-left-panel=""
        className="absolute inset-y-0 left-0 z-40 overflow-hidden"
        // A place without the task list (资源库, App) hides it as a retained surface, ❌ display:none: that drops every
        // row's layout box and the way back restyles the whole list (@@@retained-places, lib/retainedSurface.ts).
        style={{ width: contentWidth, clipPath: asideClip, ...(sidebarHidden ? RETAINED_SURFACE_HIDDEN_STYLE : {}) }}
      >
        <motion.div
          className={cn(
            'absolute inset-y-0 left-0 bg-background-tertiary',
            // 拖分隔条时别让指针顺手把侧栏里的文字选中 —— 与工作区面板同一处方。
            isResizing && 'select-none'
          )}
          style={{ width: contentWidth }}
        >
          {leftSidebar}
        </motion.div>
      </motion.aside>
      {/* #2548 a sidebar that collapses to a rail keeps its edge: dragging the rail's edge opens it. */}
      {!sidebarHidden ? (
        <PanelResizeHandle
          edge="end"
          offset={leftAnimatedWidth}
          ariaLabel={translate('task.resizeSidebar')}
          // #2548 the sidebar as one list draws no line on its edge: hovering it only shows the resize cursor.
          className="hover:bg-transparent"
          // A drag starts from where the edge is now (the rail, or mid-animation).
          getSize={() => leftAnimatedWidth.get()}
          minSize={SIDEBAR_MIN_WIDTH_PX}
          maxSize={maxSidebarWidth}
          onSize={(size) => setLeftWidth(size)}
          onSizeCommit={(size) => setLeftWidth(size, { persist: true })}
          onDraggingChange={setIsResizing}
          // #2548 the whole sidebar follows the pointer (text fading with it) and snaps to the nearer state on release
          // (mock v18 拖边缘), ❌ the half-the-minimum threshold that collapsed it mid-drag.
          follow={{ onMove: (raw) => dragLeftEdge(raw, maxSidebarWidth()), onRelease: releaseLeftEdge }}
        />
      ) : null}
      {/* #2642 内层栏右边缘的分隔条,规矩同上面那一根(悬停才出线、拖动跟手、松手存、左右键步进),只是拖不收:这一列有自己的
          收起钮,拖到最窄就停住。排在这一列**前面**:它和正文之间 ❌ 夹东西(desktop-shell.css 用相邻选择器把两半拼成一张卡片)。 */}
      {showInnerHandle ? (
        <PanelResizeHandle
          edge="end"
          offset={innerEdge}
          ariaLabel={translate('task.resizeInnerSidebar')}
          // 从画出来的宽起拖:窗口窄时它可能正被夹着,从存着的宽起拖会先空拖一截。
          getSize={innerShownNow}
          minSize={INNER_SIDEBAR_MIN_WIDTH_PX}
          maxSize={() => innerSidebarMaxWidth(innerCardWidth())}
          onSize={(size) => {
            if (size === innerShownNow()) return;
            innerResizedRef.current = true;
            setInnerWidth(size);
          }}
          onSizeCommit={(size) => {
            if (!innerResizedRef.current) return;
            innerResizedRef.current = false;
            setInnerWidth(size, { persist: true });
          }}
        />
      ) : null}
      {/* 固定占这一格(没有内层侧栏时是 null):正文那一格的位置不因它出现 / 收起而变,正文 ❌ 重挂。
          #2548 有内层栏时它和正文是同一张卡片的左右两半(desktop-shell.css),所以它必须紧挨着正文那一格。 */}
      {sidebarHidden ? null : innerSidebar}
      <div ref={contentRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-workspace-content-surface="">
        {mainContent}
        {sidebarHidden ? null : innerSidebarRestore}
      </div>
      {!sidebarHidden ? <PanelResizeDragGuard edge="end" offset={leftAnimatedWidth} /> : null}
      {/* #2642 正文的页签条压在内层栏分隔条的右半截上:守卫排在正文后面,那半截才是拖宽度而 ❌ 拖窗口。 */}
      {showInnerHandle ? <PanelResizeDragGuard edge="end" offset={innerEdge} /> : null}
      {/* 左侧栏开关的控制器(快捷键、「消息」再点一下都走它);按钮本身 #2548 起在一张表侧栏的头一行。 */}
      {sidebarHidden ? null : <ShellSidebarToggle />}
    </div>
  );
}

interface WorkspaceContentLayoutProps {
  titlebarSlot: ReactNode;
  mainPanel: ReactNode;
}

export function WorkspaceContentLayout({ titlebarSlot, mainPanel }: WorkspaceContentLayoutProps) {
  return (
    <div className="relative flex h-full flex-col bg-background text-foreground">
      {titlebarSlot}
      <div className="flex-1 overflow-hidden">
        <div className="flex h-full flex-col overflow-hidden">{mainPanel}</div>
      </div>
    </div>
  );
}
