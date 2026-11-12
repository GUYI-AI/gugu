// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatListSlotHost } from '../../../../apps/desktop/src/components/ChatListSlotHost'
import { innerSidebarTopicLevels, topicsOfChat } from '../../../../apps/desktop/src/components/chat/innerSidebarTopicsModel'
import { innerSidebarTopicsSlotKey, setInnerSidebarTopicsAll } from '../../../../apps/desktop/src/lib/innerSidebarBridge'
import { readShellSlots } from '../../../../apps/desktop/src/lib/shellSlots'
import { drainTopicSplitRequest } from '../../../../apps/desktop/src/lib/topicSplitRequest'
import { TOPIC_SINK_AFTER_DAYS } from '@gugu/core/shared/ui/chatModels'
import { installSessionViewRequestBridge } from '../../../../apps/desktop/src/session/renderer/features/sessions/stores/session-view-requests'
import { chat, clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))

const NOW = Date.parse('2099-02-01T00:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString()
const source = chat({ id: 'group', kind: 'group', name: 'Planning' })
// Newest first by activity: t0 … t4 fresh, `stale` older than the sink threshold, `unread-stale` old but unread.
const topics = [
  chat({ id: 't3', kind: 'topic', source_chat_id: 'group', name: 'Three', last_message_at: at(3) }),
  chat({ id: 't0', kind: 'topic', source_chat_id: 'group', name: 'Zero', last_message_at: at(0) }),
  chat({ id: 'stale', kind: 'topic', source_chat_id: 'group', name: 'Stale', last_message_at: at(TOPIC_SINK_AFTER_DAYS + 1) }),
  chat({ id: 't1', kind: 'topic', source_chat_id: 'group', name: 'One', last_message_at: at(1) }),
  chat({ id: 'unread-stale', kind: 'topic', source_chat_id: 'group', name: 'Unread', last_message_at: at(TOPIC_SINK_AFTER_DAYS + 2), unread_count: 2 }),
  chat({ id: 't2', kind: 'topic', source_chat_id: 'group', name: 'Two', last_message_at: at(2) }),
  chat({ id: 'archived', kind: 'topic', source_chat_id: 'group', name: 'Gone', status: 'archived', last_message_at: at(0) }),
  chat({ id: 'other', kind: 'topic', source_chat_id: 'another-group', name: 'Elsewhere', last_message_at: at(0) }),
]

describe('which topics the inner sidebar shows', () => {
  it("lists only this chat's topics, newest activity first, without archived ones", () => {
    expect(topicsOfChat(topics, 'group').map((topic) => topic.id)).toEqual(['t0', 't1', 't2', 't3', 'stale', 'unread-stale'])
  })

  it('level one = the chat-list rule (a few newest plus anything unread); All = every topic', () => {
    const ordered = topicsOfChat(topics, 'group')
    const top = innerSidebarTopicLevels(ordered, NOW, false)
    expect(top.shown.map((topic) => topic.id)).toEqual(['t0', 't1', 't2', 'unread-stale'])
    expect(top.hidden.map((topic) => topic.id)).toEqual(['t3', 'stale'])
    const all = innerSidebarTopicLevels(ordered, NOW, true)
    expect(all.shown.map((topic) => topic.id)).toEqual(ordered.map((topic) => topic.id))
    expect(all.hidden).toEqual([])
  })
})

describe('the inner sidebar topics slot', () => {
  let harness: ReturnType<typeof createReactHarness>
  const openChat = vi.fn()
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    harness = createReactHarness()
    openChat.mockReset()
    installSessionViewRequestBridge(window, { openChat })
    setInnerSidebarTopicsAll(null)
  })
  afterEach(() => {
    act(() => readShellSlots()?.setSlot(innerSidebarTopicsSlotKey('group'), null))
    harness.cleanup()
    vi.useRealTimers()
  })
  const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-inner-sidebar-topics] [data-topic-subrow]')).map((row) => row.dataset.topicSubrow)

  it('draws the chat-list topic rows into the slot, switches to every topic and back, and opens a topic the existing way', async () => {
    await renderWithAppProviders(harness, createNode(ChatListSlotHost, {}), { chat: { chats: [source, ...topics] }, contacts: {} })
    const slot = document.body.appendChild(document.createElement('div'))
    await act(async () => readShellSlots()!.setSlot(innerSidebarTopicsSlotKey('group'), slot))
    expect(rows()).toEqual(['t0', 't1', 't2', 'unread-stale'])

    // The rows' own "More" is the same switch as the header's "All ›".
    await clickElement(slot.querySelector('[data-testid="topic-sunk-section"]') as HTMLElement)
    expect(rows()).toEqual(['t0', 't1', 't2', 't3', 'stale', 'unread-stale'])
    await act(async () => setInnerSidebarTopicsAll(null))
    expect(rows()).toEqual(['t0', 't1', 't2', 'unread-stale'])

    await clickElement(slot.querySelector('[data-topic-subrow="t1"]') as HTMLElement)
    expect(openChat).toHaveBeenCalledWith('group', false)
    expect(drainTopicSplitRequest('group')).toMatchObject({ chatId: 't1', sourceChatId: 'group' })
    slot.remove()
  })
})
