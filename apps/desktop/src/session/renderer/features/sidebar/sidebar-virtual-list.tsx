import { useVirtualizer } from '@tanstack/react-virtual';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react';
import { type SidebarRow } from '@renderer/features/sidebar/sidebar-store';
import { getSessionPageStore } from '@renderer/features/sessions/stores/session-selectors';
import { useParams, useWorkspaceSlots } from '@renderer/lib/layout/navigation-provider';
import { getDraggedScreenContent } from '@renderer/lib/drag-screen-content';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { cn } from '@renderer/utils/utils';
import { lastRowScrollTarget } from './last-row-scroll-target';
import { sessionKeyboardNav } from './session-keyboard-nav';
import { sidebarGroupInsetX } from './sidebar-primitives';
import { useSidebarScrollTargets } from './sidebar-scroll-context';
import { navNodeKey } from './sidebar-store';
import { SidebarProjectItem } from './project-item';
import { SidebarSessionItem } from './sidebar-session-item';
import { SidebarMoreRow } from './sidebar-more-row';
import { SidebarStateHeader } from './sidebar-state-header';
import { sessionBranchGatewayDepth } from './sidebar-session-branch';
import { SidebarSessionBranchGateway, SidebarSessionBranchNavigation, SidebarSessionTreeGuides } from './sidebar-session-branch-view';

// Task rows have a fixed height; project rows are measured.
const ROW_HEIGHT = 32;
// @@@sidebar-label-size — 状态标题的字从 11px 放大到 13px,行也跟着从 24 松到 28,
// 否则 32px 的正文行夹着 24px 的标题槽,标题会显得被压扁。与 ROW_HEIGHT 同理:
// 这是虚拟滚动的排版依据,改了标题的视觉高度就必须同步改这里。
const STATE_HEADER_HEIGHT = 28;

function projectRowHeight(row: SidebarRow | undefined): number {
  if (row?.kind === 'state-header') return STATE_HEADER_HEIGHT;
  return ROW_HEIGHT + (row?.kind === 'conversation' && sessionBranchGatewayDepth(row, sidebarStore.expandedSessionIds.has(row.sessionId)) ? 28 : 0);
}

