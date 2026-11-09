import { use, type ComponentType } from 'react';
import type { TabContentProps } from '@renderer/features/tabs/core/tab-provider';
import { registerTabViews } from '@renderer/features/tabs/core/tab-views';
import { getAcpChatResourceManager } from './acp/acp-chat-resource-manager';
import { installAcpChatResources } from './acp/acp-chat-resources';

/**
 * 任务页各种页签的「界面那半」(见 tabs/core/tab-views.tsx 的 @@@tab-views)。
 * ⚠️ 只许任务页入口(embedded.tsx)import 这个文件:下面的 import() 写在这里,手机不加载任务页入口,就够不着这些
 * 内容组件和它们连着的编辑器、对话面板、diff;写进 provider 里,它们就跟着 provider 进了手机包(phone-web-dir 按引用收)。
 */
type TabViewModule = { TabContent: ComponentType<TabContentProps> };

const loaders: Record<string, () => Promise<TabViewModule>> = {
  session: () => import('./session-tab-view'),
  'acp-chat': () => import('./acp/acp-chat-tab-view'),
  'side-chat': () => import('./acp/side-chat-tab-view'),
  'file-view': () => import('./file-view/file-view-tab-view'),
  'chat-resource': () => import('./chat-resource-tab-view'),
  review: () => import('./diff-view/review-tab-view'),
  diff: () => import('./diff-view/diff-tab-view'),
  browser: () => import('../browser/browser-tab-view'),
  terminal: () => import('./terminals/terminal-tab-view'),
  'remote-ports': () => import('../remote-hosts/workspace/remote-ports-tab-view'),
};

export const SESSION_TAB_VIEW_KINDS = Object.keys(loaders);

/**
 * @@@tab-view-sync-once-loaded - `React.lazy` suspends on its first render even when the module has already arrived, and React
 * then holds the content back for up to 300 ms after committing the fallback: a blank page on the first open of each kind, with
 * the main thread idle (mac1: 270 ms of the 400 ms to a first terminal). Once loaded this renders synchronously, so prewarming
 * removes the wait rather than only the download.
 */
function tabView(load: () => Promise<TabViewModule>) {
  let Loaded: ComponentType<TabContentProps> | null = null;
  let loading: Promise<void> | null = null;
  const ensure = () => (loading ??= load().then(
    (module) => { Loaded = module.TabContent; },
    (error: unknown) => { loading = null; throw error; },
  ));
  function TabView(props: TabContentProps) {
    if (!Loaded) use(ensure());
    return Loaded && <Loaded {...props} />;
  }
  return { View: TabView, ensure };
}

const views = Object.fromEntries(Object.entries(loaders).map(([kind, load]) => [kind, tabView(load)]));

export function installSessionTabViews(): void {
  installAcpChatResources(getAcpChatResourceManager);
  registerTabViews(Object.fromEntries(Object.entries(views).map(([kind, { View }]) => [kind, View])));
}

/** 桌面空闲时把各页签的界面那半先载进来:第一次打开某种页签就不用再等下载、解析。载失败不吞:真打开那一下会再载一次并报错。 */
export function prewarmSessionTabViews(): void {
  for (const { ensure } of Object.values(views)) void ensure();
}
