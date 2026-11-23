// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem, GroupChatSettings } from '@gugu/core/shared/types/chat'
import { compareChatsByActivityDesc } from '@gugu/core/shared/ui/chatModels'
import { ChatListSlotHost } from '../../../../apps/desktop/src/components/ChatListSlotHost'
import { INNER_SIDEBAR_TOPIC_LIMIT, innerSidebarTopicRows, topicsOfChat } from '../../../../apps/desktop/src/components/chat/innerSidebarTopicsModel'
import { i18n } from '../../../../apps/desktop/src/i18n'
import { chatService } from '../../../../apps/desktop/src/lib/chat'
import { confirmConversationAction } from '../../../../apps/desktop/src/lib/confirmDanger'
import { innerSidebarTopicsSlotKey, setInnerSidebarTopicsAll } from '../../../../apps/desktop/src/lib/innerSidebarBridge'
import { readShellSlots } from '../../../../apps/desktop/src/lib/shellSlots'
import { installSessionViewRequestBridge } from '../../../../apps/desktop/src/session/renderer/features/sessions/stores/session-view-requests'
import { SCREEN_CONTENT_DRAG_TYPE } from '../../../../apps/desktop/src/session/renderer/lib/drag-screen-content'
import { chat, clickElement, createNode, createReactHarness, renderWithAppProviders, waitForCondition } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))
vi.mock('../../../../apps/desktop/src/lib/confirmDanger', async (original) => ({
  ...(await original<object>()), confirmConversationAction: vi.fn(),
}))

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

  it('level one: the latest 5 by activity, and every unread one in its own place (as the chat list sub-rows)', () => {
    const level = innerSidebarTopicRows(topicsOfChat(topics, 'group'), { all: false })
    expect(INNER_SIDEBAR_TOPIC_LIMIT).toBe(5)
    expect(ids(level.shown)).toEqual(['t0', 't1', 't2', 't3', 't4', 'news', 'calls-me'])
    expect(level).toMatchObject({ hidden: 2, calling: 1 })
  })

  it('unread topics are shown even past the limit', () => {
    const many = Array.from({ length: 7 }, (_, index) => topic(`call-${index}`, index, unread(1, 1)))
    const level = innerSidebarTopicRows([...many, topic('quiet', 8)], { all: false })
    expect(ids(level.shown)).toEqual(ids(many))
    expect(level).toMatchObject({ hidden: 1, calling: 7 })
  })

  it('All = every topic, newest activity first, the same order as the chat list', () => {
    const all = innerSidebarTopicRows(topicsOfChat(topics, 'group'), { all: true })
    expect(ids(all.shown)).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6', 'news', 'calls-me'])
    expect(all.hidden).toBe(0)
  })

  it('reading an unread topic does not move it: unread only wears the badge', () => {
    const before = innerSidebarTopicRows(topicsOfChat(topics, 'group'), { all: true })
    const read = topics.map((row) => (row.id === 'news' || row.id === 'calls-me' ? { ...row, unread_count: 0, unread_locator: null } : row))
    const after = innerSidebarTopicRows(topicsOfChat(read, 'group'), { all: true })
    expect(ids(after.shown)).toEqual(ids(before.shown))
    expect(ids(before.shown), 'the chat list order: activity only').toEqual(ids([...before.shown].sort(compareChatsByActivityDesc)))
  })

  it('a pinned topic goes above every unpinned one, however old, and back to its place when unpinned', () => {
    const pinned = topics.map((row) => (row.id === 't6' || row.id === 'calls-me' ? { ...row, is_pinned: true } : row))
    expect(ids(topicsOfChat(pinned, 'group'))).toEqual(['t6', 'calls-me', 't0', 't1', 't2', 't3', 't4', 't5', 'news'])
    expect(ids(innerSidebarTopicRows(topicsOfChat(pinned, 'group'), { all: false }).shown)).toEqual(['t6', 'calls-me', 't0', 't1', 't2', 'news'])
    const unpinned = pinned.map((row) => ({ ...row, is_pinned: false }))
    expect(ids(topicsOfChat(unpinned, 'group'))).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6', 'news', 'calls-me'])
  })
})

