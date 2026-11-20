import { Folder, Globe } from '@/lib/icons';
import { openApp } from '@/components/appSlot/useOpenApp';
import { OpenSuperseded, openLinkTarget } from '@/lib/guguLinks';
import { notify } from '@/lib/notices';
import { messageForUser } from '@/lib/userFacingError';
import { useBrowserAnnotations } from './browser-annotations';
import { isAnnotationConversation, type AnnotationConversation } from '@shared/browser-annotation';
import { observer } from 'mobx-react-lite';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { usePaneContext } from '@renderer/features/tabs/pane-context';
import { useSessionViewContext, useWorkspaceSurface, useWorkspaceViewModel } from '@renderer/features/sessions/session-view-context';
import { events, rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import {
  BROWSER_TAB_URL_OPTIONS,
  normalizeBrowserUrl,
  normalizeBrowserZoomFactor,
} from '@shared/browser';
import { tabNavigationShortcutChannel } from '@shared/events/appEvents';
import { browserFocusedChannel } from '@shared/events/browserEvents';
import { browserControlsRegistry } from './browser-controls-registry';
import {
  browserLoadErrorCode,
  describeBrowserLoadError,
  type BrowserLoadErrorPresentation,
} from './browser-load-error';
import { decideBrowserReload } from './browser-navigation-controls';
import { fitBrowserPageToPane } from './browser-page-fit';
import { browserSessionStore } from './browser-session-store';
import { popupClaims } from './browser-popup-claims';
import { installedExtensionsStore } from '../extensions/installed-extensions-store';
import { ExtensionMark } from '../extensions/extension-mark';
import { openPanelItem } from '../chats/chat-tabs/chat-layouts';
import { folderItem, WORKSPACE_APP_KIND } from '../chats/chat-tabs/chat-panel-item';
import { openFileInSessionEditor } from '../sessions/stores/open-file-in-file-editor';
import { BrowserStartTerminalOptions } from './browser-start-terminal-options';
import { BrowserWorkspaceStartContent, type BrowserWorkspaceStart } from './browser-workspace-start-page';
import { BrowserStartPage } from './browser-start-page';
import { useSessionWorkspaceActions, type WorkspacePanelAction } from '../sessions/pane-empty-state';
import { BrowserToolbar } from './browser-toolbar';
import { BrowserUrlResolverContext } from './browser-url-resolver';
import { canOpenBrowserUrlExternally, openBrowserUrlExternally } from './browser-toolbar-actions';
import { createBrowserPageAdapter, type BrowserPageHandle } from './browser-page-handle';
import { BrowserPageSurface } from './browser-page-surface';
import { StandaloneBrowserPageSurface } from './standalone-browser-page-surface';
import type { BrowserTabResource } from './browser-tab-resource';
import { bindBrowserPageEvents } from './browser-webview-events';
import type { BrowserWebviewAdapter } from './browser-webview-types';

function reportRecentToolError(error: unknown): void {
  if (!(error instanceof OpenSuperseded)) notify({ tier: 'error', title: messageForUser(error) });
}

export const BrowserPane = observer(function BrowserPane({
  browserId,
  visible,
  focused = true,
  startTabId,
}: {
  browserId: string;
  visible: boolean;
  startTabId?: string;
  /** 并排时屏上两页,只有拿着焦点的那页算(spec session-page「并排」)。 */
  focused?: boolean;
}) {
  const { pane, paneId } = usePaneContext();
  const surface = useWorkspaceSurface();
  const session = useWorkspaceViewModel();
  const { projectId, sessionId } = useSessionViewContext();
  const conversation = isAnnotationConversation(pane.ctx.place) ? pane.ctx.place : undefined;
  const { translate } = useSessionMessages();
  const openInStart = (kind: string) => startTabId
    ? surface.paneLayout.open(kind, {}, { from: startTabId, intent: 'navigate', inPlace: true })
    : surface.paneLayout.openBeside(kind, {}, paneId);
  const available = useSessionWorkspaceActions(
    () => surface.paneLayout.openBeside('browser', {}, paneId), openInStart,
  );
  const startPageActions = startTabId ? available.map((item): WorkspacePanelAction => {
    if (item.id === WORKSPACE_APP_KIND) return { ...item, id: 'files', section: 'builtin', label: translate('workspace.files'), shortcutSettingsKey: 'session.sidebarFiles' };
    if (item.id === 'review') return { ...item, shortcutSettingsKey: 'session.sidebarChanges', onClick: () => openInStart('review') };
    if (item.id === 'ports') return { ...item, onClick: () => openInStart('remote-ports') };
    if (item.id === 'browser') return { ...item, shortcutSettingsKey: 'session.openBrowser' };
    if (item.id === 'terminal') return {
      ...item,
      shortcutSettingsKey: 'session.newTerminal',
      onClick: () => void session.openTerminalAsTab(undefined, paneId, startTabId),
      trailing: !item.disabled && <BrowserStartTerminalOptions projectId={projectId} launch={(shell) => void session.openTerminalAsTab(shell, paneId, startTabId)} />,
    };
    return item;
  }) : available;
  const workspaceStart: BrowserWorkspaceStart | undefined = startTabId ? {
    ctx: pane.ctx,
    openRecent: (item) => {
      if (item.kind === 'folder') openInStart(WORKSPACE_APP_KIND);
      if (item.kind === 'file') {
        void openFileInSessionEditor(projectId, sessionId, item.path, { from: startTabId, intent: 'navigate' }).catch(reportRecentToolError);
      }
    },
  } : undefined;
  return (
    <BrowserPaneContent
      conversation={conversation}
      browserId={browserId}
      visible={visible}
      focused={focused}
      onFocused={() => {
        // 点进了这个网页:页签的焦点跟过来(两个网页并排时 = 点的那一边,后退、刷新、⌘\ 都认它)。
        const tab = pane.resolvedTabs.find(
          (t) => t.kind === 'browser' && (t.resource as BrowserTabResource).browserId === browserId
        );
        if (tab && pane.resolvedActiveTabId !== tab.tabId) pane.setActiveTab(tab.tabId);
      }}
      startPageActions={startPageActions}
      workspaceStart={workspaceStart}
      devServerUrls={[...surface.previewServerUrls]}
      onNavigateTab={(direction) => {
        if (direction === 'next') pane.setNextTabActive();
        else pane.setPreviousTabActive();
      }}
    />
  );
});

export const ChatBrowserPane = observer(function ChatBrowserPane({ chatId, tabId, browserId, visible, focused, workspaceStart }: {
  chatId: string;
  tabId: string;
  browserId: string;
  visible: boolean;
  focused: boolean;
  workspaceStart: boolean;
}) {
  const { pane } = usePaneContext();
  const conversation = isAnnotationConversation(pane.ctx.place) ? pane.ctx.place : undefined;
  const { translate } = useSessionMessages();
  const openFolder = () => openPanelItem(chatId, folderItem(), { from: tabId });
  const startPageActions: WorkspacePanelAction[] = [
    { id: 'files', label: translate('workspace.files'), icon: <Folder className="size-3.5" />, shortcutSettingsKey: 'session.sidebarFiles', onClick: openFolder },
    { id: 'browser', label: translate('workspace.browser'), icon: <Globe className="size-3.5" />, shortcutSettingsKey: 'session.openBrowser', onClick() {} },
    ...installedExtensionsStore.openableApps.map((app): WorkspacePanelAction => ({
      id: app.extensionId, label: app.name, icon: <ExtensionMark iconDataUrl={app.iconDataUrl} />,
      section: 'extensions',
      onClick: () => openApp(app.extensionId, chatId, tabId),
    })),
  ];
  return <BrowserPaneContent conversation={conversation} browserId={browserId} visible={visible} focused={focused} devServerUrls={[]}
    onFocused={() => pane.setActiveTab(tabId)}
    onNavigateTab={(direction) => direction === 'next' ? pane.setNextTabActive() : pane.setPreviousTabActive()}
    startPageActions={startPageActions}
    workspaceStart={workspaceStart ? {
      ctx: pane.ctx,
      openRecent: (item) => {
        if (item.kind === 'folder') openFolder();
        if (item.kind === 'chat-file') {
          void openLinkTarget({ kind: 'file', itemId: item.itemId }, { from: { chatId, tabId }, fileName: item.title, intent: 'navigate' }).catch(reportRecentToolError);
        }
      },
    } : undefined}
  />;
});

export const StandaloneBrowserPane = observer(function StandaloneBrowserPane({
  browserId,
  visible,
}: {
  browserId: string;
  visible: boolean;
}) {
  return <BrowserPaneContent browserId={browserId} visible={visible} devServerUrls={[]} />;
});

const BrowserPaneContent = observer(function BrowserPaneContent({
  conversation,
  browserId,
  visible,
  focused = true,
  devServerUrls,
  startPageActions,
  workspaceStart,
  onNavigateTab,
  onFocused,
}: {
  conversation?: AnnotationConversation;
  browserId: string;
  visible: boolean;
  focused?: boolean;
  onFocused?: () => void;
  devServerUrls: string[];
  startPageActions?: WorkspacePanelAction[];
  workspaceStart?: BrowserWorkspaceStart;
  onNavigateTab?: (direction: 'next' | 'previous') => void;
}) {
  const { translate } = useSessionMessages();
  const session = browserSessionStore.getSession(browserId);
  const focusUrlRef = useRef<() => void>(() => {});
  const [adapter, setAdapter] = useState<BrowserWebviewAdapter | null>(null);
  /** #7274 页签里那张网页(主进程持有的 view)在这边的代理;挂好之前是 null。 */
  const [page, setPage] = useState<BrowserPageHandle | null>(null);
  const [pageMount, setPageMount] = useState<{
    browserId: string;
    partition: string;
    src: string;
  } | null>(null);
  /** 网页还没挂好时要去的地址:挂好立刻载入。 */
  const pendingLoad = useRef<string | null>(null);
  const [isRegistered, setIsRegistered] = useState(false);
  const BrowserSurface = session?.kernel === 'standalone' ? StandaloneBrowserPageSurface : BrowserPageSurface;
  const resolveUrl = useContext(BrowserUrlResolverContext);
  /** 有地址改写时,页签自带的首个地址先记在这里,挂好之后经改写再加载(见下方 loadUrl 之后那一段)。 */
  const pendingInitialUrl = useRef<string | null>(null);
  const sessionBrowserId = session?.browserId;
  const sessionPartition = session?.partition;
  // 起始页 = 这张网页是空白页。❌ 再加「没在加载」:新页签挂网页时会先载一次 about:blank,那几十毫秒里起始页一撤,
  // 底下的原生网页就露出来(深色外观下 about:blank 是黑的)。真去别的地址时 currentUrl 先变,起始页照常让开。
  const showStartPage = session?.currentUrl === 'about:blank';
  const loadError = session && !session.isLoading ? session.loadError : undefined;
  const loadErrorUrl = loadError ? (loadError.url ?? session?.currentUrl ?? '') : '';
  const loadErrorPresentation = useMemo<BrowserLoadErrorPresentation | undefined>(
    () => (loadError ? describeBrowserLoadError(loadError, loadErrorUrl, translate) : undefined),
    [loadError, loadErrorUrl, translate]
  );
  const canOpenLoadErrorExternal = useMemo(
    () => (loadError ? canOpenBrowserUrlExternally(loadErrorUrl) : false),
    [loadError, loadErrorUrl]
  );

  useEffect(() => {
    if (!sessionBrowserId || !sessionPartition || !session) {
      setPageMount(null);
      return;
    }
    setPageMount((current) => {
      if (current?.browserId === sessionBrowserId && current.partition === sessionPartition) {
        return current;
      }
      // #6264 别的机器上的会话(有地址改写):首个地址也要先经改写 —— `localhost:3000` 指的是那台机器,
      // ❌ 直接当这台电脑上的地址加载。先挂空白页,改写好了再加载。
      const deferInitial = resolveUrl !== null && session.currentUrl !== 'about:blank';
      pendingInitialUrl.current = deferInitial ? session.currentUrl : null;
      return {
        browserId: sessionBrowserId,
        partition: sessionPartition,
        src: deferInitial ? 'about:blank' : session.currentUrl,
      };
    });
  }, [resolveUrl, session, sessionBrowserId, sessionPartition]);

  // #7191 页签开在哪条会话里,一并告诉主进程:那条会话的 agent 只拿得到它自己会话的页签。
  const annotations = useBrowserAnnotations({ conversation, browserId, visible, available: !!adapter && !showStartPage && !loadError,
    inspect: (query, capture) => rpc.browser.inspectAnnotation({ browserId, conversation: conversation!, query, capture }) });
  useEffect(() => {
    if (!sessionBrowserId || !sessionPartition) return;
    let disposed = false;
    setIsRegistered(false);
    void rpc.browser
      .registerSession({
        browserId: sessionBrowserId,
        partition: sessionPartition,
        kernel: session?.kernel,
        url: session?.currentUrl,
        ...(conversation ? { conversation } : {}),
        // A tab opened to show a window the standalone Chrome made stays standalone: no built-in tab can show that window.
        ...(popupClaims.has(sessionBrowserId) ? { adoptsWindow: true } : {}),
      })
      .then((result) => {
        if (!disposed) {
          if (result.success) browserSessionStore.updateSession(sessionBrowserId, { kernel: result.kernel });
          setIsRegistered(result.success);
        }
      }).catch(reportRecentToolError);
    return () => {
      disposed = true;
      setIsRegistered(false);
    };
  }, [sessionBrowserId, sessionPartition, conversation]);

  useEffect(() => {
    return () => {
      void rpc.browser.setActiveBrowser(null);
    };
  }, []);

  useEffect(() => {
    if (!visible || !focused || !sessionBrowserId || adapter === null) return;
    void rpc.browser.setActiveBrowser(sessionBrowserId);
  }, [adapter, sessionBrowserId, visible, focused]);

  const onFocusedRef = useRef(onFocused);
  onFocusedRef.current = onFocused;
  useEffect(() => {
    if (!sessionBrowserId) return;
    return events.on(browserFocusedChannel, ({ browserId: focusedId }) => {
      if (focusedId === sessionBrowserId) onFocusedRef.current?.();
    });
  }, [sessionBrowserId]);

  useEffect(() => {
    if (!visible || !sessionBrowserId || !onNavigateTab) return;
    return events.on(tabNavigationShortcutChannel, (event) => {
      if (event.source.kind !== 'browser' || event.source.browserId !== sessionBrowserId) return;
      onNavigateTab(event.direction);
    });
  }, [sessionBrowserId, onNavigateTab, visible]);

  const resolveGeneration = useRef(0);

  const loadResolvedUrl = useCallback(
    (url: string) => {
      if (!sessionBrowserId) return;
      browserSessionStore.updateSession(sessionBrowserId, {
        currentUrl: url,
        faviconUrl: null,
        isLoading: true,
        loadError: null,
      });
      if (page) {
        void page.loadURL(url);
        return;
      }
      pendingLoad.current = url;
    },
    [page, sessionBrowserId]
  );

  useEffect(() => {
    const url = pendingLoad.current;
    if (!page || !url) return;
    pendingLoad.current = null;
    void page.loadURL(url);
  }, [page]);

  // #6264 别的机器上的会话:localhost 先经 SSH 转到那台机器上,再加载转好的地址(见 browser-url-resolver.ts)。
  const loadUrl = useCallback(
    (url: string) => {
      if (!sessionBrowserId) return;
      if (!resolveUrl) {
        loadResolvedUrl(url);
        return;
      }
      const generation = ++resolveGeneration.current;
      browserSessionStore.updateSession(sessionBrowserId, { currentUrl: url, isLoading: true, loadError: null });
      void resolveUrl(url, sessionBrowserId).then((resolution) => {
        // 等转发的时候人又去了别的地址:这一次的结果作废。
        if (generation !== resolveGeneration.current) return;
        if ('url' in resolution) {
          loadResolvedUrl(resolution.url);
          return;
        }
        browserSessionStore.updateSession(sessionBrowserId, {
          currentUrl: url,
          isLoading: false,
          loadError: { description: resolution.error, url },
        });
      });
    },
    [loadResolvedUrl, resolveUrl, sessionBrowserId]
  );

  useEffect(() => {
    const initial = pendingInitialUrl.current;
    if (!initial || !pageMount) return;
    pendingInitialUrl.current = null;
    loadUrl(initial);
  }, [loadUrl, pageMount]);

  const navigateTo = useCallback(
    (url: string): boolean => {
      const normalized = normalizeBrowserUrl(url, BROWSER_TAB_URL_OPTIONS);
      if (!normalized.ok) return false;
      loadUrl(normalized.url);
      return true;
    },
    [loadUrl]
  );

  const goBack = useCallback(() => {
    if (!adapter?.canGoBack()) return;
    adapter.goBack();
  }, [adapter]);

  const goForward = useCallback(() => {
    if (!adapter?.canGoForward()) return;
    adapter.goForward();
  }, [adapter]);

  const reload = useCallback(() => {
    if (!session) return;
    // 加载失败那一页上的「重新加载」:照原来要去的地址再走一遍(含远端地址改写),❌ 重载那张错误页。
    if (loadError) {
      loadUrl(loadErrorUrl || session.currentUrl);
      return;
    }
    const decision = decideBrowserReload({
      currentUrl: session.currentUrl,
      isLoading: session.isLoading,
      hasAdapter: adapter !== null,
    });
    if (decision.kind === 'reload-adapter') adapter?.reload();
    if (decision.kind === 'stop-adapter') adapter?.stop();
    if (decision.kind === 'retry-url') loadUrl(decision.url);
  }, [adapter, loadError, loadErrorUrl, loadUrl, session]);

  const forceReload = useCallback(() => {
    if (adapter) {
      adapter.reloadIgnoringCache();
      return;
    }
    reload();
  }, [adapter, reload]);

  const setZoomFactor = useCallback(
    (factor: number) => {
      if (!sessionBrowserId) return;
      const zoomFactor = normalizeBrowserZoomFactor(factor);
      browserSessionStore.updateSession(sessionBrowserId, {
        zoomFactor,
        // 用户自己调了 —— 从此这个页签的缩放归他,「装进面板」那条兜底不再插手(见 browser-page-fit.ts)。
        zoomSource: 'user',
      });
      adapter?.setZoomFactor(zoomFactor);
    },
    [adapter, sessionBrowserId]
  );

  /** 「适应宽度」:把缩放交还给自动挡,并按当前面板宽度立刻重算一次。 */
  const fitToWidth = useCallback(() => {
    if (!sessionBrowserId || !page) return;
    browserSessionStore.updateSession(sessionBrowserId, { zoomSource: 'auto' });
    void fitBrowserPageToPane(sessionBrowserId, page, { remeasure: true });
  }, [page, sessionBrowserId]);

  // 网页挂上 / 换了一张:先清掉旧的操作入口,等它就绪(dom-ready)再接上。
  const onPageHandle = useCallback((next: BrowserPageHandle | null) => {
    setPage(next);
    setAdapter(null);
  }, []);

  useEffect(() => {
    if (!sessionBrowserId || !page) return;
    return bindBrowserPageEvents(sessionBrowserId, page, {
      onDomReady: () => setAdapter(createBrowserPageAdapter(page)),
    });
  }, [page, sessionBrowserId]);

  useEffect(() => {
    if (!sessionBrowserId) return;
    return browserControlsRegistry.register(sessionBrowserId, {
      adapter,
      focusUrl: () => focusUrlRef.current(),
    });
  }, [adapter, sessionBrowserId]);

  // 面板宽度变了(拖分隔条、收起聊天栏、改窗口大小),自动缩放要跟着重算 —— 拖宽之后还停在
  // 34%,就成了一张平白无故的小图。用记住的原始宽度算,❌ 不重量(理由见 browser-page-fit.ts)。
  //
  // 隔一帧再算:ResizeObserver 在**每一帧**都会响,拖动过程中一路改缩放会让内嵌页疯狂重排。
  useEffect(() => {
    if (!sessionBrowserId || !page) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        void fitBrowserPageToPane(sessionBrowserId, page);
      });
    });
    observer.observe(page.element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [page, sessionBrowserId]);

  if (!session) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-background text-sm text-foreground-muted">
        {translate('browser.sessionUnavailable')}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <BrowserToolbar
        session={session}
        adapter={adapter}
        workspaceStart={showStartPage && !!workspaceStart}
        annotationAction={annotations.toolbar}
        // 空白页一露出来就把光标放进地址栏;并排时露出来的是另一页,❌ 把焦点从用户正看的那页抢走。
        autoFocusUrl={showStartPage && focused}
        onNavigate={navigateTo}
        onGoBack={goBack}
        onGoForward={goForward}
        onReload={reload}
        onForceReload={forceReload}
        onSetZoomFactor={setZoomFactor}
        onFitToWidth={fitToWidth}
        onFocusUrl={(focus) => {
          focusUrlRef.current = focus;
        }}
      />
      {/* 网页区固定浅色:emlight 给会话页那套名字,data-theme="light" 让它们接到的咕咕 token 也是浅色那一套(宿主是深色时也一样)。 */}
      <div data-theme="light" className="emlight relative min-h-0 flex-1 bg-background">
        {annotations.overlay}
        {pageMount && isRegistered ? (
          // #7274 网页一直挂着(加载失败页、起始页都盖在它上面,❌ 代替它):换了位置、出错重试都接着用同一张,
          // 会话的 agent 也一直有页面可操作(#7191)。被这些盖住时网页自己让开(见 browser-page-occlusion.ts)。
          <BrowserSurface
            key={`${pageMount.browserId}:${pageMount.partition}`}
            browserId={pageMount.browserId}
            partition={pageMount.partition}
            initialUrl={pageMount.src}
            visible={visible}
            onHandle={onPageHandle}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-foreground-muted">
            {translate('browser.preparingSession')}
          </div>
        )}
        {loadError && loadErrorPresentation ? (
          <div className="absolute inset-0 bg-background">
            <BrowserLoadErrorView
              url={loadErrorUrl}
              presentation={loadErrorPresentation}
              code={browserLoadErrorCode(loadError, translate)}
              canOpenExternal={canOpenLoadErrorExternal}
              onReload={reload}
              onOpenExternal={() => openBrowserUrlExternally(loadErrorUrl)}
            />
          </div>
        ) : null}
        {/* 起始页盖在空白网页上面,❌ 代替它:网页得一直在,会话的 agent 才有页面可操作(#7191)。
            agent / 人一打开地址,起始页就自己让开。 */}
        {showStartPage && !loadError ? (
          <div className="absolute inset-0 bg-background">
            {workspaceStart
              ? <BrowserWorkspaceStartContent config={workspaceStart} actions={startPageActions ?? []} onOpenUrl={navigateTo} onFocusUrl={() => focusUrlRef.current()} />
              : <BrowserStartPage actions={startPageActions} devServerUrls={devServerUrls} onOpenUrl={navigateTo} />}
          </div>
        ) : null}
      </div>
    </div>
  );
});

function BrowserLoadErrorView({
  presentation,
  code,
  url,
  canOpenExternal,
  onReload,
  onOpenExternal,
}: {
  presentation: BrowserLoadErrorPresentation;
  code: string | null;
  url: string;
  canOpenExternal: boolean;
  onReload: () => void;
  onOpenExternal: () => void;
}) {
  const { translate } = useSessionMessages();
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-auto p-8">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <h1 className="text-base font-medium text-foreground">{presentation.heading}</h1>
        <p className="text-sm text-foreground-muted" title={url}>
          {presentation.detail}
          {code && <span className="text-foreground-tertiary-muted"> ({code})</span>}
        </p>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onReload}>
            {translate('browser.reload')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canOpenExternal}
            onClick={onOpenExternal}
          >
            {translate('browser.openExternally')}
          </Button>
        </div>
      </div>
    </div>
  );
}
