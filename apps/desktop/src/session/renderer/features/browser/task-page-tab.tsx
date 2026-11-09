// #1607 node 5 — a task's page that lives on another of the person's computers (a Gugu server's), in this session's
// browser tab: its live picture, and the person takes over by clicking and typing in it. On this computer the same page
// is the real page in the browser tab; there it is that page's picture. Opened when that machine's agent opens its page.
import { Globe } from '@/lib/icons';
import type { ResolvedTab, TabBarItemProps, TabEntry, TabProvider, TabResource } from '@renderer/features/tabs/core/tab-provider';
import { createTabProvider } from '@renderer/features/tabs/core/tab-provider-registry';
import { registeredTabView } from '@renderer/features/tabs/core/tab-views';
import { GenericTabDragPreview, GenericTabItem } from '@renderer/features/tabs/tab-bar/generic-tab-item';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

export type TaskPageState = { deviceId: string; sessionId: string };

export class TaskPageResource implements TabResource {
  constructor(readonly deviceId: string, readonly sessionId: string) {}
  dispose(): void {}
}

function TaskPageTabItem({ tab, host, ctx }: TabBarItemProps<TaskPageResource>) {
  const { translate } = useSessionMessages();
  return <GenericTabItem tab={tab} host={host} ctx={ctx} label={translate('browser.tabFallbackTitle')} preSlot={<Globe className="size-3 shrink-0 text-foreground-muted" />} />;
}

function TaskPageTabDragPreview({ tab: _tab }: { tab: ResolvedTab<TaskPageResource> }) {
  const { translate } = useSessionMessages();
  return <GenericTabDragPreview preSlot={<Globe className="size-3 shrink-0 text-foreground-muted" />} label={translate('browser.tabFallbackTitle')} />;
}

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
