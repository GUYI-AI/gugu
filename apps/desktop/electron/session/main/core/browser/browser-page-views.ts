import { BrowserWindow, WebContentsView, type WebContents } from 'electron';
import { getMainWindow } from '@main/app/window';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { AUX_WINDOW_NAME_PREFIX } from '@shared/aux-window';
import { BROWSER_TAB_URL_OPTIONS, normalizeBrowserUrl, normalizeBrowserZoomFactor } from '@shared/browser';
import { BROWSER_PAGE_MEASURE_SCRIPT, parseBrowserPageLayout, type BrowserPageLayout } from '@shared/browser-page-layout';
import {
  browserPageEventChannel,
  type BrowserPageEventType,
  type BrowserPageMode,
  type BrowserPageState,
} from '@shared/events/browserEvents';
import { BROWSER_PINCH_MAX_LEVEL } from '@shared/preview/pinch-zoom';
import { hardenWebPreferences } from '../../../../devtools-lock';
import { raiseWindowLayers } from '../../../../window-layers';
import { wirePageDialogs, type PageDialogs } from './browser-page-dialogs';
import { BrowserPageRuntime } from './browser-page-runtime';
import { browserWebContentsRegistry } from './browser-webcontents-registry';
import { assertCredentialAgentContents, assertCredentialNativeAdoption, credentialAgentPartitionBlocked } from './credential-isolation-registry';
import type { CredentialUseBinding } from './credential-use-contract';
import { isPreviewPageUrl, validateBrowserPageMount } from './webview-security';
import { nativePagePresentation } from './page-presentation';
import type { TaskPagePresentation } from '@shared/extensions/task-page-protocol';

/**
 * #7274 会话页浏览器页签里的网页:主进程持有的 `WebContentsView`,盖在咕咕窗口里页签那一块上。
 *
 * ## 为什么不是 `<webview>`
 *
 * `<webview>` 是嵌在咕咕页面里的内层 WebContents,和咕咕界面共用一棵焦点树。Chromium 收到任何一下按下
 * (真鼠标、CDP 合成、`sendInputEvent`,一视同仁)都会 `FocusOwningWebContents` 把这棵树的焦点挪进网页,
 * 咕咕界面随之失焦 —— 人在聊天框里正拼着的中文被强行结束、成了一串字母,后面打的字落进网页
 * (实测 exp8:四种点法 × 有无 focus emulation,宿主一律 blur + compositionend)。独立的 view 是窗口里另一个
 * 顶层 WebContents,agent 的点击只动它自己那棵树:宿主 0 事件、拼字不断、真键盘的下一个键照旧落在聊天框,
 * 网页那边点击仍是 isTrusted、输入框照常聚焦(exp8 / exp9)。VS Code 的内置浏览器同一个做法。
 *
 * ## 代价,与这里怎么接住
 *
 * - **网页画在界面之上**:页签那一块在界面里只是一个空的占位(browser-page-surface.tsx),它量好自己在窗口里的
 *   位置报过来,这里把 view 摆上去。咕咕自己的浮层(菜单、弹窗、起始页…)压到网页上时,页签报 `occluded`:
 *   view 收起、占位换成一张网页截图,浮层照常盖在上面。
 * - **agent 的鼠标与快捷消息按钮**是窗口里的两层(window-layers.ts);鼠标只在动作期间露出,消息按钮跟随页签。
 *   运行控制属于 Agent 会话。落在鼠标层上的真实鼠标输入原样交给网页,不暂停 agent。
 * - **后台页仍归原宿主**:view 隐藏,不迁移到额外窗口。视口初始化与截图所需的出帧由
 *   browser-page-runtime.ts 管理;显示位置、会话控制权和渲染需求分别维护。
 * - **导航不抢焦点**:`focusOnNavigation: false`,网页换页时不把焦点拉过去(electron#42578 / #49425)。
 *
 * ⚠️ 网页销毁后不再碰它:对已销毁的 webContents 调方法会让整个 app 崩溃(t3code#9067)。
 */

type Rect = { x: number; y: number; width: number; height: number };

