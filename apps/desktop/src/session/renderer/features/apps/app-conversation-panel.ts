import { useSyncExternalStore } from 'react';

/**
 * #1925 Whether an App's panel beside its bound conversation is collapsed: per App, kept on this computer the way the
 * built-in assistant page keeps its own (`gugu.assistant.panel`), and changed by the frame's buttons or the App's own
 * `gugu.bindings.setPanel` (host action `conversationPanel`, main having checked the page is drawn there).
 */
const panelKey = (extensionId: string) => `gugu.app.${extensionId}.panel`;
const collapsedNow = new Map<string, boolean>();
const listeners = new Set<() => void>();

function stored(extensionId: string): boolean {
  try {
    return localStorage.getItem(panelKey(extensionId)) === 'closed';
  } catch {
    return false;
  }
}

export function appConversationPanelCollapsed(extensionId: string): boolean {
  let collapsed = collapsedNow.get(extensionId);
  if (collapsed === undefined) {
    collapsed = stored(extensionId);
    collapsedNow.set(extensionId, collapsed);
  }
  return collapsed;
}

export function setAppConversationPanelCollapsed(extensionId: string, collapsed: boolean): void {
  if (appConversationPanelCollapsed(extensionId) === collapsed) return;
  collapsedNow.set(extensionId, collapsed);
  try {
    localStorage.setItem(panelKey(extensionId), collapsed ? 'closed' : 'open');
  } catch {
    // 记不住就算了:这次照样收起 / 展开,下次打开回到默认(展开)。
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAppConversationPanelCollapsed(extensionId: string): boolean {
  return useSyncExternalStore(subscribe, () => appConversationPanelCollapsed(extensionId));
}
