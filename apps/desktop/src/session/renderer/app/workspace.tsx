import { LeftSidebar } from '@renderer/features/sidebar/left-sidebar';
import { InnerSidebar, InnerSidebarRestore } from '@renderer/features/sidebar/inner-sidebar';
import { PinnedSidebarAgentsPublisher } from '@renderer/features/sidebar/sidebar-pinned-agents';
import { SessionKeyboardNavListener } from '@renderer/features/sidebar/session-keyboard-nav-listener';
import { SESSION_NAV_FOCUS_REGION } from '@renderer/features/sidebar/session-keyboard-nav';
import { CommandShortcutBinder } from '@renderer/lib/commands/command-shortcut-binder';
import { AppKeyboardShortcuts } from '@renderer/lib/components/app-keyboard-shortcuts';
import { BrowserAppShortcutEvents } from '@renderer/lib/components/browser-app-shortcut-events';
import { CodeEditorKeyboardBridge } from '@renderer/lib/components/code-editor-keyboard-bridge';
import { useTheme } from '@renderer/lib/hooks/useTheme';
import { useWorkspaceSlots } from '@renderer/lib/layout/navigation-provider';
import { PageModalClose } from '@renderer/lib/components/titlebar/shell-titlebar';
import { PAGE_MODAL_FRAME, Sheet } from '@/components/ui/Sheet';
import { WorkspaceContentLayout, WorkspaceLayout } from '@renderer/lib/layout/workspace-layout';
import { NoticeHost } from '@/components/NoticeHost';
import { SshKeyInstallToasts } from '@renderer/features/remote-hosts/ssh-key-install-toasts';
import { observer } from 'mobx-react-lite';
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ComponentType, type CSSProperties, type ReactNode } from 'react';
import { appState } from '@renderer/lib/stores/app-state';
import { registeredViews } from '@renderer/lib/layout/registered-views';
import type { ViewDefinition, ViewId } from './view-registry';
import { useRecentSessions, type SessionParams } from './recent-session-pages';
import { ScreenBlockContext } from './screen-block-context';
import { anchoredToBlock, ScreenFrame, screenDropHandlers } from './screen-frame';
import { DropHighlightLayer, hideDropHighlight } from '@renderer/lib/drop-highlight';
import { hasDraggedScreenContent } from '@renderer/lib/drag-screen-content';
import { shieldNativeDrags } from '@renderer/lib/drag-shield';
import { screenLayout } from './screen-layout';
import { ensureScreenLayoutSync, focusScreenBlock, isScreenView, putBackFromWindow, setBlockDropPreview } from './screen-layout-actions';
import { auxWindows } from './aux-windows';
import { followBox, PEEKED_PAGE_STYLE, sessionPeek } from './session-peek';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { RETAINED_SURFACE_HIDDEN_STYLE, SurfaceShown } from '@/lib/retainedSurface';
import { sessionView } from '@renderer/features/sessions/view';
import { runInAction } from 'mobx';
import { pageModalOpen } from './page-modal';
import { ensureMachineSessionWiring } from '@renderer/features/remote-hosts/workspace/machine-session-wiring';
import { ensureMachineWorkspaceBackend } from '@renderer/features/remote-hosts/workspace/machine-workspace-backend';
import { isEmbedVisible, subscribeEmbedVisibility } from '@renderer/lib/portal-container';


