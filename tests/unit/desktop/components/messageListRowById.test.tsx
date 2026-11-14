// @vitest-environment jsdom
// @@@row-by-id — a mounted message row re-renders when its own message, read state or sender changes, not when the list
// around it does: a read receipt from one member, a message arriving, the window coming back to the front.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { createReactHarness, message } from '../../../support/testHarness'
import type { ChatListRowItem, MessageListRowProps } from '../../../../apps/desktop/src/components/chat/MessageList'

// A row's body renders its sender provider once per render of the row (it is not memoized), so it counts row renders.
const rowRenders = new Map<string, number>()
vi.mock('../../../../apps/desktop/src/components/chat/MessageSenderProvider', async () => {
  const React = await import('react')
  return {
    MessageSenderProvider: ({ message: msg, children }: { message: MessageItem; children: React.ReactNode }) => {
      rowRenders.set(msg.id, (rowRenders.get(msg.id) ?? 0) + 1)
      return React.createElement(React.Fragment, null, children)
    },
  }
})
vi.mock('../../../../apps/desktop/src/components/chat/MessageBubble', async () => {
  const React = await import('react')
  return { MessageBubble: ({ msg }: { msg: MessageItem }) => React.createElement('span', null, msg.content) }
})

const { MessageList } = await import('../../../../apps/desktop/src/components/chat/MessageList')

const noop = () => {}
const mine = (id: string, seq: number) => message({ id, chat_id: 'g', seq, sender_user_id: 'me', is_mine: true, content: id, created_at: '2026-11-14T08:00:00Z' })
function listProps(messages: MessageItem[], memberReadSeqs: Record<string, number>, onVisible: (msg: MessageItem) => void = noop) {
  const rows: ChatListRowItem[] = messages.map((msg) => ({ type: 'message', message: msg }))
  const rowProps: MessageListRowProps = {
    rows, messages, mobile: false, memberReadSeqs, deliveryWaits: new Map(), recipientFacts: { agentIds: new Set(), wakes: new Map() }, isGroupChat: true, memberProfiles: {},
    onReaction: noop, onQuote: noop, onForward: noop, onDelete: noop, onVisible, memberProfileOpener: undefined, onMentionMember: undefined,
    flashMessageId: undefined, threeParty: undefined, readReceiptHandle: undefined, onOpenTopic: undefined, topicAnchors: undefined, onOpenTopicAnchor: undefined,
    agentFloodNoticeMessageId: undefined, onAgentFloodUndone: undefined, onOpenFile: undefined,
    selectMode: false, selectedIds: new Set(), onToggleSelect: noop, onEnterSelectMode: noop,
  }
  return { rows, rowProps, resetKey: 'g#0#1' }
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); rowRenders.clear() })
afterEach(() => { harness.cleanup(); vi.unstubAllGlobals() })

describe('MessageList rows select their own view', () => {
  it('a member reading one more message re-renders only the row whose receipt changed', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const messages = [mine('m1', 1), mine('m2', 2), mine('m3', 3), mine('m4', 4)]
    await harness.render(createElement(MessageList, listProps(messages, { me: 4, b: 2 })))
    expect(Object.fromEntries(rowRenders)).toEqual({ m1: 1, m2: 1, m3: 1, m4: 1 })
    await harness.render(createElement(MessageList, listProps(messages, { me: 4, b: 3 })))
    expect(Object.fromEntries(rowRenders)).toEqual({ m1: 1, m2: 1, m3: 2, m4: 1 })
  })

  it('a message arriving re-renders no row whose own view stayed the same', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const messages = [mine('m1', 1), mine('m2', 2), mine('m3', 3)]
    await harness.render(createElement(MessageList, listProps(messages, { me: 3 })))
    await harness.render(createElement(MessageList, listProps([...messages, mine('m4', 4)], { me: 4 })))
    // m3 is now grouped with a message below it; m1 and m2 did not change.
    expect(rowRenders.get('m1')).toBe(1)
    expect(rowRenders.get('m2')).toBe(1)
    expect(rowRenders.get('m4')).toBe(1)
  })

  it('coming back to the window reports the seen rows again without re-rendering them', async () => {
    const observers: { callback: IntersectionObserverCallback; nodes: Element[] }[] = []
    vi.stubGlobal('IntersectionObserver', class {
      private entry: { callback: IntersectionObserverCallback; nodes: Element[] }
      constructor(callback: IntersectionObserverCallback) { this.entry = { callback, nodes: [] }; observers.push(this.entry) }
      observe(node: Element) { this.entry.nodes.push(node) }
      disconnect() { this.entry.nodes = [] }
    })
    const visibility = { value: 'visible' as DocumentVisibilityState }
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility.value })
    const reported: string[] = []
    const messages = [mine('m1', 1), mine('m2', 2)]
    await harness.render(createElement(MessageList, listProps(messages, { me: 2 }, (msg) => reported.push(msg.id))))
    const seen = { isIntersecting: true, intersectionRatio: 1, intersectionRect: { height: 40 }, boundingClientRect: { height: 40 }, rootBounds: { height: 400 } } as unknown as IntersectionObserverEntry
    await act(async () => { for (const observer of observers) if (observer.nodes.length) observer.callback([{ ...seen, target: observer.nodes[0]! }], {} as IntersectionObserver) })
    expect(reported.sort()).toEqual(['m1', 'm2'])
    const rendersBefore = Object.fromEntries(rowRenders)

    await act(async () => { visibility.value = 'hidden'; document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { visibility.value = 'visible'; document.dispatchEvent(new Event('visibilitychange')) })

    expect(reported.sort()).toEqual(['m1', 'm1', 'm2', 'm2'])
    expect(Object.fromEntries(rowRenders)).toEqual(rendersBefore)
  })
})
