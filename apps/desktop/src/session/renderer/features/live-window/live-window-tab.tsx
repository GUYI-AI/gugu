import { useSyncExternalStore } from 'react';
import { Globe, Monitor } from '@/lib/icons';
import type { TabProvider, TabResource } from '../tabs/core/tab-provider';
import { createTabProvider } from '../tabs/core/tab-provider-registry';
import { registeredTabView } from '../tabs/core/tab-views';
import { GenericTabItem, GenericTabDragPreview } from '../tabs/tab-bar/generic-tab-item';
import { findLiveWindowConversation } from './use-live-window-conversation';
import type { LiveWindowConversation } from './conversation';

export type LiveWindowTabState = { conversationKey: string; sourceId: string; chatTabId: string };
export class LiveWindowTabResource implements TabResource {
  constructor(readonly state: LiveWindowTabState, readonly conversation: LiveWindowConversation) {}
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
  initialize: entry => {
    const conversation = findLiveWindowConversation(entry.state.conversationKey);
    if (!conversation) throw new Error('The live conversation has ended');
    return new LiveWindowTabResource(entry.state, conversation);
  },
  onBeforeClose: (_entry, resource) => {
    const snapshot = resource.conversation.model.getSnapshot();
    if (snapshot.presentation?.selectedTab === 'chat') return false;
    resource.conversation.model.dispatch({ type: 'close-tab', sourceId: resource.state.sourceId }); return true;
  },
  dispose: (_entry, resource) => resource.dispose(),
  TabBarItem: ({ tab, host, ctx }) => {
    const { conversation, state } = tab.resource;
    const snapshot = useSyncExternalStore(conversation.model.subscribe, conversation.model.getSnapshot, conversation.model.getSnapshot);
    const source = snapshot.sources.find(source => source.id === state.sourceId);
    return <GenericTabItem tab={tab} host={host} ctx={ctx} label={source?.title ?? ''}
      closeDisabled={snapshot.presentation?.selectedTab === 'chat'} preSlot={source?.kind === 'computer' ? <Monitor className="size-3" /> : <Globe className="size-3" />} />;
  },
  TabBarItemDragPreview: ({ tab }) => {
    const source = tab.resource.conversation.model.getSnapshot().sources.find(source => source.id === tab.resource.state.sourceId);
    return <GenericTabDragPreview label={source?.title ?? ''} />;
  },
  TabContent: registeredTabView('live-window'),
});
