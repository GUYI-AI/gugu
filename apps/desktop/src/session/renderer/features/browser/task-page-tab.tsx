// #1607 node 5 — a task's page that lives on another of the person's computers (a Gugu server's), in this session's
// browser tab: its live picture, and the person takes over by clicking and typing in it. On this computer the same page
// is the real page in the browser tab; there it is that page's picture. Opened when that machine's agent opens its page.
import { Globe } from '@/lib/icons';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { action, makeObservable, observable } from 'mobx';
import { observer } from 'mobx-react-lite';
import { BROWSER_DEFAULT_ZOOM_FACTOR, BROWSER_ISOLATED_PROFILE_ID, type BrowserSessionSnapshot } from '@shared/browser';
import type { TaskPageState as TaskPageToolbarState } from '@shared/browser-task-page';
import type { ResolvedTab, TabBarItemProps, TabEntry, TabProvider, TabResource } from '@renderer/features/tabs/core/tab-provider';
import { createTabProvider } from '@renderer/features/tabs/core/tab-provider-registry';
import { registeredTabView } from '@renderer/features/tabs/core/tab-views';
import { GenericTabDragPreview, GenericTabItem } from '@renderer/features/tabs/tab-bar/generic-tab-item';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { browserTabLabel } from './browser-tab-item';

export type TaskPageState = { deviceId: string; sessionId: string };

export class TaskPageResource implements TabResource {
  /** The page there, as its toolbar shows it; null until the first report arrives. */
  page: TaskPageToolbarState | null = null;

  constructor(readonly deviceId: string, readonly sessionId: string) {
    makeObservable(this, { page: observable.ref, setPage: action });
  }

  setPage(page: TaskPageToolbarState): void { this.page = page; }

  /** The page in the shape the browser tab's toolbar and title read: the same toolbar, the same title rules. */
  get session(): BrowserSessionSnapshot | undefined {
    const page = this.page;
    if (!page) return undefined;
    return {
      browserId: `task-page:${this.deviceId}:${this.sessionId}`, projectId: '', workspaceId: '', sessionId: this.sessionId,
      profileId: BROWSER_ISOLATED_PROFILE_ID, partition: '', currentUrl: page.url, title: page.title, isLoading: page.isLoading,
      canGoBack: page.canGoBack, canGoForward: page.canGoForward, zoomFactor: BROWSER_DEFAULT_ZOOM_FACTOR, zoomSource: 'auto',
      createdAt: 0, updatedAt: 0,
    };
  }

  dispose(): void {}
}

const TaskPageTabItem = observer(function TaskPageTabItem({ tab, host, ctx }: TabBarItemProps<TaskPageResource>) {
  const { translate } = useSessionMessages();
  const session = tab.resource.session;
  return (
    <GenericTabItem tab={tab} host={host} ctx={ctx} label={browserTabLabel(session, translate)}
      preSlot={<span className="shrink-0 text-foreground-muted [&>svg]:h-3 [&>svg]:w-3">{session?.isLoading ? <LoadingIndicator size="inline" /> : <Globe />}</span>} />
  );
});

const TaskPageTabDragPreview = observer(function TaskPageTabDragPreview({ tab }: { tab: ResolvedTab<TaskPageResource> }) {
  const { translate } = useSessionMessages();
  return <GenericTabDragPreview preSlot={<Globe className="size-3 shrink-0 text-foreground-muted" />} label={browserTabLabel(tab.resource.session, translate)} />;
});

export const taskPageTabProvider: TabProvider<'task-page', TaskPageState, TaskPageResource, TaskPageState> = createTabProvider({
  kind: 'task-page',
  resourceKey: (state: TaskPageState) => `${state.deviceId}:${state.sessionId}`,
  // One page per task: opening it again shows the same tab.
  placementKey: () => 'browser',
  // It lives as long as that machine's page: nothing to bring back after a restart.
  isPersistent: () => false,
  onBeforeOpen(args: TaskPageState): TaskPageState {
    return { deviceId: args.deviceId, sessionId: args.sessionId };
  },
  initialize(entry: TabEntry<TaskPageState>): TaskPageResource {
    return new TaskPageResource(entry.state.deviceId, entry.state.sessionId);
  },
  dispose(_entry: TabEntry<TaskPageState>, resource: TaskPageResource): void {
    resource.dispose();
  },
  TabBarItem: TaskPageTabItem,
  TabBarItemDragPreview: TaskPageTabDragPreview,
  TabContent: registeredTabView('task-page'),
});
