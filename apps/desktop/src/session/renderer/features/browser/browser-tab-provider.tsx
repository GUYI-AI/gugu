import { workspaceBackend } from '@renderer/features/sessions/workspace-backend/workspace-backend';
import { browserSessionStore } from '@renderer/features/browser/browser-session-store';
import { popupClaims } from '@renderer/features/browser/browser-popup-claims';
import { getAppSettingValueSnapshot } from '@renderer/features/settings/app-settings-client';
import type { TabEntry, TabHandle, TabProvider, TabViewContext } from '@renderer/features/tabs/core/tab-provider';
import { createTabProvider } from '@renderer/features/tabs/core/tab-provider-registry';
import { registeredTabView } from '@renderer/features/tabs/core/tab-views';
import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';
import { profileForNewTab } from '@shared/browser';
import type { BrowserSessionSnapshot, BrowserWindowOwner } from '@shared/browser';
import { BrowserTabBarItem, BrowserTabBarItemDragPreview } from './browser-tab-item';
import { BrowserTabResource } from './browser-tab-resource';

// 浏览器页签只有这一种。会话在别的机器上时,工作区后端给它装上那台机器的那一半(workspace-browser-backend):
// localhost 端口经 SSH 转过来、file: 网页从那台机器取、ssh 要问人时画一张提问卡片 —— 页签、地址栏、加载失败页都是同一个。

export interface BrowserState {
  browserId: string;
  /** Session snapshot — kept current by BrowserTabResource's MobX reaction. */
  session: BrowserSessionSnapshot;
  workspaceStart?: true;
  /** 转发的端口活不过应用重启(别的机器上的会话):❌ 从快照里复活一个地址栏指着没人监听的本机端口的页签。 */
  ephemeral?: true;
}

export type BrowserOpenArgs = {
  initialUrl?: string;
  workspaceStart?: true;
  /** The window the standalone Chrome already created for this tab: the tab shows it instead of loading `initialUrl`. */
  popup?: string;
  /** With `popup`: the tab of the page that opened the window. The window lives in its Chrome, so this tab is in its profile and partition. */
  windowOf?: BrowserWindowOwner;
};

export const browserTabProvider: TabProvider<
  'browser',
  BrowserState,
  BrowserTabResource,
  BrowserOpenArgs
> = createTabProvider({
  kind: 'browser',
  resourceKey: (s: BrowserState) => s.browserId,
  // Every open is a new browser session: where it shows is remembered for the kind.
  placementKey: () => 'browser',
  // 两个网页并排:两页都在这一层里各摆一边,❌ 另一页单独挂一份(挪过去 = 重新加载)。
  isPersistent: (s: BrowserState) => !s.ephemeral,

  // No mount: multi. Each open creates a fresh browser session.

  /**
   * Creates a new browser session and returns it as the initial state.
   * Returns null to abort if session creation fails (shouldn't happen).
   */
  onBeforeOpen(args: BrowserOpenArgs, ctx: TabViewContext): BrowserState | null {
    const sessionCtx = ctx as SessionTabContext;
    const chatId = ctx.place?.kind === 'chat' ? ctx.place.chatId : undefined;
    const browserSettings = getAppSettingValueSnapshot('browser');
    // A tab opened to show a window the standalone Chrome created is a standalone tab in that window's profile; every other tab
    // opens in the profile chosen in Settings, on the engine chosen there.
    const windowOf = args.popup ? args.windowOf : undefined;
    const { profileId, partition } = profileForNewTab(browserSettings, windowOf);
    const session = browserSessionStore.createSession({
      kernel: windowOf ? 'standalone' : browserSettings?.kernel,
      projectId: chatId ? 'chat' : sessionCtx.projectId,
      workspaceId: chatId ?? sessionCtx.workspaceId,
      sessionId: chatId ? '' : sessionCtx.sessionId,
      profileId,
      partition,
      initialUrl: args.initialUrl,
    });
    if (args.popup) popupClaims.remember(session.browserId, args.popup);
    const persistent = !!chatId || workspaceBackend(sessionCtx.projectId).browser.persistent;
    return {
      browserId: session.browserId,
      session,
      ...(args.workspaceStart && { workspaceStart: true }),
      ...(!persistent && { ephemeral: true }),
    };
  },

  initialize(
    entry: TabEntry<BrowserState>,
    handle: TabHandle,
    ctx: TabViewContext
  ): BrowserTabResource {
    if (ctx.place?.kind === 'chat') return new BrowserTabResource(entry, handle);
    const sessionCtx = ctx as SessionTabContext;
    return new BrowserTabResource(entry, handle, (browserId) =>
      workspaceBackend(sessionCtx.projectId).browser.attach(browserId, sessionCtx),
      { projectId: sessionCtx.projectId, workspaceId: sessionCtx.workspaceId }
    );
  },

  dispose(_entry: TabEntry<BrowserState>, resource: BrowserTabResource): void {
    resource.dispose();
  },

  TabBarItem: BrowserTabBarItem,
  TabBarItemDragPreview: BrowserTabBarItemDragPreview,
  TabContent: registeredTabView('browser'),
});
