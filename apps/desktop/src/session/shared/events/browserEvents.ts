import type { ProjectionHostPacket } from '@shared/extensions/projection-protocol';
import type { TaskPageState } from '@shared/browser-task-page';
import { defineEvent } from '@shared/lib/ipc/events';

export const browserOpenInNewTabChannel = defineEvent<{
  sourceBrowserId: string;
  url: string;
}>('browser:open-in-new-tab');

/**
 * 用户点进了这个网页。点进网页的按下、聚焦都发生在网页自己的进程里,咕咕的界面收不到,
 * 只有主进程看得见 —— 两个网页并排时靠它让页签的焦点跟到点的那一边(spec session-page「并排」)。
 */
export const browserFocusedChannel = defineEvent<{ browserId: string }>('browser:focused');

/**
 * #7274 页签里那张网页此刻的导航状态,随每一条网页事件一起报(网页是主进程持有的 WebContentsView,页签那边
 * 读不到它,只能照这一份画地址栏、前进后退)。
 */
export type BrowserPageState = { url: string; title: string; canGoBack: boolean; canGoForward: boolean };
export type BrowserPageEventType =
  | 'dom-ready'
  | 'did-start-loading'
  | 'did-stop-loading'
  | 'did-navigate'
  | 'did-navigate-in-page'
  | 'did-fail-load'
  | 'console-message'
  | 'page-title-updated'
  | 'page-favicon-updated'
  | 'focus'
  | 'blur';
export type BrowserPageEvent = {
  browserId: string;
  type: BrowserPageEventType;
  /** 与原先 `<webview>` 同名事件上的字段一样(url、errorCode、title、favicons…)。 */
  detail: Record<string, unknown>;
  state: BrowserPageState;
};
export const browserPageEventChannel = defineEvent<BrowserPageEvent>('browser:page-event');

/**
 * #1607 node 5 — a task's page on another of the person's computers (a Gugu server's), shown in this tab as its live
 * picture: the packets of one watch (`rpc.browser.watchTaskPage`), with the projection protocol's shapes.
 */
export const browserTaskPagePacketChannel = defineEvent<{ watchId: string; packet: ProjectionHostPacket }>('browser:task-page-packet');
/** That page's toolbar state (address, title, loading, back / forward), whenever it changes there. */
export const browserTaskPageStateChannel = defineEvent<{ watchId: string; state: TaskPageState }>('browser:task-page-state');

/**
 * #7274 页签里网页那一块此刻的样子:`shown` 露在屏上;`occluded` 页签在屏上、但咕咕自己的浮层(菜单、弹窗、
 * 起始页…)压在它上面 —— 网页画在界面之上,这时得让开、换成一张截图;`background` 不在屏上(后台页签、别的会话)。
 */
export type BrowserPageMode = 'shown' | 'occluded' | 'background';

export const browserLinkCopiedChannel = defineEvent<{
  kind: 'image' | 'link' | 'url';
  url: string;
}>('browser:link-copied');
