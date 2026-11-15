import { useSyncExternalStore } from 'react';
import { readInterface, takeLegacyLocalStorage, writeInterface } from '@/lib/viewStateTable';

/**
 * #1925 Whether an App's panel beside its bound conversation is collapsed: per App, kept on this computer the way the
 * built-in assistant page keeps its own (`gugu.assistant.panel`), and changed by the frame's buttons or the App's own
 * `gugu.bindings.setPanel` (host action `conversationPanel`, main having checked the page is drawn there).
 */
const panelKey = (extensionId: string) => `gugu.app.${extensionId}.panel`;
const collapsedNow = new Map<string, boolean>();
const listeners = new Set<() => void>();

// These are view state of the device (lib/viewStateTable): an App's panel, the built-in page's panel and last tab. Kept in
// localStorage before; moved over once.
takeLegacyLocalStorage(
  (key) => /^gugu\.app\..+\.panel$/.test(key) || key === 'gugu.assistant.panel' || key === 'gugu.assistant.lastTab',
  (key, raw) => writeInterface(key, raw || undefined),
);

function stored(extensionId: string): boolean {
  return readInterface<string>(panelKey(extensionId)) === 'closed';
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
  writeInterface(panelKey(extensionId), collapsed ? 'closed' : 'open');
  for (const listener of listeners) listener();
}

/**
 * Entry switch (G6): the built-in assistant page's own panel state (`gugu.assistant.panel`, 'open' | 'closed') becomes this
 * App's, once — only while this App has none of its own yet; from then on the App's own state is the one kept. Nothing is
 * read or written when the built-in page never stored one (both open by default). Answers whether it carried.
 */
export const BUILT_IN_ASSISTANT_PANEL_KEY = 'gugu.assistant.panel';
export function carryBuiltInPanelOnce(extensionId: string): boolean {
  if (readInterface<string>(panelKey(extensionId)) !== undefined) return false;
  const builtIn = readInterface<string>(BUILT_IN_ASSISTANT_PANEL_KEY);
  if (builtIn !== 'open' && builtIn !== 'closed') return false;
  // Written even when equal to what is cached, so it is the App's own from now on.
  collapsedNow.delete(extensionId);
  setAppConversationPanelCollapsed(extensionId, builtIn === 'closed');
  writeInterface(panelKey(extensionId), builtIn);
  return true;
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

/**
 * Entry switch (G6): the tab the person last had open on the built-in assistant page (its view's `tab`, kept in the
 * navigation snapshot; once that view is gone, what the snapshot still held for it), to hand to the App once. Null: 动态 (the
 * default, nothing to hand) or nothing stored.
 */
const RESUME_TABS: readonly string[] = ['tasks', 'memory', 'profile'];
export function builtInAssistantLastTab(params: { tab?: unknown } | null | undefined): 'tasks' | 'memory' | 'profile' | null {
  const tab = params?.tab;
  return typeof tab === 'string' && RESUME_TABS.includes(tab) ? (tab as 'tasks' | 'memory' | 'profile') : null;
}

/**
 * The navigation snapshot keeps the built-in page's view only for the run that restores it (the view is gone): its last tab
 * is kept here on this computer until it is handed over (an App still being put in hands it over on a later run).
 */
const KEPT_LAST_TAB_KEY = 'gugu.assistant.lastTab';
export function keepBuiltInAssistantLastTab(params: { tab?: unknown } | null | undefined): void {
  const tab = builtInAssistantLastTab(params);
  if (!tab) return;
  writeInterface(KEPT_LAST_TAB_KEY, tab);
}
export function keptBuiltInAssistantLastTab(): 'tasks' | 'memory' | 'profile' | null {
  return builtInAssistantLastTab({ tab: readInterface<string>(KEPT_LAST_TAB_KEY) });
}

const handedOverKey = (ownerId: string) => `gugu.assistant.handedOver:${ownerId}`;
/** Whether the hand-over to the App was done for this account on this computer (then never again). */
export function assistantHandedOver(ownerId: string): boolean {
  try {
    return localStorage.getItem(handedOverKey(ownerId)) === '1';
  } catch {
    return false;
  }
}
export function markAssistantHandedOver(ownerId: string): void {
  try {
    localStorage.setItem(handedOverKey(ownerId), '1');
  } catch {
    // 记不住:下次再交一回,App 只是再从那一页开一次。
  }
}
