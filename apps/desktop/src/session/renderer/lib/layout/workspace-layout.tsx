import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ShellSidebarToggle } from '@renderer/lib/components/titlebar/shell-titlebar';
import { useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import { INNER_SIDEBAR_MIN_WIDTH_PX, innerSidebarMaxWidth, SIDEBAR_MIN_WIDTH_PX } from '@renderer/lib/layout/layout-provider';
import { PanelSlot } from '@renderer/lib/layout/panel-slot';
import { MOVE, PANEL_LANDED_PX } from '@renderer/lib/layout/panel-track';
import { INNER_FOLD_FADES, INNER_FOLD_LINE, innerFoldFrames, innerFoldOpacity } from '@renderer/lib/layout/inner-fold-paint';
import { RESTORE_LANE_FOLLOWER } from '@renderer/lib/components/titlebar/shell-restore-lane';
import { PanelResizeDragGuard, PanelResizeHandle } from '@renderer/lib/layout/panel-resize-handle';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
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
}

const all = (root: Element | null | undefined, name: string) => [...(root?.getElementsByClassName(name) ?? [])] as HTMLElement[];
const moves = (from: number, to: number, content: number) => Math.abs(from - to) >= PANEL_LANDED_PX && content > 0;
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
 * 一条 flex 行:列表、内层栏两格,正文吃剩下的(flex-1)。三者是同一条 PanelTrack(panel-track.ts):格子去哪由
 * layout-provider 推出,怎么动只由 track 定 —— 每一帧都按画出来的尺寸真排版,正文跟着让。
 *
 * #2548 the list collapses to a rail of its avatars (SIDEBAR_RAIL_PX) and is always there. Its content layer keeps the
 * list's width through a fold and is clipped at the drawn edge (@@@list-clip below).
 */
