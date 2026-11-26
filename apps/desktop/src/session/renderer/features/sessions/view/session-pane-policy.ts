import type { TabEntry } from '@renderer/features/tabs/core/tab-provider';
import type { sessionTabView } from '../session-tab-registry';

type SessionPaneLayout = ReturnType<typeof sessionTabView.createPaneLayoutStore>;

/** 会话本身的页签(对话):两种形态 —— 编程模式的 conversation 与通用模式的 acp-chat。 */
export const CHAT_TAB_KINDS: ReadonlySet<string> = new Set(['session', 'acp-chat']);

/**
 * 正显示着「当前会话」的那一格(#7052:对话是会话的第一枚页签,可以在任何一格)。先看正聚焦的那一格前面是不是对话,
 * 再按格子的顺序找前面是对话的那一格,都没有就是第一格里收着对话页签的那一格。
 */
export function findChatPaneId(paneLayout: SessionPaneLayout): string | undefined {
  // 并排时屏上有两枚(spec session-page「并排」):问的是「对话在不在屏上」,❌ 只看第一枚亮着的。
  const showsChat = (g: (typeof paneLayout.groups)[number]) =>
    g.pane.resolvedTabs.some((t) => t.isActive && CHAT_TAB_KINDS.has(t.kind));
  const focused = paneLayout.groups.find((g) => g.paneId === paneLayout.activePaneId);
  if (focused && showsChat(focused)) return focused.paneId;
  return (
    paneLayout.groups.find(showsChat) ??
    paneLayout.groups.find((g) => g.pane.resolvedTabs.some((t) => CHAT_TAB_KINDS.has(t.kind)))
  )?.paneId;
}

export function isSessionConversationTab(entry: TabEntry, sessionId: string): boolean {
  return CHAT_TAB_KINDS.has(entry.kind) && (entry.state as { sessionId?: string } | undefined)?.sessionId === sessionId;
}

/** Resolve only the named conversation's identity; no active-pane or neighbouring fallback. */
export function sessionConversationTabId(paneLayout: SessionPaneLayout, sessionId: string): string | null {
  for (const { pane } of paneLayout.groups) {
    for (const entry of pane.entries.values()) {
      if (isSessionConversationTab(entry, sessionId)) return entry.tabId;
    }
  }
  return null;
}

/**
 * 这一块正看着的那条会话 —— 「当前会话」在会话页只有这一种读法(两种形态一视同仁)。
 * 侧边任务、块右上的控制、「在会话里写一句」都读它,❌ 各算一份。
 */
export function activeChatSessionId(paneLayout: SessionPaneLayout): string | undefined {
  const paneId = findChatPaneId(paneLayout);
  const group = paneLayout.groups.find((g) => g.paneId === paneId);
  if (!group) return undefined;
  const chatTabs = group.pane.resolvedTabs.filter((t) => CHAT_TAB_KINDS.has(t.kind));
  const activeTab = chatTabs.find((t) => t.isActive) ?? chatTabs[0];
  if (!activeTab) return undefined;
  return (group.pane.entries.get(activeTab.tabId)?.state as { sessionId?: string })?.sessionId;
}

/**
 * Close every chat tab (pty conversation / acp-chat / side-chat fork) bound to `conversationId`, in
 * every pane. Reports the pane that was DISPLAYING it — judged by `resolvedActiveTabId`, the same read
 * the chat column uses (a restored legacy snapshot can show a tab with `activeTabId` undefined).
 * One loop for both callers (deletion in the view model, Stop in the resource monitor): the older
 * per-caller copy read `entry.conversationId`, a field that never existed, and matched nothing.
 */
export function closeTabsOfSession(
  paneLayout: SessionPaneLayout,
  sessionId: string
): {
  displayedInPaneId: string | undefined;
  /** 它自己那枚对话页签原来在哪一格、排第几(按关完之后剩下的页签数)—— 换展示时新那枚放回这里。 */
  chatTabAt: { paneId: string; index: number } | undefined;
} {
  let displayedInPaneId: string | undefined;
  let chatTabAt: { paneId: string; index: number } | undefined;
  for (const { paneId, pane } of paneLayout.groups) {
    const doomed: string[] = [];
    for (const [tabId, entry] of pane.entries) {
      if (!CHAT_TAB_KINDS.has(entry.kind) && entry.kind !== 'side-chat') continue;
      const state = entry.state as { sessionId?: string } | undefined;
      if (state?.sessionId !== sessionId) continue;
      // 「正显示着」按屏上算:并排时焦点可能在右边那页,对话照样在屏上(spec session-page「并排」)。
      if (pane.shownTabIds.includes(tabId) && CHAT_TAB_KINDS.has(entry.kind)) {
        displayedInPaneId = paneId;
      }
      doomed.push(tabId);
    }
    const chatTabId = doomed.find((tabId) => CHAT_TAB_KINDS.has(pane.entries.get(tabId)?.kind ?? ''));
    if (chatTabId && !chatTabAt) {
      const before = pane.tabOrder.slice(0, pane.tabOrder.indexOf(chatTabId));
      chatTabAt = { paneId, index: before.filter((tabId) => !doomed.includes(tabId)).length };
    }
    for (const tabId of doomed) pane.closeTab(tabId);
  }
  return { displayedInPaneId, chatTabAt };
}
