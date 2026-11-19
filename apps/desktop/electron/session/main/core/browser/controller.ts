import { defaultBrowser, importDefaultBrowserCookies } from '@main/core/browser/browser-cookie-import';
import { inspectBrowserAnnotation } from './browser-annotation';
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
import { listPersistedBrowserPartitions } from './browser-partition-cleanup';
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
import type { BrowserKernelAction, BrowserKernelKind } from '@shared/browser-kernel';
import { standaloneKernelService } from './standalone-kernel-service';
import { browserKernelBindings, copyStandaloneScreenshot, isStandalonePage, measureStandalonePage,
  mountStandalonePage, registerBrowserKernel, snapshotStandalonePage, standaloneCommand, standaloneHostCommand,
  standaloneScreen, unregisterBrowserKernel, watchStandalonePage } from './standalone-page-runtime';

export const browserController = createRPCController({
  kernelStatus: () => standaloneKernelService().status(),
  kernelAction: (action: BrowserKernelAction) => standaloneKernelService().action(action),
  /** `sessionId`:页签开在哪条会话里(#7191 会话的 agent 据此找到自己的页签);新建任务的草稿面板不带。 */
  registerSession: async (args: { browserId: string; partition: string; sessionId?: string; kernel?: BrowserKernelKind; url?: string }) => {
    if (!args.browserId.trim() || !isBrowserPartition(args.partition)) {
      return { success: false as const, error: 'Invalid browser session' };
    }
    if (args.kernel !== undefined && args.kernel !== 'builtin' && args.kernel !== 'standalone') throw new Error('Invalid browser kernel');
    const { kernel } = await registerBrowserKernel(args);
    if (kernel === 'builtin') configureBrowserProfileSession(args.partition);
    browserWebContentsRegistry.registerSession({
      browserId: args.browserId,
      partition: args.partition,
      ...(args.sessionId?.trim() ? { sessionId: args.sessionId } : {}),
    });
    return { success: true as const, kernel };
  },

  unregisterSession: async (browserId: string) => {
    // 页签关了:它的网页当场关掉(❌ 留一块没主的网页 view 在窗口里)。
    destroyBrowserPage(browserId);
    await unregisterBrowserKernel(browserId);
    return { success: true as const };
  },

  /**
   * #7274 页签的网页(主进程持有的 WebContentsView,见 browser-page-views.ts)。页签那边只有一块占位:
   * 挂上 / 报位置 / 卸下,以及代它向网页发的那几样操作。
   */
  mountPage: (args: { browserId: string; partition: string; url: string; windowName: string }) => isStandalonePage(args.browserId) ? mountStandalonePage(args) : mountBrowserPage(args),
  ensureAgentPage: (args: { browserId: string; partition: string; url: string }) => isStandalonePage(args.browserId) ? mountStandalonePage(args) : ensureAgentBrowserPage(args),
  watchStandalonePage,
  layoutPage: (args: Parameters<typeof layoutBrowserPage>[0]) => ({ success: isStandalonePage(args.browserId) || layoutBrowserPage(args) }),
  releasePage: (browserId: string) => {
    releaseBrowserPage(browserId);
    return { success: true as const };
  },
  navigatePage: async (args: { browserId: string; url: string }) => {
    if (isStandalonePage(args.browserId)) { await (await standaloneScreen(args.browserId)).control({ action: 'navigate', url: args.url }); return { success: true }; }
    return { success: navigateBrowserPage(args.browserId, args.url) };
  },
  pageCommand: async (args: { browserId: string; command: BrowserPageCommand }) => ({
    success: isStandalonePage(args.browserId) ? await standaloneCommand(args.browserId, args.command) : runBrowserPageCommand(args.browserId, args.command),
  }),
  setPageZoom: async (args: { browserId: string; factor: number }) => {
    if (!isStandalonePage(args.browserId)) return { success: setBrowserPageZoom(args.browserId, args.factor) };
    if (!Number.isFinite(args.factor) || args.factor < 0.25 || args.factor > 5) throw new Error('Invalid browser zoom');
    await standaloneHostCommand(args.browserId, 'Emulation.setPageScaleFactor', { pageScaleFactor: args.factor });
    return { success: true };
  },
  measurePage: async (browserId: string) => ({ layout: await (isStandalonePage(browserId) ? measureStandalonePage(browserId) : measureBrowserPage(browserId)) }),
  snapshotPage: async (browserId: string) => ({ dataUrl: await (isStandalonePage(browserId) ? snapshotStandalonePage(browserId) : snapshotBrowserPage(browserId)) }),
  inspectAnnotation: async (args: Parameters<typeof inspectBrowserAnnotation>[0]) => {
    if (!isStandalonePage(args.browserId)) return inspectBrowserAnnotation(args);
    if (browserKernelBindings.get(args.browserId)?.sessionId !== args.sessionId) throw new Error('This conversation has no selected browser page');
    const result = await (await standaloneScreen(args.browserId)).control({ action: 'annotate', query: args.query, capture: args.capture });
    if (!result) throw new Error('The browser annotation could not be read');
    return result;
  },
  setAnnotationBrowsing: (args: { browserId: string; browsing: boolean }) => ({
    success: isStandalonePage(args.browserId) || browserWebContentsRegistry.setAnnotationBrowsing(args.browserId, args.browsing),
  }),
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
      if (await standaloneKernelService().selection() === 'standalone') {
        throw new Error('Importing logins into standalone Chrome is not available in this prototype');
      }
      return await importDefaultBrowserCookies(profileId);
    } catch (error) {
      return { ok: false as const, browser: defaultBrowser().name, reason: 'other' as const, detail: error instanceof Error ? error.message : String(error) };
    }
  },

  openDevTools: (browserId: string) => ({
    success: import.meta.env.DEV && browserWebContentsRegistry.openDevTools(browserId),
  }),

  captureScreenshot: async (browserId: string) => ({
    success: await (isStandalonePage(browserId) ? copyStandaloneScreenshot(browserId) : browserWebContentsRegistry.captureScreenshotToClipboard(browserId)),
  }),

  clearData: async (browserId: string, kind: BrowserDataClearKind) => {
    if (!isBrowserDataClearKind(kind)) {
      return { success: false as const, error: 'Invalid browser data clear kind' };
    }
    if (isStandalonePage(browserId)) {
      if (kind === 'storage') throw new Error('Clearing standalone Chrome site storage is not available in this prototype');
      await standaloneHostCommand(browserId, kind === 'cookies' ? 'Network.clearBrowserCookies' : 'Network.clearBrowserCache');
      return { success: true };
    }
    return { success: await browserWebContentsRegistry.clearData(browserId, kind) };
  },

  clearProfileStorage: async (profileId: string) => {
    if (await standaloneKernelService().hasProfiles()) throw new Error('Clearing standalone Chrome profiles is not available in this prototype');
    return { success: await browserWebContentsRegistry.clearProfileStorage(profileId) };
  },

  clearBrowsingData: async (kind: string) => {
    if (!isBrowsingDataKind(kind)) {
      return { success: false as const, error: 'Invalid browsing data kind' };
    }
    if (await standaloneKernelService().hasProfiles()) throw new Error('Clearing all standalone Chrome browsing data is not available in this prototype');
    const partitions = await collectBrowserPartitions();
    return { success: await browserWebContentsRegistry.clearBrowsingData(kind, partitions) };
  },
});

// Explicit browsing-data controls include legacy on-disk partitions too. Their
// retirement never authorizes startup deletion of cookies or unsaved site data.
async function collectBrowserPartitions(): Promise<string[]> {
  const browserSettings = await appSettingsService.get('browser');
  const partitions = new Set<string>([browserProfilePartition(DEFAULT_BROWSER_PROFILE_ID)]);
  for (const profile of browserSettings.profiles) {
    partitions.add(browserProfilePartition(profile.id));
  }
  for (const partition of browserWebContentsRegistry.registeredPartitions) {
    partitions.add(partition);
  }
  for (const partition of await listPersistedBrowserPartitions()) partitions.add(partition);
  return [...partitions];
}
