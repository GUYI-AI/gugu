import type { MessageItem } from '@gugu/core/shared/types/chat'
import { observer } from 'mobx-react-lite'
import { act, createElement, Fragment } from 'react'
import { expect } from 'vitest'
import { GroupTabContent } from '../../../../apps/desktop/src/components/appSlot/GroupTabContent'
import { useChatOpener } from '../../../../apps/desktop/src/components/appSlot/useChatOpener'
import { askChat, openPanelItem, shownPanelTab, type ChatOpenAsk } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-layouts'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'
import { AuthContext } from '../../../../apps/desktop/src/store/auth'
import { tellInstalled, type InstalledExtensionsList } from '../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions'

export interface ChatTabsProps {
  chatId: string
  /** In a block, whose strip names the tab (ChatAreaPanel's `blockHost`). */
  tabbed?: boolean
  mobile?: boolean
  visible?: boolean
  onForward?: (message: MessageItem) => void
}

/**
 * What ChatAreaPanel draws of a chat's tabs, without the rest of it: the chat's opener (its overlay — the open-with pick,
 * an App's files, a file that cannot open) and the panel tab on screen, as one tab of the strip shows it.
 */
export const ChatTabs = observer(function ChatTabs({ chatId, tabbed = false, mobile = false, visible, onForward }: ChatTabsProps) {
  const opener = useChatOpener(chatId)
  const tab = shownPanelTab(chatId)
  return createElement(Fragment, null, opener.overlay, tab
    ? createElement(GroupTabContent, { key: tab.tabId, chatId, tabId: tab.tabId, item: tab.item, tabbed, inWindow: tab.inWindow, mobile, visible, onForward, onOpenWith: opener.openWith })
    : null)
})

/** The chat's tabs, as a signed-in person sees them (the group's shared packages are read for one). */
export const chatTabs = (props: ChatTabsProps, userId = 'user-1') =>
  createElement(AuthContext.Provider, { value: { user: { id: userId } } as never }, createElement(ChatTabs, props))

/** Ask the chat, as the shell does (MainLayout, a link): kept for it, and the chat on screen told. */
export function ask(chatId: string, what: ChatOpenAsk): void {
  act(() => {
    askChat(chatId, what)
    window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked, { detail: { chatId } }))
  })
}

/** The item of the panel tab on screen; null: only the chat. */
export const shownItem = (chatId: string) => shownPanelTab(chatId)?.item ?? null

/** This chat's shared package cards as a file's mock of `chatPackageCards` answers them (`() => sharedCards.answer()`). */
export const sharedCards = { answer: async (): Promise<unknown[]> => [] }

/**
 * The shared-package mock is live: a file's page is held while this chat's shared packages are unknown (what decides its
 * offer), and drawn once they are read. Signed out, their key is null and the page would be held for good.
 */
export async function expectSharedPackagesLive(render: (node: ReturnType<typeof chatTabs>) => Promise<void>): Promise<void> {
  const chatId = 'shared-packages-live'
  let answer!: (cards: unknown[]) => void
  sharedCards.answer = () => new Promise((resolve) => { answer = resolve })
  try {
    // What is installed here is known (nothing): only the shared packages decide whether the page waits.
    act(() => tellInstalled('local', { extensions: [], invalid: [] } as unknown as InstalledExtensionsList))
    await render(chatTabs({ chatId }))
    act(() => { openPanelItem(chatId, { kind: 'office.main', itemId: 'doc', title: 'doc' }) })
    const held = () => document.querySelector('[data-testid="group-app-slot-raw-folded"]') !== null
    for (let turn = 0; turn < 20; turn += 1) await act(async () => { await Promise.resolve() })
    expect(held(), 'held while the shared packages are unknown').toBe(true)
    await act(async () => { answer([]) })
    for (let turn = 0; turn < 20 && held(); turn += 1) await act(async () => { await Promise.resolve() })
    expect(held(), 'drawn once they are read').toBe(false)
  } finally {
    sharedCards.answer = async () => []
  }
}