describe('the inner sidebar topics slot', () => {
  let harness: ReturnType<typeof createReactHarness>
  const openChat = vi.fn()
  const confirm = vi.mocked(confirmConversationAction)
  const groupSettings = (canManage: boolean) => ({
    id: source.id, my_role: canManage ? 'admin' : 'member', can_manage: canManage, can_archive_topic: false,
  } as GroupChatSettings)
  beforeEach(() => {
    harness = createReactHarness()
    openChat.mockReset()
    confirm.mockReset()
    vi.spyOn(chatService, 'getGroupChatSettings').mockResolvedValue(groupSettings(false))
    installSessionViewRequestBridge(window, { openChat })
    setInnerSidebarTopicsAll(null)
  })
  afterEach(() => {
    act(() => readShellSlots()?.setSlot(innerSidebarTopicsSlotKey('group'), null))
    harness.cleanup()
  })
  const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-inner-sidebar-topics] [data-topic-row]')).map((row) => row.dataset.topicRow)

  it('draws level one into the slot, follows All, and opens a topic the existing way', async () => {
    await renderWithAppProviders(harness, createNode(ChatListSlotHost, {}), { chat: { chats: [source, ...topics] }, contacts: {} })
    const slot = document.body.appendChild(document.createElement('div'))
    await act(async () => readShellSlots()!.setSlot(innerSidebarTopicsSlotKey('group'), slot))
    expect(rows()).toEqual(['t0', 't1', 't2', 't3', 't4', 'news', 'calls-me'])
    // #2548 a topic that calls me (3 unread, 1 addressed) says 「@1」 in red; one with news that does not call me (2 unread,
    // 0 addressed) only wears the grey dot, without a number; one with nothing new wears nothing.
    const mark = (id: string) => {
      const chip = slot.querySelector(`[data-topic-row="${id}"]`)?.closest('[role="listitem"]')?.querySelector<HTMLElement>('[data-slot="chip"]')
      return chip && { text: chip.textContent, tone: chip.dataset.tone, shape: chip.dataset.shape, label: chip.getAttribute('aria-label') }
    }
    expect(mark('calls-me')).toEqual({ text: '@1', tone: 'danger', shape: 'count', label: null })
    expect(mark('news')).toEqual({ text: '', tone: undefined, shape: 'dot', label: expect.any(String) })
    expect(mark('t0')).toBeNull()

    await act(async () => setInnerSidebarTopicsAll('group'))
    expect(rows()).toHaveLength(9)
    await act(async () => setInnerSidebarTopicsAll(null))

    await clickElement(slot.querySelector('[data-topic-row="t1"]') as HTMLElement)
    expect(openChat).toHaveBeenCalledWith('t1', false)
    slot.remove()
  })

  it('pins a topic independently of whether the viewer can close it', async () => {
    const pinChat = vi.fn(async () => {})
    await renderWithAppProviders(harness, createNode(ChatListSlotHost, {}), { chat: { chats: [source, ...topics], pinChat } })
    const slot = document.body.appendChild(document.createElement('div'))
    try {
      await act(async () => readShellSlots()!.setSlot(innerSidebarTopicsSlotKey('group'), slot))
      const row = slot.querySelector('[data-topic-row="t1"]')!.closest('[role="listitem"]')!
      const pin = row.querySelector<HTMLElement>(`button[aria-label="${i18n.t('chatList.pin', { ns: 'messaging' })}"]`)!
      const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
      pin.dispatchEvent(press)
      expect(press.defaultPrevented).toBe(true)
      await clickElement(pin)
      expect(pinChat).toHaveBeenCalledWith('t1', true)
      expect(row.querySelectorAll('button')).toHaveLength(2)
      expect(openChat).not.toHaveBeenCalled()
      expect(confirm).not.toHaveBeenCalled()
    } finally {
      slot.remove()
    }
  })

  it('gives source group managers the existing topic confirmation and close action', async () => {
    vi.mocked(chatService.getGroupChatSettings).mockResolvedValue(groupSettings(true))
    const deleteChat = vi.fn(async () => {})
    await renderWithAppProviders(harness, createNode(ChatListSlotHost, {}), { chat: { chats: [source, ...topics], deleteChat } })
    const slot = document.body.appendChild(document.createElement('div'))
    try {
      await act(async () => readShellSlots()!.setSlot(innerSidebarTopicsSlotKey('group'), slot))
      const row = slot.querySelector('[data-topic-row="t1"]')!.closest('[role="listitem"]')!
      const close = () => row.querySelector<HTMLElement>(`button[aria-label="${i18n.t('chatList.closeTopic', { ns: 'messaging' })}"]`)
      await waitForCondition(() => close() !== null, 'Manager did not get the Close topic action')
      confirm.mockResolvedValueOnce(false)
      await clickElement(close()!)
      expect(deleteChat).not.toHaveBeenCalled()
      confirm.mockResolvedValueOnce(true)
      await clickElement(close()!)
      expect(confirm).toHaveBeenLastCalledWith('delete-chat', 'topic', 't1')
      expect(deleteChat).toHaveBeenCalledExactlyOnceWith('t1', true)
      expect(openChat).not.toHaveBeenCalled()
      expect(chatService.getGroupChatSettings).toHaveBeenCalledExactlyOnceWith('group')
    } finally {
      slot.remove()
    }
  })

  it('a topic row drags into the chat area as the topic itself, with the chat list topic sub-row payload', async () => {
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
    expect(setData).toHaveBeenCalledWith(SCREEN_CONTENT_DRAG_TYPE, JSON.stringify({ kind: 'chat', chatId: 't1', title: 't1' }))
    expect(dragImage).toHaveBeenCalledTimes(1)
    await act(async () => { row.dispatchEvent(new Event('dragend', { bubbles: true })) })
    slot.remove()
  })
})
