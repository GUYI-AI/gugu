import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #7274 页签的网页是主进程持有的 WebContentsView。这里钉住它在窗口里的样子随页签走:
 * 同一宿主内按页签状态显示或隐藏,前后台切换不改变原生窗口归属;页签挪走留一会儿、关了当场收,界面整页重载 / 窗关了一并收。
 */

const state = vi.hoisted(() => ({
  views: [] as any[],
  windows: [] as any[],
  emitted: [] as any[],
  registered: new Map<string, string>(),
  adopted: [] as Array<{ browserId: string; placement: { window: () => unknown; origin: () => { x: number; y: number } } }>,
  boxes: [] as Array<{ parent: unknown; options: any }>,
  nativeApp: undefined as unknown as EventEmitter,
  nativeSessions: new Map<string, object>(),
  owners: new Map<string, any>(),
  adoptHook: undefined as (() => void) | undefined,
}));

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  state.nativeApp = new Emitter();
  class FakeWebContents extends Emitter {
    static nextId = 100;
    id = FakeWebContents.nextId++;
    destroyed = false;
    url = '';
    loaded: string[] = [];
    zoom = 1;
    session: object = {};
    navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {} };
    isDestroyed() {
      return this.destroyed;
    }
    getURL() {
      return this.url;
    }
    getTitle() {
      return 'title';
    }
    loadURL(url: string) {
      this.loaded.push(url);
      this.url = url;
      return Promise.resolve();
    }
    setBackgroundThrottling = vi.fn();
    setWindowOpenHandler = vi.fn();
    executeJavaScript = vi.fn(async () => undefined);
    capturePage = vi.fn(async () => ({ isEmpty: () => false, toJPEG: () => Buffer.from([1, 2]) }));
    beginFrameSubscription = vi.fn((_dirty: boolean, callback: (image: { isEmpty: () => boolean }) => void) => { queueMicrotask(() => callback({ isEmpty: () => false })); });
    endFrameSubscription = vi.fn();
    setVisualZoomLevelLimits() {
      return Promise.resolve();
    }
    setZoomFactor(factor: number) {
      this.zoom = factor;
    }
    getZoomFactor() { return this.zoom; }
    // 照 Electron v44:网页的 JS 对话框走这两个内部事件(browser-page-dialogs.ts 接管)。
    debugger = Object.assign(new Emitter(), { isAttached: () => false });
    constructor() {
      super();
      this.on('-run-dialog', () => {});
      this.on('-cancel-dialogs', () => {});
    }
    close() {
      this.destroyed = true;
      this.emit('destroyed');
    }
    inputs: unknown[] = [];
    sendInputEvent(input: unknown) { this.inputs.push(input); }
    focused = 0;
    focus() {
      this.focused += 1;
    }
  }
  class WebContentsView {
    webContents: FakeWebContents;
    bounds: unknown = null;
    background = '';
    visible = true;
    constructor(readonly options: { webPreferences?: Record<string, unknown>; webContents?: FakeWebContents }) {
      this.webContents = options.webContents ?? new FakeWebContents();
      const partition = String(options.webPreferences?.partition ?? '');
      if (!state.nativeSessions.has(partition)) state.nativeSessions.set(partition, {});
      this.webContents.session = state.nativeSessions.get(partition)!;
      state.views.push(this);
      state.nativeApp.emit('web-contents-created', {}, this.webContents);
    }
    setBounds(bounds: unknown) {
      this.bounds = bounds;
    }
    getBounds() { return this.bounds; }
    getVisible() { return this.visible; }
    setVisible(visible: boolean) {
      this.visible = visible;
    }
    setBackgroundColor(color: string) {
      this.background = color;
    }
  }
  return {
    app: state.nativeApp,
    webContents: { getAllWebContents: () => state.views.map(view => view.webContents) },
    WebContentsView,
    BaseWindow: class { constructor() { throw new Error('browser pages must not create windows'); } },
    BrowserWindow: { getAllWindows: () => state.windows },
    dialog: {
      showMessageBox: (parent: unknown, options: any) => {
        state.boxes.push({ parent, options });
        return new Promise(() => {});
      },
    },
  };
});

