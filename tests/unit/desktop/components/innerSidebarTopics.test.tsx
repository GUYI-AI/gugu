// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { ChatListSlotHost } from '../../../../apps/desktop/src/components/ChatListSlotHost'
import { INNER_SIDEBAR_TOPIC_LIMIT, innerSidebarTopicRows, topicsOfChat } from '../../../../apps/desktop/src/components/chat/innerSidebarTopicsModel'
import { innerSidebarTopicsSlotKey, setInnerSidebarFilter, setInnerSidebarTopicsAll } from '../../../../apps/desktop/src/lib/innerSidebarBridge'
import { readShellSlots } from '../../../../apps/desktop/src/lib/shellSlots'
import { drainTopicSplitRequest } from '../../../../apps/desktop/src/lib/topicSplitRequest'
import { installSessionViewRequestBridge } from '../../../../apps/desktop/src/session/renderer/features/sessions/stores/session-view-requests'
import { SCREEN_CONTENT_DRAG_TYPE } from '../../../../apps/desktop/src/session/renderer/lib/drag-screen-content'
import { chat, clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))

const NOW = Date.parse('2099-02-01T00:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString()
// Unread, of which `addressed` call me (the server's addressed_count): agents talking among themselves do not.
const unread = (count: number, addressed: number): Partial<ChatItem> => ({
  unread_count: count,
  unread_locator: {
    stream_id: 's', stream_kind: 'main', thread_root_id: null, message_id: null, message_seq: null,
    unread_count: count, addressed_count: addressed, cursor_seq: 0, version: 1, is_marked_unread: false,
  },
})
const topic = (id: string, daysAgo: number, extra: Partial<ChatItem> = {}) =>
  chat({ id, kind: 'topic', source_chat_id: 'group', name: id, last_message_at: at(daysAgo), ...extra })
const source = chat({ id: 'group', kind: 'group', name: 'Planning' })
// Newest first by activity: t0 … t6; `calls-me` old but calls me; `news` old with unread that nobody addressed to me.
const topics = [
  topic('t3', 3), topic('t0', 0), topic('t6', 6), topic('t1', 1), topic('t5', 5), topic('t2', 2), topic('t4', 4),
  topic('calls-me', 30, unread(3, 1)),
  topic('news', 20, unread(2, 0)),
  topic('archived', 0, { status: 'archived' }),
  chat({ id: 'other', kind: 'topic', source_chat_id: 'another-group', name: 'Elsewhere', last_message_at: at(0) }),
]
const ids = (list: readonly ChatItem[]) => list.map((item) => item.id)

describe('which topics the inner sidebar shows', () => {
  it("lists only this chat's topics, newest activity first, without archived ones", () => {
    expect(ids(topicsOfChat(topics, 'group'))).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6', 'news', 'calls-me'])
  })

  it('level one: what calls me always, then new messages, then recent activity, up to 5', () => {
    const level = innerSidebarTopicRows(topicsOfChat(topics, 'group'), { all: false, query: '' })
    expect(INNER_SIDEBAR_TOPIC_LIMIT).toBe(5)
    expect(ids(level.shown)).toEqual(['calls-me', 'news', 't0', 't1', 't2'])
    expect(level).toMatchObject({ hidden: 4, calling: 1, matched: 9 })
  })

  it('what calls me is shown even past the limit', () => {
    const many = Array.from({ length: 7 }, (_, index) => topic(`call-${index}`, index, unread(1, 1)))
    const level = innerSidebarTopicRows([...many, topic('quiet', 0)], { all: false, query: '' })
    expect(ids(level.shown)).toEqual(ids(many))
    expect(level).toMatchObject({ hidden: 1, calling: 7 })
  })

  it('All = every topic in the same order; filtering shows every match and truncates nothing', () => {
    const ordered = topicsOfChat(topics, 'group')
    const all = innerSidebarTopicRows(ordered, { all: true, query: '' })
    expect(ids(all.shown)).toEqual(['calls-me', 'news', 't0', 't1', 't2', 't3', 't4', 't5', 't6'])
    expect(all.hidden).toBe(0)
    const found = innerSidebarTopicRows(ordered, { all: false, query: 'T' })
    expect(ids(found.shown)).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6'])
    expect(found).toMatchObject({ hidden: 0, matched: 7 })
  })
})

describe('the inner sidebar topics slot', () => {
  let harness: ReturnType<typeof createReactHarness>
  const openChat = vi.fn()
  beforeEach(() => {
    harness = createReactHarness()
    openChat.mockReset()
    installSessionViewRequestBridge(window, { openChat })
    setInnerSidebarTopicsAll(null)
    setInnerSidebarFilter('group', '')
  })
  afterEach(() => {
    act(() => readShellSlots()?.setSlot(innerSidebarTopicsSlotKey('group'), null))
    harness.cleanup()
  })
  const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-inner-sidebar-topics] [data-topic-row]')).map((row) => row.dataset.topicRow)

  it('draws level one into the slot, follows All and the filter, and opens a topic the existing way', async () => {
    await renderWithAppProviders(harness, createNode(ChatListSlotHost, {}), { chat: { chats: [source, ...topics] }, contacts: {} })
    const slot = document.body.appendChild(document.createElement('div'))
    await act(async () => readShellSlots()!.setSlot(innerSidebarTopicsSlotKey('group'), slot))
    expect(rows()).toEqual(['calls-me', 'news', 't0', 't1', 't2'])
    // The row's mark is today's topic-row mark (the unread number), untouched.
    expect(slot.querySelector('[data-topic-row="news"] [data-slot="chip"]')?.textContent).toBe('2')
    expect(slot.querySelector('[data-topic-row="t0"] [data-slot="chip"]')).toBeNull()

    await act(async () => setInnerSidebarTopicsAll('group'))
    expect(rows()).toHaveLength(9)
    await act(async () => setInnerSidebarTopicsAll(null))
    await act(async () => setInnerSidebarFilter('group', ' t1 '))
    expect(rows()).toEqual(['t1'])
    await act(async () => setInnerSidebarFilter('group', ''))

    await clickElement(slot.querySelector('[data-topic-row="t1"]') as HTMLElement)
    expect(openChat).toHaveBeenCalledWith('group', false)
    expect(drainTopicSplitRequest('group')).toMatchObject({ chatId: 't1', sourceChatId: 'group' })
    slot.remove()
  })

  it('a topic row drags into the chat area as a split, with the chat list topic sub-row payload', async () => {
    await renderWithAppProviders(harness, createNode(ChatListSlotHost, {}), { chat: { chats: [source, ...topics] }, contacts: {} })
    const slot = document.body.appendChild(document.createElement('div'))
    await act(async () => readShellSlots()!.setSlot(innerSidebarTopicsSlotKey('group'), slot))
    const button = slot.querySelector<HTMLElement>('[data-topic-row="t1"]')!
    // The row's button must not swallow mousedown, or the browser never starts a native drag.
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    button.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(false)

    const row = button.closest<HTMLElement>('[draggable="true"]')!
    expect(row.getAttribute('role')).toBe('listitem')
    const setData = vi.fn()
    const dragImage = vi.fn()
    const start = new Event('dragstart', { bubbles: true, cancelable: true })
    Object.defineProperty(start, 'dataTransfer', { value: { setData, setDragImage: dragImage, effectAllowed: 'all', types: [] } })
    await act(async () => { row.dispatchEvent(start) })
    expect(setData).toHaveBeenCalledWith(SCREEN_CONTENT_DRAG_TYPE, JSON.stringify({ kind: 'chat', chatId: 'group', title: 't1', topic: { chatId: 't1', name: 't1' } }))
    expect(dragImage).toHaveBeenCalledTimes(1)
    await act(async () => { row.dispatchEvent(new Event('dragend', { bubbles: true })) })
    slot.remove()
  })
})