type BrowserPage = {
  browserId: string;
  partition: string;
  view: WebContentsView;
  webContents: WebContents;
  runtime: BrowserPageRuntime;
  /** 占位所在那扇窗的名字:主窗是空串,单独成窗的那几扇是 `gugu-aux:<id>`。 */
  windowName: string;
  /** 页签量来的位置(那扇窗内容区的 DIP)。 */
  rect: Rect | null;
  mode: BrowserPageMode;
  fullscreen: boolean;
  ready: boolean;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  releaseExpired: boolean;
  dialogs: PageDialogs | null;
  /** An App's host-authorized presentation lease, independent of the browser tab's box. */
  presentation?: { host: BrowserWindow; rect: Rect | null };
  presentationListeners: Set<() => void>;
};

/** 占位卸下(页签挪去别的窗、分栏重排)后,网页留这么久等它在新位置挂回来 —— 挪动 ❌ 重新载入网页。 */
const RELEASE_GRACE_MS = 5_000;

const pages = new Map<string, BrowserPage>();
const hostsWired = new WeakSet<BrowserWindow>();

function emitPageEvent(page: BrowserPage, type: BrowserPageEventType, detail: Record<string, unknown> = {}): void {
  if (page.webContents.isDestroyed() || page.runtime.initializing) return;
  try { assertCredentialAgentContents(page.webContents); } catch { return; }
  events.emit(browserPageEventChannel, { browserId: page.browserId, type, detail, state: pageState(page.webContents) });
}

function pageState(webContents: WebContents): BrowserPageState {
  return {
    url: webContents.getURL(),
    title: webContents.getTitle(),
    canGoBack: webContents.navigationHistory.canGoBack(),
    canGoForward: webContents.navigationHistory.canGoForward(),
  };
}

function resolveHost(windowName: string): BrowserWindow | null {
  if (!windowName.startsWith(AUX_WINDOW_NAME_PREFIX)) return getMainWindow();
  return (
    BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.webContents.mainFrame.name === windowName) ??
    null
  );
}

function wireHost(host: BrowserWindow): void {
  if (hostsWired.has(host)) return;
  hostsWired.add(host);
  const reposition = () => {
    for (const page of pages.values()) {
      if (page.runtime.host !== host) continue;
      page.dialogs?.pageShown();
      notifyPresentation(page);
    }
  };
  host.on('move', reposition);
  host.on('resize', reposition);
  host.on('show', reposition);
  host.on('hide', reposition);
  host.on('minimize', reposition);
  host.on('restore', reposition);
  // 窗关了(单独成窗的那扇被关掉):上面的网页先放手、留一会儿 —— 页签挪回别的窗会接着用;没人要就关掉。
  host.on('closed', () => {
    for (const page of [...pages.values()]) {
      if (page.runtime.host !== host) continue;
      page.runtime.moveTo(null);
      notifyPresentation(page);
      page.dialogs?.hostChanged();
      releaseBrowserPage(page.browserId);
    }
  });
  // 界面整页重载 / 换页:画在上面的那些网页没了主人 —— 一并关掉,❌ 留一块没人管的网页盖在新界面上。
  host.webContents.on('did-start-navigation', (event) => {
    if (!event.isMainFrame || event.isSameDocument) return;
    for (const page of [...pages.values()]) if (page.runtime.host === host) destroyBrowserPage(page.browserId);
  });
}

function contentRect(host: BrowserWindow): Rect {
  const [width, height] = host.getContentSize();
  return { x: 0, y: 0, width, height };
}

function pageIsShown(page: BrowserPage): boolean {
  if (page.presentation) return !!page.presentation.rect && page.presentation.rect.width > 0 && page.presentation.rect.height > 0;
  const rect = page.rect;
  return page.fullscreen || (page.mode === 'shown' && !!rect && rect.width > 0 && rect.height > 0);
}

