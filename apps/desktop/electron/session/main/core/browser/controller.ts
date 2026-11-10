import { defaultBrowser, importDefaultBrowserCookies } from '@main/core/browser/browser-cookie-import';
import { configureBrowserProfileSession } from '@main/core/browser/browser-profile-session';
import {
  destroyBrowserPage,
  ensureAgentBrowserPage,
  focusBrowserHost,
  layoutBrowserPage,
  measureBrowserPage,
  mountBrowserPage,
  navigateBrowserPage,
  releaseBrowserPage,
  runBrowserPageCommand,
  setBrowserPageZoom,
  snapshotBrowserPage,
  type BrowserPageCommand,
} from '@main/core/browser/browser-page-views';
import { browserWebContentsRegistry } from '@main/core/browser/browser-webcontents-registry';
import { controlRemoteTaskPage, sendRemoteTaskPage, unwatchRemoteTaskPage, watchRemoteTaskPage } from '@main/core/browser/remote-task-page';
import type { TaskPageControl } from '@shared/browser-task-page';
import { isBrowserPartition } from '@main/core/browser/webview-security';
import { appSettingsService } from '@main/core/settings/settings-service';
import {
  browserProfilePartition,
  DEFAULT_BROWSER_PROFILE_ID,
  isBrowserDataClearKind,
  isBrowsingDataKind,
  type BrowserDataClearKind,
} from '@shared/browser';
import { createRPCController } from '@shared/lib/ipc/rpc';

export const browserController = createRPCController({
  /** `sessionId`:页签开在哪条会话里(#7191 会话的 agent 据此找到自己的页签);新建任务的草稿面板不带。 */
  registerSession: (args: { browserId: string; partition: string; sessionId?: string }) => {
    if (!args.browserId.trim() || !isBrowserPartition(args.partition)) {
      return { success: false as const, error: 'Invalid browser session' };
    }
    configureBrowserProfileSession(args.partition);
    browserWebContentsRegistry.registerSession({
      browserId: args.browserId,
      partition: args.partition,
      ...(args.sessionId?.trim() ? { sessionId: args.sessionId } : {}),
    });
    return { success: true as const };
  },

  unregisterSession: (browserId: string) => {
    // 页签关了:它的网页当场关掉(❌ 留一块没主的网页 view 在窗口里)。
    destroyBrowserPage(browserId);
    browserWebContentsRegistry.unregisterSession(browserId);
    return { success: true as const };
  },

  /**
   * #7274 页签的网页(主进程持有的 WebContentsView,见 browser-page-views.ts)。页签那边只有一块占位:
   * 挂上 / 报位置 / 卸下,以及代它向网页发的那几样操作。
   */
  mountPage: (args: { browserId: string; partition: string; url: string; windowName: string }) => mountBrowserPage(args),
  ensureAgentPage: (args: { browserId: string; partition: string; url: string }) => ensureAgentBrowserPage(args),
  layoutPage: (args: Parameters<typeof layoutBrowserPage>[0]) => ({ success: layoutBrowserPage(args) }),
  releasePage: (browserId: string) => {
    releaseBrowserPage(browserId);
    return { success: true as const };
  },
  navigatePage: (args: { browserId: string; url: string }) => ({ success: navigateBrowserPage(args.browserId, args.url) }),
  pageCommand: (args: { browserId: string; command: BrowserPageCommand }) => ({
    success: runBrowserPageCommand(args.browserId, args.command),
  }),
  setPageZoom: (args: { browserId: string; factor: number }) => ({ success: setBrowserPageZoom(args.browserId, args.factor) }),
  measurePage: async (browserId: string) => ({ layout: await measureBrowserPage(browserId) }),
  snapshotPage: async (browserId: string) => ({ dataUrl: await snapshotBrowserPage(browserId) }),
  /**
   * #1607 node 5: a task's page on another of the person's computers, watched here as its live picture. The person's
   * input goes to that page directly, as their click into a page on this computer does; no App is involved.
   */
  watchTaskPage: (args: { watchId: string; deviceId: string; sessionId: string }) => watchRemoteTaskPage(args),
  sendTaskPage: (args: { watchId: string; packet: unknown }) => sendRemoteTaskPage(args),
  controlTaskPage: (args: { watchId: string; control: TaskPageControl }) => controlRemoteTaskPage(args),
  unwatchTaskPage: (watchId: string) => ({ success: unwatchRemoteTaskPage(watchId) }),
  /** 界面要把焦点拿回自己身上(网页这个独立 view 拿着窗口焦点时,界面 JS 的 focus() 挪不动)。 */
  focusHost: (windowName: string) => ({ success: focusBrowserHost(windowName) }),

  setActiveBrowser: (browserId: string | null) => {
    browserWebContentsRegistry.setActiveBrowser(browserId);
    return { success: true as const };
  },

  getActiveBrowser: () => ({ browserId: browserWebContentsRegistry.getActiveBrowser() }),

  /** #7191 系统默认浏览器是哪一家、能不能从它导入登录(设置里那个按钮的文案用)。 */
  defaultBrowser: () => defaultBrowser(),

  /** #7191「从默认浏览器导入登录」:它的全部 cookie 一次导进这份浏览器配置。 */
  importDefaultBrowserCookies: async (profileId: string) => {
    try {
      return await importDefaultBrowserCookies(profileId);
    } catch (error) {
      return { ok: false as const, browser: defaultBrowser().name, reason: 'other' as const, detail: error instanceof Error ? error.message : String(error) };
    }
  },

  openDevTools: (browserId: string) => ({
    success: import.meta.env.DEV && browserWebContentsRegistry.openDevTools(browserId),
  }),

  captureScreenshot: async (browserId: string) => ({
    success: await browserWebContentsRegistry.captureScreenshotToClipboard(browserId),
  }),

  clearData: async (browserId: string, kind: BrowserDataClearKind) => {
    if (!isBrowserDataClearKind(kind)) {
      return { success: false as const, error: 'Invalid browser data clear kind' };
    }
    return { success: await browserWebContentsRegistry.clearData(browserId, kind) };
  },

  clearProfileStorage: async (profileId: string) => ({
    success: await browserWebContentsRegistry.clearProfileStorage(profileId),
  }),

  clearBrowsingData: async (kind: string) => {
    if (!isBrowsingDataKind(kind)) {
      return { success: false as const, error: 'Invalid browsing data kind' };
    }
    const partitions = await collectBrowserPartitions();
    return { success: await browserWebContentsRegistry.clearBrowsingData(kind, partitions) };
  },
});

// Every persistent profile partition (default + named) plus any partitions with
// live sessions, so clearing browsing data covers isolated-per-session tabs too.
async function collectBrowserPartitions(): Promise<string[]> {
  const browserSettings = await appSettingsService.get('browser');
  const partitions = new Set<string>([browserProfilePartition(DEFAULT_BROWSER_PROFILE_ID)]);
  for (const profile of browserSettings.profiles) {
    partitions.add(browserProfilePartition(profile.id));
  }
  for (const partition of browserWebContentsRegistry.registeredPartitions) {
    partitions.add(partition);
  }
  return [...partitions];
}