function fakeWindow(name = '', zoom = 1) {
  const window = Object.assign(new EventEmitter(), {
    destroyed: false,
    visible: true,
    minimized: false,
    isDestroyed() {
      return this.destroyed;
    },
    isVisible() {
      return this.visible;
    },
    isMinimized() {
      return this.minimized;
    },
    getMediaSourceId: () => 'window:101:0',
    children: [] as unknown[],
    contentView: {
      addChildView(view: unknown) {
        window.children = [...window.children.filter((v) => v !== view), view];
      },
      removeChildView(view: unknown) {
        window.children = window.children.filter((v) => v !== view);
      },
    },
    webContents: Object.assign(new EventEmitter(), {
      mainFrame: { name },
      getZoomFactor: () => zoom,
      focus: vi.fn(),
      isDestroyed: () => false,
    }),
    getContentSize: () => [1200, 800],
    getContentBounds: () => ({ x: 100, y: 50, width: 1200, height: 800 }),
  });
  return window;
}

let mainWindow = fakeWindow();
vi.mock('@main/app/window', () => ({ getMainWindow: () => mainWindow }));
vi.mock('@main/lib/events', () => ({ events: { emit: (_channel: unknown, payload: unknown) => state.emitted.push(payload) } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../../devtools-lock', () => ({ hardenWebPreferences: <T>(prefs: T) => prefs }));
vi.mock('./browser-webcontents-registry', async () => {
  return {
  browserWebContentsRegistry: {
    get registeredPartitions() {
      return new Set(state.registered.values());
    },
    isRegistered: (browserId: string, partition: string) => state.registered.get(browserId) === partition,
    isRegisteredForSession: (id: string, sid: string, partition: string) => sid === 'fixture-session' && state.registered.get(id) === partition,
    browsersOfSession: () => [...state.owners].map(([browserId, webContents]) => ({ browserId, webContents })),
    browserIdFor: (id: number) => [...state.owners].find(([, wc]) => wc.id === id)?.[0],
    adoptPageWebContents: (browserId: string, contents: any, placement: (typeof state.adopted)[number]['placement']) => {
      state.owners.set(browserId, contents);
      contents.once('destroyed', () => { if (state.owners.get(browserId) === contents) state.owners.delete(browserId); });
      state.adopted.push({ browserId, placement });
      state.adoptHook?.();
    },
  },
}; });

import {
  destroyBrowserPage,
  layoutBrowserPage,
  leaseBrowserPagePresentation,
  mountBrowserPage,
  releaseBrowserPage,
  snapshotBrowserPage,
  toDip,
  visibleHostOfPage,
  browserPagePresentation,
  onBrowserPagePresentation,
  setBrowserPageZoom,
} from './browser-page-views';
import { acquireBrowserPage } from './browser-page-runtime';
import { windowLayerResponse } from '../../../../window-layers';
import { buildTagWindowName, isBuildTagWindowName } from '@shared/aux-window';

const PARTITION = 'persist:gugu-browser-profile';
const RECT = { x: 804, y: 81, width: 476, height: 819 };

function mount(browserId: string, url = 'https://example.com', windowName = '') {
  state.registered.set(browserId, PARTITION);
  const result = mountBrowserPage({ browserId, partition: PARTITION, url, windowName });
  return { result, view: state.views.at(-1) };
}

async function settled(view: any) {
  const lease = acquireBrowserPage(view.webContents)!;
  await lease.ready;
  lease.dispose();
  await Promise.resolve();
}

beforeEach(() => {
  mainWindow = fakeWindow();
  state.windows = [mainWindow];
  state.views.length = 0;
  state.emitted.length = 0;
  state.adopted.length = 0;
  state.registered.clear();
  state.boxes.length = 0;
  state.nativeSessions.clear(); state.owners.clear();
  state.adoptHook = undefined;
});

afterEach(() => {
  for (const browserId of ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9']) destroyBrowserPage(browserId);
  vi.useRealTimers();
});

describe('#7274 建网页', () => {
  it('收紧过的独立 view:沙盒、不嵌 webview、换页不抢焦点;载入页签的首个地址', async () => {
    const { result, view } = mount('b1');
    expect(result).toMatchObject({ success: true, reused: false });
    expect(view.options.webPreferences).toMatchObject({
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      focusOnNavigation: false,
    });
    await settled(view);
    expect(view.webContents.loaded).toEqual(['https://example.com/']);
    expect(state.adopted.map((a) => a.browserId)).toEqual(['b1']);
  });

  it('没登记的页签、不支持的地址:不建', () => {
    expect(mountBrowserPage({ browserId: 'b2', partition: PARTITION, url: 'https://a.test', windowName: '' })).toMatchObject({ success: false });
    state.registered.set('b2', PARTITION);
    expect(mountBrowserPage({ browserId: 'b2', partition: PARTITION, url: 'javascript:alert(1)', windowName: '' })).toMatchObject({
      success: false,
      error: 'unsupported-url',
    });
    expect(state.views).toHaveLength(0);
  });
});

describe('#7274 网页在窗口里的样子跟着页签走', () => {
  it('露着:挂到窗口上、摆在页签那一块(界面缩放换成窗口 DIP)', () => {
    mainWindow = fakeWindow('', 1.25);
    state.windows = [mainWindow];
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    expect(mainWindow.children).toContain(view);
    expect(view.bounds).toEqual(toDip(RECT, 1.25));
  });

  it('#72 停着的网页弹 alert:什么窗都不出(❌ 挂到停放窗上);页签露出来、窗露着才挂到那扇窗上', () => {
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'background' });
    const callback = vi.fn();
    view.webContents.emit('-run-dialog', { dialogType: 'alert', messageText: 'saved' }, callback);
    expect(callback).toHaveBeenCalledWith(true, '');
    expect(state.boxes).toHaveLength(0);
    mainWindow.visible = false;
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    expect(state.boxes).toHaveLength(0);
    mainWindow.visible = true;
    mainWindow.emit('show');
    expect(state.boxes).toHaveLength(1);
    expect(state.boxes[0]).toMatchObject({ parent: mainWindow, options: { message: 'saved' } });
  });

  it('#72 停着的网页弹的 alert:切回这个页签(窗一直露着)就挂到那扇窗上', () => {
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'background' });
    view.webContents.emit('-run-dialog', { dialogType: 'alert', messageText: 'later' }, vi.fn());
    expect(state.boxes).toHaveLength(0);
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    expect(state.boxes).toHaveLength(1);
    expect(state.boxes[0]).toMatchObject({ parent: mainWindow, options: { message: 'later' } });
  });

  it('切换显示状态只改变 view,不创建或移动到额外原生窗口', () => {
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    expect(view.visible).toBe(true);
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'background' });
    expect(view.visible).toBe(false);
    expect(mainWindow.children).toContain(view);
    expect(state.windows).toEqual([mainWindow]);
  });

  it('从没露过面的页签(人在别的会话里):建好就隐藏在所属宿主、大小跟着页签 —— agent 在后台操作它时视口是对的', () => {
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'background' });
    expect(view.visible).toBe(false);
    expect(mainWindow.children).toContain(view);
    expect(view.bounds).toEqual(RECT);
  });

  it('被界面浮层盖住:留在所属宿主隐藏、大小不变;浮层走了在原宿主显示', () => {
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'occluded' });
    expect(mainWindow.children).toContain(view);
    expect(view.visible).toBe(false);
    expect(view.bounds).toEqual(RECT);
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    expect(mainWindow.children).toContain(view);
    expect(view.visible).toBe(true);
  });

  it('要当面问人一句(选通行密钥)时它露在哪扇窗:露着 → 那扇窗;隐藏 / 窗收起 / 最小化 → null;不是页签的网页 → undefined', () => {
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    expect(visibleHostOfPage(view.webContents)).toBe(mainWindow);
    mainWindow.minimized = true;
    expect(visibleHostOfPage(view.webContents)).toBeNull();
    mainWindow.minimized = false;
    mainWindow.visible = false;
    expect(visibleHostOfPage(view.webContents)).toBeNull();
    mainWindow.visible = true;
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'occluded' });
    expect(visibleHostOfPage(view.webContents)).toBeNull();
    expect(visibleHostOfPage({} as never)).toBeUndefined();
  });

  it('切到后台:留在所属宿主隐藏;大小仍跟着页签(窗口改了大小,后台的网页也跟着)', () => {
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: { ...RECT, width: 500 }, mode: 'background' });
    expect(mainWindow.children).toContain(view);
    expect(view.visible).toBe(false);
    expect(view.bounds).toEqual({ ...RECT, width: 500 });
  });

  it('多会话后台页不创建额外窗口', () => {
    mount('b1');
    mount('b2');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'background' });
    layoutBrowserPage({ browserId: 'b2', windowName: '', rect: RECT, mode: 'occluded' });
    expect(state.windows).toEqual([mainWindow]);
  });

  it('截图(浮层压上来时换上的那张):从没摆好过的网页不截(视口 0×0,Chromium 会一直等)', async () => {
    mount('b1');
    expect(await snapshotBrowserPage('b1')).toBeNull();
  });

  it('首次就被浮层盖住的网页,界面截图也经过完整运行时准备', async () => {
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'occluded' });
    expect(await snapshotBrowserPage('b1')).toBe('data:image/jpeg;base64,AQI=');
    expect(view.visible).toBe(false);
    expect(view.webContents.beginFrameSubscription).toHaveBeenCalledOnce();
    expect(view.webContents.endFrameSubscription).toHaveBeenCalledOnce();
  });

  it('网页要全屏(视频):铺满窗口内容区、叠到最上面(分栏的另一张网页压不着它);退出回到页签那一块', () => {
    const { view } = mount('b1');
    const other = mount('b2').view;
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    layoutBrowserPage({ browserId: 'b2', windowName: '', rect: { ...RECT, x: 0 }, mode: 'shown' });
    view.webContents.emit('enter-html-full-screen');
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
    expect(mainWindow.children.at(-1)).toBe(view);
    expect(mainWindow.children).toContain(other);
    view.webContents.emit('leave-html-full-screen');
    expect(view.bounds).toEqual(RECT);
  });

  it('右键菜单的落点:网页左上角在窗口里的位置(全屏时是窗口原点)', () => {
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    const placement = state.adopted.at(-1)!.placement;
    expect(placement.window()).toBe(mainWindow);
    expect(placement.origin()).toEqual({ x: 804, y: 81 });
    view.webContents.emit('enter-html-full-screen');
    expect(placement.origin()).toEqual({ x: 0, y: 0 });
  });

  it('单独成窗:挂到名字对得上的那扇窗上', () => {
    const aux = fakeWindow('gugu-aux:7');
    state.windows = [mainWindow, aux];
    const { view } = mount('b1', 'https://example.com', 'gugu-aux:7');
    layoutBrowserPage({ browserId: 'b1', windowName: 'gugu-aux:7', rect: RECT, mode: 'shown' });
    expect(aux.children).toContain(view);
    expect(mainWindow.children).not.toContain(view);
  });
});