/** 页面始终留在所属宿主;只改变视口与显示状态。 */
function applyLayout(page: BrowserPage): void {
  if (page.webContents.isDestroyed()) return;
  if (page.presentation) {
    const { host, rect } = page.presentation;
    if (host.isDestroyed()) return;
    page.runtime.moveTo(host); page.runtime.layout(rect, !!rect && rect.width > 0 && rect.height > 0);
    page.dialogs?.pageShown(); notifyPresentation(page); return;
  }
  const host = page.runtime.host;
  if (!host || host.isDestroyed()) return;
  const sized = page.rect !== null && page.rect.width > 0 && page.rect.height > 0;
  let shown = pageIsShown(page);
  try { assertCredentialAgentContents(page.webContents); } catch { shown = false; }
  // 先定大小再挂上去:挂上的那一帧就在新位置。
  page.runtime.layout(page.fullscreen ? contentRect(host) : sized ? page.rect : null, shown);
  page.dialogs?.pageShown();
  notifyPresentation(page);
}

/** 人此刻看得见这张网页:挂在窗口上、那扇窗露着。 */
function onScreen(page: BrowserPage): boolean {
  const host = page.runtime.host;
  return pageIsShown(page) && !!host && !host.isDestroyed() && host.isVisible() && !host.isMinimized();
}

export type MountBrowserPageResult =
  | { success: true; reused: boolean; ready: boolean; state: BrowserPageState }
  | { success: false; error: string };

/**
 * 页签的占位挂上了:还没有这张网页就建一张并载入 `url`;已经有(页签挪了位置、换了窗)就接着用,❌ 重新载入。
 */
export function mountBrowserPage(args: {
  browserId: string;
  partition: string;
  url: string;
  windowName: string;
}): MountBrowserPageResult {
  if (credentialAgentPartitionBlocked(args.partition)) return { success: false, error: 'credential-partition-isolated' };
  const validation = validateBrowserPageMount(
    { partition: args.partition, src: args.url },
    browserWebContentsRegistry.registeredPartitions
  );
  if (!validation.ok) return { success: false, error: validation.reason };
  if (!browserWebContentsRegistry.isRegistered(args.browserId, args.partition)) {
    return { success: false, error: 'unregistered-browser' };
  }

  let page = pages.get(args.browserId);
  if (page && (page.partition !== args.partition || page.webContents.isDestroyed())) {
    destroyBrowserPage(args.browserId);
    page = undefined;
  }
  if (page) {
    if (page.releaseTimer) clearTimeout(page.releaseTimer);
    page.releaseTimer = null;
    page.releaseExpired = false;
    moveToHost(page, args.windowName);
    return { success: true, reused: true, ready: page.ready, state: pageState(page.webContents) };
  }

  page = createBrowserPage(args);
  installBrowserPage(page);
  navigatePage(page, validation.url);
  return { success: true, reused: false, ready: false, state: pageState(page.webContents) };
}

function createBrowserPage(args: { browserId: string; partition: string; windowName: string }): BrowserPage {
  const view = new WebContentsView({
    // 锁定态(生产包)下 DevTools 一并关掉,同咕咕别的窗口(devtools-lock.ts)。
    webPreferences: hardenWebPreferences({
      partition: args.partition,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      // 网页换页时 ❌ 把焦点拉过去(人可能正在聊天框里打字)。
      focusOnNavigation: false,
    }),
  });
  view.setBackgroundColor('#ffffff');
  const webContents = view.webContents;
  const runtime = new BrowserPageRuntime(view, () => {
    const current = pages.get(args.browserId);
    if (current?.runtime === runtime && current.releaseExpired) destroyBrowserPage(args.browserId);
  });
  const page: BrowserPage = {
    browserId: args.browserId,
    partition: args.partition,
    view,
    webContents,
    runtime,
    windowName: args.windowName,
    rect: null,
    mode: 'background',
    fullscreen: false,
    ready: false,
    releaseTimer: null,
    releaseExpired: false,
    presentationListeners: new Set(),
    dialogs: null,
  };
  return page;
}

function installBrowserPage(page: BrowserPage): void {
  browserWebContentsRegistry.adoptPageWebContents(page.browserId, page.webContents, {
    window: () => (page.runtime.host && !page.runtime.host.isDestroyed() ? page.runtime.host : null),
    origin: () => (page.fullscreen ? { x: 0, y: 0 } : { x: page.rect?.x ?? 0, y: page.rect?.y ?? 0 }),
  });
  // A synchronous host callback during adoption can revoke/retire this very candidate.
  assertCredentialNativeAdoption(page.webContents);
  pages.set(page.browserId, page);
  wirePage(page);
  moveToHost(page, page.windowName);
}