export function Workspace() {
  useTheme();
  const { modal, currentView, pageView } = useWorkspaceSlots();
  // @@@page-modal — a modal view is drawn over the page you were on: that page stays the workspace's under it.
  const page = pageView ?? (screenLayout.layout ? 'screen' : 'home');
  // 看哪条会话 → 这屏怎么摆:要赶在下面任何一个会话页渲染之前(同上面两件的理由)。
  ensureScreenLayoutSync();
  // gugu-embedded: while the frame is display-hidden (user on another gugu tab) the document-level
  // hotkey binders must detach — ⌘K etc. would otherwise open invisible modals and steal focus.
  // Standalone: always true.
  const embedVisible = useSyncExternalStore(subscribeEmbedVisibility, isEmbedVisible);
  // #6264 别的机器上的项目:工作区后端(预览、传输、浏览器转发)与「看着那条会话」才有的那几件事。
  // 幂等,且要赶在任何任务视图渲染之前装上(子组件的 effect 先于这里跑,所以 ❌ 放进 useEffect)。
  ensureMachineWorkspaceBackend();
  ensureMachineSessionWiring();

  return (
    <>
      {embedVisible && <AppKeyboardShortcuts />}
      <BrowserAppShortcutEvents />
      {embedVisible && <CommandShortcutBinder />}
      {/* behavior session-page「键盘导航」: same visibility gate as the other document-level binders —
          a hidden task frame must not answer arrow keys aimed at the chat tab. */}
      {embedVisible && <SessionKeyboardNavListener />}
      {/* The nav layer needs somewhere real to park focus: the sidebar list is virtualised, so the row the cursor sits on
          may have no DOM node at all. Always mounted: inserted under the page root on each show, it re-matched the root's
          :has() rules and restyled the whole page (~130 ms at 1000 chat rows). */}
      <div data-region={SESSION_NAV_FOCUS_REGION} tabIndex={-1} aria-hidden="true" style={{ position: 'fixed', width: 0, height: 0, opacity: 0, outline: 'none' }} />
      <CodeEditorKeyboardBridge />
      {/* #2548 my agents pinned to the one list (固定到左侧栏), for the shell that draws that list. Draws nothing. */}
      <PinnedSidebarAgentsPublisher />
      <WorkspaceLayout
        leftSidebar={<LeftSidebar />}
        innerSidebar={<InnerSidebar />}
        innerSidebarRestore={<InnerSidebarRestore />}
        mainContent={
          <PageArea page={page} />
        }
      />
      {modal ? <PageModal viewId={currentView} onClose={() => appState.navigation.navigate(page as ViewId)} /> : null}
      {/* #6264「下次免密」做完的回执(装好了 / 没做成)。 */}
      <SshKeyInstallToasts />
      {/* 提示条:嵌在主 app 里时主 app 画,这里什么也不画;会话页单独成文档时由它画(#137)。 */}
      <NoticeHost embedded />
    </>
  );
}

/**
 * 会话页这一屏(spec session-page「一屏几块」):骨架(几块、分界)+ 每个留着的会话页。摆在某一块里的会话页
 * 贴到那块上,其余的藏着(@@@retained-session-pages)。左边一行、⋮⋮ 拖到一块的边上,在这里判落点。
 */
