import { createContext, useContext, useSyncExternalStore } from 'react'
import { MOBILE_TABS, type SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels'

// @@@shell-tab-store — which top-level surface (消息 / 联系人 / 设置 …) is shown. One store per main layout,
// outside React state: a switch must cost O(1) renders. A surface asks only "am I shown?" (useShellTabIs),
// so flipping tabs re-renders the two surfaces whose answer changed, never the hidden trees behind them.
// ❌ Thread the tab down as a prop again: every prop change re-renders the whole retained surface.
// @@@phone-chat-layer — on the phone a conversation is a page pushed over the root tab (消息 / 伙伴) it was opened from;
// 咕咕 / 项目 / 我的 are layers pushed over either. The store keeps the root and the chat page's origin, never a separate
// "chat page is open" flag: the chat page is up only while its origin is the current root and the conversation is still
// in the chat list, read from the chat store itself. Leaving, being removed or a deleted conversation therefore shows
// the origin's root page in that same frame; nothing has to remember to close it.
// @@@phone-chat-trail — what the chat page was entered over, so back returns there, one entry per back press, before the
// origin's root page: the conversation that was on screen (a member's card → 发消息, a group card in a message, a
// notification while chatting), or the search panel a result was opened from (it reopens as it was left). The trail is
// part of the chat page: entering it from a root tab starts it empty, closing it or leaving the root drops it. It follows
// the chat list: a conversation deleted or left leaves the trail in that same notification, so back never lands on a
// conversation that is gone.
export type ChatUnder = { chatId: string } | { search: true }
export type ShellTabStore = {
  /** The surface on screen: a pushed layer, else 'chats' while the phone chat page is up, else the root tab. */
  get(): SidebarTab
  /** The root tab (消息 / 伙伴) under the chat page and any pushed layer. */
  root(): SidebarTab
  /** What a pushed layer returns to: the layer or root tab as set, with the chat page (if any) still over its root. */
  under(): SidebarTab
  chatShown(): boolean
  set(tab: SidebarTab): void
  /** Push the phone chat page from root tab `from`, or close it (null). Either starts its trail empty. */
  setChatFrom(from: SidebarTab | null): void
  /** A conversation is entered from root tab `from`. With the chat page already up, `onPage` (the conversation shown there,
   *  if it is another one) goes under it; else the chat page is pushed from `from`. A pending search goes under it too. */
  openChat(from: SidebarTab, onPage: string | null): void
  /** A search result is being opened: the conversation it opens is entered over the search panel. */
  searchLeft(): void
  /** Back on the chat page: what to show again (the caller shows it), or null = back to the origin's root page. */
  popChat(): ChatUnder | null
  subscribe(listener: () => void): () => void
}
export type ShellChatList = {
  /** The open conversation, if it is still in the chat list. */
  activeId(): string | null
  listed(chatId: string): boolean
  subscribe(listener: () => void): () => void
}

export function createShellTabStore(initial: SidebarTab, chatList?: ShellChatList): ShellTabStore {
  let tab = initial
  let root: SidebarTab = MOBILE_TABS.includes(initial) ? initial : 'chats'
  let chatFrom: SidebarTab | null = null
  let trail: ChatUnder[] = []
  let searchPending = false
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  const chatShown = () => chatFrom !== null && chatFrom === root && !!chatList?.activeId()
  const gone = (entry: ChatUnder) => 'chatId' in entry && (entry.chatId === chatList?.activeId() || !chatList?.listed(entry.chatId))
  chatList?.subscribe(() => { trail = trail.filter((entry) => !('chatId' in entry) || chatList.listed(entry.chatId)) })
  return {
    get: () => tab === root && chatShown() ? 'chats' : tab,
    root: () => root,
    under: () => tab,
    chatShown,
    set(next) {
      if (next === tab) return
      tab = next
      if (MOBILE_TABS.includes(next)) {
        // Another root tab is another place: the chat page pushed over the old one is not kept for later.
        if (chatFrom !== next) { chatFrom = null; trail = []; searchPending = false }
        root = next
      }
      notify()
    },
    setChatFrom(from) {
      if (from === chatFrom) return
      chatFrom = from
      trail = []
      searchPending = false
      notify()
    },
    openChat(from, onPage) {
      if (chatShown() && chatFrom === from) {
        if (onPage) trail.push({ chatId: onPage })
      } else {
        chatFrom = from
        trail = []
      }
      if (searchPending) trail.push({ search: true })
      searchPending = false
      notify()
    },
    searchLeft() {
      searchPending = true
    },
    popChat() {
      let under = trail.pop()
      while (under && gone(under)) under = trail.pop()
      return under ?? null
    },
    subscribe(listener) {
      listeners.add(listener)
      const offChats = chatList?.subscribe(listener)
      return () => { listeners.delete(listener); offChats?.() }
    },
  }
}

export const ShellTabContext = createContext<ShellTabStore | null>(null)

export function useShellTabStore(): ShellTabStore {
  const store = useContext(ShellTabContext)
  if (!store) throw new Error('useShellTab* is used outside the main layout (no ShellTabContext)')
  return store
}

export function useShellTabOf(store: ShellTabStore): SidebarTab {
  return useSyncExternalStore(store.subscribe, store.get)
}

export function useShellTab(): SidebarTab {
  return useShellTabOf(useShellTabStore())
}

export function useShellTabIs(tab: SidebarTab): boolean {
  const store = useShellTabStore()
  return useSyncExternalStore(store.subscribe, () => store.get() === tab)
}

/** The shown tab if it is one of `tabs`, else null: re-renders only when the answer changes. `[]` never re-renders. */
export function useShellTabAmong(tabs: readonly SidebarTab[]): SidebarTab | null {
  // An empty set is "this surface does not depend on the shell tab": it needs no store (it may live in another root).
  const store = useContext(ShellTabContext)
  if (!store && tabs.length) throw new Error('useShellTabAmong is used outside the main layout (no ShellTabContext)')
  return useSyncExternalStore(store?.subscribe ?? subscribeNothing, () => { const tab = store?.get(); return tab && tabs.includes(tab) ? tab : null })
}

const subscribeNothing = () => () => {}

const IM_PAGE_TABS: readonly SidebarTab[] = ['chats', 'contacts']
const NO_TABS: readonly SidebarTab[] = []

/** Which tab a chat area belongs to. Only the IM page's panel (web / phone 消息, `imPage`) follows the shell tab; every
 *  other host (task-page block, assistant slot, task window, phone assistant) owns its visibility through `hidden`,
 *  draws as 消息 and never subscribes. */
export function useImPageTab(imPage: boolean): SidebarTab | null {
  return useShellTabAmong(imPage ? IM_PAGE_TABS : NO_TABS) ?? (imPage ? null : 'chats')
}