/** Capture presentation before retirement; never retain DOM, snapshots, URL/query or old observers.
 * The returned native slot is private to the fixed host and is not an Agent tool or approval.
 */
export function captureCredentialBrowserSlot(binding: CredentialUseBinding) {
  const original = livePage(binding.browserId);
  if (!original || !browserWebContentsRegistry.isRegisteredForSession(binding.browserId, binding.sessionId, original.partition)) {
    throw new Error('credential_handoff_target_unavailable');
  }
  const registration = browserWebContentsRegistry.registrationIdentity(binding.browserId);
  const presentation = { browserId: original.browserId, partition: original.partition, windowName: original.windowName,
    rect: original.rect ? { ...original.rect } : null, mode: original.mode };
  let created: BrowserPage | undefined;
  const assertCurrent = () => {
    const current = pages.get(binding.browserId);
    const host = resolveHost(presentation.windowName);
    if (!registration || browserWebContentsRegistry.registrationIdentity(binding.browserId) !== registration
      || !browserWebContentsRegistry.isRegisteredForSession(binding.browserId, binding.sessionId, presentation.partition)
      || (current && current !== original && current !== created) || !host || host.isDestroyed()) {
      throw new Error('credential_handoff_target_unavailable');
    }
  };
  return Object.freeze({ source: original.webContents, assertCurrent,
    create: () => {
      assertCurrent();
      if (created || !original.webContents.isDestroyed()) throw new Error('credential_handoff_target_unavailable');
      const candidate = createBrowserPage(presentation);
      created = candidate;
      candidate.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      candidate.rect = presentation.rect;
      // Initial viewport exists, but the candidate is neither shown nor registered/observed.
      candidate.runtime.moveTo(resolveHost(presentation.windowName));
      candidate.runtime.layout(candidate.rect, false);
      return Object.freeze({ webContents: candidate.webContents, runtime: candidate.runtime,
        publish: () => {
          assertCurrent();
          if (pages.has(binding.browserId) || candidate.webContents.isDestroyed()) throw new Error('credential_handoff_target_unavailable');
          candidate.mode = presentation.mode;
          candidate.ready = true;
          installBrowserPage(candidate);
        },
        dispose: () => {
          if (pages.get(binding.browserId) === candidate) destroyBrowserPage(binding.browserId);
          else candidate.runtime.close();
        },
      });
    },
  });
}

function moveToHost(page: BrowserPage, windowName: string): void {
  if (page.presentation) { page.windowName = windowName; return; }
  const host = resolveHost(windowName);
  const moved = page.runtime.host !== host;
  if (moved) {
    page.runtime.moveTo(host);
    if (host) {
      wireHost(host);
      raiseWindowLayers(host);
    }
    // 换了窗:旧窗里的那几层收着(applyLayout),由旧窗那边的页签按名字关;新窗那边页签会在新窗里开 ——
    // ❌ 这里关:挪窗时两边的布局请求会来回交错几下,关了就把新窗刚开的也关了。
  }
  page.windowName = windowName;
  applyLayout(page);
  if (moved) page.dialogs?.hostChanged();
}

/** Browser Use can restore a saved tab without mounting its whole session UI or moving a live page to another window. */
export function ensureAgentBrowserPage(args: { browserId: string; partition: string; url: string }): MountBrowserPageResult {
  if (credentialAgentPartitionBlocked(args.partition)) return { success: false, error: 'credential-partition-isolated' };
  const page = livePage(args.browserId);
  if (page && page.partition === args.partition) {
    if (page.releaseTimer) clearTimeout(page.releaseTimer);
    page.releaseTimer = null;
    page.releaseExpired = false;
    return { success: true, reused: true, ready: page.ready, state: pageState(page.webContents) };
  }
  const mounted = mountBrowserPage({ ...args, windowName: '' });
  const restored = livePage(args.browserId);
  // An unmounted session has no surface to report its bounds. Give the hidden page a real viewport;
  // the actual pane reports its own geometry when the person opens the session again.
  if (mounted.success && restored?.runtime.host && !restored.rect) {
    restored.rect = contentRect(restored.runtime.host);
    applyLayout(restored);
  }
  return mounted;
}