const ScreenArea = observer(function ScreenArea({
  onScreenView: onSessionView,
  current,
  children,
}: {
  /** 看着这一屏(一条会话、一个项目):画几块;别的视图(资源库、已安排……)盖在它上面。 */
  onScreenView: boolean;
  /** 正看着的会话;看着项目块时没有。 */
  current: SessionParams | null;
  children: ReactNode;
}) {
  // 开在单独窗里的会话不在主窗里画(一个会话只在一处,画两份就是两套终端、两个输入框)。
  const currentWindow = current ? auxWindows.windowOfSession(current.sessionId) : undefined;
  // A session beside an App is on screen too: mounted, and never the page to leave.
  const peek = sessionPeek.current;
  const onScreen = peek ? [...screenLayout.sessions, { projectId: peek.projectId, sessionId: peek.sessionId }] : screenLayout.sessions;
  const recentSessions = useRecentSessions(currentWindow ? null : current, onScreen).filter(
    (page) => !auxWindows.windowOfSession(page.sessionId)
  );
  const multi = screenLayout.order.length > 1;
  // 焦点在某扇子窗:主窗这屏没有「正看着的那块」,快捷键全给那扇窗。
  const mainFocused = auxWindows.focusedWindowId === null;
  const handlers = screenDropHandlers(onSessionView);
  const embedVisible = useSyncExternalStore(subscribeEmbedVisibility, isEmbedVisible);
  // 原生拖放(左边一行、⋮⋮):拖着的时候内嵌网页让开指针;落点只在拖的过程中画,拖到窗口外松手、按 Esc 取消也收掉。
  useEffect(
    () =>
      shieldNativeDrags(
        document,
        hasDraggedScreenContent,
        () => {
          setBlockDropPreview(null);
          hideDropHighlight();
        }
      ),
    []
  );
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" {...handlers}>
      {/* @@@retained-screen — the screen stays mounted under Library & the other places: going back flips it visible,
          its chat blocks keep their live message windows (no remount, no refetch, no restyle of the whole list). */}
      <div style={onSessionView ? SHOWN_IN_PLACE : RETAINED_SURFACE_HIDDEN_STYLE}>
        {/* The frame itself hidden (another of gugu's tabs) hides the screen with it. */}
        <SurfaceShown shown={onSessionView && embedVisible}>
          <ScreenFrame />
        </SurfaceShown>
      </div>
      {recentSessions.map(({ projectId, sessionId }) => {
        // Beside an App the page is where the App is: on another of gugu's tabs this screen is not drawn, its blocks with it.
        const peeked = peek?.sessionId === sessionId && (!embedVisible || !onSessionView || !screenLayout.blockOfSession(sessionId));
        const blockId = onSessionView && !peeked ? (screenLayout.blockOfSession(sessionId) ?? null) : null;
        const corners = blockId ? screenLayout.corners(blockId) : { topLeft: false };
        return (
          <RetainedSessionPage
            key={sessionId}
            projectId={projectId}
            sessionId={sessionId}
            blockId={blockId}
            peekBox={peeked && peek ? peek.box : null}
            focused={peeked || (blockId !== null && mainFocused && screenLayout.focusedBlockId === blockId)}
            topLeft={corners.topLeft}
            multi={multi}
          />
        );
      })}
      {onSessionView && !screenLayout.layout && currentWindow ? <InWindowNotice windowId={currentWindow.id} /> : null}
      <DropHighlightLayer />
      {children}
    </div>
  );
});

/** 这屏唯一那块开到了单独的窗里:这里说一句它在哪,能切过去、能放回来(照原型)。 */
const InWindowNotice = observer(function InWindowNotice({ windowId }: { windowId: string }) {
  const { translate } = useSessionMessages();
  const window = auxWindows.windows.get(windowId);
  if (!window || window.content.kind !== 'session') return null;
  const { sessionId } = window.content;
  const title = sessionRegistry.get(sessionId)?.sessions.get(sessionId)?.data.title ?? '';
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-foreground-muted" data-in-window-notice="">
      <span>{translate('screen.inWindow', { title })}</span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => window.handle?.focus()}>
          {translate('screen.goToWindow')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => putBackFromWindow(windowId)}>
          {translate('screen.putBackHere')}
        </Button>
      </div>
    </div>
  );
});

