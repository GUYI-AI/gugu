import { observer } from 'mobx-react-lite'
import { Fragment, useEffect, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { chatTabSlotKey, readShellSlots } from '../../lib/shellSlots'
import { chatLayoutOf, chatPaneOf, focusedChatTab, infoTabOf, panelTabOf, panelTabsOf, topicTabOf, type ChatPanelTab } from '../../session/renderer/features/chats/chat-tabs/chat-layouts'
import { PaneContext } from '@renderer/features/tabs/pane-context'
import { makesPaneCurrent } from '@renderer/features/tabs/pane-activation'

const EMPTY: ReadonlyMap<string, HTMLElement> = new Map()

/** Input belongs to the React tree that draws it, including content portaled into a pane's empty DOM slot. */
export function ChatPaneContent({ chatId, tabId, ...props }: ComponentProps<'div'> & { chatId: string; tabId?: string }) {
  const focus = (event: { target: EventTarget }) => {
    if (!makesPaneCurrent(event.target)) return
    const layout = chatLayoutOf(chatId)
    const id = tabId ?? layout.groups.flatMap(({ pane }) => [...pane.entries.values()]).find(tab => tab.kind === 'chat')?.tabId
    if (id) chatPaneOf(chatId, id)?.setActiveTab(id)
  }
  return <div {...props} onPointerDownCapture={focus} onFocusCapture={focus} />
}


/**
 * In a block, each tab of the chat that is on screen has a slot the session page's engine left for it (chat-tab-providers'
 * ShellTabSlots): what it shows is drawn into it here, in the chat's own tree — its state, its Apps, its topic line.
 */
export const ChatTabPortals = observer(function ChatTabPortals({ chatId, panel, topic, info }: {
  chatId: string
  panel: (tab: ChatPanelTab) => ReactNode
  topic: () => ReactNode
  info: () => ReactNode
}) {
  const slots = readShellSlots()
  const entries = useSyncExternalStore(
    (listener) => slots?.subscribeSlots(listener) ?? (() => undefined),
    () => slots?.getSlots() ?? EMPTY,
  )
  const topicTab = topicTabOf(chatId)
  const topicSlot = topicTab ? entries.get(chatTabSlotKey(chatId, topicTab.tabId)) : undefined
  const infoTab = infoTabOf(chatId)
  const infoSlot = infoTab ? entries.get(chatTabSlotKey(chatId, infoTab.tabId)) : undefined
  return (
    <>
      {panelTabsOf(chatId).map((tab) => {
        const element = entries.get(chatTabSlotKey(chatId, tab.tabId))
        const layout = chatLayoutOf(chatId)
        const owner = [...layout.groups, ...layout.windowPanes.values()].find(({ pane }) => pane.entries.has(tab.tabId))
        // A portal inherits the shell's React context, not the pane around its DOM slot.
        return element && owner ? createPortal(<PaneContext.Provider value={{ pane: owner.pane, paneId: owner.paneId, isFocusedPane: tab.focused && tab.shown }}><ChatPaneContent chatId={chatId} tabId={tab.tabId} className="contents">{panel(tab)}</ChatPaneContent></PaneContext.Provider>, element, tab.tabId) : null
      })}
      {topicTab && topicSlot ? createPortal(<ChatPaneContent chatId={chatId} tabId={topicTab.tabId} className="contents">{topic()}</ChatPaneContent>, topicSlot, topicTab.tabId) : null}
      {infoTab && infoSlot ? createPortal(<ChatPaneContent chatId={chatId} tabId={infoTab.tabId} className="contents">{info()}</ChatPaneContent>, infoSlot, infoTab.tabId) : null}
    </>
  )
})

/**
 * Where there is no strip (the phone, the assistant's window): the tab in front, a whole page over the chat — its way out
 * is its back. A tab and the 上一页 it goes back to are one page here (`key`: the first of them), so going back finds that
 * page as it was (G2: a phone frame is not kept anywhere else).
 */
export const ChatTabPage = observer(function ChatTabPage({ chatId, panel, topic, info }: {
  chatId: string
  panel: (tab: ChatPanelTab) => ReactNode
  topic: () => ReactNode
  info: () => ReactNode
}) {
  useEffect(() => {
    const layout = chatLayoutOf(chatId)
    layout.setSinglePaneHost(true)
    return () => layout.setSinglePaneHost(false)
  }, [chatId])
  const focused = focusedChatTab(chatId)
  if (focused?.kind === 'topic') return <>{topic()}</>
  if (focused?.kind === 'info') return <>{info()}</>
  const tab = focused?.kind === 'panel' ? panelTabOf(chatId, focused.tabId) : null
  if (!tab) return null
  return <Fragment key={tab.tabId}>{panel(tab)}</Fragment>
})