function wirePage(page: BrowserPage): void {
  const { webContents } = page;
  page.dialogs = wirePageDialogs(webContents, {
    onScreen: () => onScreen(page),
    host: () => (page.runtime.host && !page.runtime.host.isDestroyed() ? page.runtime.host : null),
  });
  webContents.on('dom-ready', () => {
    notifyPresentation(page);
    if (page.runtime.initializing) return;
    page.ready = true;
    // 网页照 Chrome 那样能双指捏合放大(#6456)。Electron 默认关着;只开这一张网页的。每次 dom-ready 都设:换页可能换渲染进程。
    webContents.setVisualZoomLevelLimits(1, BROWSER_PINCH_MAX_LEVEL).catch((error: unknown) => {
      log.warn('could not enable pinch zoom on a browser page', { browserId: page.browserId, error: String(error) });
    });
    emitPageEvent(page, 'dom-ready');
  });
  webContents.on('did-start-loading', () => emitPageEvent(page, 'did-start-loading'));
  webContents.on('did-stop-loading', () => emitPageEvent(page, 'did-stop-loading'));
  webContents.on('did-navigate', (_event, url) => emitPageEvent(page, 'did-navigate', { url }));
  webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) emitPageEvent(page, 'did-navigate-in-page', { url });
  });
  webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // 只认整页:页里某个子框架(广告、埋点)没载上,❌ 把整页换成「打不开」。
    if (isMainFrame) emitPageEvent(page, 'did-fail-load', { errorCode, errorDescription, validatedURL });
  });
  webContents.on('console-message', (event) => {
    const params = event as unknown as { level: string; message: string; lineNumber: number; sourceId: string };
    emitPageEvent(page, 'console-message', {
      level: CONSOLE_LEVELS[params.level] ?? 1,
      message: params.message,
      line: params.lineNumber,
      sourceId: params.sourceId,
    });
  });
  webContents.on('page-title-updated', (_event, title) => emitPageEvent(page, 'page-title-updated', { title }));
  webContents.on('page-favicon-updated', (_event, favicons) => emitPageEvent(page, 'page-favicon-updated', { favicons }));
  webContents.on('focus', () => emitPageEvent(page, 'focus'));
  webContents.on('blur', () => emitPageEvent(page, 'blur'));
  webContents.on('zoom-changed', () => notifyPresentation(page));
  // 网页要全屏(视频):view 铺满整个窗口内容区,退出时回到页签那一块。
  webContents.on('enter-html-full-screen', () => {
    page.fullscreen = true;
    applyLayout(page);
    // 叠到最上面:分栏时别的网页 view 不能压着它(再挂一次就到最上层)。
    if (page.runtime.host && !page.runtime.host.isDestroyed()) {
      page.runtime.raise();
      raiseWindowLayers(page.runtime.host);
    }
  });
  webContents.on('leave-html-full-screen', () => {
    page.fullscreen = false;
    applyLayout(page);
  });
  webContents.once('destroyed', () => {
    if (pages.get(page.browserId) === page) {
      notifyPresentation(page);
      page.presentationListeners.clear();
      pages.delete(page.browserId);
      if (page.releaseTimer) clearTimeout(page.releaseTimer);
    }
  });
}

/** Chromium 的日志级别 → 原先 `<webview>` 的 console-message 用的数字(0 verbose … 3 error)。 */
const CONSOLE_LEVELS: Record<string, number> = { debug: 0, info: 1, warning: 2, error: 3 };

/**
 * 页签量到的位置与样子。`rect` 是占位在那扇窗视口里的 CSS 像素,这里乘上界面自己的缩放换成窗口内容区的 DIP。
 */
export function layoutBrowserPage(args: {
  browserId: string;
  windowName: string;
  rect: Rect | null;
  mode: BrowserPageMode;
}): boolean {
  const page = pages.get(args.browserId);
  if (!page || page.webContents.isDestroyed()) return false;
  if (args.windowName !== page.windowName) moveToHost(page, args.windowName);
  const host = resolveHost(args.windowName);
  const zoom = host && !host.isDestroyed() ? host.webContents.getZoomFactor() : 1;
  page.rect = args.rect ? toDip(args.rect, zoom) : null;
  page.mode = args.mode;
  applyLayout(page);
  return true;
}