export function WorkspaceLayout({ leftSidebar, mainContent, innerSidebar = null, innerSidebarRestore = null }: WorkspaceLayoutProps) {
  const { translate } = useSessionMessages();
  const {
    track,
    leftAnimatedWidth,
    innerEdge,
    workspaceRootRef,
    setWorkspaceWidth,
    setLeftWidth,
    dragLeftEdge,
    releaseLeftEdge,
    innerShownWidth,
    innerCardWidth,
    setInnerWidth,
    innerSidebarShown,
  } = useWorkspaceLayoutContext();
  const [isResizing, setIsResizing] = useState(false);

  // #2642 会话页的宽:内层栏放得下多宽由它推出(窗口变窄时那一列跟着让)。
  useLayoutEffect(() => {
    const root = workspaceRootRef.current;
    if (!root) return;
    const measure = () => setWorkspaceWidth(root.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [workspaceRootRef, setWorkspaceWidth]);
  const fillNode = useRef<HTMLDivElement | null>(null);
  const fillRef = useCallback((element: HTMLDivElement | null) => {
    fillNode.current = element;
    track.attachFill(element && { place: element, window: element, content: element });
  }, [track]);
  // @@@inner-fold-motion (owner 11-26) — what goes with the inner column's move, as animations riding it on these elements only: the restore lane's button and the tab strip that
  // leaves it room get `--shell-restore-lane-shown` (0 → 1 over the second half of a fold, 1 → 0 over the first half of an unfold); inside the column (inner-fold-paint.ts) the line's
  // `right` and the fading blocks' `opacity`. The card's `data-inner-column` (@@@inner-on-card) is held while any of the column is drawn: its left corners go at the start of an unfold and
  // come back when a fold has landed, ❌ at the click (a seam for the whole move). ❌ An inherited variable on the shell or the page: every frame would restyle every element under it.
  useLayoutEffect(() => {
    const column = workspaceRootRef.current?.querySelector(':scope > [data-panel-slot="inner"]');
    return track.ride('inner', (from, to, content) => !moves(from, to, content) ? [] : [
      ...all(column, INNER_FOLD_LINE).map((line) => line.animate({ right: [`${content - from}px`, `${content - to}px`] }, MOVE)),
      ...all(column, INNER_FOLD_FADES).map((block) => block.animate(innerFoldFrames(from, to, content, 'opacity', innerFoldOpacity), MOVE)),
    ]);
  }, [track, workspaceRootRef]);
  // The followers come and go with the render that starts the move (the lane's button mounts, the strip takes the class): their rider is registered after that render, and joins the move under way.
  useLayoutEffect(() => {
    const fill = fillNode.current;
    const rest = () => { // ❌ the column's box read here: in the render that starts its move it would lay the page out again; while it moves, its rider holds the mark
      for (const follower of all(fill, RESTORE_LANE_FOLLOWER)) follower.style.setProperty('--shell-restore-lane-shown', innerSidebarShown ? '0' : '1');
      fill?.toggleAttribute('data-inner-column', innerSidebarShown);
    };
    rest();
    const off = [track.onLanded(rest), track.ride('inner', (from, to, content) => !moves(from, to, content) ? [] : (fill?.toggleAttribute('data-inner-column', true),
      all(fill, RESTORE_LANE_FOLLOWER).map((follower) => follower.animate(innerFoldFrames(from, to, content, '--shell-restore-lane-shown', (open) => innerFoldOpacity(1 - open)), MOVE))))];
    return () => off.forEach((stop) => stop());
  }, [track, innerSidebarShown]);

  const maxSidebarWidth = () => {
    const rootWidth = workspaceRootRef.current?.clientWidth ?? 0;
    return rootWidth > 0 ? rootWidth * SIDEBAR_MAX_SHARE : Number.POSITIVE_INFINITY;
  };
  // #2642 这一下手势真改了画出来的宽才存:按下不动就松手、在上限处再按右键,画出来的宽没变 —— 存着的那个宽(可能更宽,
  // 只是此刻被窗口夹着)❌ 被夹出来的值覆盖。
  const innerResizedRef = useRef(false);

  return (
    <div
      ref={workspaceRootRef}
      className="relative flex h-full w-full overflow-clip"
      data-workspace-shell=""
    >
      {/* @@@list-clip - the list, the inner column and the page are one PanelTrack (panel-track.ts): in every frame of a
          fold each is laid out at the size it is drawn at, and the page takes the rest. The list keeps its width through the
          fold and is clipped at its drawn edge (its text fades, left-sidebar); it lands on the rail's width with the rows'
          rail layout. */}
      {/* #2548 a sidebar that collapses to a rail keeps its edge: dragging the rail's edge opens it. The handle is the
          slot's edge: where the list is drawn in every frame. */}
      <PanelSlot track={track} id="list" className="z-40" edge={
        <PanelResizeHandle
          ariaLabel={translate('task.resizeSidebar')}
          // #2548 the sidebar as one list draws no line on its edge: hovering it only shows the resize cursor.
          className="hover:bg-transparent"
          // A drag starts from where the edge is now (the rail, or mid-animation).
          getSize={() => track.drawn('list')}
          minSize={SIDEBAR_MIN_WIDTH_PX}
          maxSize={maxSidebarWidth}
          onSize={(size) => setLeftWidth(size)}
          onSizeCommit={(size) => setLeftWidth(size, { persist: true })}
          onDraggingChange={setIsResizing}
          // #2548 the whole sidebar follows the pointer (text fading with it) and snaps to the nearer state on release
          // (mock v18 拖边缘), ❌ the half-the-minimum threshold that collapsed it mid-drag.
          follow={{ onMove: (raw) => dragLeftEdge(raw, maxSidebarWidth()), onRelease: releaseLeftEdge }}
        />
      }>
        <div
          data-workspace-left-panel=""
          className={cn(
            'absolute inset-0 bg-background-tertiary',
            // 拖分隔条时别让指针顺手把侧栏里的文字选中 —— 与工作区面板同一处方。
            isResizing && 'select-none'
          )}
        >
          {leftSidebar}
        </div>
      </PanelSlot>
      {/* 固定占这一格(没有内层侧栏时宽 0):正文那一格的位置不因它出现 / 收起而变,正文 ❌ 重挂。
          #2548 有内层栏时它归列表那一层,紧挨着正文那张卡片(desktop-shell.css)。
          #2642 它右边缘的分隔条规矩同上面那一根(悬停才出线、拖动跟手、松手存、左右键步进),只是拖不收:这一列有自己的
          收起钮,拖到最窄就停住。 */}
      <PanelSlot track={track} id="inner" edge={innerSidebarShown ? (
        <PanelResizeHandle
          ariaLabel={translate('task.resizeInnerSidebar')}
          // 从该画的宽起拖:窗口窄时它可能正被夹着,从存着的宽起拖会先空拖一截。
          getSize={innerShownWidth}
          minSize={INNER_SIDEBAR_MIN_WIDTH_PX}
          maxSize={() => innerSidebarMaxWidth(innerCardWidth())}
          onSize={(size) => {
            if (size === innerShownWidth()) return;
            innerResizedRef.current = true;
            setInnerWidth(size);
          }}
          onSizeCommit={(size) => {
            if (!innerResizedRef.current) return;
            innerResizedRef.current = false;
            setInnerWidth(size, { persist: true });
          }}
        />
      ) : null}>
        {innerSidebar}
      </PanelSlot>
      <div ref={fillRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-workspace-content-surface="" data-panel-fill="">
        {mainContent}
        {innerSidebarRestore}
      </div>
      <PanelResizeDragGuard offset={leftAnimatedWidth} />
      {/* #2642 正文的页签条压在内层栏分隔条的右半截上:守卫排在正文后面,那半截才是拖宽度而 ❌ 拖窗口。 */}
      {innerSidebarShown ? <PanelResizeDragGuard offset={innerEdge} /> : null}
      {/* 左侧栏开关的控制器(快捷键、「消息」再点一下都走它);按钮本身 #2548 起在一张表侧栏的头一行。 */}
      <ShellSidebarToggle />
    </div>
  );
}

interface WorkspaceContentLayoutProps {
  titlebarSlot: ReactNode;
  mainPanel: ReactNode;
}

export function WorkspaceContentLayout({ titlebarSlot, mainPanel }: WorkspaceContentLayoutProps) {
  return (
    <div className="relative flex h-full flex-col bg-[var(--screen-ground,var(--color-background))] text-foreground" data-workspace-content-page="">
      {titlebarSlot}
      <div className="flex-1 overflow-hidden">
        <div className="flex h-full flex-col overflow-hidden">{mainPanel}</div>
      </div>
    </div>
  );
}