describe('#7274 生命周期', () => {
  it('页签挪了位置:先留在所属宿主隐藏、留着;在新位置挂回来接着用原来那张(❌ 重新载入)', async () => {
    vi.useFakeTimers();
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    releaseBrowserPage('b1');
    expect(mainWindow.children).toContain(view);
    expect(view.visible).toBe(false);
    vi.advanceTimersByTime(1_000);
    const again = mountBrowserPage({ browserId: 'b1', partition: PARTITION, url: 'https://other.test', windowName: '' });
    expect(again).toMatchObject({ success: true, reused: true });
    expect(state.views).toHaveLength(1);
    await settled(view);
    expect(view.webContents.loaded).toEqual(['https://example.com/']);
    vi.advanceTimersByTime(10_000);
    expect(view.webContents.destroyed).toBe(false);
  });

  it('展示占位卸下时,连接中的执行者保有页面;最后释放时再回收', async () => {
    vi.useFakeTimers();
    const { view } = mount('b1');
    const lease = acquireBrowserPage(view.webContents)!;
    await lease.ready;
    releaseBrowserPage('b1');
    vi.advanceTimersByTime(5_100);
    expect(view.webContents.destroyed).toBe(false);
    lease.dispose();
    expect(view.webContents.destroyed).toBe(true);
  });

  it('卸下后没人再要:过一会儿关掉', () => {
    vi.useFakeTimers();
    const { view } = mount('b1');
    releaseBrowserPage('b1');
    vi.advanceTimersByTime(5_100);
    expect(view.webContents.destroyed).toBe(true);
  });

  it('页签关了:网页当场关掉、从窗口 / 停放窗上摘下;之后的布局请求不再碰它', () => {
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    destroyBrowserPage('b1');
    expect(view.webContents.destroyed).toBe(true);
    expect(mainWindow.children).not.toContain(view);
    const parked = mount('b2').view;
    layoutBrowserPage({ browserId: 'b2', windowName: '', rect: RECT, mode: 'background' });
    destroyBrowserPage('b2');
    expect(mainWindow.children).not.toContain(parked);
    expect(layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' })).toBe(false);
  });

  it('界面整页重载:这扇窗上的网页一并关掉(❌ 留一块没人管的网页盖在新界面上)', () => {
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    mainWindow.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(view.webContents.destroyed).toBe(true);
  });

  it('单独成窗的那扇关了:网页先放手、留一会儿(页签挪回主窗接着用),没人要就关掉;不创建额外窗口', () => {
    vi.useFakeTimers();
    const aux = fakeWindow('gugu-aux:7');
    state.windows = [mainWindow, aux];
    const kept = mount('b1', 'https://example.com', 'gugu-aux:7').view;
    const dropped = mount('b2', 'https://example.com', 'gugu-aux:7').view;
    layoutBrowserPage({ browserId: 'b1', windowName: 'gugu-aux:7', rect: RECT, mode: 'shown' });
    layoutBrowserPage({ browserId: 'b2', windowName: 'gugu-aux:7', rect: RECT, mode: 'background' });
    aux.destroyed = true;
    aux.emit('closed');
    mountBrowserPage({ browserId: 'b1', partition: PARTITION, url: 'https://example.com', windowName: '' });
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    vi.advanceTimersByTime(5_100);
    expect(mainWindow.children).toContain(kept);
    expect(kept.webContents.destroyed).toBe(false);
    expect(dropped.webContents.destroyed).toBe(true);
  });

  it('网页自己没了(崩溃回收):不再记着它', () => {
    const { view } = mount('b1');
    view.webContents.close();
    expect(layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' })).toBe(false);
  });
});

describe('#7274 网页事件报给页签(带着此刻的导航状态)', () => {
  it('子框架的失败 / 页内跳转不算整页的;console 级别换成原先 webview 的数字', async () => {
    const { view } = mount('b1');
    await settled(view);
    const wc = view.webContents;
    wc.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'https://ads.test/', false);
    wc.emit('did-navigate-in-page', {}, 'https://ads.test/#x', false);
    expect(state.emitted).toHaveLength(0);
    wc.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'https://example.com/', true);
    wc.emit('console-message', { level: 'warning', message: 'm', lineNumber: 3, sourceId: 's' });
    expect(state.emitted.map((e) => [e.type, e.detail])).toEqual([
      ['did-fail-load', { errorCode: -105, errorDescription: 'NAME_NOT_RESOLVED', validatedURL: 'https://example.com/' }],
      ['console-message', { level: 2, message: 'm', line: 3, sourceId: 's' }],
    ]);
    expect(state.emitted[0].state).toMatchObject({ url: 'https://example.com/', canGoBack: false });
  });
});