/** Main supplies the actual App embedder. Apps never choose native windows or browser partitions. */
export function leaseBrowserPagePresentation(browserId: string, host: BrowserWindow) {
  const page = pages.get(browserId);
  if (!page || page.webContents.isDestroyed() || host.isDestroyed()) throw new Error('The task page cannot be mounted');
  if (page.presentation) throw new Error('The task page is already mounted by an App');
  const presentation = { host, rect: null as Rect | null };
  page.presentation = presentation; wireHost(host);
  let closed = false;
  return {
    layout(rect: Rect | null) {
      if (closed || page.presentation !== presentation || page.webContents.isDestroyed() || host.isDestroyed()) throw new Error('The task page mount closed');
      presentation.rect = rect ? toDip(rect, host.webContents.getZoomFactor()) : null;
      applyLayout(page);
    },
    close() {
      if (closed) return; closed = true;
      if (page.presentation !== presentation) return;
      delete page.presentation;
      if (!page.webContents.isDestroyed()) { moveToHost(page, page.windowName); applyLayout(page); }
    },
  };
}

export function toDip(rect: Rect, zoom: number): Rect {
  const x = Math.round(rect.x * zoom);
  const y = Math.round(rect.y * zoom);
  return {
    x,
    y,
    width: Math.max(0, Math.round((rect.x + rect.width) * zoom) - x),
    height: Math.max(0, Math.round((rect.y + rect.height) * zoom) - y),
  };
}

/** 占位卸下了:网页在所属宿主隐藏,等新占位接回;无人接回则释放。 */
export function releaseBrowserPage(browserId: string): void {
  const page = pages.get(browserId);
  if (!page) return;
  page.mode = 'background';
  applyLayout(page);
  if (page.releaseTimer) clearTimeout(page.releaseTimer);
  page.releaseTimer = setTimeout(() => {
    page.releaseTimer = null;
    page.releaseExpired = true;
    if (!page.runtime.inUse) destroyBrowserPage(browserId);
  }, RELEASE_GRACE_MS);
}

/** 页签关了(会话关了、页签被关):网页当场关掉。 */
export function destroyBrowserPage(browserId: string): void {
  const page = pages.get(browserId);
  if (!page) return;
  pages.delete(browserId);
  notifyPresentation(page); page.presentationListeners.clear();
  if (page.releaseTimer) clearTimeout(page.releaseTimer);
  page.runtime.close();
}

function livePage(browserId: string): BrowserPage | null {
  const page = pages.get(browserId);
  if (!page || page.webContents.isDestroyed()) return null;
  try { assertCredentialAgentContents(page.webContents); return page; } catch { return null; }
}

export function navigateBrowserPage(browserId: string, url: string): boolean {
  const page = livePage(browserId);
  if (!page) return false;
  if (!isPreviewPageUrl(url) && !normalizeBrowserUrl(url, BROWSER_TAB_URL_OPTIONS).ok) return false;
  navigatePage(page, url);
  return true;
}

function navigationFailed(page: BrowserPage, url: string, error: unknown): void {
  // Network navigation failures already emit did-fail-load. Startup failures have no destination renderer yet.
  if (!page.runtime.failed || page.webContents.isDestroyed()) return;
  log.warn('could not initialize a browser page', { browserId: page.browserId, error: String(error) });
  emitPageEvent(page, 'did-fail-load', { errorCode: -2, errorDescription: 'ERR_FAILED', validatedURL: url, isMainFrame: true });
}

function navigatePage(page: BrowserPage, url: string): void {
  void page.runtime.navigate(url).catch(error => navigationFailed(page, url, error));
}

export type BrowserPageCommand = 'goBack' | 'goForward' | 'reload' | 'reloadIgnoringCache' | 'stop' | 'focus';

export function runBrowserPageCommand(browserId: string, command: BrowserPageCommand): boolean {
  const page = livePage(browserId);
  if (!page) return false;
  const { webContents } = page;
  switch (command) {
    case 'goBack':
      page.runtime.goBack();
      return true;
    case 'goForward':
      page.runtime.goForward();
      return true;
    case 'reload':
      void page.runtime.reload().catch(error => navigationFailed(page, page.runtime.requestedUrl, error));
      return true;
    case 'reloadIgnoringCache':
      void page.runtime.reload(true).catch(error => navigationFailed(page, page.runtime.requestedUrl, error));
      return true;
    case 'stop':
      page.runtime.stop();
      return true;
    case 'focus':
      webContents.focus();
      return true;
  }
}

