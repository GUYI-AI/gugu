import type { PaneLayoutStore } from '../tabs/pane-layout-store';
import type { PaneStore } from '../tabs/pane-store';
import type { LiveWindowTabResource } from './live-window-tab';
import type { LiveWindowPresentation, LiveWindowSource } from './types';

/**
 * @@@layout-wide - a screen tab opened from a chat lands wherever the layout seats it (the side pane of a chat
 * workspace), so a conversation's screen tabs are looked up across the whole layout, never only in the chat's own pane.
 */
export function screenTabsOf(layout: PaneLayoutStore, key: string) {
  return [...layout.groups, ...layout.windowPanes.values()].flatMap(({ pane: holder }) => holder.resolvedTabs
    .filter(tab => tab.kind === 'live-window' && (tab.resource as LiveWindowTabResource).state.conversationKey === key)
    .map(tab => ({ tab, holder, sourceId: (tab.resource as LiveWindowTabResource).state.sourceId })));
}

/** One screen tab per shown source while the window is tabbed; none otherwise. */
export function syncScreenTabs(layout: PaneLayoutStore, chat: { pane: PaneStore; tabId: string }, key: string,
  presentation: LiveWindowPresentation | null | undefined, sources: readonly LiveWindowSource[]): void {
  const matching = screenTabsOf(layout, key);
  // Closing one tab can collapse a pair and move the rest, so each is closed in the pane holding it by then.
  const close = (tabId: string) => screenTabsOf(layout, key).find(({ tab }) => tab.tabId === tabId)?.holder.closeTab(tabId);
  if (presentation?.mode !== 'tabbed') {
    if (matching.some(({ tab }) => tab.isActive)) chat.pane.setActiveTab(chat.tabId);
    for (const { tab } of matching) close(tab.tabId);
    return;
  }
  for (const source of sources) {
    if (!matching.some(({ sourceId }) => sourceId === source.id)) {
      layout.open('live-window', { conversationKey: key, sourceId: source.id, chatTabId: chat.tabId }, { from: chat.tabId, intent: 'newTab', activate: false });
    }
  }
  for (const { tab, sourceId } of matching) if (!sources.some(source => source.id === sourceId)) close(tab.tabId);
  if (presentation.selectedTab === 'screen') {
    const selected = screenTabsOf(layout, key).find(({ sourceId }) => sourceId === presentation.selectedSourceId);
    if (selected && !selected.tab.isActive) selected.holder.setActiveTab(selected.tab.tabId);
  }
}