/** One retained session page; see @@@retained-session-pages in recent-session-pages.ts. */
const RetainedSessionPage = memo(function RetainedSessionPage({
  projectId,
  sessionId,
  blockId,
  peekBox,
  focused,
  topLeft,
  multi,
}: SessionParams & { blockId: string | null; peekBox: HTMLElement | null; focused: boolean; topLeft: boolean; multi: boolean }) {
  // A block is drawn only while the frame is; a page peeked beside an App is drawn over the shell even when the frame is hidden.
  const embedVisible = useSyncExternalStore(subscribeEmbedVisibility, isEmbedVisible);
  const shown = (blockId !== null && embedVisible) || peekBox !== null;
  const pageRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => (pageRef.current && peekBox ? followBox(pageRef.current, peekBox) : undefined), [peekBox]);
  const place = useMemo(() => ({ blockId, focused, topLeft, multi }), [blockId, focused, topLeft, multi]);
  return (
    <div
      className="flex min-h-0 min-w-0 flex-col"
      ref={pageRef}
      style={blockId ? anchoredToBlock(blockId) : peekBox ? PEEKED_PAGE_STYLE : RETAINED_SURFACE_HIDDEN_STYLE}
      data-screen-page={blockId ?? undefined}
      // 在一块里按下 = 看这一块(导航跟到它的会话);已经是正看着的就什么都不做。
      onPointerDownCapture={blockId && !focused ? () => focusScreenBlock(blockId) : undefined}
    >
      <SurfaceShown shown={shown}>
        <ScreenBlockContext.Provider value={place}>
          <sessionView.WrapView projectId={projectId} sessionId={sessionId}>
            <WorkspaceContentLayout titlebarSlot={<sessionView.TitlebarSlot />} mainPanel={<sessionView.MainPanel />} />
          </sessionView.WrapView>
        </ScreenBlockContext.Provider>
      </SurfaceShown>
    </div>
  );
});

/** A shown retained surface lays out as if the wrapper were not there. */
const SHOWN_IN_PLACE: CSSProperties = { display: 'contents' };

const viewOf = (viewId: string) => (registeredViews() as unknown as Record<string, ViewDefinition<Record<string, unknown>>>)[viewId];
const paramsOf = (viewId: string) => (appState.navigation.viewParamsStore as Record<string, Record<string, unknown> | undefined>)[viewId] ?? {};

/** The page the workspace shows: the screen (its blocks), or another view drawn over it in its place. */
const PageArea = observer(function PageArea({ page }: { page: string }) {
  const onScreenView = isScreenView(page);
  const def = viewOf(page);
  const Wrap = (def.WrapView ?? Fragment) as ComponentType<{ children: ReactNode } & Record<string, unknown>>;
  const Titlebar = def.TitlebarSlot ?? NoTitlebar;
  const Main = def.MainPanel;
  return (
    <ScreenArea onScreenView={onScreenView} current={page === 'session' ? (paramsOf(page) as SessionParams) : null}>
      {onScreenView ? null : (
        <Wrap {...paramsOf(page)}>
          <WorkspaceContentLayout titlebarSlot={<Titlebar />} mainPanel={<Main />} />
        </Wrap>
      )}
    </ScreenArea>
  );
});

/** A modal view (@@@page-modal), in the same modal frame as Settings (@@@page-modal-frame). */
const PageModal = observer(function PageModal({ viewId, onClose }: { viewId: string; onClose: () => void }) {
  useLayoutEffect(() => {
    runInAction(() => pageModalOpen.set(true));
    return () => runInAction(() => pageModalOpen.set(false));
  }, []);
  const def = viewOf(viewId);
  const Wrap = (def.WrapView ?? Fragment) as ComponentType<{ children: ReactNode } & Record<string, unknown>>;
  const Titlebar = def.TitlebarSlot ?? NoTitlebar;
  const Main = def.MainPanel;
  return (
    // In the session page's mount (its skin, and the layer an App's live page is drawn in); the frame rises above the
    // shell while it is open (MainLayout, pageModalOpen).
    <Sheet onClose={onClose} {...PAGE_MODAL_FRAME} testId="page-modal" ariaLabel={viewId}>
      <div className="flex min-h-0 flex-1 flex-col" data-page-modal={viewId}>
        <PageModalClose.Provider value={onClose}>
          <Wrap {...paramsOf(viewId)}>
            <WorkspaceContentLayout titlebarSlot={<Titlebar />} mainPanel={<Main />} />
          </Wrap>
        </PageModalClose.Provider>
      </div>
    </Sheet>
  );
});

function NoTitlebar() {
  return null;
}
