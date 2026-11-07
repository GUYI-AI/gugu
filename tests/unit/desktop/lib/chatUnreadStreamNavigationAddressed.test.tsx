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
  addressed_count: 1, first_addressed_message_id: 'm25', first_addressed_seq: 25, cursor_seq: 9, version: 1, is_marked_unread: false }

// A phone keeps the group active behind its list, so tapping it again is an opening of the current chat: it lands on the
// message that called you like any opening does. The pill's jump still goes to the first unread.
it('opens a main line that called you on that call; the unread pill still jumps to the first unread', async () => {
  let navigation: ReturnType<typeof useChatUnreadStreamNavigation> | undefined
  function Host() {
    const chatsRef = useRef([chat({ id: 'g1', kind: 'group', unread_locator: locator })])
    const activeChatIdRef = useRef<string | null>('g1'), cancelChatOpenRef = useRef(() => {})
    navigation = useChatUnreadStreamNavigation({ user: { id: 'u1' }, chatsRef, activeChatIdRef, cancelChatOpenRef,
      getMessageSnapshotEpoch: () => 0, isChatOpen: () => true, threadRootOf: () => null,
      setActiveChatId: () => {}, setActiveThreadRootId: () => {}, setLoadingThread: () => {}, setThreadMessages: () => {}, loadChats: async () => {} })
    return null
  }
  harness = createReactHarness()
  await harness.render(<Host />)
  await act(async () => { void navigation!.openUnreadChat('g1') })
  expect(vi.mocked(getUnreadLocatorWindow).mock.calls.at(-1)?.[1]).toMatchObject({ message_id: 'm25', message_seq: 25 })
  await act(async () => { void navigation!.openStreamAtLocator('g1', locator) })
  expect(vi.mocked(getUnreadLocatorWindow).mock.calls.at(-1)?.[1]).toMatchObject({ message_id: 'm10', message_seq: 10 })
})