export const SidebarVirtualList = observer(function SidebarVirtualList() {
  const rows = sidebarStore.sidebarRows;
  const { currentView } = useWorkspaceSlots();
  const { params: sessionParams } = useParams('session');
  const { params: projectParams } = useParams('project');

  // @@@sidebar-single-scroller — 滚动容器不归本列表所有,它是侧栏正文那一个共用容器
  // (见 sidebar-scroll-context)。本列表只是容器里的一段,因此要把「这一段从容器顶端起算的
  // 偏移」作为 scrollMargin 告诉 virtualizer,并在行的绝对定位里把它减回去。
  const { scroller, content: scrollContent } = useSidebarScrollTargets();
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [insertion, setInsertion] = useState<ProjectInsertion | null>(null);

  const activeSessionProjectExpanded =
    currentView === 'session' && sessionParams.projectId && sessionParams.sessionId
      ? sidebarStore.expandedProjectIds.has(sidebarStore.rowOfSession(sessionParams.projectId, sessionParams.sessionId) ?? '')
      : null;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getItemKey: (index) => rowKey(rows[index]),
    getScrollElement: () => scroller,
    estimateSize: (index) => projectRowHeight(rows[index]),
    overscan: 8,
    scrollMargin,
  });

  const rowHeightKey = rows.map((row) => projectRowHeight(row)).join(',');
  useLayoutEffect(() => { virtualizer.measure(); }, [virtualizer, rowHeightKey]);

  // 偏移会被上方任何一处布局变化改写(「置顶」分区展开/收起、项目分区标题、窗口高度),
  // 而那些分区各自是独立的 observer——它们重渲染时本组件不会跟着重渲染。所以靠观察共用
  // 容器与其内容层的尺寸来重测,而不是挂在某个 React 依赖上。
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !scroller) return;
    const measure = () => {
      const next =
        list.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      // 阈值不是「差不多就行」:内容层的高度变化本身也会触发观察,若无条件 setState,
      // 每次测量都排一次重渲染 → 再触发一次观察,成环。
      setScrollMargin((prev) => (Math.abs(prev - next) < 0.5 ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    if (scrollContent) observer.observe(scrollContent);
    return () => observer.disconnect();
  }, [scroller, scrollContent]);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // 把某一行滚进视野。末行不能直接交给 virtualizer.scrollToIndex —— 理由与算法见
  // lastRowScrollTarget;其余行走 virtualizer 原路。
  const scrollRowIntoView = useCallback(
    (index: number) => {
      const element = virtualizer.scrollElement;
      if (index !== virtualizer.options.count - 1 || !element) {
        virtualizer.scrollToIndex(index, { align: 'auto' });
        return;
      }
      // align='auto' 的语义(已整行可见就不动)由 lastRowScrollTarget 承担。
      const target = lastRowScrollTarget({
        listEnd: virtualizer.options.scrollMargin + virtualizer.getTotalSize(),
        rowHeight:
          projectRowHeight(rowsRef.current[index]),
        scrollTop: element.scrollTop,
        clientHeight: element.clientHeight,
      });
      if (target !== null) element.scrollTo({ top: target });
    },
    [virtualizer]
  );

  // Scroll the active project/task into view only when the navigation target itself
  // changes, plus the active task's project expansion state. Re-running on every
  // `rows` change would yank the user back to the active row whenever the
  // sidebar mutates (e.g. deleting an unrelated task). Explicitly expanding a
  // project may reveal the active row; navigation itself never opens the project.
  useEffect(() => {
    let targetProjectId: string | null = null;
    let targetSessionId: string | null = null;

    if (currentView === 'session') {
      targetProjectId = sessionParams.projectId;
      targetSessionId = sessionParams.sessionId;
    } else if (currentView === 'project') {
      targetProjectId = projectParams.projectId;
    }

    if (!targetProjectId) return;

    if (targetSessionId) {
      const activeSession = getSessionPageStore(targetProjectId, targetSessionId);
      if (activeSession?.data.isPinned) {
        return;
      }
    }

    // Tasks don't render as rows — for a task target, scroll to its first conversation row.
    const activeIndex = rowsRef.current.findIndex((row) => {
      if (targetSessionId) {
        return (
          row.kind === 'conversation' &&
          row.sessionId === targetSessionId &&
          row.projectId === targetProjectId
        );
      }
      return row.kind === 'project' && row.projectId === targetProjectId;
    });

    if (activeIndex >= 0) {
      scrollRowIntoView(activeIndex);
    }
  }, [
    currentView,
    sessionParams.projectId,
    sessionParams.sessionId,
    projectParams.projectId,
    activeSessionProjectExpanded,
    scrollRowIntoView,
  ]);

  // behavior session-page「键盘导航」: keep the cursor row on screen. The list is virtualised, so an
  // off-screen row has no DOM node — scrollIntoView cannot be used; the virtualizer must be asked
  // by index. Keyed on the cursor alone (never on `rows`) for the same reason the effect above is:
  // re-running on every sidebar mutation would yank the viewport around.
  const cursorKey = sessionKeyboardNav.cursor ? navNodeKey(sessionKeyboardNav.cursor) : null;
  useEffect(() => {
    const cursor = sessionKeyboardNav.cursor;
    if (!cursor || cursor.kind === 'new-session') return;
    const index = rowsRef.current.findIndex((row) =>
      cursor.kind === 'project'
        ? row.kind === 'project' && row.projectId === cursor.projectId
        : row.kind === 'conversation' && row.sessionId === cursor.sessionId
    );
    if (index >= 0) scrollRowIntoView(index);
  }, [cursorKey, scrollRowIntoView]);

  // 拖的是一个项目行(项目群):落在列表里 = 换次序。只有项目行能换 —— 会话的次序归状态分组。
  // 拖起、落到分屏都是同一份原生拖拽内容(drag-screen-content),这里只收落在列表里的那一下。
  function projectInsertionAt(event: DragEvent<HTMLElement>): ProjectInsertion | null {
    const dragged = getDraggedScreenContent(event.dataTransfer);
    // 还没有本地项目的账号项目,行 id 就是它的群,拖起来的是那个群(project-item);别的群不是项目行,nextProjectOrder 认不出就不动。
    const projectId = dragged?.kind === 'project' ? dragged.projectId : dragged?.kind === 'chat' && !dragged.topic ? dragged.chatId : null;
    if (!projectId) return null;
    const rowElement = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-index]') : null;
    const overIndex = Number(rowElement?.dataset.index);
    if (!rowElement || !listRef.current?.contains(rowElement) || !Number.isInteger(overIndex)) return null;
    const rect = rowElement.getBoundingClientRect();
    return { projectId, rowIndex: event.clientY < rect.top + rect.height / 2 ? overIndex : overIndex + 1 };
  }

  function nextProjectOrder({ projectId, rowIndex }: ProjectInsertion): string[] | null {
    // 一个账号项目一行(行 id 见 SidebarProjectRef),拖拽写回的是整份行 id。
    const ids = sidebarStore.sidebarProjects.map((ref) => ref.id);
    const oldIdx = ids.indexOf(projectId);
    if (oldIdx === -1) return null;
    let newIdx = rows.slice(0, rowIndex).filter((r) => r.kind === 'project').length;
    if (newIdx > oldIdx) newIdx -= 1;
    if (newIdx === oldIdx) return null;
    const order = [...ids];
    order.splice(newIdx, 0, ...order.splice(oldIdx, 1));
    return order;
  }

  // The line's place from the virtualizer's row offsets (list coordinates), not from the row's screen rect.
  const insertionTop = (rowIndex: number) => {
    const measured = virtualizer.measurementsCache;
    const at = rowIndex < measured.length ? measured[rowIndex]?.start : measured[measured.length - 1]?.end;
    return (at ?? scrollMargin) - scrollMargin;
  };

  const dropHandlers = {
    onDragOver: (event: DragEvent<HTMLElement>) => {
      const next = projectInsertionAt(event);
      const changes = next && nextProjectOrder(next) ? next : null;
      // dragover 每几十毫秒一发:落点没换行就不重画。
      setInsertion((prev) => (prev?.rowIndex === changes?.rowIndex ? prev : changes));
      if (!changes) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setInsertion(null);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      setInsertion(null);
      const next = projectInsertionAt(event);
      const order = next && nextProjectOrder(next);
      if (!order) return;
      event.preventDefault();
      sidebarStore.setProjectOrder(order);
    },
    // 源行在列表里,它的 dragend 冒上来:Esc 取消、落到别处,线都要收掉。
    onDragEnd: () => setInsertion(null),
  };

  return (
    <>
      <div className={cn('pt-1 pb-1', sidebarGroupInsetX)}>
        <SidebarSessionBranchNavigation />
        <div
          ref={listRef}
          {...dropHandlers}
          style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
        >
          {virtualizer.getVirtualItems().map((vItem) => {
            const row = rows[vItem.index];
            if (!row) return null;
            const vStyle: React.CSSProperties = {
              position: 'absolute',
              // vItem.start 是相对共用滚动容器的绝对位置,这里的定位原点却是本列表自己,
              // 所以要把 scrollMargin 减回去(TanStack Virtual 的 scrollMargin 用法)。
              top: vItem.start - scrollMargin,
              left: 0,
              width: '100%',
              height: row.kind === 'project' ? undefined : `${vItem.size}px`,
            };
            if (row.kind === 'project') {
              return (
                <div key={row.projectId} ref={virtualizer.measureElement} data-index={vItem.index} style={vStyle}>
                  <SidebarProjectItem projectId={row.projectId} />
                </div>
              );
            }
            if (row.kind === 'state-header') {
              return (
                <div key={`${row.projectId}:state:${row.group}`} data-index={vItem.index} style={vStyle}>
                  <SidebarStateHeader group={row.group} count={row.count} variant="tree" />
                </div>
              );
            }
            if (row.kind === 'conversation') {
              const gatewayDepth = sessionBranchGatewayDepth(row, sidebarStore.expandedSessionIds.has(row.sessionId));
              return (
                <div key={`${row.projectId}:${row.sessionId}`} data-index={vItem.index} style={vStyle}>
                  <SidebarSessionItem
                    projectId={row.projectId}
                    sessionId={row.sessionId}
                    depth={row.depth}
                    parentProjectId={row.parentProjectId}
                    hasChildren={row.hasChildren}
                    expanded={sidebarStore.expandedSessionIds.has(row.sessionId)}
                    needsAttention={row.needsAttention}
                    treeSummary={row.tree?.summary}
                    onToggle={() => sidebarStore.toggleSessionExpanded(row.sessionId)}
                    join={row.join}
                  />
                  {row.tree ? <SidebarSessionTreeGuides depth={row.depth} tree={row.tree} /> : null}
                  {gatewayDepth ? <SidebarSessionBranchGateway sessionId={row.sessionId} depth={row.depth} remainingDepth={gatewayDepth} /> : null}
                </div>
              );
            }
            return (
              <div key={`${row.projectId}:more`} data-index={vItem.index} style={vStyle}>
                <SidebarMoreRow
                  foldKey={row.projectId}
                  expanded={row.expanded}
                  hiddenCount={row.hiddenCount}
                />
              </div>
            );
          })}
          {insertion ? <InsertionLine top={insertionTop(insertion.rowIndex)} /> : null}
        </div>
      </div>
    </>
  );
});

/** Where a dropped project row would land: before row `rowIndex` (rows.length = after the last). Kept as a row, not a screen
 * position, so the line follows the list when it scrolls during the drag. */
type ProjectInsertion = { projectId: string; rowIndex: number };

function rowKey(row: SidebarRow): string {
  if (row.kind === 'project') return `proj::${row.projectId}`;
  if (row.kind === 'state-header') return `state::${row.projectId}::${row.group}`;
  if (row.kind === 'conversation') return `conv::${row.projectId}::${row.sessionId}`;
  return `more::${row.projectId}`;
}

/** 松手会落在哪:那一行的上沿一根线(在列表里定位,随列表滚动)。 */
function InsertionLine({ top }: { top: number }) {
  return (
    <div
      className="bg-foreground"
      style={{ position: 'absolute', left: 8, right: 8, top: top - 1.5, height: 3, borderRadius: 2, pointerEvents: 'none', zIndex: 10 }}
    />
  );
}

