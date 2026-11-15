// @vitest-environment jsdom
import { act, useRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createReactHarness, chat } from '../../../support/testHarness'
import { useChatUnreadStreamNavigation } from '../../../../apps/desktop/src/lib/chatUnreadStreamNavigation'
import { getUnreadLocatorWindow } from '../../../../apps/desktop/src/lib/chatUnreadLocatorMessages'

vi.mock('../../../../apps/desktop/src/lib/chatUnreadLocatorMessages', () => ({ getUnreadLocatorWindow: vi.fn(() => new Promise(() => {})) }))

let harness: ReturnType<typeof createReactHarness> | undefined
afterEach(() => { harness?.cleanup(); vi.mocked(getUnreadLocatorWindow).mockClear() })

const locator = { stream_id: 'main:g1', stream_kind: 'main' as const, thread_root_id: null, message_id: 'm10', message_seq: 10, unread_count: 30,
  addressed_count: 0, cursor_seq: 9, version: 1, is_marked_unread: false }

// A phone keeps the group active behind its list. Reopening it from there is an opening: it captures this opening's first
// unread instead of jumping inside the chat, and an opening with nothing new takes the previous opening's pill away.
it('reopening the active chat as an opening captures its own first unread, and none when nothing is new', async () => {
  let navigation: ReturnType<typeof useChatUnreadStreamNavigation> | undefined
  let chats = [chat({ id: 'g1', kind: 'group', unread_locator: locator })]
  function Host() {
    const chatsRef = useRef(chats)
    chatsRef.current = chats
    const activeChatIdRef = useRef<string | null>('g1'), cancelChatOpenRef = useRef(() => {})
    navigation = useChatUnreadStreamNavigation({ user: { id: 'u1' }, chatsRef, activeChatIdRef, cancelChatOpenRef,
      getMessageSnapshotEpoch: () => 0, isChatOpen: () => true, threadRootOf: () => null,
      setActiveChatId: () => {}, setActiveThreadRootId: () => {}, setLoadingThread: () => {}, setThreadMessages: () => {}, loadChats: async () => {} })
    return null
  }
  harness = createReactHarness()
  await harness.render(<Host />)
  await act(async () => { await navigation!.openUnreadChat('g1', false) })
  expect(getUnreadLocatorWindow).not.toHaveBeenCalled()
  expect(navigation!.entryFor('g1')?.locator.message_id).toBe('m10')
  chats = [chat({ id: 'g1', kind: 'group', unread_locator: null })]
  await harness.render(<Host />)
  await act(async () => { await navigation!.openUnreadChat('g1', false) })
  expect(navigation!.entryFor('g1')).toBeNull()
})