export function setBrowserPageZoom(browserId: string, factor: number): boolean {
  const page = livePage(browserId);
  if (!page) return false;
  page.webContents.setZoomFactor(normalizeBrowserZoomFactor(factor));
  notifyPresentation(page);
  return true;
}

/** A host-only lookup captured by a task lease; the App never supplies a native contents/window ID. */
export function browserPagePresentation(browserId: string): TaskPagePresentation | null {
  const page = livePage(browserId);
  try { return page && pageIsShown(page) ? nativePagePresentation(page.view, page.runtime.host) : null; }
  catch (error) { log.warn('Could not measure page presentation', { error: String(error) }); return null; }
}

function notifyPresentation(page: BrowserPage): void {
  for (const listener of page.presentationListeners) {
    try { listener(); } catch (error) { log.warn('Could not report page presentation', { error: String(error) }); }
  }
}

export function onBrowserPagePresentation(browserId: string, listener: (value: TaskPagePresentation | null) => void): () => void {
  const page = livePage(browserId);
  if (!page) throw new Error('The task page was closed');
  const changed = () => listener(browserPagePresentation(browserId));
  page.presentationListeners.add(changed);
  try { changed(); } catch (error) { page.presentationListeners.delete(changed); throw error; }
  return () => { page.presentationListeners.delete(changed); };
}

export async function measureBrowserPage(browserId: string): Promise<BrowserPageLayout | null> {
  const page = livePage(browserId);
  if (!page) return null;
  try {
    return parseBrowserPageLayout(await page.webContents.executeJavaScript(BROWSER_PAGE_MEASURE_SCRIPT));
  } catch {
    // 网页可能正被导航走 / 崩了。量不到就不缩(这条兜底本来就是「能改善就改善」)。
    return null;
  }
}

/** 网页此刻的样子(JPEG data URL):页签被浮层盖住时,占位上换成这张。 */
export async function snapshotBrowserPage(browserId: string): Promise<string | null> {
  const page = livePage(browserId);
  // 从没摆好过的网页(视口 0×0)截不出图,Chromium 会一直等。
  if (!page || !page.runtime.host || !page.rect) return null;
  try {
    const image = await page.runtime.snapshot();
    if (page.webContents.isDestroyed() || image.isEmpty()) return null;
    return `data:image/jpeg;base64,${image.toJPEG(85).toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * 要当面问人一句(如选哪把通行密钥)时,这一页此刻挂在哪扇人看得见的窗上:挂在窗上、那扇窗露着且没最小化才算。
 * 隐藏着、窗收进托盘或最小化 ⇒ null —— 调用方据此不问,❌ 为了问一句把窗抢到前面(会打断人在别处打字)。
 * 不是内置浏览器的网页(没登记在这里)⇒ undefined,由调用方自己认;❌ 和 null 混成一个值 —— 隐藏着的网页
 * 再去按「谁拥有它」找窗,就会把对话框挂到一扇看不见这页的窗上。
 */
export function visibleHostOfPage(contents: WebContents): BrowserWindow | null | undefined {
  for (const page of pages.values()) {
    if (page.webContents !== contents) continue;
    const host = onScreen(page) ? page.runtime.host : null;
    return host && !host.isDestroyed() && host.isVisible() && !host.isMinimized() ? host : null;
  }
  return undefined;
}

/**
 * 界面要把焦点拿回自己身上(人在网页里时按了 ⌘K、点了界面的「聚焦地址栏」…):界面 JS 的 `focus()` 只在
 * 它自己那棵树里挪,网页这个独立 view 拿着窗口焦点时挪不动 —— 先把窗口焦点交回界面那一层。
 */
export function focusBrowserHost(windowName: string): boolean {
  const host = resolveHost(windowName);
  if (!host || host.isDestroyed()) return false;
  host.webContents.focus();
  return true;
}