describe('window layers', () => {
  it('build tag names are unique and recognizable', () => {
    expect(buildTagWindowName()).not.toBe(buildTagWindowName());
    expect(isBuildTagWindowName(buildTagWindowName())).toBe(true);
    expect(isBuildTagWindowName('gugu-aux:build-tag')).toBe(false);
  });

  it('a window.open that is no layer is not opened as one', () => {
    expect(windowLayerResponse(mainWindow as any, 'about:blank', 'gugu-aux:s1')).toBeNull();
  });
});

describe('App-native presentation lease', () => {
  it('measures the current native mount and invalidates on window visibility, zoom, unmount and destruction', async () => {
    const { view } = mount('b1'); await settled(view);
    const changes = vi.fn();
    const off = onBrowserPagePresentation('b1', changes);
    expect(changes).toHaveBeenLastCalledWith(null);
    const appHost = fakeWindow('gugu-aux:app', 1.5); state.windows.push(appHost);
    const lease = leaseBrowserPagePresentation('b1', appHost as any);
    lease.layout({ x: 30, y: 40, width: 300, height: 200 });
    expect(browserPagePresentation('b1')).toMatchObject({ bounds: { x: 145, y: 110, width: 450, height: 300 }, zoomFactor: 1 });
    appHost.getContentBounds = () => ({ x: 500, y: 300, width: 1200, height: 800 }); appHost.emit('move');
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ bounds: { x: 545, y: 360, width: 450, height: 300 } }));
    appHost.visible = false; appHost.emit('hide'); expect(changes).toHaveBeenLastCalledWith(null);
    appHost.visible = true; appHost.emit('show');
    setBrowserPageZoom('b1', 2);
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ zoomFactor: 2 }));
    appHost.minimized = true; appHost.emit('minimize'); expect(changes).toHaveBeenLastCalledWith(null);
    appHost.minimized = false; appHost.emit('restore');
    lease.layout(null); expect(changes).toHaveBeenLastCalledWith(null);
    lease.close(); expect(browserPagePresentation('b1')).toBeNull();
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    expect(browserPagePresentation('b1')).not.toBeNull();
    destroyBrowserPage('b1'); expect(changes).toHaveBeenLastCalledWith(null);
    const count = changes.mock.calls.length;
    appHost.emit('show'); expect(changes).toHaveBeenCalledTimes(count); off();
  });
  it('keeps the App viewport despite old tab layout and restores the latest original position when closed', async () => {
    const { view } = mount('b1'); await settled(view);
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    const appHost = fakeWindow('gugu-aux:app', 1.5); state.windows.push(appHost);
    const appRect = { x: 30, y: 40, width: 300, height: 200 };
    const lease = leaseBrowserPagePresentation('b1', appHost as any);
    lease.layout(appRect);
    expect(appHost.children).toContain(view); expect(mainWindow.children).not.toContain(view);
    expect(view.bounds).toEqual(toDip(appRect, 1.5));
    const updated = { ...RECT, x: 99 };
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: updated, mode: 'shown' });
    expect(view.bounds).toEqual(toDip(appRect, 1.5));
    expect(() => leaseBrowserPagePresentation('b1', mainWindow as any)).toThrow('already mounted');
    lease.layout(null); expect(view.visible).toBe(false);
    lease.close(); lease.close();
    expect(mainWindow.children).toContain(view); expect(appHost.children).not.toContain(view);
    expect(view.bounds).toEqual(toDip(updated, 1)); expect(view.visible).toBe(true);
    expect(view.webContents.loaded).toHaveLength(1);
  });
});
