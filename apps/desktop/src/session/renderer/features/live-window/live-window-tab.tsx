import { useSyncExternalStore } from 'react';
import { Globe, Monitor } from '@/lib/icons';
import type { TabProvider, TabResource } from '../tabs/core/tab-provider';
import { createTabProvider } from '../tabs/core/tab-provider-registry';
import { registeredTabView } from '../tabs/core/tab-views';
import { GenericTabItem, GenericTabDragPreview } from '../tabs/tab-bar/generic-tab-item';
import { findLiveWindowConversation } from './use-live-window-conversation';
import type { LiveWindowConversation } from './conversation';
import { getSessionView } from '../sessions/stores/session-selectors';
import type { SessionTabContext } from '../tabs/core/session-tab-context';
import { useLiveWindowLabels } from './desktop-labels';

export type LiveWindowTabState = { conversationKey: string; sourceId: string; chatTabId: string };
export class LiveWindowTabResource implements TabResource {
  constructor(readonly state: LiveWindowTabState, readonly conversation: LiveWindowConversation, readonly chatSelected: () => boolean) {}
  onActivate() {
    this.conversation.model.dispatch({ type: 'show-tab' });
    this.conversation.model.dispatch({ type: 'select-tab', tab: 'screen', sourceId: this.state.sourceId });
  }
  dispose() {}
}
export const liveWindowTabProvider: TabProvider<'live-window', LiveWindowTabState, LiveWindowTabResource, LiveWindowTabState> = createTabProvider({
  kind: 'live-window', resourceKey: state => `${state.conversationKey}:${state.sourceId}`, placementKey: () => 'live-window',
  isPersistent: () => false, reopenable: false,
  onBeforeOpen: state => findLiveWindowConversation(state.conversationKey) ? state : null,
  initialize: (entry, _handle, ctx) => {
    const conversation = findLiveWindowConversation(entry.state.conversationKey);
    if (!conversation) throw new Error('The live conversation has ended');
    return new LiveWindowTabResource(entry.state, conversation, () => {
      const session = ctx as SessionTabContext;
      const view = getSessionView(session.projectId, session.sessionId);
      return !!view && [...view.paneLayout.groups, ...view.paneLayout.windowPanes.values()]
        .some(({ pane }) => pane.resolvedTabs.some(tab => tab.tabId === entry.state.chatTabId && tab.isActive));
    });
  },
  onBeforeClose: (_entry, resource) => {
    const snapshot = resource.conversation.model.getSnapshot();
    if (resource.chatSelected() || snapshot.presentation?.selectedTab === 'chat') return false;
    resource.conversation.model.dispatch({ type: 'close-tab', sourceId: resource.state.sourceId }); return true;
  },
  dispose: (_entry, resource) => resource.dispose(),
  TabBarItem: ({ tab, host, ctx }) => {
    const t = useLiveWindowLabels();
    const { conversation, state } = tab.resource;
    const snapshot = useSyncExternalStore(conversation.model.subscribe, conversation.model.getSnapshot, conversation.model.getSnapshot);
    const source = snapshot.sources.find(source => source.id === state.sourceId);
    return <GenericTabItem tab={tab} host={host} ctx={ctx} label={source?.kind === 'computer' ? t('computer') : source?.title || t('web')}
      closeDisabled={host.resolvedTabs.some(tab => tab.tabId === state.chatTabId && tab.isActive)} preSlot={source?.kind === 'computer' ? <Monitor className="size-3" /> : <Globe className="size-3" />} />;
  },
  TabBarItemDragPreview: ({ tab }) => {
    const t = useLiveWindowLabels();
    const source = tab.resource.conversation.model.getSnapshot().sources.find(source => source.id === tab.resource.state.sourceId);
    return <GenericTabDragPreview label={source?.kind === 'computer' ? t('computer') : source?.title || t('web')} />;
  },
  TabContent: registeredTabView('live-window'),
});
